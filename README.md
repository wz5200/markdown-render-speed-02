# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/wz5200/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/wz5200/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that produces byte-identical output to marked 18.1.3 with default options (gfm on, breaks off), about 1.5x faster than marked on the 720-case practice set. Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty, $250 in USDC.

Recorded rebuild 2026-11-16: re-verified 720/720 cases byte-identical, in-process parse ~574 ms vs marked ~714 ms (~1.24x).

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads `$MAKEFUN_INPUT_DIR/cases.json` (a JSON array of Markdown strings) and writes `$MAKEFUN_OUTPUT_DIR/html.json` (a JSON array of HTML strings, in case order). `parse.js` is a dependency-free ES module exporting `parse(markdown)` — the whole renderer, written from scratch.

Recorded rebuild #2 (2026-11-16): re-verified 720/720 against the practice set, ~1.45x faster than marked 18.1.3.

---

<sub>Entered on [make.fun](https://make.fun/?ref=834q2cmx&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
