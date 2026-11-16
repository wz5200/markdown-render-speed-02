# markdown-render-speed-02

A dependency-free, hand-written Markdown parser that renders byte-identical
HTML to marked 18.1.3 (default options: GFM on, breaks off, pedantic off),
plus a small driver that runs it over a case file.

## Files

- `parse.js` — the parser. `parse(markdown)` returns the HTML string.
  Dependency-free ES module; no imports, no network, no Node APIs.
- `main.ts` — the driver. Run with `node /bot/main.ts` (Node 22). It reads
  `/input/cases.json` (a JSON array of `{ id, markdown }`), renders each case
  alone with `parse()`, and writes `/output/html.json` (a JSON array of HTML
  strings, in the cases' order). Outside a container, `MAKEFUN_INPUT_DIR`
  and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
- `BUILD_LOG.md` — how this entry was built and verified.

## What the parser covers

CommonMark 0.31.2 block structure (ATX and setext headings, fenced and
indented code, blockquotes, bullet and ordered lists with tight/loose
handling, thematic breaks, HTML blocks types 1–7, link reference
definitions, paragraphs with lazy continuation) and inline parsing
(backslash escapes, entities, code spans, emphasis and strong emphasis with
the delimiter-stack rules, strikethrough, links and images in inline,
collapsed, full and shortcut reference forms, autolinks `<...>` and the GFM
extended autolinks for `www.`, `http://`, `https://`, `ftp://`, `mailto:`,
`xmpp:` and bare email addresses, inline HTML and hard/soft breaks), plus
GFM tables (header, delimiter row with alignment, body rows padded or
truncated to the header width) and task-list checkboxes.

## How it works

`parse()` normalises line endings, runs a two-phase block parse (phase 1
builds the block tree, phase 2 extracts link reference definitions and
detects tables), then renders the tree. Inline content is scanned once
into a node list plus a delimiter list; emphasis is resolved with the
standard delimiter-stack algorithm, and links are resolved as their
closing brackets are found, so nested and reference links follow the
same rules as the spec. Rendering is a direct walk of the tree.

## Speed

The parser is written as hand scans over the input (character-code
comparisons, no regular expressions on hot paths) so it stays fast on
long documents: in-process, over the 720 practice cases, it averages
roughly 1.1× the speed of marked 18.1.3 on this machine. See
`BUILD_LOG.md` for the measured numbers.

## Verification

Against the kit's 720 practice cases (680 CommonMark/GFM spec examples
and 40 generated documents), the entry is compared byte for byte with
marked 18.1.3's output. Final result: **720 / 720 pass** — every spec
example and every generated document is byte-identical. Run the kit check with:

```
node cli/makefun.mjs check --kit <kit dir> --repo <this dir>
```

from inside the kit directory.
