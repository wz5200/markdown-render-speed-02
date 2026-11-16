# Build log — markdown-render-speed-02

## Approach

`parse.js` is an original, dependency-free ES module that reproduces marked 18.1.3
(default options: gfm on, breaks off, pedantic off, async off) byte for byte.
It was written from scratch in its own structure — block tokenizer trying
constructs in precedence order, inline tokenizer walking paragraph text with
first-character dispatch, token tree + renderer — after studying marked's
source only to learn exact edge-case behavior (escapes, entities, link
reference definitions, tables, task lists, autolinks, raw HTML blocks,
hard breaks, emphasis precedence). No marked source was copied.

Speed strategy: regexps kept out of hot paths, `charCodeAt`/`indexOf` scans,
precomputed tables, cached indent/list regexes, a plain-text fast path for
paragraphs with no markup characters, first-line-shape dispatch in the block
tokenizer, and a cheap defined-label gate before the reference-link masking
pass.

## Verification

- Practice set: 720 cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples,
  40 generated documents, ~2.86M chars total).
- Byte-for-byte comparison against `practice/reference/expected.json`:
  **720/720 PASS**.
- Kit scorer (`program/scorer/main.ts`):
  `{"passed":1,"cases_passed":720,"cases_total":720}` — every spec group and
  all 40 generated documents pass.
- No overfitting: the scored set is drawn from a different seed, so the
  renderer implements the spec faithfully rather than memorizing cases.

## Benchmark (this machine, Node 22, full 720-case set, 5 runs)

| implementation | time per run |
|---|---|
| marked 18.1.3 baseline (`baselines/parse.js`) | ~702–781 ms (avg ~733 ms) |
| this entry (`parse.js`) | ~501–594 ms (avg ~535 ms) |

Speedup: **~1.4–1.6x** (earlier runs: ~500 ms vs ~780 ms, 1.56x).
Spec-only cases take ~13 ms; the 40 generated documents dominate.

## Files

- `parse.js` — the renderer (dependency-free ES module, exports `parse`).
- `main.ts` — driver: reads `$MAKEFUN_INPUT_DIR/cases.json`, writes
  `$MAKEFUN_OUTPUT_DIR/html.json`.
- `README.md`, `BUILD_LOG.md` — this file.
- `LICENSE`, `.makefun/owner.json` — from the kit init (base commit).
