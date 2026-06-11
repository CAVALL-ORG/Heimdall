A1

A2
exported SMILES
c1ccccc1

atom table
id	element	charge	radical
0	C	null	0
1	C	null	0
2	C	null	0
3	C	null	0
4	C	null	0
5	C	null	0

bond table
id	atom1	atom2	order
0	0	1	4
1	1	2	4
2	2	3	4
3	3	4	4
4	4	5	4
5	5	0	4

whether Ketcher marks the structure as a reaction
false

A3
failure
Mutation "load_smiles" failed: page.evaluate: Error: Convert error! Given string could not be loaded as (query or plain) molecule or reaction, see the error messages: 'molecule auto loader: SMILES loader: cycle 1 not closed', 'scanner: BufferScanner::read() error', 'scanner: BufferScanner::read() error', 'molecule auto loader: SMILES loader: cycle 1 not closed', 'molecule auto loader: SMILES loader: cycle 1 not closed', 'scanner: BufferScanner::read() error'
no

A4
- recognized SMILES C1CCCCC1

- atom table | id | element | charge | radical | |---:|:-------:|-------:|--------:| | 0 | C | null | 0 | | 1 | C | null | 0 | | 2 | C | null | 0 | | 3 | C | null | 0 | | 4 | C | null | 0 | | 5 | C | null | 0 |

- bond table | id | atom1 | atom2 | order | |---:|------:|------:|------:| | 0 | 0 | 1 | 1 | | 1 | 1 | 2 | 1 | | 2 | 2 | 3 | 1 | | 3 | 3 | 4 | 1 | | 4 | 4 | 5 | 1 | | 5 | 0 | 5 | 1 |

- whether OCR succeeded true

B1 
- Atom IDs (sorted): 0:C, 1:C, 2:O

- Bond IDs (sorted): 0:(0-1, order 1), 1:(1-2, order 1)

- Total atom count: 3

- Total bond count: 2

B2
- snap_2

- CCO

- 076a1b5130495b4d5f787d8292954692932925b704aaa3474460a3762735187a

C1
- CCO

- C=CO

- [0]

- []

- Bond 0 (atoms 0-1) was changed from order 1 to order 2, with no atom-level changes.

C2
- CCO

- [CH2+]CO

- [0]

- []

- id element charge radical 0 C 1 0

C3
- C

- [CH2]

- [0]

- 1


C4
- `CCO`

- `[CH3+]C=O`

- 1. Loaded `CCO` into Ketcher 2) Set atom `0:C` charge to `+1` 3) Set bond `1:(1-2, order 1)` to order `2`

- `0, 1, 2`

- `1`

D1
1. changed atoms: atom 2 charge 0 → -1
2. changed bonds: none
3. total atom count before and after: 3 → 3
4. total bond count before and after: 2 → 2

D2
- false

- false

- [0]

- []

D3
