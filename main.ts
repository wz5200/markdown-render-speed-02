// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` (Node 22) in a fresh container with
// no network, 1 CPU, 1024 MB and a 20 s wall budget. It reads every case
// from /input/cases.json (a JSON array of { id, markdown }), renders each
// one alone with parse() from ./parse.js, and writes /output/html.json: a
// JSON array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
