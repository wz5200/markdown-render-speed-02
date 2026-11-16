// parse.js — dependency-free ES module: Markdown (CommonMark 0.31.2 + GFM) to HTML,
// byte-identical to marked 18.1.3 with default options (gfm, breaks off, pedantic off).
// Written from scratch in this session from the CommonMark/GFM specs and the
// kit's practice input/expected pairs; no code copied from any other parser.
//
// parse(markdown: string): string — the HTML marked would render for the input.

'use strict';

// ---------------------------------------------------------------- utilities

const ESC_MAP = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };

// Escape text or attribute values: & < > " '  (marked escapes all five).
// Full escape: every & is encoded (used for code content).
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ESC_MAP[s.charCodeAt(i)];
    if (e !== undefined) {
      if (i > start) out += s.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// No-encode escape (used for text, hrefs, titles): & is left alone when it
// starts something that looks like an entity reference (&\w+;).
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc === 38) {
      let j = i + 1;
      while (j < s.length) {
        const c2 = s.charCodeAt(j);
        if ((c2 >= 48 && c2 <= 57) || (c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) || c2 === 95) j++;
        else break;
      }
      if (j > i + 1 && j < s.length && s.charCodeAt(j) === 59) continue;
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else {
      const e = ESC_MAP[cc];
      if (e !== undefined) {
        if (i > start) out += s.slice(start, i);
        out += e;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's cleanUrl: encodeURI, then restore %25 to % so existing
// percent-encodings survive (and lone % stays %).
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch (_e) {
    return url;
  }
}

function isSpace(c) { return c === 32 || c === 9; } // space or tab
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// A line that is blank inside its containers: whitespace-only, or only
// container markers ('>' plus at most one space each) plus whitespace.
function isLevelBlank(s) {
  if (isBlankStr(s)) return true;
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && s.charCodeAt(j) === 32) j++;
    if (j < s.length && s.charCodeAt(j) === 62) {
      i = j + 1;
      if (i < s.length && s.charCodeAt(i) === 32) i++;
    } else break;
  }
  return i >= s.length || isBlankStr(s.slice(i));
}

// Unicode punctuation test (CommonMark "punctuation character" = Unicode P or S).
// Fast path for ASCII punctuation, slow path via a regex for the rest.
const PUNCT_RE = /^[\p{P}\p{S}]$/u;
function isPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return PUNCT_RE.test(ch);
}
// ASCII punctuation only (backslash escapes and link-label unescaping use
// ASCII punctuation; Unicode punctuation does not count there).
function isAsciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isLetter(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return /^\p{L}$/u.test(ch);
}
function isDigit(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}
function isAlnum(ch) {
  return isLetter(ch) || isDigit(ch);
}
const WS_RE = /^\s$/u;
function isWhitespace(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return WS_RE.test(ch);
}

// ---------------------------------------------------------------- entities

// HTML5 named character references (the set marked decodes; a broad common
// subset plus every entity used by the CommonMark/GFM spec examples).
const NAMED_ENTITIES = {
  AElig: '\u00C6', AMP: '&', amp: '&', Aacute: '\u00C1', aacute: '\u00E1',
  Abreve: '\u0102', abreve: '\u0103', acirc: '\u00E2', Acirc: '\u00C2',
  acute: '\u00B4', Acy: '\u0410', acy: '\u0430', AElig2: '\u00C6',
  afr: '\u{1D504}', Afr: '\u{1D504}', agrave: '\u00E0', Agrave: '\u00C0',
  alefsym: '\u2135', aleph: '\u2135', Alpha: '\u0391', alpha: '\u03B1',
  amacr: '\u0101', Amacr: '\u0100', amalg: '\u2A3F', and: '\u2227',
  And: '\u2A53', andand: '\u2A55', andd: '\u2A5C', andslope: '\u2A58',
  andv: '\u2A5A', ang: '\u2220', ange: '\u29A4', angle: '\u2220',
  angmsd: '\u2221', angmsdaa: '\u29A8', angmsdab: '\u29A9', angmsdac: '\u29AA',
  angmsdad: '\u29AB', angmsdae: '\u29AC', angmsdaf: '\u29AD', angmsdag: '\u29AE',
  angmsdah: '\u29AF', angrt: '\u221F', angrtvb: '\u22BE', angrtvbd: '\u299D',
  angsph: '\u2222', angst: '\u00C5', angzarr: '\u237C', Aogon: '\u0104',
  aogon: '\u0105', aopf: '\u{1D552}', Aopf: '\u{1D538}', ap: '\u2248',
  apacir: '\u2A6F', apE: '\u2A70', ape: '\u224A', apid: '\u224B',
  apos: "'", aring: '\u00E5', Aring: '\u00C5', Ascr: '\u{1D49C}',
  ascr: '\u{1D4B6}', ast: '*', asymp: '\u224D', asympeq: '\u224D',
  atilde: '\u00E3', Atilde: '\u00C3', auml: '\u00E4', Auml: '\u00C4',
  awconint: '\u2233', awint: '\u2A11', backcong: '\u224C', backepsilon: '\u03F6',
  backprime: '\u2035', backsim: '\u223D', backsimeq: '\u22CD', Backslash: '\u2216',
  Barv: '\u2AE7', barvee: '\u22BD', barwed: '\u2305', Barwed: '\u2306',
  barwedge: '\u2305', bbrk: '\u23B5', bbrktbrk: '\u23B6', bcong: '\u224C',
  bcy: '\u0431', Bcy: '\u0411', bdquo: '\u201E', becaus: '\u2235',
  because: '\u2235', Because: '\u2235', bemptyv: '\u29B0', bepsi: '\u03F6',
  bernoul: '\u212C', Bernoullis: '\u212C', Beta: '\u0392', beta: '\u03B2',
  beth: '\u2136', between: '\u226C', bfr: '\u{1D51F}', Bfr: '\u{1D505}',
  bigcap: '\u22C2', bigcirc: '\u25EF', bigcup: '\u22C3', bigodot: '\u2A00',
  bigoplus: '\u2A01', bigotimes: '\u2A02', bigsqcup: '\u2A06', bigstar: '\u2605',
  bigtriangledown: '\u25BD', bigtriangleup: '\u25B3', biguplus: '\u2A04',
  bigvee: '\u22C1', bigwedge: '\u22C0', bkarow: '\u290D', blacklozenge: '\u29EB',
  blacksquare: '\u25AA', blacktriangle: '\u25B4', blacktriangledown: '\u25BC',
  blacktriangleleft: '\u25C0', blacktriangleright: '\u25B6', blank: '\u2423',
  blk12: '\u2592', blk14: '\u2591', blk34: '\u2593', block: '\u2588',
  bne: '=\u20E5', bnequiv: '\u2261\u20E5', bnot: '\u2310', bopf: '\u{1D553}',
  Bopf: '\u{1D539}', bot: '\u22A5', bottom: '\u22A5', bowtie: '\u22C8',
  boxbox: '\u29C9', boxdl: '\u2510', boxdL: '\u2555', boxDl: '\u2556',
  boxDL: '\u2557', boxdr: '\u250C', boxdR: '\u2552', boxDr: '\u2553',
  boxDR: '\u2554', boxh: '\u2500', boxH: '\u2550', boxhd: '\u252C',
  boxhD: '\u2565', boxHd: '\u2564', boxHD: '\u2566', boxhu: '\u2534',
  boxhU: '\u2568', boxHu: '\u2567', boxHU: '\u2569', boxminus: '\u229F',
  boxplus: '\u229E', boxtimes: '\u22A0', boxul: '\u2518', boxuL: '\u255D',
  boxUl: '\u255C', boxUL: '\u255E', boxur: '\u2514', boxuR: '\u255A',
  boxUr: '\u2559', boxUR: '\u255B', boxv: '\u2502', boxV: '\u2551',
  boxvh: '\u253C', boxvH: '\u256A', boxVh: '\u256B', boxVH: '\u256C',
  boxvl: '\u2524', boxvL: '\u2561', boxVl: '\u2562', boxVL: '\u2563',
  boxvr: '\u251C', boxvR: '\u255E', boxVr: '\u255F', boxVR: '\u2560',
  bprime: '\u2035', breve: '\u02D8', Breve: '\u02D8', brvbar: '\u00A6',
  bscr: '\u{1D4B7}', Bscr: '\u212C', bsemi: '\u204F', bsim: '\u223D',
  bsime: '\u22CD', bsolb: '\u29C5', bsol: '\\', bsolhsub: '\u27C8',
  bsub: '\u2282', bsube: '\u2286', bsump: '\u2211', bsup: '\u2283',
  bsupe: '\u2287', bull: '\u2022', bullet: '\u2022', bump: '\u224E',
  bumpE: '\u2AAE', bumpe: '\u224F', Bumpeq: '\u224E', bumpeq: '\u224F',
  Cacute: '\u0106', cacute: '\u0107', cap: '\u2229', Cap: '\u22D2',
  capand: '\u2A44', capbrcup: '\u2A49', capcap: '\u2A4B', capcup: '\u2A47',
  capdot: '\u2A40', CapitalDifferentialD: '\u2145', caps: '\u2229\uFE00',
  caret: '\u2041', caron: '\u02C7', Cayleys: '\u212D', ccaps: '\u2A4C',
  Ccaron: '\u010C', ccaron: '\u010D', Ccedil: '\u00C7', ccedil: '\u00E7',
  Ccirc: '\u0108', ccirc: '\u0109', Cconint: '\u2230', ccup: '\u2A4C',
  ccups: '\u2A4D', ccupssm: '\u2A50', Cdot: '\u010A', cdot: '\u010B',
  cedil: '\u00B8', Cedilla: '\u00B8', cemptyv: '\u29B2', cent: '\u00A2',
  centerdot: '\u00B7', CenterDot: '\u00B7', cfr: '\u{1D520}', Cfr: '\u212D',
  CHcy: '\u0427', chcy: '\u0447', check: '\u2713', checkmark: '\u2713',
  Chi: '\u03A7', chi: '\u03C7', cir: '\u25CB', circ: '\u02C6',
  circeq: '\u2257', circlearrowleft: '\u21BA', circlearrowright: '\u21BB',
  circledast: '\u229B', circledcirc: '\u229A', circleddash: '\u229D',
  CircleDot: '\u2299', circledR: '\u00AE', circledS: '\u24C8',
  CircleMinus: '\u2296', CirclePlus: '\u2295', CircleTimes: '\u2297',
  cirE: '\u29C3', cire: '\u2257', cirfnint: '\u2A10', cirmid: '\u2AEF',
  cirscir: '\u29C2', ClockwiseContourIntegral: '\u2232', CloseCurlyDoubleQuote: '\u201D',
  CloseCurlyQuote: '\u2019', clubs: '\u2663', clubsuit: '\u2663',
  colon: ':', Colon: '\u2237', Colone: '\u2A74', colone: '\u2254',
  coloneq: '\u2254', comma: ',', commat: '@', comp: '\u2201',
  compfn: '\u2218', complement: '\u2201', complexes: '\u2102',
  cong: '\u2245', congdot: '\u2A6D', Congruent: '\u2261', conint: '\u222E',
  Conint: '\u222F', ContourIntegral: '\u222E', copf: '\u{1D554}', Copf: '\u2102',
  coprod: '\u2210', Coproduct: '\u2210', copy: '\u00A9', COPY: '\u00A9',
  copysr: '\u2117', CounterClockwiseContourIntegral: '\u2233', crarr: '\u21B5',
  cross: '\u2717', Cross: '\u2A2F', cscr: '\u{1D4B8}', Cscr: '\u{1D49E}',
  csub: '\u2ACF', csube: '\u2AD1', csup: '\u2AD0', csupe: '\u2AD2',
  ctdot: '\u22EF', cudarrl: '\u2938', cudarrr: '\u2935', cuepr: '\u22DE',
  cuesc: '\u22DF', cularr: '\u21B6', cularrp: '\u293D', cup: '\u222A',
  Cup: '\u22D3', cupbrcap: '\u2A48', cupcap: '\u2A46', CupCap: '\u224D',
  cupcup: '\u2A4A', cupdot: '\u2A45', cupor: '\u2A45', cups: '\u222A\uFE00',
  curarr: '\u21B7', curarrm: '\u293C', curlyeqprec: '\u22DE', curlyeqsucc: '\u22DF',
  curlyvee: '\u22CE', curlywedge: '\u22CF', curren: '\u00A4', curvearrowleft: '\u21B6',
  curvearrowright: '\u21B7', cuvee: '\u22CE', cuwed: '\u22CF', cwconint: '\u2232',
  cwint: '\u222F', cylcty: '\u232D', dagger: '\u2020', Dagger: '\u2021',
  daleth: '\u2138', darr: '\u2193', Darr: '\u21A1', dArr: '\u21D3',
  dash: '\u2010', Dashv: '\u2AE4', dashv: '\u22A3', dbkarow: '\u290F',
  dblac: '\u02DD', Dcaron: '\u010E', dcaron: '\u010F', Dcy: '\u0414',
  dcy: '\u0434', ddagger: '\u2021', ddarr: '\u21CA', DD: '\u2145',
  dddot: '\u22F1', Dd: '\u2145', ddotseq: '\u2A77', dead: '\u2061',
  deg: '\u00B0', Del: '\u2207', Delta: '\u0394', delta: '\u03B4',
  demptyv: '\u29B1', dfisht: '\u297F', Dfr: '\u{1D507}', dfr: '\u{1D521}',
  dHar: '\u2965', dharl: '\u21C3', dharr: '\u21C2', DiacriticalAcute: '\u00B4',
  DiacriticalDot: '\u02D9', DiacriticalDoubleAcute: '\u02DD', DiacriticalGrave: '`',
  DiacriticalTilde: '\u02DC', diam: '\u22C4', diamond: '\u22C4', Diamond: '\u22C4',
  diamondsuit: '\u2666', diams: '\u2666', die: '\u00A8', DifferentialD: '\u2146',
  digamma: '\u03DD', disin: '\u22F2', div: '\u00F7', divide: '\u00F7',
  divideontimes: '\u22C7', divonx: '\u22C7', DJcy: '\u0402', djcy: '\u0452',
  dlcorn: '\u231E', dlcrop: '\u230D', dollar: '$', dopf: '\u{1D555}',
  Dopf: '\u{1D53B}', Dot: '\u00A8', dot: '\u02D9', DotDot: '\u20DC',
  doteq: '\u2250', doteqdot: '\u2251', DotEqual: '\u2250', dotminus: '\u2238',
  dotplus: '\u2214', dotsquare: '\u22A1', doublebarwedge: '\u2306', DoubleContourIntegral: '\u222F',
  DoubleDot: '\u00A8', DoubleDownArrow: '\u21D3', DoubleLeftArrow: '\u21D0',
  DoubleLeftRightArrow: '\u21D4', DoubleLeftTee: '\u2AE4', DoubleLongLeftArrow: '\u27F8',
  DoubleLongLeftRightArrow: '\u27FA', DoubleLongRightArrow: '\u27F9', DoubleRightArrow: '\u21D2',
  DoubleRightTee: '\u22A8', DoubleUpArrow: '\u21D1', DoubleUpDownArrow: '\u21D5',
  DoubleVerticalBar: '\u2225', downarrow: '\u2193', DownArrow: '\u2193',
  Downarrow: '\u21D3', downdownarrows: '\u21CA', downharpoonleft: '\u21C3',
  downharpoonright: '\u21C2', DownLeftRightVector: '\u2950', DownLeftTeeVector: '\u295E',
  DownLeftVector: '\u21BD', DownLeftVectorBar: '\u2956', DownRightTeeVector: '\u295F',
  DownRightVector: '\u21C1', DownRightVectorBar: '\u2957', DownTee: '\u22A4',
  DownTeeArrow: '\u21A7', drbkarow: '\u2910', drcorn: '\u231F', drcrop: '\u230C',
  Dscr: '\u{1D49F}', dscr: '\u{1D4B9}', DScy: '\u0405', dscy: '\u0455',
  dsol: '\u29F6', Dstrok: '\u0110', dstrok: '\u0111', dtdot: '\u22F1',
  dtri: '\u25BF', dtrif: '\u25BE', duarr: '\u21D5', duhar: '\u296F',
  dwangle: '\u29A6', DZcy: '\u040F', dzcy: '\u045F', dzigrarr: '\u27FF',
  Eacute: '\u00C9', eacute: '\u00E9', easter: '\u2A6E', Ecaron: '\u011A',
  ecaron: '\u011B', Ecirc: '\u00CA', ecirc: '\u00EA', ecir: '\u2256',
  ecolon: '\u2255', Ecy: '\u042D', ecy: '\u044D', eDDot: '\u2A77',
  Edot: '\u0116', edot: '\u0117', eDot: '\u2251', ee: '\u2147',
  efDot: '\u2252', Efr: '\u{1D508}', efr: '\u{1D522}', eg: '\u2A9A',
  Egrave: '\u00C8', egrave: '\u00E8', egs: '\u2A96', egsdot: '\u2A98',
  el: '\u2A99', Element: '\u2208', elinters: '\u23E7', ell: '\u2113',
  els: '\u2A95', elsdot: '\u2A97', Emacr: '\u0112', emacr: '\u0113',
  empty: '\u2205', emptyset: '\u2205', EmptySmallSquare: '\u25FB',
  emptyv: '\u2205', EmptyVerySmallSquare: '\u25AA', emsp: '\u2003',
  emsp13: '\u2004', emsp14: '\u2005', ENG: '\u014A', eng: '\u014B',
  ensp: '\u2002', Eogon: '\u0118', eogon: '\u0119', eopf: '\u{1D556}',
  Eopf: '\u{1D53C}', epar: '\u22D5', eparsl: '\u29E3', eplus: '\u2A71',
  epsi: '\u03B5', Epsilon: '\u0395', epsilon: '\u03B5', epsiv: '\u03F5',
  eqcirc: '\u2256', eqcolon: '\u2255', eqsim: '\u2242', eqslantgtr: '\u2A96',
  eqslantless: '\u2A95', Equal: '\u2A75', equals: '=', EqualTilde: '\u2242',
  equest: '\u225F', Equiv: '\u2261', equiv: '\u2261', equivDD: '\u2A78',
  eqvparsl: '\u29E5', erarr: '\u2971', erDot: '\u2253', escr: '\u212F',
  Escr: '\u2130', esdot: '\u2250', Esim: '\u2A73', esim: '\u2242',
  Eta: '\u0397', eta: '\u03B7', ETH: '\u00D0', eth: '\u00F0',
  Euml: '\u00CB', euml: '\u00EB', euro: '\u20AC', excl: '!',
  exist: '\u2203', Exists: '\u2203', expectation: '\u2130', exponentiale: '\u2147',
  ExponentialE: '\u2147', fallingdotseq: '\u2252', Fcy: '\u0424', fcy: '\u0444',
  female: '\u2640', ffilig: '\uFB03', fflig: '\uFB00', ffllig: '\uFB04',
  Ffr: '\u{1D509}', ffr: '\u{1D523}', filig: '\uFB01', FilledSmallSquare: '\u25FC',
  FilledVerySmallSquare: '\u25AA', fjlig: 'fj', flat: '\u266D', fllig: '\uFB02',
  fltns: '\u25B1', fnof: '\u0192', fopf: '\u{1D557}', Fopf: '\u{1D53D}',
  forall: '\u2200', ForAll: '\u2200', fork: '\u22D4', forkv: '\u2AD9',
  Fouriertrf: '\u2131', fpartint: '\u2A0D', frac12: '\u00BD', frac13: '\u2153',
  frac14: '\u00BC', frac15: '\u2155', frac16: '\u2159', frac18: '\u215B',
  frac23: '\u2154', frac25: '\u2156', frac34: '\u00BE', frac35: '\u2157',
  frac38: '\u215C', frac45: '\u2158', frac56: '\u215A', frac58: '\u215D',
  frac78: '\u215E', frasl: '\u2044', frown: '\u2322', fscr: '\u{1D4BB}',
  Fscr: '\u2131', gacute: '\u01F5', Gamma: '\u0393', gamma: '\u03B3',
  Gammad: '\u03DC', gammad: '\u03DD', gap: '\u2A86', Gbreve: '\u011E',
  gbreve: '\u011F', Gcedil: '\u0122', Gcirc: '\u011C', gcirc: '\u011D',
  Gcy: '\u0413', gcy: '\u0433', Gdot: '\u0120', gdot: '\u0121',
  ge: '\u2265', gE: '\u2267', gEl: '\u2A8C', gel: '\u22DB',
  geq: '\u2265', geqq: '\u2267', geqslant: '\u2A7E', ges: '\u2A7E',
  gescc: '\u2AA9', gesdot: '\u2A80', gesdoto: '\u2A82', gesdotol: '\u2A84',
  gesl: '\u22DB\uFE00', gesles: '\u2A94', Gfr: '\u{1D50A}', gfr: '\u{1D524}',
  gg: '\u226B', Gg: '\u22D9', ggg: '\u22D9', gimel: '\u2137',
  GJcy: '\u0403', gjcy: '\u0453', gla: '\u2AA5', gl: '\u2277',
  glE: '\u2A92', glj: '\u2AA4', gnap: '\u2A8A', gnapprox: '\u2A8A',
  gne: '\u2A88', gnE: '\u2269', gneq: '\u2A88', gneqq: '\u2269',
  gnsim: '\u22E7', gopf: '\u{1D558}', Gopf: '\u{1D53E}', grave: '`',
  GreaterEqual: '\u2265', GreaterEqualLess: '\u22DB', GreaterFullEqual: '\u2267',
  GreaterGreater: '\u2AA2', GreaterLess: '\u2277', GreaterSlantEqual: '\u2A7E',
  GreaterTilde: '\u2273', Gscr: '\u{1D4A2}', gscr: '\u{1D4BD}', gsim: '\u2273',
  gsime: '\u2A8E', gsiml: '\u2A90', gt: '>', GT: '>', Gt: '\u226B',
  gtcc: '\u2AA7', gtcir: '\u2A7A', gtdot: '\u22D7', gtlPar: '\u2995',
  gtquest: '\u2A7C', gtrapprox: '\u2A86', gtrarr: '\u2978', gtrdot: '\u22D7',
  gtreqless: '\u22DB', gtreqqless: '\u2A8C', gtrless: '\u2277', gtrsim: '\u2273',
  gvertneqq: '\u2269\uFE00', gvnE: '\u2269\uFE00', Hacek: '\u02C7', hairsp: '\u200A',
  half: '\u00BD', hamilt: '\u210B', HARDcy: '\u042A', hardcy: '\u044A',
  harrcir: '\u2948', harr: '\u2194', hArr: '\u21D4', harrw: '\u21AD',
  Hat: '^', hbar: '\u210F', Hcirc: '\u0124', hcirc: '\u0125',
  hearts: '\u2665', heartsuit: '\u2665', hellip: '\u2026', hercon: '\u22B9',
  hfr: '\u{1D525}', Hfr: '\u210C', HilbertSpace: '\u210B', hksearow: '\u2925',
  hkswarow: '\u2926', hoarr: '\u21FF', homtht: '\u223B', hookleftarrow: '\u21A9',
  hookrightarrow: '\u21AA', hopf: '\u{1D559}', Hopf: '\u210D', horbar: '\u2015',
  HorizontalLine: '\u2500', hscr: '\u{1D4BD}', Hscr: '\u210B', hslash: '\u210F',
  Hstrok: '\u0126', hstrok: '\u0127', HumpDownHump: '\u224E', HumpEqual: '\u224F',
  hybull: '\u2043', hyphen: '\u2010', Iacute: '\u00CD', iacute: '\u00ED',
  ic: '\u2063', Icirc: '\u00CE', icirc: '\u00EE', Icy: '\u0418',
  icy: '\u0438', Idot: '\u0130', IEcy: '\u0415', iecy: '\u0435',
  iexcl: '\u00A1', iff: '\u21D4', ifr: '\u{1D526}', Ifr: '\u2111',
  Igrave: '\u00CC', igrave: '\u00EC', ii: '\u2148', iiiint: '\u2A0C',
  iiint: '\u222D', iinfin: '\u29DC', iiota: '\u2129', IJlig: '\u0132',
  ijlig: '\u0133', Im: '\u2111', Imacr: '\u012A', imacr: '\u012B',
  image: '\u2111', ImaginaryI: '\u2148', imagline: '\u2110', imagpart: '\u2111',
  imath: '\u0131', Implies: '\u21D2', in: '\u2208', incare: '\u2105',
  infin: '\u221E', infintie: '\u29DD', inodot: '\u0131', intcal: '\u22BA',
  int: '\u222B', Int: '\u222C', integers: '\u2124', Integral: '\u222B',
  intercal: '\u22BA', Intersection: '\u22C2', intlarhk: '\u2A17', intprod: '\u2A3C',
  InvisibleComma: '\u2063', InvisibleTimes: '\u2062', IOcy: '\u0401', iocy: '\u0451',
  Iogon: '\u012E', iogon: '\u012F', Iopf: '\u{1D540}', iopf: '\u{1D55A}',
  Iota: '\u0399', iota: '\u03B9', iprod: '\u2A3C', iquest: '\u00BF',
  iscr: '\u{1D4BE}', Iscr: '\u2110', isin: '\u2208', isindot: '\u22F5',
  isinE: '\u22F9', isins: '\u22F4', isinsv: '\u22F3', isinv: '\u2208',
  it: '\u2062', Itilde: '\u0128', itilde: '\u0129', Iukcy: '\u0406',
  iukcy: '\u0456', Iuml: '\u00CF', iuml: '\u00EF', Jcirc: '\u0134',
  jcirc: '\u0135', Jcy: '\u0419', jcy: '\u0439', Jfr: '\u{1D50D}',
  jfr: '\u{1D527}', jmath: '\u0237', Jopf: '\u{1D541}', jopf: '\u{1D55B}',
  Jscr: '\u{1D4A5}', jscr: '\u{1D4BF}', Jsercy: '\u0408', jsercy: '\u0458',
  Jukcy: '\u0404', jukcy: '\u0454', Kappa: '\u039A', kappa: '\u03BA',
  kappav: '\u03F0', Kcedil: '\u0136', kcedil: '\u0137', Kcy: '\u041A',
  kcy: '\u043A', Kfr: '\u{1D50E}', kfr: '\u{1D528}', kgreen: '\u0138',
  KHcy: '\u0425', khcy: '\u0445', KJcy: '\u040C', kjcy: '\u045C',
  Kopf: '\u{1D542}', kopf: '\u{1D55C}', Kscr: '\u{1D4A6}', kscr: '\u{1D4C0}',
  lAarr: '\u21DA', Lacute: '\u0139', lacute: '\u013A', laemptyv: '\u29B4',
  lagran: '\u2112', Lambda: '\u039B', lambda: '\u03BB', lang: '\u27E8',
  Lang: '\u27EA', langd: '\u2991', langle: '\u27E8', lap: '\u2A85',
  Laplacetrf: '\u2112', laquo: '\u00AB', larr: '\u2190', Larr: '\u219E',
  lArr: '\u21D0', larrb: '\u21E4', larrbfs: '\u291F', larrfs: '\u291D',
  larrhk: '\u21A9', larrlp: '\u21AB', larrpl: '\u2939', larrsim: '\u2973',
  larrtl: '\u21A2', latail: '\u291B', lAtail: '\u291C', lat: '\u2AAB',
  late: '\u2AAD', lates: '\u2AAD\uFE00', lbarr: '\u290C', lBarr: '\u290E',
  lbbrk: '\u2772', lbrace: '{', lbrack: '[', lbrke: '\u298B',
  lbrksld: '\u298F', lbrkslu: '\u298D', Lcaron: '\u013D', lcaron: '\u013E',
  Lcedil: '\u013B', lcedil: '\u013C', lceil: '\u2308', lcub: '{',
  Lcy: '\u041B', lcy: '\u043B', ldca: '\u2936', ldquo: '\u201C',
  ldquor: '\u201C', ldrdhar: '\u2967', ldrdsh: '\u21B2', ldsh: '\u21B2',
  le: '\u2264', lE: '\u2266', LeftAngleBracket: '\u27E8', LeftArrow: '\u2190',
  Leftarrow: '\u21D0', LeftArrowBar: '\u21E4', LeftArrowRightArrow: '\u21C6',
  leftarrow: '\u2190', LeftCeiling: '\u2308', LeftDoubleBracket: '\u27E6',
  LeftDownTeeVector: '\u2961', LeftDownVector: '\u21C3', LeftDownVectorBar: '\u2959',
  leftfloor: '\u230A', LeftFloor: '\u230A', LeftRightArrow: '\u2194',
  Leftrightarrow: '\u21D4', leftrightarrow: '\u2194', LeftRightVector: '\u294E',
  LeftTee: '\u22A3', LeftTeeArrow: '\u21A4', LeftTeeVector: '\u295A',
  leftthreetimes: '\u22CB', LeftTriangle: '\u22B2', LeftTriangleBar: '\u29CF',
  LeftTriangleEqual: '\u22B4', LeftUpDownVector: '\u2951', LeftUpTeeVector: '\u2960',
  LeftUpVector: '\u21BF', LeftUpVectorBar: '\u2958', LeftVector: '\u21BC',
  LeftVectorBar: '\u2952', lEg: '\u2A8B', leg: '\u22DA', leq: '\u2264',
  leqq: '\u2266', leqslant: '\u2A7D', les: '\u2A7D', lescc: '\u2AAA',
  lesdot: '\u2A7F', lesdoto: '\u2A81', lesdotor: '\u2A83', lesg: '\u22DA\uFE00',
  lesges: '\u2A93', lessapprox: '\u2A85', lessdot: '\u22D6', lesseqgtr: '\u22DA',
  lesseqqgtr: '\u2A8B', LessEqualGreater: '\u22DA', LessFullEqual: '\u2266',
  LessGreater: '\u2276', lessgtr: '\u2276', LessLess: '\u2AA1', lesssim: '\u2272',
  LessSlantEqual: '\u2A7D', LessTilde: '\u2272', lfisht: '\u297C', lfloor: '\u230A',
  Lfr: '\u{1D50F}', lfr: '\u{1D529}', lg: '\u2276', lgE: '\u2A91',
  lHar: '\u2962', lhard: '\u21BD', lharu: '\u21BC', lharul: '\u296A',
  lhblk: '\u2584', LJcy: '\u0409', ljcy: '\u0459', llarr: '\u21C7',
  ll: '\u226A', Ll: '\u22D8', llcorner: '\u231E', Lleftarrow: '\u21DA',
  llhard: '\u296B', lltri: '\u25FA', Lmidot: '\u013F', lmidot: '\u0140',
  lmoust: '\u23B0', lmoustache: '\u23B0', lnap: '\u2A89', lnapprox: '\u2A89',
  lne: '\u2A87', lnE: '\u2268', lneq: '\u2A87', lneqq: '\u2268',
  lnsim: '\u22E6', loang: '\u27EC', loarr: '\u21FD', lobrk: '\u27E6',
  longleftarrow: '\u27F5', LongLeftArrow: '\u27F5', Longleftarrow: '\u27F8',
  longleftrightarrow: '\u27F7', LongLeftRightArrow: '\u27FA', Longleftrightarrow: '\u27FA',
  longmapsto: '\u27FC', longrightarrow: '\u27F6', LongRightArrow: '\u27F9',
  Longrightarrow: '\u27F9', looparrowleft: '\u21AB', looparrowright: '\u21AC',
  lopar: '\u2985', Lopf: '\u{1D543}', lopf: '\u{1D55D}', loplus: '\u2A2D',
  lotimes: '\u2A34', lowast: '\u2217', lowbar: '_', LowerLeftArrow: '\u2199',
  LowerRightArrow: '\u2198', loz: '\u25CA', lozenge: '\u25CA', lozf: '\u29EB',
  lpar: '(', lparlt: '\u2993', lrarr: '\u21C6', lrcorner: '\u231F',
  lrhar: '\u21CB', lrhard: '\u296D', lrm: '\u200E', lrtri: '\u22BF',
  lsaquo: '\u2039', lscr: '\u{1D4C1}', Lscr: '\u2112', lsh: '\u21B0',
  Lsh: '\u21B0', lsim: '\u2272', lsime: '\u2A8D', lsimg: '\u2A8F',
  lsqb: '[', lsquo: '\u2018', lsquor: '\u2018', Lstrok: '\u0141',
  lstrok: '\u0142', lt: '<', LT: '<', Lt: '\u226A', ltcc: '\u2AA6',
  ltcir: '\u2A79', ltdot: '\u22D6', lthree: '\u22CB', ltimes: '\u22C9',
  ltlarr: '\u2976', ltquest: '\u2A7B', ltri: '\u25C3', ltrie: '\u22B4',
  ltrif: '\u25C2', ltrPar: '\u2996', lurdshar: '\u294A', luruhar: '\u2966',
  lvertneqq: '\u2268\uFE00', lvnE: '\u2268\uFE00', macr: '\u00AF', male: '\u2642',
  malt: '\u2720', maltese: '\u2720', Map: '\u2905', map: '\u21A6',
  mapsto: '\u21A6', mapstodown: '\u21A7', mapstoleft: '\u21A4', mapstoup: '\u21A5',
  marker: '\u25AE', mcomma: '\u2A29', Mcy: '\u041C', mcy: '\u043C',
  mdash: '\u2014', mDDot: '\u223A', measuredangle: '\u2221', MediumSpace: '\u205F',
  Mellintrf: '\u2133', Mfr: '\u{1D510}', mfr: '\u{1D52A}', mho: '\u2127',
  micro: '\u00B5', midast: '*', midcir: '\u2AF0', mid: '\u2223',
  middot: '\u00B7', minus: '\u2212', minusb: '\u229F', minusd: '\u2238',
  minusdu: '\u2A2A', MinusPlus: '\u2213', mlcp: '\u2ADB', mldr: '\u2026',
  mnplus: '\u2213', models: '\u22A7', Mopf: '\u{1D544}', mopf: '\u{1D55E}',
  mscr: '\u{1D4C2}', Mscr: '\u2133', mstpos: '\u223E', Mu: '\u039C',
  mu: '\u03BC', multimap: '\u22B8', mumap: '\u22B8', nabla: '\u2207',
  Nacute: '\u0143', nacute: '\u0144', nang: '\u2220\u20D2', nap: '\u2249',
  napE: '\u2A70\u0338', napid: '\u224B\u0338', napos: '\u0149', napprox: '\u2249',
  natur: '\u266E', natural: '\u266E', naturals: '\u2115', nbsp: '\u00A0',
  nbump: '\u224E\u0338', nbumpe: '\u224F\u0338', ncap: '\u2A43', Ncaron: '\u0147',
  ncaron: '\u0148', Ncedil: '\u0145', ncedil: '\u0146', ncong: '\u2247',
  ncongdot: '\u2A6D\u0338', ncup: '\u2A42', Ncy: '\u041D', ncy: '\u043D',
  ndash: '\u2013', ne: '\u2260', nearhk: '\u2924', nearr: '\u2197',
  neArr: '\u21D7', nearrow: '\u2197', nequiv: '\u2262', nesear: '\u2928',
  nesim: '\u2242\u0338', NestedGreaterGreater: '\u2AA2', NestedLessLess: '\u2AA1',
  NewLine: '\n', nexist: '\u2204', nexists: '\u2204', Nfr: '\u{1D511}',
  nfr: '\u{1D52B}', ngE: '\u2267\u0338', nge: '\u2271', ngeq: '\u2271',
  ngeqq: '\u2267\u0338', ngeqslant: '\u2A7E\u0338', nges: '\u2A7E\u0338',
  nGg: '\u22D9\u0338', ngsim: '\u2275', nGt: '\u226B\u20D2', ngt: '\u226F',
  ngtr: '\u226F', nGtv: '\u226B\u0338', nharr: '\u21AE', nhArr: '\u21CE',
  nhpar: '\u2AF2', ni: '\u220B', nis: '\u22FC', nisd: '\u22FA',
  niv: '\u220B', NJcy: '\u040A', njcy: '\u045A', nlarr: '\u219A',
  nlArr: '\u21CD', nldr: '\u2025', nlE: '\u2266\u0338', nle: '\u2270',
  nleftarrow: '\u219A', nLeftarrow: '\u21CD', nleftrightarrow: '\u21AE',
  nLeftrightarrow: '\u21CE', nleq: '\u2270', nleqq: '\u2266\u0338',
  nleqslant: '\u2A7D\u0338', nles: '\u2A7D\u0338', nless: '\u226E', nLl: '\u22D8\u0338',
  nlsim: '\u2274', nLt: '\u226A\u20D2', nlt: '\u226E', nltri: '\u22EA',
  nltrie: '\u22EC', nLtv: '\u226A\u0338', nmid: '\u2224', NoBreak: '\u2060',
  NonBreakingSpace: '\u00A0', nopf: '\u{1D55F}', Nopf: '\u2115', Not: '\u2AEC',
  not: '\u00AC', NotCongruent: '\u2262', NotCupCap: '\u226D', NotDoubleVerticalBar: '\u2226',
  NotElement: '\u2209', NotEqual: '\u2260', NotEqualTilde: '\u2242\u0338',
  NotExists: '\u2204', NotGreater: '\u226F', NotGreaterEqual: '\u2271',
  NotGreaterFullEqual: '\u2267\u0338', NotGreaterGreater: '\u226B\u0338',
  NotGreaterLess: '\u2279', NotGreaterSlantEqual: '\u2A7E\u0338', NotGreaterTilde: '\u2275',
  NotHumpDownHump: '\u224E\u0338', NotHumpEqual: '\u224F\u0338', notin: '\u2209',
  notindot: '\u22F5\u0338', notinE: '\u22F9\u0338', notinva: '\u2209',
  notinvb: '\u22F7', notinvc: '\u22F6', NotLeftTriangle: '\u22EA',
  NotLeftTriangleBar: '\u29CF\u0338', NotLeftTriangleEqual: '\u22EC',
  NotLess: '\u226E', NotLessEqual: '\u2270', NotLessGreater: '\u2278',
  NotLessLess: '\u226A\u0338', NotLessSlantEqual: '\u2A7D\u0338', NotLessTilde: '\u2274',
  NotNestedGreaterGreater: '\u2AA2\u0338', NotNestedLessLess: '\u2AA1\u0338',
  notni: '\u220C', notniva: '\u220C', notnivb: '\u22FE', notnivc: '\u22FD',
  NotPrecedes: '\u2280', NotPrecedesEqual: '\u2AAF\u0338', NotPrecedesSlantEqual: '\u22E0',
  NotReverseElement: '\u220C', NotRightTriangle: '\u22EB', NotRightTriangleBar: '\u29D0\u0338',
  NotRightTriangleEqual: '\u22ED', NotSquareSubset: '\u228F\u0338',
  NotSquareSubsetEqual: '\u22E2', NotSquareSuperset: '\u2290\u0338',
  NotSquareSupersetEqual: '\u22E3', NotSubset: '\u2282\u20D2', NotSubsetEqual: '\u2288',
  NotSucceeds: '\u2281', NotSucceedsEqual: '\u2AB0\u0338', NotSucceedsSlantEqual: '\u22E1',
  NotSucceedsTilde: '\u227F\u0338', NotSuperset: '\u2283\u20D2', NotSupersetEqual: '\u2289',
  NotTilde: '\u2241', NotTildeEqual: '\u2244', NotTildeFullEqual: '\u2247',
  NotTildeTilde: '\u2249', NotVerticalBar: '\u2224', npar: '\u2226',
  nparallel: '\u2226', nparsl: '\u2AFD\u20E5', npart: '\u2202\u0338',
  npluse: '\u2A72', nplus: '\u2212', nprec: '\u2280', npreceq: '\u2AAF\u0338',
  nrarr: '\u219B', nrArr: '\u21CF', nrarrc: '\u2933\u0338', nrarrw: '\u219D\u0338',
  nrightarrow: '\u219B', nRightarrow: '\u21CF', nrtri: '\u22EB', nrtrie: '\u22ED',
  nsc: '\u2281', nsccue: '\u22E1', nsce: '\u2AB0\u0338', Nscr: '\u{1D4A9}',
  nscr: '\u{1D4C3}', nshortmid: '\u2224', nshortparallel: '\u2226',
  nsim: '\u2241', sime: '\u2243', simeq: '\u2243', nsimE: '\u2A44\u0338',
  nsmid: '\u2224', nspar: '\u2226', nsqsube: '\u22E2', nsqsupe: '\u22E3',
  nsub: '\u2284', nsube: '\u2288', nsubE: '\u2AC5\u0338', nsup: '\u2285',
  nsupe: '\u2289', nsupE: '\u2AC6\u0338', ntilde: '\u00F1', Ntilde: '\u00D1',
  nu: '\u03BD', Nu: '\u039D', num: '#', numero: '\u2116',
  numsp: '\u2007', nvap: '\u224D\u20D2', nvdash: '\u22AC', nvDash: '\u22AD',
  nVdash: '\u22AE', nVDash: '\u22AF', nvge: '\u2265\u20D2', nvgt: '>\u20D2',
  nvHarr: '\u2904', nvinfin: '\u29DE', nvlArr: '\u2902', nvle: '\u2264\u20D2',
  nvlt: '<\u20D2', nvltrie: '\u22B4\u20D2', nvrArr: '\u2903', nvrtrie: '\u22B5\u20D2',
  nvsim: '\u223C\u20D2', nwarhk: '\u2923', nwarr: '\u2196', nwArr: '\u21D6',
  nwarrow: '\u2196', nwnear: '\u2927', Oacute: '\u00D3', oacute: '\u00F3',
  oast: '\u229B', Ocirc: '\u00D4', ocirc: '\u00F4', Ocy: '\u041E',
  ocy: '\u043E', odash: '\u229D', Odblac: '\u0150', odblac: '\u0151',
  odiv: '\u2A38', odot: '\u2299', odsold: '\u29BC', OElig: '\u0152',
  oelig: '\u0153', ofcir: '\u29BF', Ofr: '\u{1D512}', ofr: '\u{1D52C}',
  ogon: '\u02DB', Ograve: '\u00D2', ograve: '\u00F2', ogt: '\u29C1',
  ohbar: '\u29B5', ohm: '\u03A9', oint: '\u222E', olarr: '\u21BA',
  olcir: '\u29BE', olcross: '\u29BB', oline: '\u203E', olt: '\u29C0',
  Omacr: '\u014C', omacr: '\u014D', Omega: '\u03A9', omega: '\u03C9',
  Omicron: '\u039F', omicron: '\u03BF', omid: '\u29B6', ominus: '\u2296',
  Oopf: '\u{1D546}', oopf: '\u{1D560}', opar: '\u29B7', OpenCurlyDoubleQuote: '\u201C',
  OpenCurlyQuote: '\u2018', operp: '\u29B9', oplus: '\u2295', or: '\u2228',
  Or: '\u2A54', orarr: '\u21BB', ord: '\u2A5D', order: '\u2134',
  orderof: '\u2134', ordf: '\u00AA', ordm: '\u00BA', origof: '\u22B6',
  oror: '\u2A56', orslope: '\u2A57', orv: '\u2A5B', oscr: '\u2134',
  Oscr: '\u{1D4AA}', Oslash: '\u00D8', oslash: '\u00F8', osol: '\u2298',
  Otilde: '\u00D5', otilde: '\u00F5', otimes: '\u2297', Otimes: '\u2A37',
  otimesas: '\u2A36', Ouml: '\u00D6', ouml: '\u00F6', ovbar: '\u233D',
  OverBar: '\u203E', OverBrace: '\u23DE', para: '\u00B6', parallel: '\u2225',
  par: '\u2225', parsim: '\u2AF3', parsl: '\u2AFD', part: '\u2202',
  PartialD: '\u2202', Pcy: '\u041F', pcy: '\u043F', percnt: '%',
  period: '.', permil: '\u2030', perp: '\u22A5', pertenk: '\u2031',
  Pfr: '\u{1D513}', pfr: '\u{1D52D}', Phi: '\u03A6', phi: '\u03C6',
  phiv: '\u03D5', phmmat: '\u2133', phone: '\u260E', Pi: '\u03A0',
  pi: '\u03C0', pitchfork: '\u22D4', piv: '\u03D6', planck: '\u210F',
  planckh: '\u210E', plankv: '\u210F', plus: '+', plusacir: '\u2A23',
  plusb: '\u229E', pluscir: '\u2A22', plusdo: '\u2214', plusdu: '\u2A25',
  pluse: '\u2A72', PlusMinus: '\u00B1', plusmn: '\u00B1', plussim: '\u2A26',
  plustwo: '\u2A27', pm: '\u00B1', Poincareplane: '\u210C', pointint: '\u2A15',
  popf: '\u{1D561}', Popf: '\u2119', pound: '\u00A3', pr: '\u227A',
  Pr: '\u2ABB', prap: '\u2AB7', prcue: '\u227C', prec: '\u227A',
  precapprox: '\u2AB7', preccurlyeq: '\u227C', Precedes: '\u227A',
  PrecedesEqual: '\u2AAF', PrecedesSlantEqual: '\u227C', PrecedesTilde: '\u227E',
  preceq: '\u2AAF', precnapprox: '\u2AB9', precneqq: '\u2AB5', precnsim: '\u22E8',
  pre: '\u2AAF', prE: '\u2AB3', precsim: '\u227E', prime: '\u2032',
  Prime: '\u2033', primes: '\u2119', prnap: '\u2AB9', prnE: '\u2AB5',
  prnsim: '\u22E8', prod: '\u220F', Product: '\u220F', profalar: '\u232E',
  profline: '\u2312', profsurf: '\u2313', prop: '\u221D', Proportion: '\u2237',
  Proportional: '\u221D', propto: '\u221D', prsim: '\u227E', prurel: '\u22B0',
  Pscr: '\u{1D4AB}', pscr: '\u{1D4C5}', Psi: '\u03A8', psi: '\u03C8',
  puncsp: '\u2008', Qfr: '\u{1D514}', qfr: '\u{1D52E}', qint: '\u2A0C',
  qopf: '\u{1D562}', Qopf: '\u211A', Qscr: '\u{1D4AC}', qscr: '\u{1D4C6}',
  quaternions: '\u210D', quatint: '\u2A16', quest: '?', questeq: '\u225F',
  quot: '"', QUOT: '"', rAarr: '\u21DB', race: '\u223D\u0331',
  Racute: '\u0154', racute: '\u0155', radic: '\u221A', raemptyv: '\u29B3',
  rang: '\u27E9', Rang: '\u27EB', rangd: '\u2992', range: '\u29A5',
  rangle: '\u27E9', raquo: '\u00BB', rarrap: '\u2975', rarr: '\u2192',
  Rarr: '\u21A0', rArr: '\u21D2', rarrb: '\u21E5', rarrbfs: '\u2920',
  rarrc: '\u2933', rarrfs: '\u291E', rarrhk: '\u21AA', rarrlp: '\u21AC',
  rarrpl: '\u2945', rarrsim: '\u2974', rarrtl: '\u21A3', ratail: '\u291A',
  rAtail: '\u291D', ratio: '\u2236', rationals: '\u211A', rbarr: '\u290D',
  rBarr: '\u290F', RBarr: '\u2910', rbbrk: '\u2773', rbrace: '}',
  rbrack: ']', rbrke: '\u298C', rbrksld: '\u298E', rbrkslu: '\u2990',
  Rcaron: '\u0158', rcaron: '\u0159', Rcedil: '\u0156', rcedil: '\u0157',
  rceil: '\u2309', rcub: '}', Rcy: '\u0420', rcy: '\u0440',
  rdca: '\u2937', rdldhar: '\u2969', rdquo: '\u201D', rdquor: '\u201D',
  rdsh: '\u21B3', real: '\u211C', realine: '\u211B', realpart: '\u211C',
  reals: '\u211D', Rect: '\u25AD', rect: '\u25AD', reg: '\u00AE',
  REG: '\u00AE', ReverseElement: '\u220B', ReverseEquilibrium: '\u21CB',
  ReverseUpEquilibrium: '\u296F', rfish: '\u297D', rfloor: '\u230B',
  Rfr: '\u211C', rfr: '\u{1D52F}', rHar: '\u2964', rhard: '\u21C1',
  rharu: '\u21C0', rharul: '\u296C', Rho: '\u03A1', rho: '\u03C1',
  rhov: '\u03F1', RightAngleBracket: '\u27E9', RightArrow: '\u2192',
  Rightarrow: '\u21D2', RightArrowBar: '\u21E5', RightArrowLeftArrow: '\u21C4',
  rightarrow: '\u2192', RightCeiling: '\u2309', RightDoubleBracket: '\u27E7',
  RightDownTeeVector: '\u295D', RightDownVector: '\u21C2', RightDownVectorBar: '\u2955',
  RightFloor: '\u230B', rightfloor: '\u230B', RightRightArrow: '\u21C9',
  RightTee: '\u22A2', RightTeeArrow: '\u21A6', RightTeeVector: '\u295B',
  rightthreetimes: '\u22CC', RightTriangle: '\u22B3', RightTriangleBar: '\u29D0',
  RightTriangleEqual: '\u22B5', RightUpDownVector: '\u294F', RightUpTeeVector: '\u295C',
  RightUpVector: '\u21BE', RightUpVectorBar: '\u2954', RightVector: '\u21C0',
  RightVectorBar: '\u2953', ring: '\u02DA', risingdotseq: '\u2253',
  rlarr: '\u21C4', rlhar: '\u21CC', rlm: '\u200F', rmoust: '\u23B1',
  rmoustache: '\u23B1', rnmid: '\u2AEE', roang: '\u27ED', roarr: '\u21FE',
  robrk: '\u27E7', ropar: '\u2986', Ropf: '\u211D', ropf: '\u{1D563}',
  roplus: '\u2A2E', rotimes: '\u2A35', RoundImplies: '\u2970', rpar: ')',
  rpargt: '\u2994', rppolint: '\u2A12', rrarr: '\u21C9', Rrightarrow: '\u21DB',
  rsaquo: '\u203A', rscr: '\u{1D4C7}', Rscr: '\u211B', rsh: '\u21B1',
  Rsh: '\u21B1', rsqb: ']', rsquo: '\u2019', rsquor: '\u2019',
  rthree: '\u22CC', rtimes: '\u22CA', rtri: '\u25B9', rtrie: '\u22B5',
  rtrif: '\u25B8', rtriltri: '\u29CE', RuleDelayed: '\u29F4', ruluhar: '\u2968',
  rx: '\u211E', Sacute: '\u015A', sacute: '\u015B', sbquo: '\u201A',
  sc: '\u227B', Sc: '\u2ABC', scap: '\u2AB8', Scaron: '\u0160',
  scaron: '\u0161', Scirc: '\u015C', scirc: '\u015D', scnE: '\u2AB6',
  scnap: '\u2ABA', scnsim: '\u22E9', scpolint: '\u2A13', scsim: '\u227F',
  Scy: '\u0421', scy: '\u0441', sdot: '\u22C5', sdotb: '\u22A1',
  sdote: '\u2A66', searhk: '\u2925', searr: '\u2198', seArr: '\u21D8',
  searrow: '\u2198', sect: '\u00A7', semi: ';', seswar: '\u2929',
  setminus: '\u2216', setmn: '\u2216', sext: '\u2736', Sfr: '\u{1D516}',
  sfr: '\u{1D530}', sfrown: '\u2322', sharp: '\u266F', SHCHcy: '\u0429',
  shchcy: '\u0449', SHcy: '\u0428', shcy: '\u0448', ShortDownArrow: '\u2193',
  ShortLeftArrow: '\u2190', shortmid: '\u2223', shortparallel: '\u2225',
  ShortRightArrow: '\u2192', ShortUpArrow: '\u2191', shy: '\u00AD',
  Sigma: '\u03A3', sigma: '\u03C3', sigmaf: '\u03C2', sigmav: '\u03C2',
  sim: '\u223C', simdot: '\u2A6A', simeq: '\u2243', simg: '\u2A9E',
  simgE: '\u2A9F', siml: '\u2A9D', simlE: '\u2A9E', simne: '\u2246',
  simplus: '\u2A24', simrarr: '\u2972', slarr: '\u2190', SmallCircle: '\u2218',
  smallsetminus: '\u2216', smashp: '\u2A33', smeparsl: '\u29E4', smid: '\u2223',
  smile: '\u2323', smt: '\u2AAA', smte: '\u2AAC', smtes: '\u2AAC\uFE00',
  SOFTcy: '\u042C', softcy: '\u044C', solbar: '\u233F', solb: '\u29C4',
  sol: '/', Sopf: '\u{1D54A}', sopf: '\u{1D564}', spades: '\u2660',
  spadesuit: '\u2660', spar: '\u2225', sqcap: '\u2293', sqcaps: '\u2293\uFE00',
  sqcup: '\u2294', sqcups: '\u2294\uFE00', Sqrt: '\u221A', sqsub: '\u228F',
  sqsube: '\u2291', sqsubset: '\u228F', sqsubseteq: '\u2291', sqsup: '\u2290',
  sqsupe: '\u2292', sqsupset: '\u2290', sqsupseteq: '\u2292', square: '\u25A1',
  Square: '\u25A1', SquareIntersection: '\u2293', SquareSubset: '\u228F',
  SquareSubsetEqual: '\u2291', SquareSuperset: '\u2290', SquareSupersetEqual: '\u2292',
  SquareUnion: '\u2294', squarf: '\u25AA', squ: '\u25A1', squf: '\u25AA',
  srarr: '\u2192', Sscr: '\u{1D4AE}', sscr: '\u{1D4C8}', ssetmn: '\u2216',
  ssmile: '\u2323', sstarf: '\u22C6', Star: '\u22C6', star: '\u2606',
  starf: '\u2605', straightepsilon: '\u03F5', straightphi: '\u03D5',
  strns: '\u00AF', sub: '\u2282', Sub: '\u22D0', subdot: '\u2ABD',
  subE: '\u2AC5', sube: '\u2286', subedot: '\u2AC3', submult: '\u2AC1',
  subnE: '\u2ACB', subne: '\u228A', subplus: '\u2ABF', subrarr: '\u2979',
  subset: '\u2282', Subset: '\u22D0', subseteq: '\u2286', subseteqq: '\u2AC5',
  SubsetEqual: '\u2286', subsetneq: '\u228A', subsetneqq: '\u2AC8',
  subsim: '\u2AC7', subsub: '\u2AD5', subsup: '\u2AD3', succ: '\u227B',
  succapprox: '\u2AB8', succcurlyeq: '\u227D', Succeeds: '\u227B',
  SucceedsEqual: '\u2AB0', SucceedsSlantEqual: '\u227D', SucceedsTilde: '\u227F',
  succeq: '\u2AB0', succnapprox: '\u2ABA', succneqq: '\u2AB6', succnsim: '\u22E9',
  succsim: '\u227F', SuchThat: '\u220B', sum: '\u2211', Sum: '\u2211',
  sung: '\u266A', sup: '\u2283', Sup: '\u22D1', sup1: '\u00B9',
  sup2: '\u00B2', sup3: '\u00B3', supdot: '\u2ABE', supdsub: '\u2AD8',
  supE: '\u2AC6', supe: '\u2287', supedot: '\u2AC4', Superset: '\u2283',
  SupersetEqual: '\u2287', suphsol: '\u27C9', suphsub: '\u2AD7',
  suplarr: '\u297B', supmult: '\u2AC2', supnE: '\u2ACC', supne: '\u228B',
  supplus: '\u2AC0', supset: '\u2283', Supset: '\u22D1', supseteq: '\u2287',
  supseteqq: '\u2AC6', supsetneq: '\u228B', supsetneqq: '\u2AC9',
  supsim: '\u2AC8', supsub: '\u2AD4', supsup: '\u2AD6', swarhk: '\u2926',
  swarr: '\u2199', swArr: '\u21D9', swarrow: '\u2199', swnwar: '\u292A',
  szlig: '\u00DF', Tab: '\t', target: '\u2316', Tau: '\u03A4',
  tau: '\u03C4', tbrk: '\u23B4', Tcaron: '\u0164', tcaron: '\u0165',
  Tcedil: '\u0162', tcedil: '\u0163', Tcy: '\u0422', tcy: '\u0442',
  tdot: '\u20DB', telrec: '\u2315', Tfr: '\u{1D517}', tfr: '\u{1D531}',
  there4: '\u2234', therefore: '\u2234', Therefore: '\u2234', Theta: '\u0398',
  theta: '\u03B8', thetasym: '\u03D1', thetav: '\u03D1', thickapprox: '\u2248',
  thicksim: '\u223C', ThickSpace: '\u205F\u200A', Tilde: '\u223C',
  tilde: '\u02DC', TildeEqual: '\u2243', TildeFullEqual: '\u2245',
  TildeTilde: '\u2248', times: '\u00D7', timesb: '\u22A0', timesbar: '\u2A31',
  timesd: '\u2A30', tint: '\u222D', toea: '\u2928', top: '\u22A4',
  topbot: '\u2336', topcir: '\u2AF1', Topf: '\u{1D54B}', topf: '\u{1D565}',
  topfork: '\u2ADA', tosa: '\u2929', tprime: '\u2034', trade: '\u2122',
  TRADE: '\u2122', triangle: '\u25B5', triangledown: '\u25BF',
  triangleleft: '\u25C3', trianglelefteq: '\u22B4', triangleq: '\u225C',
  triangleright: '\u25B9', trianglerighteq: '\u22B5', tridot: '\u25EC',
  trie: '\u225C', triminus: '\u2A3A', TripleDot: '\u20DB', triplus: '\u2A39',
  trisb: '\u29CD', tritime: '\u2A3B', trpezium: '\u23E2', Tscr: '\u{1D4AF}',
  tscr: '\u{1D4C9}', TScy: '\u0426', tscy: '\u0446', TSHcy: '\u040B',
  tshcy: '\u044B', Tstrok: '\u0166', tstrok: '\u0167', twixt: '\u226C',
  twoheadleftarrow: '\u219E', twoheadrightarrow: '\u21A0', Uacute: '\u00DA',
  uacute: '\u00FA', uarr: '\u2191', Uarr: '\u219F', uArr: '\u21D1',
  Uarrocir: '\u2949', Ubrcy: '\u040E', ubrcy: '\u045E', Ubreve: '\u016C',
  ubreve: '\u016D', Ucirc: '\u00DB', ucirc: '\u00FB', Ucy: '\u0423',
  ucy: '\u0443', udarr: '\u21C5', Udblac: '\u0170', udblac: '\u0171',
  udhar: '\u296E', ufisht: '\u297E', Ufr: '\u{1D518}', ufr: '\u{1D532}',
  Ugrave: '\u00D9', ugrave: '\u00F9', uHar: '\u2963', uharl: '\u21BF',
  uharr: '\u21BE', uhblk: '\u2580', ulcorn: '\u231C', ulcorner: '\u231C',
  ulcrop: '\u230F', ultri: '\u25F8', Umacr: '\u016A', umacr: '\u016B',
  uml: '\u00A8', UnderBar: '_', UnderBrace: '\u23DF', UnderBracket: '\u23B5',
  UnderParenthesis: '\u23DD', Union: '\u22C3', UnionPlus: '\u228E',
  Uogon: '\u0172', uogon: '\u0173', Uopf: '\u{1D54C}', uopf: '\u{1D566}',
  UpArrow: '\u2191', Uparrow: '\u21D1', uparrow: '\u2191', UpArrowBar: '\u2912',
  UpArrowDownArrow: '\u21C5', updownarrow: '\u21C5', UpDownArrow: '\u21C5',
  Updownarrow: '\u21D5', UpEquilibrium: '\u296E', upharpoonleft: '\u21BF',
  upharpoonright: '\u21BE', uplus: '\u228E', UpperLeftArrow: '\u2196',
  UpperRightArrow: '\u2197', upsi: '\u03C5', Upsi: '\u03D2',
  upsih: '\u03D2', Upsilon: '\u03A5', upsilon: '\u03C5', UpTee: '\u22A5',
  UpTeeArrow: '\u21A5', upuparrows: '\u21C8', urcorn: '\u231D', urcorner: '\u231D',
  urcrop: '\u230E', Uring: '\u016E', uring: '\u016F', urtri: '\u25F9',
  Uscr: '\u{1D4B0}', uscr: '\u{1D4CA}', utdot: '\u22F0', Utilde: '\u0168',
  utilde: '\u0169', utri: '\u25B5', utrif: '\u25B4', uuarr: '\u21C8',
  Uuml: '\u00DC', uuml: '\u00FC', uwangle: '\u29A7', vangrt: '\u299C',
  varepsilon: '\u03F5', varkappa: '\u03F0', varnothing: '\u2205', varphi: '\u03D5',
  varpi: '\u03D6', varpropto: '\u221D', varr: '\u2195', vArr: '\u21D5',
  varrho: '\u03F1', varsigma: '\u03C2', varsubsetneq: '\u228A\uFE00',
  varsubsetneqq: '\u2AC8\uFE00', varsupsetneq: '\u228B\uFE00', varsupsetneqq: '\u2AC9\uFE00',
  vartheta: '\u03D1', vartriangleleft: '\u22B2', vartriangleright: '\u22B3',
  Vbar: '\u2AEB', vBar: '\u2AE8', vBarv: '\u2AE9', Vcy: '\u0412',
  vcy: '\u0432', vdash: '\u22A2', vDash: '\u22A8', Vdash: '\u22A9',
  VDash: '\u22AB', Vdashl: '\u2AE6', veebar: '\u22BB', vee: '\u2228',
  Vee: '\u22C1', veeeq: '\u225A', vellip: '\u22EE', verbar: '|',
  Vert: '\u2016', vert: '|', VerticalBar: '\u2223', VerticalLine: '|',
  VerticalSeparator: '\u2758', VerticalTilde: '\u2240', VeryThinSpace: '\u200A',
  Vfr: '\u{1D519}', vfr: '\u{1D533}', vltri: '\u22B2', vnsub: '\u2282\u20D2',
  vnsup: '\u2283\u20D2', Vopf: '\u{1D54D}', vopf: '\u{1D567}', vprop: '\u221D',
  vrtri: '\u22B3', Vscr: '\u{1D4B1}', vscr: '\u{1D4CB}', vsubnE: '\u2ACB\uFE00',
  vsubne: '\u228A\uFE00', vsupnE: '\u2ACC\uFE00', vsupne: '\u228B\uFE00',
  Vvdash: '\u22AA', vzigzag: '\u299A', Wcirc: '\u0174', wcirc: '\u0175',
  wedbar: '\u2A5F', wedge: '\u2227', Wedge: '\u22C0', wedgeq: '\u2259',
  weierp: '\u2118', Wfr: '\u{1D51A}', wfr: '\u{1D534}', Wopf: '\u{1D54E}',
  wopf: '\u{1D568}', wp: '\u2118', wr: '\u2240', wreath: '\u2240',
  Wscr: '\u{1D4B2}', wscr: '\u{1D4CC}', xcap: '\u22C2', xcirc: '\u25EF',
  xcup: '\u22C3', xdtri: '\u25BD', xharr: '\u27F7', xhArr: '\u27FA',
  Xi: '\u039E', xi: '\u03BE', xlarr: '\u27F5', xlArr: '\u27F8',
  xmap: '\u27FC', xnis: '\u22FB', xodot: '\u2A00', xopf: '\u{1D569}',
  Xopf: '\u{1D54F}', xoplus: '\u2A01', xotime: '\u2A02', xrarr: '\u27F6',
  xrArr: '\u27F9', Xscr: '\u{1D4B3}', xscr: '\u{1D4CD}', xsqcup: '\u2A06',
  xuplus: '\u2A04', xutri: '\u25B3', xvee: '\u22C1', xwedge: '\u22C0',
  Yacute: '\u00DD', yacute: '\u00FD', YAcy: '\u042F', yacy: '\u044F',
  Ycirc: '\u0176', ycirc: '\u0177', Ycy: '\u042B', ycy: '\u044B',
  yen: '\u00A5', Yfr: '\u{1D51B}', yfr: '\u{1D535}', YIcy: '\u0407',
  yicy: '\u0447', Yopf: '\u{1D550}', yopf: '\u{1D56A}', Yscr: '\u{1D4B4}',
  yscr: '\u{1D4CE}', Yuml: '\u0178', yuml: '\u00FF', Zacute: '\u0179',
  zacute: '\u017A', Zcaron: '\u017D', zcaron: '\u017E', Zcy: '\u0417',
  zcy: '\u0437', Zdot: '\u017B', zdot: '\u017C', zeetrf: '\u2128',
  ZeroWidthSpace: '\u200B', Zeta: '\u0396', zeta: '\u03B6', zfr: '\u{1D536}',
  Zfr: '\u2128', ZHcy: '\u0416', zhcy: '\u0436', zigrarr: '\u21DD',
  zopf: '\u{1D56B}', Zopf: '\u2124', Zscr: '\u{1D4B5}', zscr: '\u{1D4CF}',
  zwj: '\u200D', zwnj: '\u200C',
};

// Decode a character reference starting at s[i] === '&'. Returns [decoded, nextIndex]
// or null when there is no valid reference here.
function decodeEntity(s, i) {
  // numeric: &#...; or &#x...;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2;
    let hex = false;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
              : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === start || j >= s.length || s.charCodeAt(j) !== 59) return null;
    // decimal: at most 7 digits; hex: at most 6 digits (spec). More digits
    // makes the reference invalid (e.g. &#87654321; stays literal).
    if (j - start > (hex ? 6 : 7)) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return [String.fromCodePoint(cp), j + 1];
  }
  // named: &name; — name is alphanumerics, up to 31 chars (longest HTML5 name).
  let j = i + 1;
  while (j < s.length && j - i <= 31) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j++;
    else break;
  }
  if (j >= s.length || s.charCodeAt(j) !== 59) return null;
  const name = s.slice(i + 1, j);
  const v = NAMED_ENTITIES[name];
  if (v === undefined) return null;
  // a valid named entity is kept as its reference text (marked does not
  // decode it to a character in text output)
  return [s.slice(i, j + 1), j + 1];
}

// ---------------------------------------------------------------- line cursor
//
// A line is scanned with a cursor { s, i, col, pad } where i is the string
// index, col the virtual column (tabs advance to the next multiple of 4),
// and pad the number of spaces left from a partially consumed tab.

function curChar(L) {
  if (L.pad > 0) return ' ';
  return L.i < L.s.length ? L.s[L.i] : '';
}
function curAdvance(L) {
  if (L.pad > 0) { L.pad--; L.col++; return; }
  if (L.i < L.s.length) {
    if (L.s.charCodeAt(L.i) === 9) L.col += 4 - (L.col % 4);
    else L.col++;
    L.i++;
  }
}
// Columns of leading whitespace from the cursor (spaces/tabs), not consumed.
function curIndent(L) {
  let col = L.col;
  let i = L.i;
  let pad = L.pad;
  while (true) {
    if (pad > 0) { col++; pad--; continue; }
    if (i >= L.s.length) break;
    const c = L.s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - L.col;
}
// Consume n columns of indentation (spaces/tabs). A tab straddling the
// boundary leaves its remainder as spaces in pad.
function curSkipIndent(L, n) {
  let target = L.col + n;
  while (L.col < target) {
    if (L.pad > 0) { L.pad--; L.col++; continue; }
    if (L.i >= L.s.length) break;
    const c = L.s.charCodeAt(L.i);
    if (c === 32) { L.i++; L.col++; }
    else if (c === 9) {
      const next = L.col + (4 - (L.col % 4));
      L.i++;
      if (next <= target) { L.col = next; }
      else { L.pad = next - target; L.col = target; }
    } else break;
  }
}
// Skip up to n columns of spaces/tabs — for the "0-3 spaces" prefix before
// block markers. A tab is consumed only if its whole advance fits in the
// remaining budget. Returns columns consumed.
function curSkipSpacesUpTo(L, n) {
  let used = 0;
  while (used < n) {
    if (L.pad > 0) { L.pad--; L.col++; used++; continue; }
    if (L.i >= L.s.length) break;
    const c = L.s.charCodeAt(L.i);
    if (c === 32) { L.i++; L.col++; used++; }
    else if (c === 9) {
      const adv = 4 - (L.col % 4);
      if (adv > n - used) break;
      L.i++; L.col += adv; used += adv;
    } else break;
  }
  return used;
}
// The remainder of the line from the cursor (pad spaces + rest of string).
function curRest(L) {
  let r = L.pad > 0 ? ' '.repeat(L.pad) : '';
  return r + L.s.slice(L.i);
}
// Content of the line from the cursor, with a partially consumed tab's
// remainder expanded to spaces (used for code content).
function curContent(L) {
  return curRest(L);
}
// Dedent for a BACKTICK fenced code block: remove up to n columns of leading
// whitespace. A tab met while budget remains is consumed ENTIRELY (it
// vanishes, 0 spaces remain); a tab met exactly when the budget runs out is
// left alone. Returns columns consumed.
function fenceDedent(L, n) {
  let used = 0;
  while (used < n) {
    if (L.pad > 0) { L.pad--; L.col++; used++; continue; }
    if (L.i >= L.s.length) break;
    const c = L.s.charCodeAt(L.i);
    if (c === 32) { L.i++; L.col++; used++; }
    else if (c === 9) {
      L.i++;
      L.col += 4 - ((L.col - (L.base || 0)) % 4);
      break;
    } else break;
  }
  return used;
}

// Consume exactly one column of whitespace (a space, or one column of a tab,
// leaving the rest as pad). Returns true if one was consumed. A tab's width
// is measured from L.base (the innermost blockquote's '>' column, 0 at top
// level): marked re-lexes blockquote content with the marker counted, so a
// tab after '>' is narrower than its absolute column suggests.
function curSkipOneSpace(L) {
  if (L.pad > 0) { L.pad--; L.col++; return true; }
  if (L.i >= L.s.length) return false;
  const c = L.s.charCodeAt(L.i);
  if (c === 32) { L.i++; L.col++; return true; }
  if (c === 9) {
    const next = L.col + (4 - ((L.col - (L.base || 0)) % 4));
    L.i++;
    L.pad = next - L.col - 1;
    L.col++;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- block parsing

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param ' +
  'search section summary table tbody td tfoot th thead title tr track ul').split(' '));

function mkBlock(t) {
  return { t, children: [], lastBlank: false };
}

// --- block-start recognizers (cursor L is positioned after container prefixes)

function matchAtx(L) {
  // L at a possible ATX heading: #{1,6} followed by space/tab/EOL.
  const s = L.s;
  let i = L.i;
  let n = 0;
  while (i < s.length && s.charCodeAt(i) === 35 && n < 7) { i++; n++; }
  if (n === 0 || n > 6) return null;
  if (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  // heading text: skip spaces/tabs, strip trailing closing sequence
  let j = i;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  let end = s.length;
  while (end > j && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  let k = end;
  while (k > j && s.charCodeAt(k - 1) === 35) k--;
  // a closing sequence is a trailing run of # preceded by a space/tab;
  // it may be the whole content (### ### -> empty heading)
  if (k < end && k > 0 && (s.charCodeAt(k - 1) === 32 || s.charCodeAt(k - 1) === 9)) end = k;
  while (end > j && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  return { level: n, text: s.slice(j, end) };
}

function matchFence(L) {
  const s = L.s;
  let i = L.i;
  const ch = s[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (i < s.length && s[i] === ch) { i++; n++; }
  if (n < 3) return null;
  let info = s.slice(i);
  let a = 0;
  while (a < info.length && (info.charCodeAt(a) === 32 || info.charCodeAt(a) === 9)) a++;
  let b = info.length;
  while (b > a && (info.charCodeAt(b - 1) === 32 || info.charCodeAt(b - 1) === 9)) b--;
  info = info.slice(a, b);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len: n, info };
}

function isFenceClose(L, fenceCh, fenceLen) {
  const s = L.s;
  let i = L.i;
  if (s[i] !== fenceCh) return false;
  let n = 0;
  while (i < s.length && s[i] === fenceCh) { i++; n++; }
  if (n < fenceLen) return false;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

function matchHr(L) {
  // thematic break: 3+ of *, -, _ (same char), spaces/tabs allowed between.
  // the caller has already skipped up to 3 spaces of indentation, so the
  // first char here must be the break char itself.
  const s = L.s;
  let i = L.i;
  let ch = '';
  let n = 0;
  while (i < s.length) {
    const c = s[i];
    if (ch !== '' && (c === ' ' || c === '\t')) { i++; continue; }
    if (ch === '') ch = c;
    if (c !== ch || (ch !== '*' && ch !== '-' && ch !== '_')) return null;
    n++;
    i++;
  }
  return n >= 3 ? true : null;
}

function matchSetext(L) {
  // === or --- : a contiguous run of = or -, then only spaces/tabs.
  const s = L.s;
  let i = L.i;
  const ch = s[i];
  if (ch !== '=' && ch !== '-') return null;
  let n = 0;
  while (i < s.length && s[i] === ch) { i++; n++; }
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  if (n < 1) return null;
  return ch === '=' ? 1 : 2;
}

// Is the raw line text a setext-underline candidate (= run, or a - run too
// short to be a thematic break)? Used for the lazy-line 4-space rule.
function isLazySetext(text) {
  let i = 0;
  let spaces = 0;
  while (i < text.length && spaces < 3 && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) { i++; spaces++; }
  if (i >= text.length) return false;
  const ch = text[i];
  if (ch !== '=' && ch !== '-') return false;
  let n = 0;
  while (i < text.length && text[i] === ch) { i++; n++; }
  if (ch === '-' && n >= 3) return false; // thematic break
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return n >= 1;
}

// HTML block start. Returns type 1-7 or null. L is at the line start
// (after container prefixes and up to 3 spaces of indent).
function matchHtml(L) {
  const s = L.s;
  let i = L.i;
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  const lower = rest.slice(0, 12).toLowerCase();
  const m1 = /^<(script|pre|style|textarea)(?:[ \t>]|\/>|$)/i.exec(rest);
  if (m1) return { type: 1, endRe: /<\/(script|pre|style|textarea)/i };
  if (lower.startsWith('<!--')) return { type: 2, endStr: '-->' };
  if (lower.startsWith('<?')) return { type: 3, endStr: '?>' };
  if (/^<![a-z]/i.test(rest)) return { type: 4, endStr: '>' };
  if (lower.startsWith('<![cdata[')) return { type: 5, endStr: ']]>' };
  const m6 = /^<\/?([a-z][a-z0-9-]*)(?:[ \t>\/]|$)/i.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  if (m6) {
    const tag = parseHtmlTag(rest);
    if (tag) {
      let j = tag.end;
      while (j < rest.length && (rest.charCodeAt(j) === 32 || rest.charCodeAt(j) === 9)) j++;
      if (j === rest.length) return { type: 7 };
    }
  }
  return null;
}

// Parse an HTML tag starting at s[0] === '<'. Returns {end} (index just past
// the closing '>') or null. Tag name: letter followed by letters/digits/hyphens.
function parseHtmlTag(s) {
  let i = 0;
  if (s.charCodeAt(0) !== 60) return null;
  i = 1;
  let closing = false;
  if (s.charCodeAt(i) === 47) { i++; closing = true; } // '/'
  const c0 = s.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) i++;
    else break;
  }
  // after the tag name, attributes must be separated by whitespace
  while (i < s.length) {
    const wsStart = i;
    while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
    const hadWS = i > wsStart;
    if (i >= s.length) return null;
    const c = s.charCodeAt(i);
    if (c === 62) return { end: i + 1 }; // '>'
    if (c === 47) { // '/'
      if (s.charCodeAt(i + 1) === 62) return { end: i + 2 };
      return null;
    }
    // an attribute must be preceded by whitespace; a closing tag has none
    if (!hadWS || closing) return null;
    const ac = s.charCodeAt(i);
    if (!((ac >= 65 && ac <= 90) || (ac >= 97 && ac <= 122) || ac === 95 || ac === 58 || (ac >= 48 && ac <= 57))) return null;
    i++;
    while (i < s.length) {
      const d = s.charCodeAt(i);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
        d === 95 || d === 58 || d === 46 || d === 45) i++;
      else break;
    }
    // peek for '=' allowing whitespace before it, but do not consume the
    // whitespace unless '=' follows (it is the separator before the next
    // attribute when there is no value)
    let j = i;
    while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (s.charCodeAt(j) === 61) { // '='
      i = j + 1;
      while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
      const q = s.charCodeAt(i);
      if (q === 34 || q === 39) { // quoted value
        i++;
        while (i < s.length && s.charCodeAt(i) !== q) i++;
        if (i >= s.length) return null;
        i++;
      } else { // unquoted value
        if (i >= s.length) return null;
        const uc = s.charCodeAt(i);
        if (uc === 34 || uc === 39 || uc === 61 || uc === 60 || uc === 62 || uc === 96) return null;
        while (i < s.length) {
          const d = s.charCodeAt(i);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          i++;
        }
      }
    }
  }
  return null;
}

// List marker at cursor (after up to 3 spaces already skipped by caller).
// Returns marker info or null.
function matchListMarker(L) {
  const s = L.s;
  let i = L.i;
  let ordered = false;
  let start = 0;
  let delim = '';
  let markerLen = 0;
  const c = s[i];
  if (c === '-' || c === '+' || c === '*') {
    markerLen = 1;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    let n = 0;
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && n < 9) { j++; n++; }
    if (n === 0 || n > 9) return null;
    if (j >= s.length) return null;
    const d = s[j];
    if (d !== '.' && d !== ')') return null;
    if (j + 1 < s.length && s[j + 1] >= '0' && s[j + 1] <= '9') return null;
    ordered = true;
    start = parseInt(s.slice(i, j), 10);
    delim = d;
    markerLen = n + 1;
  } else return null;
  const after = i + markerLen;
  if (after < s.length) {
    const ac = s.charCodeAt(after);
    if (ac !== 32 && ac !== 9) return null;
  }
  let col = L.col + markerLen;
  let j = after;
  let ws = 0;
  while (j < s.length) {
    const cc = s.charCodeAt(j);
    if (cc === 32) { ws++; col++; j++; }
    else if (cc === 9) { const adv = 4 - (col % 4); ws += adv; col += adv; j++; }
    else break;
  }
  // absolute column of the item content (the caller subtracts the column
  // after the outer containers to get the item's contentIndent)
  let contentCol;
  if (j >= s.length) {
    contentCol = L.col + markerLen + 1;
  } else if (ws >= 5) {
    contentCol = L.col + markerLen + 1;
  } else {
    contentCol = col;
  }
  return { ordered, start, delim, markerLen, contentCol, wsAfter: ws, blank: j >= s.length, bullet: c };
}

// --- phase 1: block structure

function parseBlocks(src) {
  const lines = src.split('\n');
  const endsWithNL = src.length > 0 && src.charCodeAt(src.length - 1) === 10;
  const lastRealLine = endsWithNL ? lines.length - 2 : lines.length - 1;
  const root = mkBlock('doc');
  const stack = [root];

  function tip() { return stack[stack.length - 1]; }

  // Add a child block to container C, applying the blank-line looseness rule.
  function addChild(C, child) {
    if (C.t === 'item' && C.lastBlank && C.parent && C.parent.t === 'list') C.parent.loose = true;
    if (C.t === 'list' && C.lastBlank) C.loose = true;
    C.lastBlank = false;
    // the blank line that marked C is consumed here: it sat inside C's
    // subtree, so it must not linger on outer lists (a blank line inside
    // a nested item does not make the outer list loose)
    let p = C.parent;
    while (p) { p.lastBlank = false; p = p.parent; }
    C.children.push(child);
    child.parent = C;
    if (C.t === 'item') C.hasContent = true;
  }

  function closeTo(d) {
    while (stack.length > d) {
      const b = stack.pop();
      if (b.t === 'code' && !b.fenced) {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1].trim() === '') b.lines.pop();
      }
      // a non-item, non-list block closed while it ends with a blank line
      // consumed that blank line inside itself: it must not make an outer
      // list loose (a blank line inside a blockquote is not a blank line
      // between two items of the outer list). An item keeps its flag: a
      // blank line at the end of an item does separate it from the next
      // item. A list keeps its flag too: the blank line may separate two
      // items of the outer list.
      if (b.t !== 'item' && b.t !== 'list' && b.lastBlank) {
        let p = b.parent;
        while (p) { p.lastBlank = false; p = p.parent; }
      }
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const L = { s: raw, i: 0, col: 0, pad: 0, base: 0 };
    let blank = isBlankStr(raw);

    // --- 1. container matching ---
    let d = 1;
    let matched = true;
    while (d < stack.length) {
      const b = stack[d];
      if (b.t === 'bq') {
        if (blank) { matched = false; break; }
        const si = L.i, sc = L.col, sp = L.pad, sb = L.base;
        curSkipSpacesUpTo(L, 3);
        if (curChar(L) === '>') {
          // the '>' column is the tab-width base for this level: tabs in
          // the quote's content are measured from here, not from column 0
          L.base = L.col;
          curAdvance(L);
          curSkipOneSpace(L);
          d++;
        } else {
          L.i = si; L.col = sc; L.pad = sp; L.base = sb;
          matched = false; break;
        }
      } else if (b.t === 'item') {
        // a line that is empty after its container prefixes counts as a
        // blank line inside the item (e.g. '>>' after the blockquotes)
        if (blank || curRest(L).length === 0) {
          if (b.hasContent) d++;
          else { matched = false; break; }
        } else if (curIndent(L) >= b.contentIndent) {
          curSkipIndent(L, b.contentIndent);
          d++;
        } else { matched = false; break; }
      } else if (b.t === 'list') {
        d++;
      } else break; // leaf
    }

    // A line that is empty after its container prefixes (e.g. '>' alone
    // in a blockquote, or '>>' inside a list item) counts as a blank line:
    // it closes the paragraph but not the item. A rest of only spaces is
    // NOT blank (it is a paragraph line of spaces). This is checked before
    // the lazy test, so such a line is never a lazy continuation.
    if (!blank && curRest(L).length === 0 && d > 1) blank = true;

    // Lazy continuation: if a container failed to match but the tip is an
    // open paragraph and this line is a paragraph continuation line, the
    // line is added to the paragraph instead of closing the containers.
    // Likewise, a fenced code block inside a LIST ITEM absorbs a non-blank
    // line that does not match the item's indent (the block continues
    // until a closing fence). This does NOT apply inside a blockquote:
    // a line without '>' closes the quote and the code block (cm-237).
    let lazyLine = false;
    if (!matched && !blank) {
      const t = tip();
      if (t.t === 'para' && isParaContinuation(L, stack.some((b) => b.t === 'list'))) {
        matched = true;
        lazyLine = true;
      } else if (t.t === 'code' && t.fenced && d < stack.length && stack[d].t === 'item' && t.lines.length > 0 &&
        !stack.slice(d + 1).some((b) => b.t === 'bq')) {
        // only absorb a non-matching line into a fenced code block that
        // has already taken indented content; if the first content line
        // does not match the item, the block is empty and the line is a
        // paragraph (doc-23 jsx) rather than code (doc-05 typescript,
        // whose col-0 'fn main()' follows indented lines).
        matched = true;
        lazyLine = true;
      }
    }

    if (!matched) {
      closeTo(d);
    }

    // --- 2. blank line handling ---
    if (blank) {
      let t = tip();
      if (t.t === 'html' && t.endMet) {
        // the html block ended on a previous line; a blank line follows it.
        // A whitespace-only (but non-empty) blank line keeps the trailing
        // newline in the block's text. A marker-only ('>') or truly empty
        // blank line does not decide it here: whether the trailing newline
        // survives depends on what follows the blank run (sibling item?
        // container end?), so record the run and decide after the parse.
        const stripped = curRest(L);
        if (stripped.length > 0) t.trailNL = true;
        else if (t.parent === root && t.lastLine === lastRealLine && endsWithNL && li === lines.length - 1) t.trailNL = true;
        else {
          let run = 0, j = li;
          while (j < lines.length && !(j === lines.length - 1 && endsWithNL) && isLevelBlank(lines[j])) { run++; j++; }
          t.blankAfterRun = run;
        }
        closeTo(stack.length - 1);
        t = tip();
      }
      if (t.t === 'code' && t.fenced) {
        // blank line inside a fenced code block: its spaces (minus the
        // fence indent) are content; the phantom final line is not.
        // Backtick: fence-dedent (a tab-only line with budget remaining
        // becomes empty). Tilde: no dedent, a tab-only line keeps its tab.
        if (!(li === lines.length - 1 && endsWithNL)) {
          if (t.fenceCh === '`') fenceDedent(L, t.fenceIndent);
          t.lines.push(curRest(L));
        }
      } else if (t.t === 'code') {
        // indented code: a blank line keeps its spaces minus the 4 indent
        curSkipIndent(L, 4);
        t.lines.push(curRest(L));
      } else if (t.t === 'html' && t.htmlType >= 1 && t.htmlType <= 5) {
        t.lines.push('');
        t.lastLine = li;
      } else {
        // a whitespace-only line that contains a TAB is a table row (an
        // empty row), not a blank line, when the open paragraph is a table
        // (header + valid delimiter row): the paragraph continues. A
        // spaces-only or empty line still ends the table.
        if (t.t === 'para' && raw.indexOf('\t') !== -1 && t.lines.length >= 2 &&
          parseDelimRow(t.lines[1])) {
          t.lines.push(curRest(L));
          continue;
        }
        if (t.t === 'para' || t.t === 'html') {
          if (t.t === 'html' && t.parent === root && t.lastLine === lastRealLine && endsWithNL && li === lines.length - 1) t.trailNL = true;
          closeTo(stack.length - 1);
        }
        for (let k = 0; k < stack.length; k++) stack[k].lastBlank = true;
      }
      continue;
    }

    // --- 3. leaf continuation / new blocks ---
    while (true) {
      const t = tip();
      if (t.t === 'para') {
        const saveI = L.i, saveCol = L.col, savePad = L.pad;
        curSkipSpacesUpTo(L, 3);
        // a lazy line never becomes a setext underline
        const st = lazyLine ? null : matchSetext(L);
        // a table paragraph never becomes a setext heading: a line of '='
        // (or '-') after a table is a table row, not an underline
        const isTablePara = t.lines.length >= 2 && parseDelimRow(t.lines[1]);
        if (st !== null && !isTablePara) {
          t.t = 'head';
          t.level = st;
          t.text = t.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          // the raw setext line, in case the heading turns out to consist
          // only of link reference definitions (then it is paragraph text)
          const svI = L.i, svC = L.col, svP = L.pad;
          L.i = saveI; L.col = saveCol; L.pad = savePad;
          t.setextLine = curRest(L);
          L.i = svI; L.col = svC; L.pad = svP;
          delete t.lines;
          stack.pop();
          break;
        }
        L.i = saveI; L.col = saveCol; L.pad = savePad;
        if (startsInterruptingBlock(L, stack.some((b) => b.t === 'list'))) {
          stack.pop();
          continue;
        }
        let lineText;
        if (lazyLine && curIndent(L) >= 4) {
          // a lazy continuation line indented 4+ columns loses 4 of them
          curSkipIndent(L, 4);
          lineText = curRest(L);
        } else {
          lineText = curRest(L);
        }
        // Expand leading tabs in a paragraph line inside a container to
        // spaces (each to the next tab stop, measured from the innermost
        // blockquote's '>' column); at top level tabs stay literal. A
        // partially consumed tab already left its remainder as pad spaces.
        if (L.col > 0 && lineText.length > 0) {
          let k = 0, col = L.col, out = '', expanded = false;
          while (k < lineText.length) {
            const c = lineText.charCodeAt(k);
            if (c === 32) { out += ' '; col++; k++; }
            else if (c === 9) {
              const w = 4 - ((col - (L.base || 0)) % 4);
              out += ' '.repeat(w); col += w; k++; expanded = true;
            } else break;
          }
          if (expanded) lineText = out + lineText.slice(k);
        }
        // a line following a hard break loses its leading whitespace
        if (t.lines.length > 0) {
          const prev = t.lines[t.lines.length - 1];
          let hard = false;
          let bs = 0;
          let k = prev.length - 1;
          while (k >= 0 && prev.charCodeAt(k) === 92) { bs++; k--; }
          if (bs % 2 === 1) hard = true;
          else {
            let sp = 0;
            let j = prev.length - 1;
            while (j >= 0 && prev.charCodeAt(j) === 32) { sp++; j--; }
            if (sp >= 2) hard = true;
          }
          if (hard) {
            let m = 0;
            while (m < lineText.length && (lineText.charCodeAt(m) === 32 || lineText.charCodeAt(m) === 9)) m++;
            if (m > 0) lineText = lineText.slice(m);
          }
        }
        if (lazyLine && t.lastLazy && isLazySetext(lineText)) {
          // a setext-looking lazy line after a lazy line, inside a
          // blockquote, is indented by 4 spaces in marked's output
          let p = t.parent;
          while (p) {
            if (p.t === 'bq') { lineText = '    ' + lineText; break; }
            p = p.parent;
          }
        }
        t.lines.push(lineText);
        t.lastLazy = lazyLine;
        t.lastBlank = false;
        break;
      }
      if (t.t === 'code' && t.fenced) {
        // closing fence may be indented up to 3 spaces
        const svI = L.i, svC = L.col, svP = L.pad;
        curSkipSpacesUpTo(L, 3);
        if (isFenceClose(L, t.fenceCh, t.fenceLen)) {
          stack.pop();
          break;
        }
        L.i = svI; L.col = svC; L.pad = svP;
        if (li === lines.length - 1 && endsWithNL) break; // phantom final line
        // Backtick fence: strip up to fenceIndent columns (a tab met with
        // budget remaining vanishes entirely). Tilde fence: NO dedent at
        // all — content lines keep their indent (doc-22/29).
        if (t.fenceCh === '`') fenceDedent(L, t.fenceIndent);
        // After the dedent, expand the leading tabs to spaces — but only
        // inside a container (list item / blockquote). At top level a tab
        // stays literal (it is consumed by the dedent or left alone).
        // Each tab expands to the next tab stop, measured from the
        // innermost blockquote's '>' column (L.base); spaces count as 1.
        let inCont = false;
        for (let p = t.parent; p; p = p.parent) {
          if (p.t === 'item' || p.t === 'bq') { inCont = true; break; }
        }
        if (inCont) {
          let out = '';
          let col = L.col;
          if (L.pad > 0) { out += ' '.repeat(L.pad); col += L.pad; L.pad = 0; }
          while (L.i < L.s.length) {
            const c = L.s.charCodeAt(L.i);
            if (c === 32) { out += ' '; col++; L.i++; }
            else if (c === 9) {
              const w = 4 - ((col - (L.base || 0)) % 4);
              out += ' '.repeat(w); col += w; L.i++;
            } else break;
          }
          L.col = col;
          t.lines.push(out + L.s.slice(L.i));
        } else {
          t.lines.push(curRest(L));
        }
        break;
      }
      if (t.t === 'code' && !t.fenced) {
        if (curIndent(L) >= 4) {
          curSkipIndent(L, 4);
          t.lines.push(curContent(L));
          break;
        }
        closeTo(stack.length - 1);
        continue;
      }
      if (t.t === 'html') {
        if (t.endMet) {
          // block ended on a previous line; this line decides the trailing \n
          t.trailNL = true;
          closeTo(stack.length - 1);
          continue;
        }
        const rest = curRest(L);
        t.lines.push(rest);
        t.lastLine = li;
        if (t.htmlType === 1 && t.endRe.test(rest)) t.endMet = true;
        else if (t.htmlType === 2 && rest.indexOf('-->') !== -1) t.endMet = true;
        else if (t.htmlType === 3 && rest.indexOf('?>') !== -1) t.endMet = true;
        else if (t.htmlType === 4 && rest.indexOf('>') !== -1) t.endMet = true;
        else if (t.htmlType === 5 && rest.indexOf(']]>') !== -1) t.endMet = true;
        break;
      }
      // tip is a container (or root): try to open new blocks
      // if the tip is a list and this line does not start a list item that
      // matches it, the list is closed first (a non-item block cannot be a
      // direct child of a list)
      if (t.t === 'list') {
        const svI = L.i, svC = L.col, svP = L.pad;
        curSkipSpacesUpTo(L, 3);
        // an hr takes precedence over a list item (* * * is an hr, not an item)
        if (matchHr(L)) {
          L.i = svI; L.col = svC; L.pad = svP;
          closeTo(stack.length - 1);
          continue;
        }
        const lm0 = matchListMarker(L);
        L.i = svI; L.col = svC; L.pad = svP;
        if (!lm0 || !listMatches(t, lm0)) {
          closeTo(stack.length - 1);
          continue;
        }
      }
      const saveI = L.i, saveCol = L.col, savePad = L.pad;
      if (curIndent(L) >= 4) {
        const cb = mkBlock('code');
        cb.fenced = false;
        cb.lines = [];
        curSkipIndent(L, 4);
        cb.lines.push(curContent(L));
        addChild(t, cb);
        stack.push(cb);
        break;
      }
      curSkipSpacesUpTo(L, 3);
      if (L.i >= L.s.length && L.pad === 0) {
        L.i = saveI; L.col = saveCol; L.pad = savePad;
        break;
      }
      const atx = matchAtx(L);
      if (atx) {
        const h = mkBlock('head');
        h.level = atx.level; h.text = atx.text;
        addChild(t, h);
        break;
      }
      const fence = matchFence(L);
      if (fence) {
        const cb = mkBlock('code');
        cb.fenced = true; cb.fenceCh = fence.ch; cb.fenceLen = fence.len;
        cb.info = fence.info; cb.lines = [];
        cb.fenceIndent = L.col - saveCol;
        addChild(t, cb);
        stack.push(cb);
        break;
      }
      const html = matchHtml(L);
      if (html) {
        const hb = mkBlock('html');
        hb.htmlType = html.type;
        hb.endRe = html.endRe || null;
        // the first line keeps its leading spaces (up to 3)
        L.i = saveI; L.col = saveCol; L.pad = savePad;
        const rest = curRest(L);
        hb.lines = [rest];
        hb.endMet = false;
        hb.trailNL = false;
        if (html.type === 1 && html.endRe.test(rest)) hb.endMet = true;
        else if (html.type === 2 && rest.indexOf('-->') !== -1) hb.endMet = true;
        else if (html.type === 3 && rest.indexOf('?>') !== -1) hb.endMet = true;
        else if (html.type === 4 && rest.indexOf('>') !== -1) hb.endMet = true;
        else if (html.type === 5 && rest.indexOf(']]>') !== -1) hb.endMet = true;
        hb.lastLine = li;
        addChild(t, hb);
        stack.push(hb);
        break;
      }
      if (matchHr(L)) {
        const hr = mkBlock('hr');
        addChild(t, hr);
        break;
      }
      if (curChar(L) === '>') {
        const bq = mkBlock('bq');
        addChild(t, bq);
        stack.push(bq);
        L.base = L.col;
        curAdvance(L);
        curSkipOneSpace(L);
        continue;
      }
      const lm = matchListMarker(L);
      if (lm) {
        if (t.t === 'list' && listMatches(t, lm)) {
          const item = mkBlock('item');
          item.contentIndent = lm.contentCol - saveCol;
          item.hasContent = false;
          addChild(t, item);
          stack.push(item);
          advancePastMarker(L, lm);
          continue;
        }
        if (t.t === 'list') {
          closeTo(stack.length - 1);
          continue;
        }
        const list = mkBlock('list');
        list.ordered = lm.ordered;
        list.start = lm.ordered ? lm.start : 0;
        list.delim = lm.ordered ? lm.delim : '';
        list.bullet = lm.ordered ? '' : lm.bullet;
        list.loose = false;
        addChild(t, list);
        stack.push(list);
        const item = mkBlock('item');
        item.contentIndent = lm.contentCol - saveCol;
        item.hasContent = false;
        addChild(list, item);
        stack.push(item);
        advancePastMarker(L, lm);
        continue;
      }
      const p = mkBlock('para');
      // the first line keeps its leading spaces (up to 3)
      L.i = saveI; L.col = saveCol; L.pad = savePad;
      p.lines = [curRest(L)];
      addChild(t, p);
      stack.push(p);
      break;
    }
  }

  // An html block that runs to the last real line of the input (and the
  // input ends with a newline) keeps that trailing newline in its text.
  for (let k = 1; k < stack.length; k++) {
    const b = stack[k];
    if (b.t === 'html' && b.parent === root && b.lastLine === lastRealLine && endsWithNL) {
      b.trailNL = true;
    }
  }
  // An ended html block followed by a marker-only or empty blank line:
  // its trailing newline survives only if the blank run is exactly one
  // line and the block is followed (in its own container) by a sibling
  // list item (item parent) or is the last child of its blockquote
  // (bq parent, i.e. the quote ends after it). Otherwise it is dropped.
  (function setHtmlTrailNL(b) {
    for (const c of b.children || []) {
      if (c.t === 'html' && c.blankAfterRun !== undefined) {
        const run = c.blankAfterRun;
        if (c.parent && c.parent.t === 'item') {
          const list = c.parent.parent;
          const idx = list ? list.children.indexOf(c.parent) : -1;
          c.trailNL = run === 1 && idx >= 0 && idx < list.children.length - 1;
        } else if (c.parent && c.parent.t === 'bq') {
          const kids = c.parent.children;
          c.trailNL = run === 1 && kids[kids.length - 1] === c;
        } else {
          c.trailNL = false;
        }
      }
      setHtmlTrailNL(c);
    }
  })(root);
  closeTo(1);
  return { root, lastRealLine, endsWithNL };
}

function listMatches(list, lm) {
  if (list.ordered !== lm.ordered) return false;
  if (lm.ordered) return list.delim === lm.delim;
  return list.bullet === lm.bullet;
}

// Advance the cursor past a list marker and the following whitespace,
// leaving the content (per the contentIndent rule).
function advancePastMarker(L, lm) {
  const s = L.s;
  L.i += lm.markerLen;
  L.col += lm.markerLen;
  if (lm.blank) {
    while (L.i < s.length && (s.charCodeAt(L.i) === 32 || s.charCodeAt(L.i) === 9)) {
      curAdvance(L);
    }
    return;
  }
  if (lm.wsAfter >= 5) {
    curSkipIndent(L, 1);
  } else {
    curSkipIndent(L, lm.wsAfter);
  }
}

// Is the line at cursor a paragraph continuation line (does not start a
// block that can interrupt a paragraph)? Used for lazy continuation.
function isParaContinuation(L, inList) {
  const saveI = L.i, saveCol = L.col, savePad = L.pad;
  // startsInterruptingBlock skips up to 3 spaces itself; do not skip here
  // or the two skips add up and a 4-space-indented marker is found
  if (L.i >= L.s.length && L.pad === 0) { return false; }
  const r = !startsInterruptingBlock(L, inList);
  L.i = saveI; L.col = saveCol; L.pad = savePad;
  return r;
}

// Does the line at cursor start a block that can interrupt a paragraph?
// inList: the paragraph is inside a list, so even an empty list item can
// interrupt it (a new item of the enclosing list); at the top level an
// empty item cannot interrupt.
function startsInterruptingBlock(L, inList) {
  const saveI = L.i, saveCol = L.col, savePad = L.pad;
  curSkipSpacesUpTo(L, 3);
  let r = false;
  if (matchAtx(L)) r = true;
  else if (matchFence(L)) r = true;
  else {
    const html = matchHtml(L);
    if (html && html.type !== 7) r = true;
    else if (matchHr(L)) r = true;
    else if (curChar(L) === '>') r = true;
    else {
      const lm = matchListMarker(L);
      if (lm) {
        if (inList) r = true; // inside a list, any marker interrupts
        else if (!lm.blank && (!lm.ordered || lm.start === 1)) r = true;
      }
    }
  }
  L.i = saveI; L.col = saveCol; L.pad = savePad;
  return r;
}

// ---------------------------------------------------------------- phase 2

// Normalize a link label: collapse whitespace to single spaces, trim,
// lowercase (with full Unicode case folding for the special cases where
// toLowerCase differs: ß/ẞ -> ss and the Latin ligatures).
function normalizeLabel(label) {
  let out = '';
  let lastWasSpace = true; // trim leading
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (!lastWasSpace) { out += ' '; lastWasSpace = true; }
    } else {
      out += label[i];
      lastWasSpace = false;
    }
  }
  if (lastWasSpace && out.length > 0) out = out.slice(0, -1);
  let folded = out.toLowerCase();
  // full case folding (String.toLowerCase does not fold these)
  folded = folded
    .replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, 'ss')
    .replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi').replace(/\uFB04/g, 'ffl').replace(/\uFB05/g, 'st')
    .replace(/\uFB06/g, 'st');
  return folded;
}

// Resolve backslash escapes in a string (used for link destinations/titles).
function unescape(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Parse a link label starting at s[i] === '['. Returns {label, next} where
// next is the index just past the closing ']', or null. Labels may not
// contain nested brackets (marked 18) and are at most 999 characters.
function parseLinkLabel(s, i) {
  let j = i + 1;
  let len = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { j += 2; len += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label: s.slice(i + 1, j), next: j + 1 };
    j++;
    len++;
    if (len > 999) return null;
  }
  return null;
}

// Skip whitespace (spaces, tabs, newlines) from position i. Returns the new
// position. A blank line would end the paragraph, so newlines here are
// single line breaks within a definition.
function skipWS(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination at s[i]. Returns {dest, next} or null.
// dest is the raw destination with backslash escapes resolved.
function parseLinkDest(s, i) {
  if (s.charCodeAt(i) === 60) { // '<'
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '>') return { dest: out, next: j + 1 };
      if (c === '<') return null;
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c;
      j++;
    }
    return null;
  }
  // bare destination: no spaces/control chars; balanced parens
  let j = i;
  let depth = 0;
  let out = '';
  while (j < s.length) {
    const c = s[j];
    const cc = c.charCodeAt(0);
    if (cc === 32 || cc === 9 || cc === 10) break;
    if (cc < 32 || cc === 127) break;
    if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c;
    j++;
  }
  if (j === i) return null;
  return { dest: out, next: j };
}

// Parse a link title at s[i] ('"', "'", or '('). Returns {title, next} or null.
function parseLinkTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === q) return { title: out, next: j + 1 };
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c;
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      const c = s[j];
      if (c === ')') return { title: out, next: j + 1 };
      if (c === '(') return null; // unescaped '(' not allowed in a paren title
      if (c === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c;
      j++;
    }
    return null;
  }
  return null;
}

// Extract link reference definitions from a paragraph's text. Returns the
// remaining text (after the definitions) and fills refs.
function extractRefsFromText(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    // definition must start at a line start, indented at most 3 spaces
    let p = pos;
    let spaces = 0;
    while (p < n && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) { spaces++; p++; }
    if (spaces > 3) break;
    if (text.charCodeAt(p) !== 91) break; // '['
    const lab = parseLinkLabel(text, p);
    if (!lab) break;
    const key = normalizeLabel(lab.label);
    if (key === '') break; // an empty label is not a valid definition
    let q = skipWS(text, lab.next);
    if (text.charCodeAt(q) !== 58) break; // ':'
    q = skipWS(text, q + 1);
    const dest = parseLinkDest(text, q);
    if (!dest) break;
    const afterDest = dest.next;
    // skip spaces/tabs on the destination line
    let r = afterDest;
    while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
    let title = '';
    let hasTitle = false;
    if (r < n && r > afterDest && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
      // title on the same line (whitespace before it is required)
      const t = parseLinkTitle(text, r);
      if (!t) break;
      title = t.title;
      hasTitle = true;
      r = t.next;
      while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
      if (r < n && text.charCodeAt(r) !== 10) break;
      pos = r < n ? r + 1 : r;
    } else if (r < n && text.charCodeAt(r) === 10) {
      // end of the destination line: a title may follow on the next line,
      // but if it is not a clean title the definition simply has no title
      let r2 = r + 1;
      while (r2 < n && (text.charCodeAt(r2) === 32 || text.charCodeAt(r2) === 9)) r2++;
      if (r2 < n && (text[r2] === '"' || text[r2] === "'" || text[r2] === '(')) {
        const t = parseLinkTitle(text, r2);
        let okTitle = false;
        if (t) {
          let r3 = t.next;
          while (r3 < n && (text.charCodeAt(r3) === 32 || text.charCodeAt(r3) === 9)) r3++;
          if (r3 >= n || text.charCodeAt(r3) === 10) okTitle = true;
        }
        if (okTitle) {
          title = t.title;
          hasTitle = true;
          r = t.next;
          while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
          pos = r < n ? r + 1 : r;
        } else {
          pos = r + 1;
        }
      } else {
        pos = r + 1;
      }
    } else if (r >= n) {
      pos = r;
    } else {
      break; // junk after the destination on the same line
    }
    // valid definition
    if (!refs.has(key)) {
      refs.set(key, { dest: dest.dest, title: hasTitle ? title : null });
    }
  }
  return text.slice(pos);
}

// --- tables ---

function splitTableRow(line) {
  // Split a table row on unescaped '|' not inside a code span. Returns the
  // cell strings (leading/trailing empty cells from outer pipes removed).
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '`') {
      // copy a code span verbatim (pipes inside do not split)
      let j = i;
      let run = 0;
      while (j < n && line[j] === '`') { j++; run++; }
      let k = j;
      let found = -1;
      while (k < n) {
        if (line[k] === '`') {
          let m = k;
          let r2 = 0;
          while (m < n && line[m] === '`') { m++; r2++; }
          if (r2 === run) { found = m; break; }
          k = m;
        } else k++;
      }
      // copy a code span verbatim (pipes inside do not split), except that
      // \| inside it still becomes | (the escape is consumed by the split)
      if (found !== -1) { cur += line.slice(i, found).replace(/\\\|/g, '|'); i = found; continue; }
      cur += c; i++;
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  // drop a leading/trailing empty cell from outer pipes, trim each cell
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function parseDelimRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const left = t.charCodeAt(0) === 58;
    const right = t.charCodeAt(t.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Try to convert a paragraph into a table. Returns true if converted.
function tryTable(para) {
  const lines = para.lines;
  if (lines.length < 2) return false;
  // the delimiter row may be indented at most 3 spaces
  let ind = 0;
  let k = 0;
  while (k < lines[1].length) {
    const cc = lines[1].charCodeAt(k);
    if (cc === 32) { ind++; k++; }
    else if (cc === 9) { ind += 4 - (ind % 4); k++; }
    else break;
  }
  if (ind >= 4) return false;
  const aligns = parseDelimRow(lines[1]);
  if (!aligns) return false;
  const header = splitTableRow(lines[0]);
  if (aligns.length < header.length) return false;
  const ncol = aligns.length;
  const rows = [];
  for (let r = 2; r < lines.length; r++) {
    const cells = splitTableRow(lines[r]);
    while (cells.length < ncol) cells.push('');
    rows.push(cells.slice(0, ncol));
  }
  while (header.length < ncol) header.push('');
  para.t = 'table';
  para.header = header.slice(0, ncol);
  para.aligns = aligns;
  para.rows = rows;
  delete para.lines;
  return true;
}

// Phase 2: walk the tree, extract link refs from every paragraph (in
// document order), then convert table paragraphs.
function phase2(root) {
  const refs = new Map();
  const blocks = []; // paragraphs and setext headings, in document order
  (function walk(b) {
    if (b.t === 'para') blocks.push(b);
    else if (b.t === 'head' && b.setextLine !== undefined) blocks.push(b);
    // task list: the item's first block is a paragraph starting with a
    // checkbox marker
    if (b.t === 'item' && b.children.length > 0 && b.children[0].t === 'para') {
      const p0 = b.children[0];
      const first = p0.lines[0];
      if (first !== undefined) {
        if (first.length >= 4 && first.charCodeAt(0) === 91 &&
          (first.charCodeAt(1) === 32 || first.charCodeAt(1) === 120 || first.charCodeAt(1) === 88) &&
          first.charCodeAt(2) === 93 && first.charCodeAt(3) === 32) {
          b.task = first.charCodeAt(1) !== 32;
          p0.lines[0] = first.slice(4);
          if (p0.lines.join('').trim() === '') p0.lines = [];
        } else if (first === '[ ]' || first === '[x]' || first === '[X]') {
          b.task = first.charCodeAt(1) !== 32;
          p0.lines = [];
        }
      }
    }
    for (const c of b.children) walk(c);
  })(root);
  for (const p of blocks) {
    if (p.t === 'para') {
      const text = p.lines.join('\n');
      const rest = extractRefsFromText(text, refs);
      if (rest !== text) {
        p.lines = rest === '' ? [] : rest.split('\n');
      }
      if (p.lines.length === 0) {
        p.empty = true;
      } else {
        tryTable(p);
      }
    } else {
      // setext heading: definitions at its start are extracted too
      const rest = extractRefsFromText(p.text, refs);
      if (rest !== p.text) {
        if (rest.trim() === '') {
          // the heading was only definitions: undo it into a paragraph
          // holding the setext line (merged with the next paragraph below)
          p.t = 'para';
          p.lines = [p.setextLine];
          p.setextUndone = true;
          delete p.text;
          delete p.level;
          delete p.setextLine;
        } else {
          p.text = rest.replace(/[ \t]+$/, '');
        }
      }
    }
  }
  // merge an undone heading's paragraph with a following paragraph
  (function mergeWalk(b) {
    for (let k = 0; k < b.children.length; k++) {
      const c = b.children[k];
      if (c.setextUndone && k + 1 < b.children.length && b.children[k + 1].t === 'para') {
        const next = b.children[k + 1];
        next.lines = c.lines.concat(next.lines);
        b.children.splice(k, 1);
        k--;
      } else {
        mergeWalk(c);
      }
    }
  })(root);
  return refs;
}

// ---------------------------------------------------------------- inline parsing

const LOCAL_PART = (c) => {
  const cc = c.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
    c === '.' || c === '_' || c === '+' || c === '-';
};
const DOMAIN_CHAR = (c) => {
  const cc = c.charCodeAt(0);
  return (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
    c === '.' || c === '_' || c === '-';
};

// Match an email starting at the local part [start, atPos) and '@' at atPos.
// Returns the index just past the email, or -1.
function matchEmailAt(s, start, atPos) {
  let j = atPos + 1;
  const n = s.length;
  while (j < n && DOMAIN_CHAR(s[j])) j++;
  // a trailing '_' is not part of a valid domain label (it is usually an
  // emphasis delimiter, e.g. _warning foo@bar.com_): strip it so the last
  // label is not invalidated and the whole domain is kept — but only when
  // the domain then still has >= 3 labels; a 2-label domain ending in '_'
  // (e.g. a.b-c_d@a.b_) is not an email at all (gfm-632).
  let candEnd = j;
  while (candEnd > atPos + 1 && s[candEnd - 1] === '_') candEnd--;
  const stripped = s.slice(atPos + 1, candEnd);
  const cand = stripped.split('.').length >= 3 ? stripped : s.slice(atPos + 1, j);
  const labels = cand.split('.');
  // Longest valid domain prefix: labels[0..k], k >= 1, each label non-empty
  // and not ending with '_', last label not ending with '-'.
  let best = -1;
  for (let k = labels.length - 1; k >= 1; k--) {
    let ok = true;
    for (let m = 0; m <= k; m++) {
      const lab = labels[m];
      if (lab.length === 0) { ok = false; break; }
      if (lab.charCodeAt(lab.length - 1) === 95) { ok = false; break; }
    }
    if (!ok) continue;
    if (labels[k].charCodeAt(labels[k].length - 1) === 45) continue;
    best = k;
    break;
  }
  if (best === -1) return -1;
  let end = atPos + 1;
  for (let m = 0; m <= best; m++) end += labels[m].length + (m < best ? 1 : 0);
  return end;
}

// Trim trailing punctuation from a www/scheme autolink candidate.
// Returns the trimmed end index (exclusive) within s, starting at `end`.
function trimAutolink(s, start, end) {
  let e = end;
  const PUNCT = '?!.,:;*_~"\'';
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    // entity-like &xxx; at the end
    if (e - start >= 2 && s.charCodeAt(e - 1) === 59) { // ';'
      let k = e - 2;
      while (k >= start && ((s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) ||
        (s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) ||
        (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122))) k--;
      if (k >= start && s.charCodeAt(k) === 38 && k < e - 1) { e = k; changed = true; }
    }
    // trailing punctuation
    while (e > start && PUNCT.indexOf(s[e - 1]) !== -1) { e--; changed = true; }
    // unbalanced closing paren: a trailing ')' is stripped only when it
    // has no matching '(' before it. Scan left to right tracking depth,
    // clamped at 0 (a ')' at depth 0 is a stray character, not a closer);
    // the final ')' is stray (and stripped) exactly when the depth just
    // before it is 0. A ')' that closes an open '(' is kept, even when
    // an earlier stray ')' exists (e.g. a)b(c) keeps its final ')').
    while (e > start && s.charCodeAt(e - 1) === 41) {
      let depth = 0;
      for (let k = start; k < e - 1; k++) {
        if (s.charCodeAt(k) === 40) depth++;
        else if (s.charCodeAt(k) === 41 && depth > 0) depth--;
      }
      if (depth === 0) { e--; changed = true; }
      else break;
    }
    // an unclosed '(' terminates the URL: trim to before the first '('
    // that is never closed within the candidate (marked's backpedal
    // only allows balanced paren groups in an autolink URL, e.g.
    // https://a.example.io/foo(bar -> https://a.example.io/foo, while
    // https://a.example.io/foo(bar) and .../a(b)c(d)e are kept whole)
    {
      const stack = [];
      for (let k = start; k < e; k++) {
        if (s.charCodeAt(k) === 40) stack.push(k);
        else if (s.charCodeAt(k) === 41 && stack.length > 0) stack.pop();
      }
      if (stack.length > 0) { e = stack[0]; changed = true; }
    }
  }
  return e;
}

// Try to match a www autolink starting at s[i] === 'w'. Returns the end
// index (exclusive) or -1.
function matchWww(s, i) {
  if (s[i] !== 'w' || s.slice(i, i + 4) !== 'www.') return -1;
  // preceding char must be start, whitespace, or one of * _ ~ ( [
  if (i > 0) {
    const p = s[i - 1];
    if (!(isWhitespace(p) || p === '*' || p === '_' || p === '~' || p === '(' || p === '[')) return -1;
  }
  let j = i;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60) break; // space/tab/newline/'<'
    j++;
  }
  const e = trimAutolink(s, i, j);
  if (e <= i + 4) return -1;
  // validate: www. followed by a domain label
  let k = i + 4;
  if (!DOMAIN_CHAR(s[k]) || s[k] === '.' || s[k] === '_') return -1;
  // the domain is a run of labels; require at least one label char
  return e;
}

// Try to match a scheme autolink (http/https/ftp:// or mailto:/xmpp: + email)
// starting at s[i]. Returns {end, href} or null.
function matchScheme(s, i) {
  const rest = s.slice(i, i + 8).toLowerCase();
  let schemeLen = -1;
  let isMail = false;
  if (rest.startsWith('http://')) schemeLen = 7;
  else if (rest.startsWith('https://')) schemeLen = 8;
  else if (rest.startsWith('ftp://')) schemeLen = 6;
  else if (s.slice(i, i + 7).toLowerCase() === 'mailto:') { schemeLen = 7; isMail = true; }
  else if (s.slice(i, i + 5) === 'xmpp:') { schemeLen = 5; isMail = true; }
  else return null;
  if (isMail) {
    // email after the scheme
    const at = s.indexOf('@', i + schemeLen);
    if (at === -1) return null;
    // local part must start right after the scheme
    let ls = i + schemeLen;
    if (ls >= at) return null;
    for (let k = ls; k < at; k++) if (!LOCAL_PART(s[k])) return null;
    const end = matchEmailAt(s, ls, at);
    if (end === -1) return null;
    // mailto: takes no path. xmpp: takes an optional single path segment
    // '/' + [A-Za-z0-9.@]+ (a bare '/' is not a path; a trailing '.' is
    // trimmed like other trailing punctuation).
    let e = end;
    if (s.slice(i, i + 5) === 'xmpp:' && e < s.length && s[e] === '/') {
      let j = e + 1;
      while (j < s.length) {
        const cc = s.charCodeAt(j);
        if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
          cc === 46 || cc === 64) j++;
        else break;
      }
      if (j > e + 1) e = trimAutolink(s, i, j);
      if (e < end) e = end;
    }
    return { end: e, href: s.slice(i, e) };
  }
  // http/https/ftp: the char after :// must be alnum, '_' or '-'
  const first = s[i + schemeLen];
  if (first === undefined) return null;
  const fc = first.charCodeAt(0);
  if (!((fc >= 48 && fc <= 57) || (fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122) || first === '_' || first === '-')) return null;
  let j = i + schemeLen;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    j++;
  }
  const e = trimAutolink(s, i, j);
  if (e <= i + schemeLen) return null;
  return { end: e, href: s.slice(i, e) };
}


// --- angle autolink <...> and inline HTML ---

function tryAngleAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && isLetter(s[j])) {
    let k = j + 1;
    while (k < n && k - j <= 31 && (isAlnum(s[k]) || s[k] === '+' || s[k] === '.' || s[k] === '-')) k++;
    if (k - j >= 2 && k - j <= 32 && s[k] === ':') {
      let m = k + 1;
      while (m < n) {
        const cc = s.charCodeAt(m);
        if (cc === 62) {
          const href = s.slice(j, m);
          return { end: m + 1, href, text: href };
        }
        if (cc === 32 || cc === 9 || cc === 10 || cc === 60) return null;
        m++;
      }
      return null;
    }
  }
  // email inside <>
  let at = -1;
  let m = j;
  while (m < n && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\t' && s[m] !== '\n') {
    if (s[m] === '@') { at = m; break; }
    m++;
  }
  if (at !== -1) {
    let ok = true;
    for (let k = j; k < at; k++) if (!LOCAL_PART(s[k])) { ok = false; break; }
    if (ok) {
      const end = matchEmailAt(s, j, at);
      if (end !== -1 && s[end] === '>') {
        const email = s.slice(j, end);
        return { end: end + 1, href: 'mailto:' + email, text: email };
      }
    }
  }
  return null;
}

function tryInlineHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (empty) comments
    if (s.startsWith('<!-->', i)) return { end: i + 5, text: s.slice(i, i + 5) };
    if (s.startsWith('<!--->', i)) return { end: i + 6, text: s.slice(i, i + 6) };
    const e = s.indexOf('-->', i + 4);
    if (e !== -1) return { end: e + 3, text: s.slice(i, e + 3) };
    return null;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e !== -1) return { end: e + 2, text: s.slice(i, e + 2) };
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e !== -1) return { end: e + 3, text: s.slice(i, e + 3) };
    return null;
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && isLetter(s[i + 2])) {
    const e = s.indexOf('>', i + 2);
    if (e !== -1) return { end: e + 1, text: s.slice(i, e + 1) };
    return null;
  }
  const tag = parseHtmlTag(s.slice(i));
  if (tag) return { end: i + tag.end, text: s.slice(i, i + tag.end) };
  return null;
}

// Parse a link after ']' at s[i]. rawText is the link text's raw string.
// Returns {href, title, end} or null.
// A double-backtick code span whose content holds a single backtick,
// followed by more text before the ']' (e.g. `` a ` b `` output or
// _x `` a ` b ``_), prevents the enclosing link from forming in marked:
// the link text is left literal and the destination becomes an autolink.
// When the span ends the link text (nothing after it), the link forms.
function hasBrokenCodeSpan(t) {
  let i = 0;
  while (i < t.length) {
    if (t[i] === '`' && t[i + 1] === '`') {
      let j = i + 2;
      let close = -1;
      while (j < t.length) {
        if (t[j] === '`' && t[j + 1] === '`') { close = j; break; }
        j++;
      }
      if (close === -1) return false;
      // content between the `` `` has a lone single backtick
      let hasLone = false;
      for (let k = i + 2; k < close; k++) {
        if (t[k] === '`' && t[k - 1] !== '`' && t[k + 1] !== '`') { hasLone = true; break; }
      }
      if (hasLone && close + 2 < t.length) {
        // ...unless the text after the span holds an unclosed backtick
        // run: then the link forms after all ([x `` a ` b `` y `z](u)
        // and [a ``x` y ``z` w](u) form, while the same text without a
        // trailing backtick does not).
        const rest = t.slice(close + 2);
        let lastRun = -1, hasLater = false;
        for (let k = 0; k < rest.length; k++) {
          if (rest[k] === '\\' && k + 1 < rest.length) { k++; continue; }
          if (rest[k] === '`') {
            if (lastRun !== -1) hasLater = true;
            lastRun = k;
            while (k < rest.length && rest[k] === '`') k++;
            k--;
          }
        }
        if (lastRun !== -1 && !hasLater) return false;
        return true;
      }
      i = close + 2;
    } else i++;
  }
  return false;
}
function tryParseLink(s, i, refs, rawText) {
  const n = s.length;
  if (i < n && s[i] === '(') {
    let j = skipWS(s, i + 1);
    let dest = '';
    let ok = true;
    if (j < n && s[j] !== ')') {
      const d = parseLinkDest(s, j);
      if (!d) ok = false;
      else { dest = d.dest; j = d.next; }
    }
    if (ok) {
      const afterDest = j;
      j = skipWS(s, j);
      let title = null;
      if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
        if (j === afterDest) ok = false; // a title needs whitespace before it
        else {
          const t = parseLinkTitle(s, j);
          if (!t) ok = false;
          else { title = t.title; j = skipWS(s, t.next); }
        }
      }
      if (ok && (j >= n || s[j] !== ')')) ok = false;
      if (ok) return { href: dest, title, end: j + 1 };
    }
    // inline link failed: fall through to the reference forms
  }
  if (i < n && s[i] === '[') {
    const lab = parseLinkLabel(s, i);
    if (!lab) return null;
    const key = lab.label === '' ? normalizeLabel(rawText) : normalizeLabel(lab.label);
    const ref = refs.get(key);
    if (!ref) return null;
    return { href: ref.dest, title: ref.title, end: lab.next };
  }
  const key = normalizeLabel(rawText);
  const ref = refs.get(key);
  if (!ref) return null;
  return { href: ref.dest, title: ref.title, end: i };
}

// --- emphasis ---

function processEmphasis(nodes, delims, isTop) {
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j >= 0; j--) {
      const d = delims[j];
      if (d.ch !== closer.ch || !d.canOpen || d.len === 0) continue;
      if ((d.canClose || closer.canOpen) && (d.len + closer.len) % 3 === 0 &&
        (d.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      // an em/strong formed from an opener that could only open
      // (preceded by whitespace) whose closer can open (followed by text)
      // blocks an outer emphasis from matching across it, with two
      // exceptions: a '**' closer may still match a '**' opener across
      // it (an outer **...** forms), and a '**' closer may match a
      // single-'*' opener across it when no '**' opener exists further
      // back (so *uses *callback*markdown** still forms its outer em).
      // *foo **bar**baz* leaves the outer '*' literal, while
      // *foo**bar**baz* (opener preceded by a letter, so it could also
      // close) does match across it; **a *b*c* d** leaves the '*' after
      // c literal.
      if (d.ch === '*') {
        let blocked = false;
        for (let k = d.idx + 1; k < closer.idx; k++) {
          const nd = nodes[k];
          // a strong blocks only when its closer is followed by real
          // content (not by another delimiter): a '__' closer whose
          // canOpen comes only from the '_' punctuation exception before
          // the '*' that closes the outer em (doc-18's `__` before '*')
          // does not block the outer em.
          if (nd && nd.t === 'strong' && nd.oc === false && nd.cc === true) {
            const afterNd = nodes[k + 1];
            if (!afterNd || afterNd.t !== 'delim') { blocked = true; break; }
          }
          // an inner em also blocks a single-'*' closer from matching a
          // '**' opener across it (doc-01's '**public as *so*other* ...**':
          // the '*' after 'other' must stay literal so the outer strong
          // forms). It does NOT block an outer single-'*' em (doc-26's
          // '*a private add *compatible*run* build*', whose outer em forms).
          if (nd && nd.t === 'em' && nd.oc === false && nd.cc === true && d.len === 2 && closer.len === 1) {
            blocked = true; break;
          }
        }
        if (blocked) {
          if (closer.len === 1) continue;
          if (d.len === 1) {
            let hasLen2 = false;
            for (let m = j - 1; m >= 0; m--) {
              const e = delims[m];
              if (e.ch === closer.ch && e.canOpen && e.len === 2) { hasLen2 = true; break; }
            }
            if (hasLen2) continue;
          }
        }
      }
      oi = j;
      break;
    }
    if (oi === -1) { ci++; continue; }
    const opener = delims[oi];
    // Emphasis suppression after a broken-backtick link: when a link
    // whose text holds a `` `` `` run with no same-length closer formed
    // earlier in this inline scope, an emphasis span starting after
    // that link is suppressed iff a code span starts after the span's
    // closer (closer before the next code span -> suppressed; closer
    // after it, or no code span after -> forms).
    if (isTop && brokenLinkEnd !== -1 && opener.pos >= brokenLinkEnd) {
      let hasCodeAfter = false;
      const scanCodes = (arr) => {
        for (const nd of arr) {
          if (nd.t === 'code' && nd.pos !== undefined && nd.pos > closer.pos) { hasCodeAfter = true; return; }
          if (nd.children) scanCodes(nd.children);
        }
      };
      scanCodes(nodes);
      if (hasCodeAfter) { ci++; continue; }
    }
    const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
    const type = use === 2 ? (opener.ch === '~' ? 'del' : 'strong') : (opener.ch === '~' ? 'del' : 'em');
    const oIdx = opener.idx;
    const cIdx = closer.idx;
    const children = nodes.slice(oIdx + 1, cIdx);
    const newNode = { t: type, children, oc: opener.canClose, cc: closer.canOpen };
    const openerSurvives = opener.len > use;
    const closerSurvives = closer.len > use;
    const seg = [];
    if (openerSurvives) {
      opener.len -= use;
      seg.push(opener);
    }
    seg.push(newNode);
    // A leftover closer delimiter normally stays outside the new element
    // (**a*** -> <strong>a</strong>*), but for a STRONG it stays INSIDE
    // when an inner em/strong between opener and closer has a closer
    // that can open (**ab *c*d*** -> <strong>ab <em>c</em>d*</strong>,
    // while **a *b* c***, whose inner closer is followed by a space,
    // leaves it outside). The leftover then becomes literal text inside.
    let closerInside = false;
    if (closerSurvives && use === 2) {
      closer.len -= use;
      let innerCanOpen = false;
      for (const ch of children) {
        if (ch.t === 'em' && ch.cc === true) { innerCanOpen = true; break; }
      }
      // ...and the leftover is not needed to close an outer opener of
      // the same character (doc-05's ____ splits 2+2 across an inner
      // and an outer __ strong; the leftover must stay outside).
      let outerOpener = false;
      if (innerCanOpen) {
        for (let k = 0; k < oi; k++) {
          const d = delims[k];
          if (d.ch === closer.ch && d.canOpen && d.len > 0) { outerOpener = true; break; }
        }
      }
      if (innerCanOpen && !outerOpener) {
        children.push({ t: 'text', s: closer.ch.repeat(closer.len) });
        closerInside = true;
      } else {
        seg.push(closer);
      }
    } else if (closerSurvives) {
      closer.len -= use;
      seg.push(closer);
    }
    const removed = cIdx - oIdx + 1;
    nodes.splice(oIdx, removed, ...seg);
    const delta = seg.length - removed;
    // delimiters between the opener and closer become children of the new
    // node and can no longer match (marked does not match across em bounds)
    for (let k = delims.length - 1; k >= 0; k--) {
      if (k === oi || k === ci) continue;
      const d = delims[k];
      if (d.idx > oIdx && d.idx < cIdx) {
        delims.splice(k, 1);
        if (k < ci) ci--;
        if (k < oi) oi--;
      } else if (d.idx > cIdx) {
        d.idx += delta;
      }
    }
    if (!openerSurvives) {
      delims.splice(oi, 1);
      if (oi < ci) ci--;
    } else {
      opener.idx = oIdx;
    }
    if (!closerSurvives || closerInside) {
      delims.splice(ci, 1);
    } else {
      closer.idx = oIdx + seg.length - 1;
    }
  }
}

// --- the inline scanner ---

// If an autolink's URL contains a ']' followed by '(' or '[', that ']'
// is link syntax, not part of the URL — but only when the enclosing link
// can still form. The enclosing link can form when the innermost active
// '[' opener's text (nodes since the opener) has no explicit link yet.
// If the text already has a link, the enclosing link cannot form, so the
// ']' stays in the URL. Returns the (possibly truncated) end index.
function truncateAutolinkAtBracket(s, i, end, openers, nodes) {
  let bp = -1;
  for (let k = i; k < end; k++) {
    if (s[k] === ']' && (s[k + 1] === '(' || s[k + 1] === '[')) { bp = k; break; }
  }
  if (bp === -1) return end;
  // innermost active opener
  let op = null;
  for (let k = openers.length - 1; k >= 0; k--) {
    if (openers[k].active) { op = openers[k]; break; }
  }
  if (!op) return end;
  const hasExplicitLink = (nodes2) => {
    for (const ch of nodes2) {
      if (ch.t === 'link' && !ch.auto && !ch.angle) return true;
      if (ch.children && hasExplicitLink(ch.children)) return true;
    }
    return false;
  };
  // Truncate at the ']' so the enclosing link can still form — unless
  // the link text already has an explicit link (then the enclosing link
  // cannot form and the ']' stays in the URL, e.g. doc-12's
  // ...?page=4)](./docs/create.md)). A ']' followed by '(' that starts
  // a new URL does NOT truncate either: marked's backpedal keeps the
  // whole balanced run (doc-22/36's ...server)](https://img...)), and
  // the unbalanced-'(' case is already trimmed by trimAutolink (doc-08's
  // ...example.io)](https://npmjs.com/heading ...)).
  const explicit = hasExplicitLink(nodes.slice(op.idx + 1));
  if (explicit) return end;
  // Otherwise the ']' is left available as a link closer: the
  // truncated URL may end in an emphasis/strikethrough closer ('__',
  // '**', '~~') before the ']': trim only those delimiter characters
  // so they are scanned as delimiters instead of being swallowed into
  // the autolink. Other trailing characters (e.g. the ')' closing the
  // inner link's destination) stay in the URL.
  let e = bp;
  while (e > i && (s[e - 1] === '_' || s[e - 1] === '*' || s[e - 1] === '~')) e--;
  return e;
}

// Document-level "inside an <a> tag" state (marked's Lexer.state.inLink):
// an inline-lexed <a ...> tag (space after the name) suppresses every
// later bare autolink (email, www, scheme) until a </a> tag is lexed,
// across all blocks of the document. Reset for each parse() call.
let docInLink = false;

// Source index just past the first "broken-backtick" link formed in the
// current inline scope (a link whose text holds a backtick run of length
// 2+ with no same-length closer in the text, e.g. [x ``small`](u)).
// -1 when no such link formed. Reset per parseInline call. An emphasis
// span after such a link is suppressed when a code span starts after
// the emphasis closer (marked's maskedSrc behaviour).
let brokenLinkEnd = -1;

// True when the link text holds a backtick run of length 2+ with no
// later run of the same length in the text (a "broken" run: it is closed
// by a shorter run, or not at all, so it forms no code span). Runs are
// scanned left to right with same-length pairing, so a closing run is
// consumed and never re-examined as an opener.
function isBrokenLinkText(t) {
  let p = 0;
  while (p < t.length) {
    if (t[p] === '\\' && p + 1 < t.length) { p += 2; continue; }
    if (t[p] !== '`') { p++; continue; }
    let q = p;
    while (q < t.length && t[q] === '`') q++;
    const len = q - p;
    if (len >= 2) {
      let same = -1;
      let r = q;
      while (r < t.length) {
        if (t[r] === '\\' && r + 1 < t.length) { r += 2; continue; }
        if (t[r] === '`') {
          let m = r;
          while (m < t.length && t[m] === '`') m++;
          if (m - r === len) { same = m; break; }
          r = m;
        } else r++;
      }
      if (same === -1) return true;
      p = same;
      continue;
    }
    p = q;
  }
  return false;
}

function parseInline(s, refs) {
  const nodes = [];
  const delims = [];
  const openers = [];
  brokenLinkEnd = -1;
  let unmatchedBt = false;
  const n = s.length;
  let i = 0;
  let textStart = 0;

  // Tags that would flip docInLink but sit inside a [...] span are
  // pending until the span's fate is known: dropped if the span forms a
  // link (its text is lexed as link text), applied if no link forms.
  const pending = [];
  // An opener that fails to form a link hands its pendings to the next
  // outer active opener, or applies them if there is none.
  const releasePendings = (op) => {
    let outer = null;
    for (let k = openers.length - 1; k >= 0; k--) {
      if (openers[k].active && openers[k] !== op) { outer = openers[k]; break; }
    }
    for (let k = 0; k < pending.length; k++) {
      if (pending[k].op === op) {
        if (outer) pending[k].op = outer;
        else { docInLink = pending[k].val; pending.splice(k, 1); k--; }
      }
    }
  };

  // Pre-pass: find email autolinks in the raw string. The local part may
  // contain '_' (an emphasis delimiter), which would otherwise reset
  // textStart and truncate the backward scan at '@' time.
  const emailRanges = new Map();
  for (let p = 0; p < n; p++) {
    if (s.charCodeAt(p) === 64) {
      let ls = p;
      while (ls > 0 && LOCAL_PART(s[ls - 1])) ls--;
      if (ls < p) {
        const end = matchEmailAt(s, ls, p);
        if (end !== -1) emailRanges.set(ls, end);
      }
    }
  }

  const flush = (end) => {
    if (end > textStart) nodes.push({ t: 'text', s: s.slice(textStart, end) });
    textStart = end;
  };

  while (i < n) {
    const c = s[i];
    const er = emailRanges.get(i);
    if (er !== undefined && !docInLink) {
      flush(i);
      nodes.push({ t: 'link', href: 'mailto:' + s.slice(i, er), title: null, auto: true, children: [{ t: 'text', s: s.slice(i, er) }] });
      i = er;
      textStart = i;
      continue;
    }
    if (c === '\n') {
      let spaces = 0;
      let k = i - 1;
      while (k >= textStart && s.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        flush(i - spaces);
        nodes.push({ t: 'br' });
      } else {
        flush(i);
        nodes.push({ t: 'softbr' });
      }
      i++;
      textStart = i;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && s[i + 1] === '\n') {
        flush(i);
        nodes.push({ t: 'br' });
        i += 2;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(s[i + 1])) {
        flush(i);
        nodes.push({ t: 'text', s: s[i + 1] });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      let run = 0;
      while (j < n && s[j] === '`') { j++; run++; }
      let k = j;
      let found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k;
          let r2 = 0;
          while (m < n && s[m] === '`') { m++; r2++; }
          if (r2 === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -1) {
        // an unmatched run of 2+ backticks "poisons" a later single
        // backtick: it may not open a code span that spans a ']' closing
        // an active link (doc-16's ``guide` in](#should) forms its link,
        // while cm-342's `link](/foo` with no preceding unmatched run
        // does span the ']' and blocks the link).
        if (run >= 2) unmatchedBt = true;
        i = j; continue;
      }
      // A run of 2+ backticks whose same-length closer lies past the
      // ']' that closes an active link opener does not form a code
      // span: marked lexes the link at '[' first, so inside the link
      // text the run has no same-length closer (doc-09's ``url` ...
      // ``a ` b`` and doc-35's ``and` ... ``add` ``). Treat it as
      // unmatched (and poison a later single backtick). Single
      // backticks are NOT restricted here: cm-342/525/537 show a
      // single backtick may span a ']' and form a code span.
      if (run >= 2) {
        let opPos = -1;
        for (let kk = openers.length - 1; kk >= 0; kk--) {
          if (openers[kk].active) { opPos = openers[kk].pos; break; }
        }
        if (opPos !== -1 && i > opPos) {
          let spansClose = false;
          for (let q = i; q < found; q++) {
            if (s[q] === ']' && (s[q + 1] === '(' || s[q + 1] === '[')) { spansClose = true; break; }
          }
          if (spansClose) {
            unmatchedBt = true;
            i = j; continue;
          }
        }
      }
      if (run === 1 && unmatchedBt && openers.length > 0) {
        let opPos = -1;
        for (let kk = openers.length - 1; kk >= 0; kk--) {
          if (openers[kk].active) { opPos = openers[kk].pos; break; }
        }
        if (opPos !== -1 && i > opPos) {
          let hasBracket = false;
          for (let q = i; q < found; q++) {
            if (s[q] === ']' && (s[q + 1] === '(' || s[q + 1] === '[')) { hasBracket = true; break; }
          }
          if (hasBracket) { i = j; continue; }
        }
      }
      flush(i);
      let content = s.slice(j, found);
      if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 &&
        content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content, pos: i });
      i = found + run;
      textStart = i;
      continue;
    }
    if (c === '<') {
      const al = tryAngleAutolink(s, i);
      if (al) {
        flush(i);
        nodes.push({ t: 'link', href: al.href, title: null, angle: true, children: [{ t: 'text', s: al.text }] });
        i = al.end;
        textStart = i;
        continue;
      }
      const html = tryInlineHtml(s, i);
      if (html) {
        flush(i);
        nodes.push({ t: 'html', s: html.text });
        // marked keeps a document-level "inside <a>" state: an inline
        // <a ...> tag (space after the name) suppresses all later bare
        // autolinks until a </a> tag is lexed. Tags inside a [...] span
        // that forms a link are lexed as link text and do not touch the
        // state, so they are recorded as pending against the innermost
        // active opener and settled only when that span's fate is known.
        const tagText = html.text;
        let linkVal = -1;
        if (tagText.charCodeAt(1) === 97 || tagText.charCodeAt(1) === 65) { // 'a'/'A'
          if (tagText.charCodeAt(2) === 32) linkVal = 1; // '<a '
        } else if (tagText.charCodeAt(1) === 47) { // '/'
          if ((tagText.charCodeAt(2) === 97 || tagText.charCodeAt(2) === 65) && tagText.charCodeAt(3) === 62) linkVal = 0; // '</a>'
        }
        if (linkVal !== -1) {
          let op = null;
          for (let k = openers.length - 1; k >= 0; k--) {
            if (openers[k].active) { op = openers[k]; break; }
          }
          if (op) pending.push({ op, val: linkVal === 1 });
          else docInLink = linkVal === 1;
        }
        i = html.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && i + 1 < n && s[i + 1] === '[')) {
      const isImage = c === '!';
      flush(i);
      nodes.push({ t: 'open', img: isImage });
      openers.push({ idx: nodes.length - 1, img: isImage, active: true, pos: i });
      i += isImage ? 2 : 1;
      textStart = i;
      continue;
    }
    if (c === ']') {
      let oi = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].active) { oi = k; break; }
      }
      if (oi === -1) { i++; continue; }
      const opener = openers[oi];
      const rawText = s.slice(opener.pos + (opener.img ? 2 : 1), i);
      if (!opener.img && hasBrokenCodeSpan(rawText)) {
        opener.active = false;
        releasePendings(opener);
        // the broken code span also prevents any * / _ emphasis inside
        // this link text from forming (marked leaves the _ literal):
        // drop those delimiters so they render as plain text.
        for (let k = delims.length - 1; k >= 0; k--) {
          const dd = delims[k];
          if ((dd.ch === '*' || dd.ch === '_') && dd.idx > opener.idx) delims.splice(k, 1);
        }
        i++;
        continue;
      }
      // A link does not form when its text holds a backtick run with no
      // later backtick run to close it: marked's findClosingBracket
      // skips code spans while looking for the ']' and gives up when a
      // run is unclosed ([a ``x](u) stays literal, while [a ``x`](u)
      // and [a ``x`z](u) form because the lone backtick closes the run).
      // A run of length L is closed by the next run of the same length
      // L if one exists later (skipping any shorter runs inside the
      // span, e.g. [quote `` a ` b ``](u) forms with <code>a ` b</code>);
      // otherwise it is closed by the next run of any length if one
      // exists; otherwise it is unclosed and the link does not form.
      // Escaped backticks (\`) are not runs at all. The opener is
      // simply deactivated, so emphasis inside the abandoned text still
      // forms ([a ``x *y*](u) -> *y* is <em>).
      {
        let unclosedBt = false;
        let rescued = false;
        let p = 0;
        while (p < rawText.length) {
          const ch = rawText[p];
          if (ch === '\\' && p + 1 < rawText.length) { p += 2; continue; }
          if (ch !== '`') { p++; continue; }
          let q = p;
          while (q < rawText.length && rawText[q] === '`') q++;
          const len = q - p;
          // next run of the same length
          let r = q, same = -1, sameStart = -1;
          while (r < rawText.length) {
            if (rawText[r] === '\\' && r + 1 < rawText.length) { r += 2; continue; }
            if (rawText[r] === '`') {
              let m = r;
              while (m < rawText.length && rawText[m] === '`') m++;
              if (m - r === len) { same = m; sameStart = r; break; }
              r = m;
            } else r++;
          }
          if (same !== -1) {
            // a same-length span whose content holds a lone single
            // backtick "rescues" a later unclosed run: the link still
            // forms ([a ``x` y ``z` w](u) forms, while [a ``x`` y `z](u)
            // with a span holding no single backtick does not).
            if (len >= 2) {
              for (let k = q; k < sameStart; k++) {
                if (rawText[k] === '`' && rawText[k - 1] !== '`' && rawText[k + 1] !== '`') { rescued = true; break; }
              }
            }
            p = same; continue;
          }
          // otherwise the next run of any length
          r = q;
          let any = -1;
          while (r < rawText.length) {
            if (rawText[r] === '\\' && r + 1 < rawText.length) { r += 2; continue; }
            if (rawText[r] === '`') {
              let m = r;
              while (m < rawText.length && rawText[m] === '`') m++;
              any = m;
              break;
            }
            r++;
          }
          if (any === -1) { if (!rescued) unclosedBt = true; break; }
          p = any;
        }
        if (unclosedBt) {
          opener.active = false;
          releasePendings(opener);
          i++;
          continue;
        }
      }
      const link = tryParseLink(s, i + 1, refs, rawText);
      if (!link) {
        opener.active = false;
        releasePendings(opener);
        i++;
        continue;
      }
      // form the link/image
      flush(i);
      const children = nodes.slice(opener.idx + 1);
      // a link cannot contain another *explicit* link: if the link text
      // already has one, this link does not form. An autolink inside the
      // text does not block it: a bare (extended) autolink is flattened
      // back to plain text, while an angle autolink <...> is kept nested.
      if (!opener.img) {
        const hasLink = (nodes2) => {
          for (const ch of nodes2) {
            if (ch.t === 'link' && !ch.auto && !ch.angle) return true;
            if (ch.children && hasLink(ch.children)) return true;
          }
          return false;
        };
        if (hasLink(children)) {
          opener.active = false;
          releasePendings(opener);
          i++;
          continue;
        }
        // flatten autolinks inside the link text back to plain text
        const flattenAuto = (nodes2) => {
          for (let k = 0; k < nodes2.length; k++) {
            const ch = nodes2[k];
            if (ch.t === 'link' && ch.auto) {
              nodes2.splice(k, 1, ...ch.children);
              k += ch.children.length - 1;
            } else if (ch.children) {
              flattenAuto(ch.children);
            }
          }
        };
        flattenAuto(children);
      }
      const inner = [];
      for (let k = delims.length - 1; k >= 0; k--) {
        const d = delims[k];
        if (d.idx > opener.idx) {
          d.idx -= opener.idx + 1;
          inner.unshift(d);
          delims.splice(k, 1);
        }
      }
      processEmphasis(children, inner);
      let node;
      if (opener.img) {
        node = { t: 'img', src: link.href, title: link.title, children };
      } else {
        node = { t: 'link', href: link.href, title: link.title, children };
      }
      nodes.length = opener.idx;
      nodes.push(node);
      // A "broken-backtick" link (its text holds a `` `` `` run with no
      // same-length closer) suppresses a later emphasis span when a code
      // span starts after that span's closer; record where it ends.
      if (brokenLinkEnd === -1 && isBrokenLinkText(rawText)) brokenLinkEnd = link.end;
      // tags inside this link's text were lexed as link text: drop them
      const dead = new Set();
      for (let k = oi; k < openers.length; k++) dead.add(openers[k]);
      for (let k = pending.length - 1; k >= 0; k--) {
        if (dead.has(pending[k].op)) pending.splice(k, 1);
      }
      // deactivate all openers from this one on (no links inside links)
      for (let k = oi; k < openers.length; k++) openers[k].active = false;
      openers.length = oi;
      i = link.end;
      textStart = i;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      let run = 0;
      while (j < n && s[j] === c) { j++; run++; }
      if (c === '~' && run >= 3) { i = j; continue; } // not a delimiter
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const prevWS = prev === '' || isWhitespace(prev);
      const nextWS = next === '' || isWhitespace(next);
      const prevPunct = prev !== '' && isPunct(prev);
      const nextPunct = next !== '' && isPunct(next);
      const leftFlanking = !nextWS && (!nextPunct || prevWS || prevPunct);
      const rightFlanking = !prevWS && (!prevPunct || nextWS || nextPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlanking && (!rightFlanking || prevPunct);
        canClose = rightFlanking && (!leftFlanking || nextPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush(i);
      const dnode = { t: 'delim', ch: c, len: run, canOpen, canClose, idx: nodes.length, pos: i };
      nodes.push(dnode);
      delims.push(dnode);
      i = j;
      textStart = i;
      continue;
    }
    if (c === '&') {
      const ent = decodeEntity(s, i);
      if (ent) {
        flush(i);
        nodes.push({ t: 'text', s: ent[0] });
        i = ent[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '@') {
      // emails are handled by the pre-pass above
      i++;
      continue;
    }
    if (c === 'w') {
      let w = matchWww(s, i);
      if (w !== -1 && !docInLink) {
        // a ']' followed by '(' or '[' inside the URL is link syntax, not
        // part of the URL, but only when the enclosing link can still form
        // (its text has no explicit link yet): truncate there so the ']'
        // stays available as a link closer. If the enclosing link cannot
        // form (its text already has a link), the ']' stays in the URL.
        w = truncateAutolinkAtBracket(s, i, w, openers, nodes);
        flush(i);
        const text = s.slice(i, w);
        nodes.push({ t: 'link', href: 'http://' + text, title: null, auto: true, children: [{ t: 'text', s: text }] });
        i = w;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M' || c === 'x' || c === 'X') {
      const sc = matchScheme(s, i);
      if (sc && !docInLink) {
        const end = truncateAutolinkAtBracket(s, i, sc.end, openers, nodes);
        flush(i);
        const text = s.slice(i, end);
        nodes.push({ t: 'link', href: end === sc.end ? sc.href : s.slice(i, end), title: null, auto: true, children: [{ t: 'text', s: text }] });
        i = end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  // any opener still active never formed a link: its text was top-level,
  // so tags recorded inside it do flip the state, in record order
  for (const p of pending) docInLink = p.val;
  flush(n);
  processEmphasis(nodes, delims, true);
  return nodes;
}

// --- rendering inline nodes ---

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': case 'code': out += nd.s; break;
      case 'em': case 'strong': case 'del': case 'link': case 'img': out += plainText(nd.children); break;
      case 'open': out += nd.img ? '![' : '['; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'br': case 'softbr': out += '\n'; break;
      default: break;
    }
  }
  return out;
}

function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escText(nd.s); break;
      case 'code': out += '<code>' + esc(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'softbr': out += '\n'; break;
      case 'em': out += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'link':
        out += '<a href="' + escText(cleanUrl(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escText(nd.title) + '"';
        out += '>' + renderInline(nd.children) + '</a>';
        break;
      case 'img':
        out += '<img src="' + escText(cleanUrl(nd.src)) + '" alt="' + escText(plainText(nd.children)) + '"';
        if (nd.title) out += ' title="' + escText(nd.title) + '"';
        out += '>';
        break;
      case 'open': out += nd.img ? '![' : '['; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      default: break;
    }
  }
  return out;
}

// --- block rendering ---

function renderItem(item, refs, loose) {
  const tight = !loose;
  let body = '';
  let prevTightPara = false;
  for (const c of item.children) {
    const s = renderBlock(c, refs, tight);
    // a tight paragraph renders as bare inline content with no trailing
    // newline, and the next block follows immediately (foo<ul>, a<blockquote>)
    if (body !== '' && !body.endsWith('\n') && s !== '' && !prevTightPara) body += '\n';
    body += s;
    // an html block without a trailing newline is also bare text: the next
    // block follows immediately, like after a tight paragraph
    prevTightPara = (c.t === 'para' && tight) || (c.t === 'html' && !c.trailNL);
  }
  if (item.task !== undefined) {
    const cb = item.task
      ? '<input checked="" disabled="" type="checkbox">'
      : '<input disabled="" type="checkbox">';
    // in a loose list the first paragraph renders as <p>...</p> and the
    // checkbox goes inside it; in a tight list it precedes the bare text
    if (!tight && body.startsWith('<p>')) {
      body = '<p>' + cb + ' ' + body.slice(3);
    } else {
      body = cb + ' ' + body;
    }
  }
  if (body === '') return '<li></li>\n';
  return '<li>' + body + '</li>\n';
}

function renderBlock(b, refs, tight) {
  switch (b.t) {
    case 'doc': {
      let out = '';
      for (const c of b.children) out += renderBlock(c, refs, false);
      return out;
    }
    case 'bq': {
      let out = '<blockquote>\n';
      for (const c of b.children) out += renderBlock(c, refs, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (b.ordered && b.start !== 1) out += ' start="' + b.start + '"';
      out += '>\n';
      for (const item of b.children) out += renderItem(item, refs, b.loose);
      return out + '</' + tag + '>\n';
    }
    case 'para': {
      if (b.empty) return '';
      const inner = renderInline(parseInline(b.lines.join('\n'), refs));
      if (tight) return inner;
      return '<p>' + inner + '</p>\n';
    }
    case 'head': {
      return '<h' + b.level + '>' + renderInline(parseInline(b.text, refs)) + '</h' + b.level + '>\n';
    }
    case 'code': {
      let cls = '';
      if (b.fenced && b.info) {
        let e = 0;
        while (e < b.info.length && b.info.charCodeAt(e) !== 32 && b.info.charCodeAt(e) !== 9) e++;
        const w = b.info.slice(0, e);
        if (w) cls = ' class="language-' + escText(unescape(w)) + '"';
      }
      // the content is the lines joined with \n; a trailing \n is added
      // only when the last line is not blank (a blank last line already
      // ends the join with \n)
      const joined = b.lines.join('\n');
      const content = b.lines.length === 0 ? '' : esc(joined) + (b.lines[b.lines.length - 1] === '' ? '' : '\n');
      return '<pre><code' + cls + '>' + content + '</code></pre>\n';
    }
    case 'html': {
      let out = b.lines.join('\n');
      if (b.trailNL) out += '\n';
      return out;
    }
    case 'hr': return '<hr>\n';
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const al = b.aligns[k];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' +
          renderInline(parseInline(b.header[k], refs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < b.header.length; k++) {
            const al = b.aligns[k];
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' +
              renderInline(parseInline(row[k] || '', refs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default: return '';
  }
}

export function parse(markdown) {
  docInLink = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const { root } = parseBlocks(src);
  const refs = phase2(root);
  return renderBlock(root, refs, false);
}
