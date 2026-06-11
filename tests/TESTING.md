# Testing Heimdall

This is the public runbook for the Heimdall test tree. Heimdall ships three
skills — `heimdall-image-rebuild` (image → SMILES), `heimdall-pdf-extract`
(PDF → crops → image-rebuild), and `heimdall-ingest` (SMILES / molfile →
canonical) — and the tests exercise those three only.

There are two layers:

1. **Unit / integration suite** (`server/tests/unit`, `server/tests/runtime-e2e`)
   — deterministic, no agent, run with vitest.
2. **Agent-orchestrated image → SMILES eval** (`tests/ketcher/image-to-smiles/manifest.jsonl`)
   — a vision-capable agent transcribes each image, and `tests/scientific/runner/grader.py`
   grades the result deterministically.

> The chemistry-reasoning eval that used to live in
> `tests/scientific/manifest.jsonl` tested the `chem-*` reasoning skills,
> which are not part of Heimdall. That manifest is now empty; the
> **image → SMILES suite is the primary eval**. The grader, prompts, and
> shared image fixtures under `tests/scientific/` are kept because the
> image suite reuses them.

---

## Setup — a clean test environment

The MCP server is Node-only and needs no Python. The **eval grader** (RDKit),
the manifest / complexity tooling, the panel utility (Pillow), and the optional
**Indigo** shim do. Create one isolated venv for all of it, from the repo root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
export HEIMDALL_PYTHON="$PWD/.venv/bin/python"   # lets the server auto-start Indigo
```

`.venv/` is gitignored. This single venv both runs the grader and enables
canonical SMILES + full CIP/wedge stereo at runtime (via `HEIMDALL_PYTHON`). The
**vitest unit suite (§1) needs none of this** — only Node + Chromium.

---

## 1. Unit / integration suite (vitest)

Fast, deterministic, no agent or network required.

```bash
cd server
npx vitest run tests/unit
```

Expected: the suite passes except for three known `paclitaxel` /
`detect-unexplained-ink` cases that are pinned to a baked affine mapping of
a committed hi-res fixture (re-rendering the fixture would change the
mapping). These three are documented as a known-failing recalibration gate,
not a regression.

The bridge end-to-end suite needs a headless Chromium (installed
automatically on `npm install` via the `postinstall` hook) and, for the
stereo rows, a reachable Indigo service:

```bash
cd server
RUN_KETCHER_E2E=1 npx vitest run tests/runtime-e2e
```

Type-check and dependency-audit gates:

```bash
cd server
npm run typecheck   # authoritative tsc (src/ only)
npm run audit       # npm audit --audit-level=moderate
```

---

## 2. Agent-orchestrated image → SMILES eval

This eval measures whether a vision-capable agent, given **only the image**,
can reconstruct the molecule via Ketcher graph primitives and export the
correct SMILES — the core Heimdall capability.

### What the manifest contains

`tests/ketcher/image-to-smiles/manifest.jsonl` — one JSON row per case.
Each row carries an `image_path` plus the **answer fields** the grader needs
*afterward*:

- `expected_smiles`, `expected_canonical_smiles`
- `acceptable_smiles`, `acceptable_canonical_smiles`
- `forbidden_smiles`, `forbidden_canonical_smiles`
- `inchi_key`
- `expected_features`
- `required_trace_events`

The image fixtures resolve through
`tests/ketcher/image-to-smiles/images`, a symlink into the shared pool at
`tests/scientific/images/`. Provenance for every fixture is in
[FIXTURES.md](./FIXTURES.md).

### ⚠️ Never paste the answer fields into the agent

**The agent must see only the task and the image — never the answer fields.**
The runner deliberately constructs the agent's prompt from just
`{ id, prompt, image_path }`; the answer fields above are withheld at
prompt-construction time and read **only by the grader, after the agent has
finished**. If you run a row by hand, give the agent the prompt and the image
path and nothing else. Pasting `expected_canonical_smiles`, `inchi_key`,
`expected_features`, `acceptable_*`, `forbidden_*`, or `required_trace_events`
into the agent's context invalidates the result — the agent can then echo the
answer instead of transcribing the pixels. The whole point of the eval is
that Ketcher (not the agent's memory) is the source of truth for the SMILES.

### Running one row by hand

1. **Start the headless Ketcher runtime / MCP server.** From `server/`:

   ```bash
   cd server
   npm run mcp:start
   ```

   (Stereo rows and `export_smiles({ canonical: true })` additionally need a
   reachable Indigo service; see the project setup notes.)

2. **Point a vision-capable agent at the row.** Give it ONLY the row's
   `prompt` and its `image_path`. The agent should:
   read the image → draft a graph (atoms + bonds + rings + counts) →
   validate → build it in Ketcher → export the SMILES Ketcher emits. It must
   never type a SMILES from memory or from the filename.

3. **Capture the agent's trace and final SMILES.** The agent emits
   `TRACE:` lines (the Ketcher operations it called) and a final
   `SMILES:` line (or a refusal, with no SMILES).

4. **Grade deterministically** with the row's answer fields:

   ```bash
   python3 tests/scientific/runner/grader.py \
     --row '<the JSON manifest row>' \
     --trace <path to the captured trace JSON> \
     --transcript <path to the captured transcript JSON> \
     --out <path to write the grade JSON>
   ```

   The grader needs Python 3 with RDKit (`python3 -c "from rdkit import Chem"`;
   `pip install rdkit` works on most platforms). It compares the agent's
   exported SMILES against the manifest answers and checks the trace gates
   (no `load_smiles` / `load_canonical` shortcut on an image-rebuild row, a
   real export, required operations present).

### Running the whole suite

The full suite is driven by an orchestrator agent that, for each row, spawns
a runner sub-agent (which sees only `{ id, prompt, image_path }`) and an
evaluator sub-agent (which reads the answer fields and calls `grader.py`).
This separation is what enforces the answer-field withholding above — the
runner sub-agent's context never contains the answers. If you build your own
harness, preserve that separation: construct the agent prompt from
`{ id, prompt, image_path }` only, and pass the answer fields to the grader
exclusively.

---

## Grading rule: image-truth, not chemistry-equivalence

For an image row, the graded answer is **what the image shows**, not whatever
canonicalizes to the same molecule under InChI / RDKit normalization.

- A pyridine drawn in a file named `benzene.png` is graded as **pyridine**.
  The filename is untrusted; the pixels are the truth.
- A drawn N–H lactam tautomer must **not** be accepted as the
  chemically-equivalent C=N enol form, even though InChI normalization erases
  the difference — the human reading the deliverable cannot.

Features that survive the image-truth gate but get erased by naive
canonicalization: drawn tautomer / protomer / drawn-H placement, drawn
C=N / C=O double-bond positions, formal charges, stereo (wedge / dash, E/Z),
and multi-fragment salts. The evaluator's vision-compare step enforces this;
do not bypass it by relying on a canonical-SMILES string match alone.

---

## Negative controls and refusals

Some rows are **not** molecules (a reaction arrow, a spectrum, a blank, a
Markush / R-group panel, a too-low-resolution crop). The correct behavior is
a pixel-grounded **refusal** with no SMILES. The grader's
`safe_failure_plus_no_invented_smiles` and `image_refusal_evaluator` modes
fail any row that fabricates a SMILES or takes a forbidden shortcut instead
of refusing.
