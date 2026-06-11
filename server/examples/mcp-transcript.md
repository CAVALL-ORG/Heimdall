# Example MCP Transcript (MVP)

## 1) Load SMILES

Tool: `load_smiles`

```json
{
  "smiles": "CCO"
}
```

## 2) Export state

Tool: `get_state`

```json
{
  "includeMolfile": true
}
```

## 3) Change bond order

Tool: `set_bond_order`

```json
{
  "bondId": 0,
  "order": 2
}
```

## 4) Set atom charge

Tool: `set_atom_charge`

```json
{
  "atomId": 0,
  "charge": 1
}
```

## 5) Export updated SMILES

Tool: `export_smiles`

```json
{}
```

## Verified runtime test run

Command:

```bash
npm run test:e2e -w server
```

Observed output:

```text
✓ tests/runtime.e2e.test.ts (4 tests) 3692ms
  ✓ loads smiles and exports state
  ✓ updates bond order, atom charge, and atom radical
  ✓ resets to a previous snapshot and computes diff
  ✓ returns standalone OCR failure for image ingestion
```
