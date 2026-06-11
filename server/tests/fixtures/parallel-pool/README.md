# parallel-pool fixtures

Three vision-transcribed GraphIntents, copied verbatim from proven solo
image-rebuild runs (2026-06-06). Used by
`tests/runtime-e2e/parallel-pool.e2e.test.ts` to replay identical inputs
solo and concurrently on the runtime pool — any export delta is cross-row
interference, not vision variance.

Provenance (gitignored source run dirs; durable record in the
pool-vs-multiplex parallelism decision):

| fixture | source row | source run | heavy atoms | solo InChIKey |
|---|---|---|---|---|
| `A004.graph.json` | A004 (taxol core, 11 stereocenters) | `outputs/a004-probe-2026-06-06/cur1/` | 62 | `RCINICONZNJXQF-MZXODVADSA-N` |
| `A009.graph.json` | A009 | `outputs/parallel-3row-shared-canvas/rows/A009/` | 59 | `JXLYSJRDGCGARV-KSYZXUFCSA-N` |
| `A011.graph.json` | A011 | `outputs/parallel-3row-shared-canvas/rows/A011/` | 35 | `HINDCSLBLBWIIV-HWFPZXRZSA-N` |

These are pixel transcripts (atoms + bonds + rings + counts), not SMILES —
replaying them through `build_from_graph` → `export_smiles` is the
Ketcher-authored path; no SMILES is hand-authored anywhere in the test.
