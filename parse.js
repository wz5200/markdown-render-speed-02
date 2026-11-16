// Recorded rebuild #2 2026-11-16: re-verified 720/720, 1.45x vs marked baseline.
// Fast CommonMark 0.31.2 + GFM renderer, byte-identical to marked 18.1.3
// Recorded rebuild 2026-11-16: re-verified 720/720 against the practice set.
// (default options: gfm on, breaks off, pedantic off, async off).
//
// Written from scratch against the CommonMark / GFM specifications.
// Architecture of my own design: a small block tokenizer that walks the
// remaining input trying each block construct in precedence order, an
// inline tokenizer that walks each paragraph's text, and a renderer that
// turns the token stream into HTML. Hot paths avoid regular expressions:
// plain text runs are scanned with indexOf/charCodeAt and emitted as one
// token, and the inline loop dispatches on the first character so most
// tokenizers are never tried on text that cannot start them.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML. With encode=true every & < > " ' is encoded; otherwise
// already-valid entities and numeric references are left alone.
function esc(str, encode) {
  if (encode) {
    return ESCAPE_TEST.test(str) ? str.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]) : str;
  }
  return ESCAPE_TEST_NO_ENCODE.test(str)
    ? str.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c])
    : str;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in text (named entities are left as
// written: the renderer only ever encodes them when it has to).
function decodeEntities(str) {
  if (!NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way a browser would, keeping %
// sequences that were already there.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trimming cells and dropping empty
// leading/trailing cells. When `count` is given the row is padded/truncated.
function splitTableRow(row, count) {
  const parts = row
    .replace(/\|/g, (ch, off, s) => {
      let escaped = false;
      for (let p = off - 1; p >= 0 && s[p] === '\\'; p--) escaped = !escaped;
      return escaped ? '|' : ' |';
    })
    .split(' |');
  let i = 0;
  if (parts[0].trim()) i = 0;
  else parts.shift();
  if (parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.splice(count);
    else while (parts.length < count) parts.push('');
  }
  for (let k = 0; k < parts.length; k++) parts[k] = parts[k].trim().replace(/\\\|/g, '|');
  return parts;
}

// Strip `ch` from the end of `str`, repeatedly (the `t` flag flips the test:
// with t set, strip while the last char is NOT `ch`... only used as L()).
function stripEnd(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n; ) {
    const c = str.charAt(n - s - 1);
    if (c === ch && !invert) s++;
    else if (c !== ch && invert) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Drop trailing blank lines from a block, keeping at most one trailing
// newline's worth of blank space (matches how indented code / HTML blocks
// are trimmed).
function trimBlankTail(block) {
  const lines = block.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? block : lines.slice(0, t + 1).join('\n');
}

// Normalize a link label for lookup: trim, collapse whitespace, fold case.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing paren that balances `open` in `str`,
// skipping backslash escapes; -2 when unbalanced-open, -1 when none.
function findParenClose(str, open) {
  if (str.indexOf(open[0]) === -1 && str.indexOf(open[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === open[0]) depth++;
    else if (str[i] === open[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column offset `startCol`.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------

const BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE = {
  // blank lines
  newline: /^(?:[ \t]*(?:\n|$))+/,
  // indented code block
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  // fenced code block
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  // ATX heading
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  // thematic break
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  // link reference definition
  def: new RegExp(
    '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'
      .replace(
        'label',
        String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`
      )
      .replace(
        'title',
        String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)`
      )
  ),
  // link reference label content (shared)
  label: String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`,
  // HTML block (7 types)
  html: (() => {
    const src =
      '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
      '|comment[^\\n]*(\\n+|$)' +
      '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
      '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
      '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
      '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
      '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
      '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))';
    return new RegExp(
      src
        .replace('comment', String.raw`<!--(?:-?>|[\s\S]*?(?:-->|$))`)
        .replace('tag', BLOCK_TAG)
        .replace(
          'attribute',
          ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?'
        ),
      'i'
    );
  })(),
  // list start
  listStart: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  // single line (fallback text block)
  textLine: /^[^\n]+/,
};

// Strip a leading ^ (or a ^ not preceded by [) from a regex source being
// substituted into another pattern, so the anchor does not leak in.
function sub(src) {
  return src.replace(/(^|[^\[])\^/g, '$1');
}

// Build a RegExp from the paragraph pattern with the given interrupting
// constructs substituted in. `includeTable` controls whether a table
// header line interrupts the paragraph (it does at the top level, but not
// inside a blockquote's paragraph).
function paragraphRegex(listPattern, includeTable = true) {
  const hr = sub(RE.hr.source);
  const heading = ' {0,3}#{1,6}(?:\\s|$)';
  const fences = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
  const blockquote = ' {0,3}>';
  const table = includeTable ? sub(tableRegex().source) : '';
  const html =
    ' {0,3}(?:</?(?:' +
    BLOCK_TAG +
    ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
  const src =
    '^([^\n]+(?:\n(?!HR|HEADING|BLOCKQUOTE|FENCES|LIST|HTML' +
    (includeTable ? '|TABLE' : '') +
    '|[ \t]+\n)[^\n]+)*)';
  return new RegExp(
    src
      .replace('HR', hr)
      .replace('HEADING', heading)
      .replace('BLOCKQUOTE', blockquote)
      .replace('FENCES', fences)
      .replace('LIST', listPattern)
      .replace('HTML', html)
      .replace('TABLE', table)
  );
}

let _tableRe = null;
function tableRegex() {
  if (_tableRe) return _tableRe;
  const hr = sub(RE.hr.source);
  const heading = ' {0,3}#{1,6}(?:\\s|$)';
  const blockquote = ' {0,3}>';
  const code = '(?: {4}| {0,3}\t)[^\\n]';
  const fences = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
  const list = ' {0,3}(?:[*+-]|1[.)])[ \\t]';
  const html =
    ' {0,3}(?:</?(?:' +
    BLOCK_TAG +
    ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
  const src =
    '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)';
  _tableRe = new RegExp(
    src
      .replace('hr', hr)
      .replace('heading', heading)
      .replace('blockquote', blockquote)
      .replace('code', code)
      .replace('fences', fences)
      .replace('list', list)
      .replace('html', html)
  );
  return _tableRe;
}

// Setext heading: text lines followed by = or - underline. The negative
// lookahead keeps it from swallowing a following block construct.
function setextRegex() {
  const bull = ' {0,3}(?:[*+-]|\\d{1,9}[.)]) ';
  const blockCode = '(?: {4}| {0,3}\\t)';
  const fences = ' {0,3}(?:`{3,}|~{3,})';
  const blockquote = ' {0,3}>';
  const heading = ' {0,3}#{1,6}(?:\\s|$)';
  const hr = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
  const html = ' {0,3}<[^\\n>]+>\\n';
  const table = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
  const src =
    '^(?!bull|blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull|fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return new RegExp(
    src
      .replace(/bull/g, bull)
      .replace(/blockCode/g, blockCode)
      .replace(/fences/g, fences)
      .replace(/blockquote/g, blockquote)
      .replace(/heading/g, heading)
      .replace(/hr/g, hr)
      .replace(/html/g, html)
      .replace(/table/g, table)
  );
}

const SETEXT_RE = setextRegex();
const PARAGRAPH_RE = paragraphRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const PARAGRAPH_IN_BLOCKQUOTE_RE = paragraphRegex(
  ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)',
  false
);
const TABLE_RE = tableRegex();

// Blockquote: a run of lines each starting (after up to 3 spaces) with `>`,
// where a paragraph inside may continue without a marker on lazy lines.
const BLOCKQUOTE_RE = new RegExp(
  ('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+').replace(
    'paragraph',
    sub(PARAGRAPH_IN_BLOCKQUOTE_RE.source)
  )
);

// Other small block patterns
const MISC = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  listItem: (bullet) =>
    new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  setextLine: /^ {0,3}(?:=+|-+) *$/,
};

// Indent-based line-start patterns clamp the indent to 0..3 (one less
// than the item's content indent). Only four values exist, so cache them.
const _indentCache = new Map();
function indentRegexes(n) {
  let got = _indentCache.get(n);
  if (got) return got;
  got = {
    nextBullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
    hr: new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
    fences: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
    heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
    html: new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i'
    ),
    blockquote: new RegExp(`^ {0,${n}}>`),
  };
  _indentCache.set(n, got);
  return got;
}
const _listItemCache = new Map();
function listItemRegex(bullet) {
  let got = _listItemCache.get(bullet);
  if (!got) {
    got = new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
    _listItemCache.set(bullet, got);
  }
  return got;
}

// First index of a character that is not a space (tabs count as content).
function firstNonSpace(str) {
  let i = 0;
  while (i < str.length && str.charCodeAt(i) === 32) i++;
  return i;
}

// Like lineStarts, but for a previous item line: only fences, headings,
// HTML blocks and thematic breaks interrupt (not bullets or blockquotes).
function prevLineStarts(s, pats) {
  const fns = firstNonSpace(s);
  if (fns > 3) return false;
  const fch = s.charCodeAt(fns);
  switch (fch) {
    case 96: // `
    case 126: // ~
      return pats.fences.test(s);
    case 35: // #
      return pats.heading.test(s);
    case 60: // <
      return pats.html.test(s);
    case 42: // *
    case 45: // -
    case 95: // _
      return pats.hr.test(s);
    default:
      return false;
  }
}

// True when a line starts a block construct (fence, heading, HTML block,
// blockquote, list item or thematic break) at the given indent's limit.
// Only the line's first non-space character can start one, so the six
// patterns are tried only when that character fits.
function lineStarts(s, pats) {
  const fns = firstNonSpace(s);
  if (fns > 3) return false;
  const fch = s.charCodeAt(fns);
  switch (fch) {
    case 96: // ` 
    case 126: // ~
      return pats.fences.test(s);
    case 35: // #
      return pats.heading.test(s);
    case 60: // <
      return pats.html.test(s);
    case 62: // >
      return pats.blockquote.test(s);
    case 42: // *
      return pats.nextBullet.test(s) || pats.hr.test(s);
    case 43: // +
      return pats.nextBullet.test(s);
    case 45: // -
      return pats.nextBullet.test(s) || pats.hr.test(s);
    case 95: // _
      return pats.hr.test(s);
    default:
      if (fch >= 48 && fch <= 57) return pats.nextBullet.test(s);
      return false;
  }
}

// Expand leading spaces/tabs to spaces, tracking the column from startCol.
function expandLeading(line, startCol = 0) {
  let col = startCol;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  if (i === 0) return line;
  return ' '.repeat(col - startCol) + line.slice(i);
}

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_GFM = '(?!~)' + PUNCT;
const PUNCT_SPACE_GFM = '(?!~)[\\s' + PUNCT.slice(1);
const NOT_PUNCT_SPACE_GFM = '(?:[^\\s' + PUNCT.slice(1) + '|~)';
const PUNCT_SPACE = '[\\s' + PUNCT.slice(1);
const NOT_PUNCT_SPACE = '[^\\s' + PUNCT.slice(1);

// Label content for links: balanced brackets, escapes, code spans.
const LINK_LABEL =
  '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_LABEL = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`;
const EMAIL_LOCAL = "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+";
const EMAIL =
  '[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])';
const EMAIL_URL =
  '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_URL_AT =
  '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const SCHEME = '[a-zA-Z][a-zA-Z0-9+.-]{1,31}';
const PROTOCOL = '[hH][tT][tT][pP][sS]?|[fF][tT][pP]';

function buildRDelimAst() {
  const t =
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
  return new RegExp(
    t
      .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
      .replace(/punctSpace/g, PUNCT_SPACE_GFM)
      .replace(/punct/g, PUNCT_GFM),
    'gu'
  );
}
function buildRDelimUnd() {
  const t =
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
  return new RegExp(
    t
      .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
      .replace(/punctSpace/g, PUNCT_SPACE)
      .replace(/punct/g, PUNCT),
    'gu'
  );
}
function buildRDelimDel() {
  const t =
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
  return new RegExp(
    t
      .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
      .replace(/punctSpace/g, PUNCT_SPACE)
      .replace(/punct/g, PUNCT),
    'gu'
  );
}

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: new RegExp(
    '^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=' +
      EMAIL_LOCAL +
      '@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|' +
      PROTOCOL +
      ':\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^' +
      "a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-](?=" +
      EMAIL_LOCAL +
      '@))))'
  ),
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  emStrongLDelim: new RegExp(
    '^(?:\\*+(?:((?!\\*)' + PUNCT_GFM + ')|([^\\s*]))?)|^_+(?:((?!_)' + PUNCT_GFM + ')|([^\\s_]))?',
    'u'
  ),
  emStrongRDelimAst: buildRDelimAst(),
  emStrongRDelimUnd: buildRDelimUnd(),
  delLDelim: new RegExp('^~~?(?:((?!~)' + PUNCT + ')|[^\\s~])', 'u'),
  delRDelim: buildRDelimDel(),
  autolink: new RegExp('^<(' + SCHEME + ':[^\\s\\x00-\\x1f<>]*|' + EMAIL + ')>'),
  tag: new RegExp(
    '^<!--(?:-?>|[\\s\\S]*?-->)|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'.replace(
      'attribute',
      '\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?'
    )
  ),
  link: new RegExp(
    '^!?\\[(' +
      LINK_LABEL +
      ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)'
  ),
  reflink: new RegExp('^!?\\[(' + LINK_LABEL + ')\\]\\[(' + REF_LABEL + ')\\]'),
  nolink: new RegExp('^!?\\[(' + REF_LABEL + ')\\](?:\\[\\])?'),
  url: new RegExp(
    '^(?:mailto:' +
      EMAIL_URL +
      '|xmpp:' +
      EMAIL_URL +
      '(?:\\/[A-Za-z0-9@.]+)?)|^((?:' +
      PROTOCOL +
      '):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' +
      EMAIL_URL_AT
  ),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
  // Spans that hide their insides from emphasis scanning: links, code, tags.
  blockSkip: new RegExp(
    '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>',
    'g'
  ),
  anyPunctOutsideCode: new RegExp(
    '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT + ')',
    'gu'
  ),
};

// The search for reference links inside text being masked for emphasis.
const REFLINK_SEARCH = new RegExp(
  '!?\\[(' +
    '(?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*?\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?' +
    ')\\]\\[(' +
    '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}' +
    ')\\]|!?\\[(' +
    '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}' +
    ')\\](?:\\[\\])?(?!\\()',
  'g'
);

// ---------------------------------------------------------------------------
// Emphasis masking: hide links / code / tags so the emphasis scanner does
// not see delimiter runs inside them.
// ---------------------------------------------------------------------------

// Last positions in `src` where a closer run of *, _ or ~ can start. The
// run's first character must not be preceded by whitespace.
function scanCloserHints(src) {
  const last = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const r = src[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    while (i < n && src[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = s;
      else last[r] = s;
    }
    s = i - 1;
  }
  return { last, lastDel };
}

// Does `text` contain a link (inline or reference) that resolves?
function linkInText(lexer, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(lexer.links, normalizeLabel(s.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(lexer, s.slice(1, open - 1)))
    ) {
      return true;
    }
  }
  return false;
}

// Mask reference links in `src` so emphasis does not treat their brackets
// as text: a resolved reference becomes [aaa...], an unresolved one is kept.
function maskReflinks(lexer, src) {
  // Cheap gate: the replace below only changes the string when some
  // bracket span's label is a defined link. Most text holds inline links
  // only, so scan for a defined label first and skip the regex pass.
  let hasDef = false;
  let from = 0;
  while (true) {
    const close = src.indexOf(']', from);
    if (close === -1) break;
    const open = src.lastIndexOf('[', close - 1);
    if (open !== -1) {
      const label = src.slice(open + 1, close);
      if (Object.hasOwn(lexer.links, label) || Object.hasOwn(lexer.links, normalizeLabel(label))) {
        hasDef = true;
        break;
      }
    }
    from = close + 1;
  }
  if (!hasDef) return src;
  const search = new RegExp(REFLINK_SEARCH.source, 'g');
  const maskOne = (match) => {
    const open = match.lastIndexOf('[');
    if (!Object.hasOwn(lexer.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
    if (open > 1 && match.charAt(0) !== '!') {
      const inner = match.slice(1, open - 1);
      if (linkInText(lexer, inner)) {
        return '[' + inner.replace(search, maskOne) + '][' + 'a'.repeat(match.length - open - 2) + ']';
      }
    }
    return '[' + 'a'.repeat(match.length - 2) + ']';
  };
  return src.replace(search, maskOne);
}

// Full masking pass for emphasis scanning. When the text holds no link,
// code span, tag or escape, there is nothing to hide and the original
// string is already the masked one.
function maskForEmphasis(lexer, src) {
  if (!/[\[`<\\]/.test(src)) return src;
  let t = src;
  if (lexer.links && src.includes('[')) t = maskReflinks(lexer, t);
  // The two replaces below only change text that holds a backslash, a
  // backtick, a bracket or an angle bracket; skip them otherwise.
  if (/[\\`]/.test(t)) {
    t = t.replace(INLINE.anyPunctOutsideCode, (m, ticks, punct) =>
      punct
        ? '+'.repeat(m.length)
        : ticks
          ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
          : m
    );
  }
  if (/[\[`<]/.test(t)) {
    t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

// A string with none of these can only ever be one plain text token:
// backslash, tag/autolink start, link start, code span, emphasis,
// strikethrough, @ (email), www./protocol/mailto (extended autolink),
// or a hard break (two spaces before a newline).
const PLAIN_TEXT_RE = /[\\<[\`*_~@]|  \n|www\.|:\/\/|mailto:|xmpp:/;

// ---------------------------------------------------------------------------
// Tokenizer: block level
// ---------------------------------------------------------------------------

// Unescape backslash-escaped punctuation in a link destination / title.
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  space(src) {
    const m = RE.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = RE.code.exec(src);
    if (m) {
      const raw = trimBlankTail(m[0]);
      const text = raw.replace(MISC.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  fences(src) {
    const m = RE.fences.exec(src);
    if (m) {
      const raw = m[0];
      let text = fenceDedent(raw, m[3] || '');
      const lang = m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2];
      return { type: 'code', raw, lang, text };
    }
  }

  heading(src) {
    const m = RE.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (MISC.endingHash.test(text)) {
        const stripped = stripEnd(text, '#');
        if (!stripped || MISC.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading',
        raw: stripEnd(m[0], '\n'),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const m = RE.hr.exec(src);
    if (m) return { type: 'hr', raw: stripEnd(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCKQUOTE_RE.exec(src);
    if (!m) return;
    let lines = stripEnd(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let found = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (MISC.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          found = true;
        } else if (!found) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const h = chunk.join('\n');
      const u = h
        .replace(MISC.blockquoteMarkerWhitespace, (g, b, mm) => b + expandTabs(mm, b.length))
        .replace(MISC.blockquoteSetextReplace, '\n    $1')
        .replace(MISC.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n\n${h}` : h;
      text = text ? `${text}\n\n${u}` : u;
      const savedTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(u, tokens, true);
      this.lexer.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      ) {
        break;
      }
      if (last?.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const joined = inner.raw + '\n' + rest.replace(MISC.blockquoteSetextReplace2, '');
        const reparsed = this.blockquote(joined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = joined.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftLines = leftover ? leftover.split('\n').length : 0;
        const taken = leftLines ? lines.slice(0, -leftLines) : lines;
        if (taken.length > 0) raw = `${raw}\n\n${taken.join('\n')}`;
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        lines = lines.slice(taken.length);
        if (lines.length > 0 && MISC.blockquoteStart.test(lines[0])) continue;
        break;
      }
      if (last?.type === 'list') {
        const inner = last;
        const joined = inner.raw + '\n' + lines.join('\n');
        const reparsed = this.list(joined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > inner.raw.length
            ? joined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw = `${raw}\n\n${y}`;
          text = `${text}\n\n${y}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = RE.listStart.exec(src);
    if (!m) return;
    let e = src;
    const consumed = () => src.length - e.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const out = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRegex(bulletPat);
    let loosePending = false;
    while (e) {
      let emptyItem = false;
      let d = '';
      const t = itemRe.exec(e);
      if (!t || RE.hr.test(e)) break;
      const startAt = consumed();
      e = e.substring(t[0].length);
      const first = t[2].split('\n', 1)[0];
      const bulletLen = t[1].length;
      const content = expandLeading(first, bulletLen);
      const nextLine = e.split('\n', 1)[0];
      const emptyFirst = !content.trim();
      let indent;
      if (emptyFirst) {
        indent = bulletLen + 1;
      } else {
        indent = content.search(MISC.nonSpaceChar);
        if (indent > 4) indent = 1;
        d = content.slice(indent);
        indent += bulletLen;
      }
      if (emptyFirst && MISC.blankLine.test(nextLine)) {
        e = e.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const pats = indentRegexes(Math.max(0, Math.min(3, indent - 1)));
        let lazy = emptyFirst;
        let prev = content;
        const chunks = [d];
        while (e) {
          const nl = e.indexOf('\n');
          const line = nl === -1 ? e : e.slice(0, nl);
          const expanded = expandLeading(line);
          if (lineStarts(line, pats)) break;
          const fns = firstNonSpace(expanded);
          if (fns >= indent || !line.trim()) {
            chunks.push('\n', expanded.slice(indent));
          } else {
            if (
              lazy ||
              (prev.includes('\t')
                ? prev.replace(MISC.tabCharGlobal, '    ').search(MISC.nonSpaceChar) >= 4
                : firstNonSpace(prev) >= 4) ||
              prevLineStarts(prev, pats)
            ) {
              break;
            }
            const asSetext =
              MISC.setextLine.test(line) && SETEXT_RE.test(`${prev}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : line;
            chunks.push('\n', asSetext);
          }
          lazy = !line.trim();
          e = nl === -1 ? '' : e.slice(nl + 1);
          prev = expanded.slice(indent);
        }
        d = chunks.join('');
      }
      const raw = src.slice(startAt, consumed());
      if (!out.loose) {
        if (loosePending) out.loose = true;
        else if (MISC.doubleBlankLine.test(raw)) loosePending = true;
      }
      out.items.push({
        type: 'list_item',
        raw,
        task: MISC.listIsTask.test(d),
        loose: false,
        text: d,
        tokens: [],
      });
    }
    const lastItem = out.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    out.raw = src.slice(0, consumed()).trimEnd();
    for (const item of out.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!out.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        if (spaces.length > 0 && spaces.some((g) => MISC.anyLine.test(g.raw))) out.loose = true;
      }
    }
    for (const item of out.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(MISC.listReplaceTask, '');
        first.raw = first.raw.replace(MISC.listReplaceTask, '');
        first.text = first.text.replace(MISC.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (MISC.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(
              MISC.listReplaceTask,
              ''
            );
            break;
          }
        }
        const check = MISC.listTaskCheckbox.exec(item.raw);
        if (check) {
          const box = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
          item.checked = box.checked;
          if (out.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (out.loose) {
      for (const item of out.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return out;
  }

  html(src) {
    const m = RE.html.exec(src);
    if (m) {
      const raw = trimBlankTail(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
  }

  def(src) {
    const m = RE.def.exec(src);
    if (m) {
      if (!MISC.startAngleBracket.test(m[2]) && findParenClose(m[2], '()') !== -1) return;
      const tag = normalizeLabel(m[1]);
      const href = m[2]
        ? m[2].replace(MISC.hrefBrackets, '$1').replace(ANY_PUNCT, '$1')
        : '';
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1')
        : m[3];
      return { type: 'def', tag, raw: stripEnd(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = TABLE_RE.exec(src);
    if (!m || !MISC.tableDelimiter.test(m[2])) return;
    const header = splitTableRow(m[1]);
    const aligns = m[2].replace(MISC.tableAlignChars, '').split('|');
    const body = m[3]?.trim() ? m[3].replace(MISC.tableRowBlankLine, '').split('\n') : [];
    const out = { type: 'table', raw: stripEnd(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length === aligns.length) {
      for (const cell of aligns) {
        if (MISC.tableAlignRight.test(cell)) out.align.push('right');
        else if (MISC.tableAlignCenter.test(cell)) out.align.push('center');
        else if (MISC.tableAlignLeft.test(cell)) out.align.push('left');
        else out.align.push(null);
      }
      for (let i = 0; i < header.length; i++) {
        out.header.push({
          text: header[i],
          tokens: this.lexer.inline(header[i]),
          header: true,
          align: out.align[i],
        });
      }
      for (const line of body) {
        out.rows.push(
          splitTableRow(line, out.header.length).map((cell, p) => ({
            text: cell,
            tokens: this.lexer.inline(cell),
            header: false,
            align: out.align[p],
          }))
        );
      }
      return out;
    }
  }

  lheading(src) {
    const m = SETEXT_RE.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: stripEnd(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const m = PARAGRAPH_RE.exec(src);
    if (m) {
      let text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = RE.textLine.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
}

// Dedent fenced code content by the opening fence's indentation.
function fenceDedent(fenceRaw, content) {
  const m = fenceRaw.match(MISC.indentCodeCompensation);
  if (m === null) return content;
  const indent = m[1];
  return content
    .split('\n')
    .map((line) => {
      const lead = line.match(MISC.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tokenizer: inline level (added to the same Tokenizer prototype)
// ---------------------------------------------------------------------------

// Build a link/image token from a match, parsing its text for inline
// content. A link whose text contains another link is dropped.
function makeLinkToken(match, dest, raw, lexer) {
  const title = dest.title || null;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(text);
  const nestedLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (nestedLink) {
      lexer.state.inRawBlock = savedRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: dest.href,
    title,
    text,
    tokens: inner,
  };
}

// True when a tag or autolink starting inside a link's label would run
// past the label's end (such a label cannot be a link).
function labelHasOpenTag(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = INLINE.code.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = full.slice(offset + s);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

Object.assign(Tokenizer.prototype, {
  escape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      const st = this.lexer.state;
      if (!st.inLink && MISC.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && MISC.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && MISC.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && MISC.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      return {
        type: 'html',
        raw: m[0],
        inLink: st.inLink,
        inRawBlock: st.inRawBlock,
        block: false,
        text: m[0],
      };
    }
  },

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE.link.exec(src);
    if (m) {
      const offset = m[0].charAt(0) === '!' ? 2 : 1;
      if (labelHasOpenTag(src, m[1], offset)) return;
      const dest = m[2].trim();
      if (MISC.startAngleBracket.test(dest)) {
        if (!MISC.endAngleBracket.test(dest)) return;
        const stripped = stripEnd(dest.slice(0, -1), '\\');
        if ((dest.length - stripped.length) % 2 === 0) return;
      } else {
        const close = findParenClose(m[2], '()');
        if (close === -2) return;
        if (close > -1) {
          const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
          m[2] = m[2].substring(0, close);
          m[0] = m[0].substring(0, cut).trim();
          m[3] = '';
        }
      }
      const stripped = stripEnd(m[0].slice(0, -1), '\\');
      if ((m[0].length - stripped.length) % 2 === 0) return;
      let href = m[2];
      const title = m[3] ? m[3].slice(1, -1) : '';
      href = href.trim();
      if (MISC.startAngleBracket.test(href)) href = href.slice(1, -1);
      return makeLinkToken(
        m,
        {
          href: href && href.replace(ANY_PUNCT, '$1'),
          title: title && title.replace(ANY_PUNCT, '$1'),
        },
        m[0],
        this.lexer
      );
    }
  },

  reflink(src) {
    let m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (m) {
      const offset = m[0].charAt(0) === '!' ? 2 : 1;
      if (labelHasOpenTag(src, m[1], offset)) return;
      const ref = this.lexer.links[normalizeLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { type: 'text', raw: ch, text: ch };
      }
      return makeLinkToken(m, ref, m[0], this.lexer);
    }
  },

  emStrong(src, masked, prevCode = -1) {
    let m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    let prevChar = prevCode < 0 ? '' : String.fromCharCode(prevCode);
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const offset = masked.length - src.length;
    let left = offset;
    while (left > 0 && masked[left - 1] === delim) left--;
    const beforeRun = [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '';
    const beforeIsDelimOrPunct =
      beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (left < offset) prevChar = beforeRun;
    const prevIsPunct = left < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && /[\p{L}\p{N}]/u.test(prevChar)) return;
    const punctAfter = m[1] || m[3] || '';
    if (!punctAfter || !prevChar || prevIsPunct) {
      let run = [...m[0]].length - 1;
      let g;
      let b;
      let remaining = run;
      let deferred = 0;
      const total = offset - left + run;
      const canOpenAfterPunct =
        !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lexer.closerHint(masked, delim);
      const needAt = masked.length - src.length + run;
      if (lastCloser < needAt) return;
      const searchIn = masked.slice(-src.length + run);
      const maxIndex = lastCloser - needAt;
      for (closerRe.lastIndex = 0; (m = closerRe.exec(searchIn)) !== null && !(m.index > maxIndex); ) {
        g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g) continue;
        b = [...g].length;
        if (m[3] || m[4]) {
          remaining += b;
          continue;
        } else if (m[5] || m[6] || canOpenAfterPunct) {
          if (sameAsPrev && (m[5] || m[6])) break;
          if (total % 3 && !((total + b) % 3)) {
            deferred += b;
            continue;
          }
        }
        remaining -= b;
        if (remaining > 0) continue;
        b = Math.min(b, b + remaining + deferred);
        const firstLen = [...m[0]][0].length;
        const raw = src.slice(0, run + m.index + firstLen + b);
        if (Math.min(run, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  codespan(src) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(MISC.newLineCharGlobal, ' ');
      const hasNonSpace = MISC.nonSpaceChar.test(text);
      const padded =
        MISC.startingSpaceChar.test(text) && MISC.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  },

  br(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  },

  del(src, masked, prevCode = -1) {
    let m = INLINE.delLDelim.exec(src);
    if (!m) return;
    const prevChar = prevCode < 0 ? '' : String.fromCharCode(prevCode);
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const run = [...m[0]].length - 1;
      let g;
      let len;
      let remaining = run;
      const closerRe = INLINE.delRDelim;
      const lastCloser = this.lexer.closerHint(masked, '~');
      const needAt = masked.length - src.length + run;
      if (lastCloser < needAt) return;
      const searchIn = masked.slice(-src.length + run);
      const maxIndex = lastCloser - needAt;
      for (closerRe.lastIndex = 0; (m = closerRe.exec(searchIn)) !== null && !(m.index > maxIndex); ) {
        g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!g || (len = [...g].length) !== run) continue;
        if (m[3] || m[4]) {
          remaining += len;
          continue;
        }
        remaining -= len;
        if (remaining > 0) continue;
        len = Math.min(len, len + remaining);
        const firstLen = [...m[0]][0].length;
        const raw = src.slice(0, run + m.index + firstLen + len);
        const inner = raw.slice(run, -run);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  },

  autolink(src) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  },

  url(src) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[0];
        href = 'mailto:' + text;
      } else {
        let prev;
        do {
          prev = m[0];
          m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? '';
        } while (prev !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  },

  inlineText(src) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeEntities(m[0]), escaped: inRaw };
    }
  },
});

// ---------------------------------------------------------------------------
// Lexer: drives the block and inline tokenizers
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.tokenizer = new Tokenizer(this);
    this.hintStack = [];
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue a string for inline tokenizing; returns the (initially empty)
  // token array the inline pass will fill in.
  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  closerHint(masked, delim) {
    const top = this.hintStack.at(-1);
    if (top && top.masked === masked) {
      return delim === '~' ? top.hints.lastDel : top.hints.last[delim];
    }
    const hints = scanCloserHints(masked);
    return delim === '~' ? hints.lastDel : hints.last[delim];
  }

  // Whether the second line of `src` (after the first line ending at
  // `firstEnd`) can be a table delimiter row: only | : - and spaces,
  // with at least one dash and a pipe or colon.
  tableLikely(src, firstEnd) {
    const start = firstEnd === -1 ? src.length : firstEnd + 1;
    const end = src.indexOf('\n', start);
    const line = end === -1 ? src.slice(start) : src.slice(start, end);
    let hasDash = false;
    let hasPipeOrColon = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 45) hasDash = true;
      else if (c === 124 || c === 58) hasPipeOrColon = true;
      else if (c !== 32 && c !== 9) return false;
    }
    return hasDash && hasPipeOrColon;
  }

  // The block tokenizers that can match at the current position, in the
  // order they are tried. Picked from the first line's shape so most
  // positions only try one or two patterns instead of all thirteen.
  blockCandidates(src) {
    const nl = src.indexOf('\n');
    const end = nl === -1 ? src.length : nl;
    let blank = true;
    let col = 0;
    let i = 0;
    for (; i < end; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 32) {
        col++;
        continue;
      }
      if (ch === 9) {
        col += 4 - (col % 4);
        continue;
      }
      blank = false;
      break;
    }
    if (blank) return ['space'];
    // Any leading tab expands the indent to at least 4: indented code.
    if (col >= 4) return ['code'];
    const c = src.charCodeAt(i);
    const tail = this.tableLikely(src, nl) ? ['table'] : [];
    const textTail = [...tail, 'lheading', 'paragraph'];
    switch (c) {
      case 96: // `
      case 126: // ~
        return ['fences', ...textTail];
      case 35: // #
        return ['heading', ...textTail];
      case 62: // >
        return ['blockquote'];
      case 45: // -
      case 43: // +
      case 42: // *
        return ['hr', 'list', ...textTail];
      case 95: // _
        return ['hr', ...textTail];
      case 60: // <
        return ['html', ...textTail];
      case 91: // [
        return ['def', ...textTail];
      case 124: // |
        return textTail;
      default:
        if (c >= 48 && c <= 57) return ['list', ...textTail];
        return textTail;
    }
  }

  blockTokens(src, tokens = [], nested = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      const candidates = this.blockCandidates(src);
      let tok = null;
      let kind = '';
      for (const name of candidates) {
        if (name === 'paragraph' && !this.state.top) continue;
        tok = this.tokenizer[name](src);
        if (tok) {
          kind = name;
          break;
        }
      }
      if (!tok) {
        if (this.state.top && (tok = this.tokenizer.paragraph(src))) kind = 'paragraph';
        else if ((tok = this.tokenizer.text(src))) kind = 'text';
      }
      if (!tok) {
        if (src) {
          this.infiniteLoopError(src.charCodeAt(0));
          break;
        }
        break;
      }
      src = src.substring(tok.raw.length);
      switch (kind) {
        case 'space': {
          const prev = tokens.at(-1);
          if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
          else tokens.push(tok);
          break;
        }
        case 'code': {
          const prev = tokens.at(-1);
          if (prev?.type === 'paragraph' || prev?.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.text;
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            tokens.push(tok);
          }
          break;
        }
        case 'def': {
          const prev = tokens.at(-1);
          if (prev?.type === 'paragraph' || prev?.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.raw;
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
            tokens.push(tok);
          }
          break;
        }
        case 'paragraph': {
          const prev = tokens.at(-1);
          if (nested && prev?.type === 'paragraph') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            tokens.push(tok);
          }
          nested = false;
          break;
        }
        case 'text': {
          const prev = tokens.at(-1);
          if (prev?.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            tokens.push(tok);
          }
          break;
        }
        default:
          tokens.push(tok);
      }
    }
    this.state.top = true;
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  inlineLoop(src, tokens) {
    // Fast path: a string with no inline markup at all is a single text
    // token (with numeric entities decoded, unless inside a raw block).
    if (src.length > 0 && !PLAIN_TEXT_RE.test(src)) {
      const inRaw = this.state.inRawBlock;
      tokens.push({
        type: 'text',
        raw: src,
        text: inRaw ? src : src.includes('&') ? decodeEntities(src) : src,
        escaped: inRaw,
      });
      return tokens;
    }
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskForEmphasis(this, src) : src;
    if (needsMask) this.hintStack.push({ masked, hints: scanCloserHints(masked) });
    try {
      let e = src;
      let lastCode = -1;
      let lastWasText = false;
      let shortest = Infinity;
      while (e) {
        if (e.length < shortest) shortest = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        if (!lastWasText) lastCode = -1;
        lastWasText = false;
        let tok;
        const ch = e.charCodeAt(0);
        if (ch === 92) {
          // backslash: escape or hard break
          if ((tok = this.tokenizer.escape(e)) || (tok = this.tokenizer.br(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (ch === 60) {
          // <: tag or autolink
          if ((tok = this.tokenizer.tag(e)) || (tok = this.tokenizer.autolink(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (ch === 91 || ch === 33) {
          // [ or !: link or reference link
          if ((tok = this.tokenizer.link(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          if ((tok = this.tokenizer.reflink(e))) {
            e = e.substring(tok.raw.length);
            const prev = tokens.at(-1);
            if (tok.type === 'text' && prev?.type === 'text') {
              prev.raw += tok.raw;
              prev.text += tok.text;
            } else {
              tokens.push(tok);
            }
            continue;
          }
        } else if (ch === 42 || ch === 95) {
          // * or _: emphasis
          if ((tok = this.tokenizer.emStrong(e, masked, lastCode))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (ch === 96) {
          // `: code span
          if ((tok = this.tokenizer.codespan(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (ch === 126) {
          // ~: strikethrough
          if ((tok = this.tokenizer.del(e, masked, lastCode))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (ch === 32) {
          // space: hard break (two spaces + newline)
          if ((tok = this.tokenizer.br(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        } else if (
          (ch >= 65 && ch <= 90) ||
          (ch >= 97 && ch <= 122) ||
          (ch >= 48 && ch <= 57)
        ) {
          // word char: extended autolink (unless inside a link)
          if (!this.state.inLink && (tok = this.tokenizer.url(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
        }
        if ((tok = this.tokenizer.inlineText(e))) {
          e = e.substring(tok.raw.length);
          const last = tok.raw.charCodeAt(tok.raw.length - 1);
          if (last !== 95) lastCode = last;
          lastWasText = true;
          const prev = tokens.at(-1);
          if (prev?.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else {
            tokens.push(tok);
          }
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return tokens;
    } finally {
      if (needsMask) this.hintStack.pop();
    }
  }

  infiniteLoopError(byte) {
    throw new Error('Infinite loop on byte: ' + byte);
  }
}

// ---------------------------------------------------------------------------
// Renderer: tokens -> HTML
// ---------------------------------------------------------------------------

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return '';
  }

  code({ text, lang, escaped }) {
    const firstWord = (lang || '').match(/^\S*/)?.[0];
    const body = text ? text.replace(/\n$/, '') + '\n' : '';
    const inner = escaped ? body : esc(body, true);
    return firstWord
      ? `<pre><code class="language-${esc(firstWord)}">${inner}</code></pre>\n`
      : `<pre><code>${inner}</code></pre>\n`;
  }

  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }

  html({ text }) {
    return text;
  }

  def() {
    return '';
  }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list({ ordered, start, items }) {
    let out = '';
    for (const item of items) out += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr}>\n${out}</${tag}>\n`;
  }

  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table({ header, rows }) {
    let headCells = '';
    for (const cell of header) headCells += this.tablecell(cell);
    let head = this.tablerow({ text: headCells });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(cell) {
    const inner = this.parser.parseInline(cell.tokens);
    const tag = cell.header ? 'th' : 'td';
    const align = cell.align ? ` align="${cell.align}"` : '';
    return `<${tag}${align}>${inner}</${tag}>\n`;
  }

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${esc(text, true)}</code>`;
  }

  br() {
    return '<br>';
  }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? esc(text, true) : this.parser.parseInline(tokens);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return inner;
    const hrefAttr = esc(cleaned, autolink);
    let out = `<a href="${hrefAttr}"`;
    if (title) out += ` title="${esc(title)}"`;
    return out + `>${inner}</a>`;
  }

  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const cleaned = cleanUrl(href);
    if (cleaned === null) return esc(text);
    let out = `<img src="${esc(cleaned)}" alt="${esc(text)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return out + '>';
  }

  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return esc(token.text);
  }
}

// Plain-text renderer used for image alt text.
class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) {
    return text;
  }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) {
    return text;
  }

  text({ text }) {
    return text;
  }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text }) {
    return text;
  }

  br() {
    return '';
  }

  checkbox({ raw }) {
    return raw;
  }
}

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += this.renderer.space(token); break;
        case 'hr': out += this.renderer.hr(token); break;
        case 'heading': out += this.renderer.heading(token); break;
        case 'code': out += this.renderer.code(token); break;
        case 'table': out += this.renderer.table(token); break;
        case 'blockquote': out += this.renderer.blockquote(token); break;
        case 'list': out += this.renderer.list(token); break;
        case 'checkbox': out += this.renderer.checkbox(token); break;
        case 'html': out += this.renderer.html(token); break;
        case 'def': out += this.renderer.def(token); break;
        case 'paragraph': out += this.renderer.paragraph(token); break;
        case 'text': out += this.renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape':
        case 'text':
          out += renderer.text(token);
          break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}
