# Ketcher Agent Basic Editing Test Suite

## Purpose

This document defines a first-pass test suite for a Claude Code agent that uses Ketcher through a backend-facing tool layer.

The goal of this suite is **not** to test scientific reasoning. It is only to test whether the agent can reliably:

1. ingest a molecule from SMILES or image,
2. load it into Ketcher,
3. inspect atom and bond IDs/state,
4. perform exactly the requested edit,
5. export the updated molecule,
6. report what changed without making unrelated edits.

This suite assumes a typed tool surface roughly like:

- `load_smiles(smiles)`
- `load_image(image)`
- `get_state()`
- `export_smiles()`
- `export_ket()`
- `set_bond_order(bond_id, order)`
- `set_atom_charge(atom_id, charge)`
- `set_atom_radical(atom_id, radical_state)`
- `layout()`
- `clean()`
- `reset_to_snapshot(snapshot_id)`
- `diff_state(before, after)`

Adjust names as needed to match the actual MCP server.

---

## General Evaluation Rules

For every test:

- The agent should obey the exact requested action.
- The agent should not make extra edits unless explicitly instructed.
- The agent should not explain chemistry unless asked.
- The agent should return the requested fields only.
- The preferred oracle is the structured state (`KET`, atom table, bond table, diff), not only the final SMILES.

A test fails if the agent:

- edits the wrong atom or bond,
- performs additional unrequested mutations,
- returns the wrong format,
- silently repairs invalid input,
- or leaves the editor in a corrupted state.

---

## Standard Return Contract

Unless otherwise specified, require the agent to return:

- `before_smiles`
- `after_smiles`
- `before_snapshot`
- `after_snapshot`
- `changed_atoms`
- `changed_bonds`
- `summary`

If available, also capture:

- `before_ket_hash`
- `after_ket_hash`
- `recent_events`

---

## Scoring Rubric

Score each test out of 10:

- 2 points: correct ingestion/loading
- 2 points: correct target identification
- 2 points: exactly the requested edit
- 2 points: correct return format/artifacts
- 2 points: state integrity preserved

Recommended threshold before moving to scientific reasoning:

- 90%+ pass rate on deterministic tests
- 0 silent state corruptions
- 0 extra edits on single-mutation tests

---

## Fixtures

Suggested fixtures:

### SMILES fixtures
- `CCO` — ethanol
- `c1ccccc1` — benzene
- `CC(C)O` — isopropanol
- `C` — methane
- `[CH3+]` or equivalent charged example
- a simple radical example if radical support is implemented

### Image fixtures
Use clean, high-contrast images for:
- ethanol
- benzene

### Observed IDs from prior runs
Use these concrete IDs unless your runtime shows different ones:

#### `CCO`
- atoms:
  - `0:C`
  - `1:C`
  - `2:O`
- bonds:
  - `0:(0-1, order 1)`
  - `1:(1-2, order 1)`

#### `c1ccccc1`
- atoms:
  - `0:C`
  - `1:C`
  - `2:C`
  - `3:C`
  - `4:C`
  - `5:C`
- bonds:
  - `0:(0-1, order 4)`
  - `1:(1-2, order 4)`
  - `2:(2-3, order 4)`
  - `3:(3-4, order 4)`
  - `4:(4-5, order 4)`
  - `5:(5-0, order 4)`

#### `C`
- atoms:
  - `0:C`

---

## Test Set A — Ingestion and Export

### A1. Load simple SMILES and export state

**Prompt**
> Load this SMILES into Ketcher: `CCO`  
> Return only:
> 1. exported SMILES  
> 2. whether the structure is empty  
> 3. atom table with atom ID, element, charge, radical  
> 4. bond table with bond ID, atom1 ID, atom2 ID, order

**Pass criteria**
- Structure is not empty.
- Atom table has 3 atoms.
- Bond table has 2 bonds.
- No charges or radicals appear.
- Export succeeds.

---

### A2. Load aromatic SMILES

**Prompt**
> Load this SMILES into Ketcher: `c1ccccc1`  
> Return only:
> 1. exported SMILES  
> 2. atom table  
> 3. bond table  
> 4. whether the structure is a reaction

**Pass criteria**
- Structure is not empty.
- Structure is not a reaction.
- Atom table has 6 atoms.
- Bond table has 6 bonds.
- Export succeeds.

---

### A3. Invalid SMILES should fail cleanly

**Prompt**
> Try to load this SMILES into Ketcher: `C1(CC`  
> Do not guess or repair it.  
> Return only:
> 1. success or failure  
> 2. error message  
> 3. whether current state changed

**Pass criteria**
- Load fails cleanly.
- State remains unchanged or empty.
- No silent repair occurs.

---

### A4. OCR image happy path

**Prompt**
> Load the attached molecule image into Ketcher using OCR.  
> Return only:
> 1. recognized SMILES  
> 2. atom table  
> 3. bond table  
> 4. whether OCR succeeded

**Pass criteria**
- OCR succeeds.
- Structure is plausible and non-empty.
- Atom and bond tables are populated.
- Export succeeds.

**Note**
- If OCR is not yet implemented in the current build, this test should be marked blocked rather than silently skipped.

---

## Test Set B — Pure State Inspection

### B1. List IDs only

**Prompt**
> Load `CCO` into Ketcher.  
> Do not edit anything.  
> Return only:
> 1. sorted atom IDs with element labels  
> 2. sorted bond IDs with endpoints and order  
> 3. total atom count  
> 4. total bond count

**Pass criteria**
- Accurate listing of atoms and bonds.
- No mutation occurs.

---

### B2. Snapshot creation

**Prompt**
> Load `CCO` into Ketcher.  
> Save a snapshot named `baseline`.  
> Return only:
> 1. snapshot ID  
> 2. exported SMILES  
> 3. KET hash

**Pass criteria**
- Snapshot is created.
- Snapshot ID is returned.
- Export succeeds.

---

## Test Set C — Single-Edit Execution

### C1. Change one bond order

**Prompt**
> Load `CCO` into Ketcher.  
> Change bond `0` to order `2`.  
> Do not make any other edits.  
> Return only:
> 1. before SMILES  
> 2. after SMILES  
> 3. changed bond IDs  
> 4. changed atom IDs  
> 5. one-sentence diff summary

**Pass criteria**
- Exactly one bond order changes.
- No atom count change occurs.
- No unrelated bond changes occur.
- Changed bond list contains only the target bond.

---

### C2. Set atom charge

**Prompt**
> Load `CCO` into Ketcher.  
> Set atom `0` to formal charge `+1`.  
> Do not change any other atom or bond.  
> Return only:
> 1. before SMILES  
> 2. after SMILES  
> 3. changed atom IDs  
> 4. changed bond IDs  
> 5. atom table rows for changed atoms only

**Pass criteria**
- Exactly one atom charge changes.
- No bond changes occur.
- No atom count change occurs.

---

### C3. Set atom radical

**Prompt**
> Load `C` into Ketcher.  
> Set atom `0` radical state to `1`.  
> Return only:
> 1. before SMILES  
> 2. after SMILES  
> 3. changed atom IDs  
> 4. radical state of that atom

**Pass criteria**
- Exactly one atom radical changes.
- No bond changes occur.
- Export succeeds.

---

### C4. Two-step edit with explicit sequencing

**Prompt**
> Load `CCO` into Ketcher.  
> First set atom `0` charge to `+1`.  
> Then set bond `1` to order `2`.  
> Return only:
> 1. before SMILES  
> 2. after SMILES  
> 3. ordered list of operations performed  
> 4. changed atom IDs  
> 5. changed bond IDs

**Pass criteria**
- Exactly the two requested edits occur.
- No extras occur.
- Operations are reported in the correct order.

---

## Test Set D — No-Unintended-Change Tests

### D1. Mutation locality

**Prompt**
> Load `CCO` into Ketcher.  
> Set atom `2` charge to `-1`.  
> Return only:
> 1. changed atoms  
> 2. changed bonds  
> 3. total atom count before and after  
> 4. total bond count before and after

**Pass criteria**
- Only the requested atom changes.
- Bond count is unchanged.
- Atom count is unchanged.

---

### D2. No auto-clean unless asked

**Prompt**
> Load `CCO` into Ketcher.  
> Change bond `0` to order `2`.  
> Do not run cleanup or layout.  
> Return only:
> 1. whether cleanup was run  
> 2. whether layout was run  
> 3. changed bonds  
> 4. changed atoms

**Pass criteria**
- No cleanup or layout occurs unless explicitly requested.
- Only the requested structural mutation occurs.

---

### D3. Cleanup only when asked

**Prompt**
> Load `CCO` into Ketcher.  
> Change bond `0` to order `2`, then run cleanup.  
> Return only:
> 1. structural diff  
> 2. whether cleanup was run  
> 3. whether any atom or bond identities changed

**Pass criteria**
- Cleanup is reported.
- The requested mutation remains present.
- ID instability, if any, is clearly reported.

---

## Test Set E — Reset and Rollback

### E1. Reset to snapshot

**Prompt**
> Load `CCO` into Ketcher.  
> Save a snapshot named `baseline`.  
> Change bond `0` to order `2`.  
> Reset to `baseline`.  
> Return only:
> 1. baseline SMILES  
> 2. post-edit SMILES  
> 3. final SMILES after reset  
> 4. whether final state matches baseline

**Pass criteria**
- Final state matches baseline exactly or by snapshot/KET hash.
- No residue from the edit remains.

---

### E2. Failed edit rollback

**Prompt**
> Load `CCO` into Ketcher.  
> Attempt to change bond `999999` to order `2`.  
> Return only:
> 1. success or failure  
> 2. error message  
> 3. whether state changed  
> 4. current SMILES

**Pass criteria**
- Edit fails.
- State remains unchanged.
- Error is explicit.

---

## Test Set F — ID Targeting and Precision

### F1. Distinguish atoms precisely

**Prompt**
> Load `CCO` into Ketcher.  
> Set charge `+1` on atom `2` only, and do not modify atom `0` or atom `1`.  
> Return only:
> 1. changed atom IDs  
> 2. atom table rows for all atoms

**Pass criteria**
- Only atom `2` changes.
- Atom `0` and atom `1` remain unchanged.

---

### F2. Distinguish similar bonds precisely

**Prompt**
> Load `c1ccccc1` into Ketcher.  
> Change only bond `0` to order `1`.  
> Do not modify bonds `1`, `2`, `3`, `4`, or `5`.  
> Return only:
> 1. changed bond IDs  
> 2. full bond table before and after

**Pass criteria**
- Exactly one bond changes.
- The correct bond changes.

**Note**
- Because aromatic editing may trigger representation-related propagation, treat this as a soft precision test rather than a hard fail if the editor normalizes related bond representations.

---

## Test Set G — Return-Format Obedience

### G1. Exact JSON output

**Prompt**
> Load `CCO` into Ketcher.  
> Change bond `0` to order `2`.  
> Return valid JSON only with these keys:
> `before_smiles`, `after_smiles`, `changed_atoms`, `changed_bonds`, `summary`

**Pass criteria**
- Output is valid JSON.
- No extra prose appears.
- Only the required keys are present.

---

### G2. No hidden reasoning

**Prompt**
> Load `CCO` into Ketcher.  
> Set atom `0` charge to `+1`.  
> Return only the requested fields. Do not explain chemistry or justify the edit.

**Pass criteria**
- No extra reasoning appears.
- Mechanical execution only.

---

## Test Set H — Repeated-Session Robustness

### H1. Repeated edit cycle

**Prompt**
> Load `CCO`.  
> Perform these steps in order:
> 1. set atom `0` charge to `+1`
> 2. set atom `0` charge back to `0`
> 3. set bond `0` to order `2`
> 4. set bond `0` back to order `1`
> Return only:
> 1. final SMILES  
> 2. whether final state matches initial state  
> 3. list of operations performed

**Pass criteria**
- Final state matches initial state.
- No drift occurs after repeated edits.

---

### H2. Multi-molecule session

**Prompt**
> Load `CCO`, return exported SMILES.  
> Then load `c1ccccc1`, return exported SMILES.  
> Then load `C`, return exported SMILES.  
> Return only the three exported SMILES in order.

**Pass criteria**
- No stale state leakage occurs between molecules.
- Each load cleanly replaces the previous structure.

---

## Minimal Starter Suite

If you only want the smallest useful suite before moving on, run these first:

1. A1 — Load simple SMILES and export state
2. B1 — List atom and bond IDs
3. C1 — Change one bond order
4. C2 — Set one atom charge
5. E2 — Failed edit rollback
6. E1 — Reset to snapshot

This six-test suite is enough to validate the core ingest → inspect → mutate → export → recover loop.

---

## Suggested Test Harness Notes

- Prefer asserting on structured state diffs instead of raw SMILES alone.
- Keep prompts highly explicit and mechanical.
- Use exact atom IDs and bond IDs taken from prior inspection steps.
- Do not ask the agent to infer chemistry.
- Do not mix reasoning tests into this suite.

---

## Ready-to-Use Evaluation Template

For each run, record:

- Test ID
- Input prompt
- Pass/Fail
- Failure category:
  - ingestion failure
  - wrong target ID
  - extra mutation
  - wrong output format
  - rollback failure
  - state corruption
- Notes
- Before SMILES
- After SMILES
- Before snapshot/hash
- After snapshot/hash

---

## Exit Criteria Before Scientific Reasoning

Do not move to scientific reasoning until the agent can reliably:

- ingest SMILES,
- ingest images if OCR is in scope,
- expose atom and bond IDs,
- perform one explicit edit exactly,
- export before/after state,
- reset or roll back on failure,
- and obey strict output formatting.

A good practical standard is:

- 90%+ pass rate on this suite,
- no silent corruption,
- and no repeated pattern of extra edits.
