# Manifest audit report

- Total rows audited: **180**
- Errors: **0**
- Warnings: **51**
- Info notes: **5**


Severity legend: **error** — internal contradiction (manifest should be fixed); **warn** — likely bug or stale value; **info** — soft signal, may be intentional.


## tests/ketcher/image-to-smiles/manifest.jsonl
- Rows: 98; flagged: 54

### A002 (image_to_smiles)
- fixture: `tests/scientific/images/images/academic/penicillin_g.png`
- manifest SMILES: `CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)Cc3ccccc3)C(=O)O)C`
- RDKit canonical: `CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O`
- notes: penicillin G β-lactam (CC-licensed source) Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O'

### A003 (image_to_smiles)
- fixture: `tests/scientific/images/images/academic/cholesterol.png`
- manifest SMILES: `C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C`
- RDKit canonical: `CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C`
- notes: cholesterol steroid skeleton Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C'
  - **INFO** [wedges_lt_stereocenters] expected_features.wedges=6 < RDKit stereocenters=8 (may be intentional partial-stereo drawing or an undercount)

### A004 (image_to_smiles)
- fixture: `tests/scientific/images/images/academic/taxol_core.png`
- manifest SMILES: `CC(=O)O[C@H]1C(=O)[C@@]2(C)[C@H]([C@H](OC(=O)c3ccccc3)[C@]3(O)C[C@H](OC(=O)[C@H](O)[C@@H](NC(=O)c4ccccc4)c4ccccc4)C(C)=C1C3(C)C)[C@]1(OC(C)=O)CO[C@@H]1C[C@@H]2O`
- notes: Full paclitaxel (taxol). Updated 2026-05-15: filename says 'taxol_core' but the image is full paclitaxel (N-benzoyl phenylisoserine side chain + benzoate ester + 2'-OH all visible — confirmed by image…
  - **INFO** [wedges_lt_stereocenters] expected_features.wedges=10 < RDKit stereocenters=11 (may be intentional partial-stereo drawing or an undercount)

### A005 (image_to_smiles)
- fixture: `tests/scientific/images/images/academic/glucose_pyranose.png`
- manifest SMILES: `OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O`
- notes: α-D-glucose pyranose form. Fixed 2026-05-20: previous expected SMILES was β-anomer despite the image and these notes naming the α-anomer; corrected to α-anomer canonical. Grading: flat (connectivity) …
  - **INFO** [wedges_lt_stereocenters] expected_features.wedges=4 < RDKit stereocenters=5 (may be intentional partial-stereo drawing or an undercount)

### W002 (image_to_smiles)
- fixture: `tests/scientific/images/images/wikipedia/caffeine_wiki.png`
- manifest SMILES: `Cn1cnc2c1c(=O)n(C)c(=O)n2C`
- RDKit canonical: `Cn1c(=O)c2c(ncn2C)n(C)c1=O`
- notes: Wikimedia Commons: caffeine Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='Cn1c(=O)c2c(ncn2C)n(C)c1=O'

### W003 (image_to_smiles)
- fixture: `tests/scientific/images/images/wikipedia/morphine_wiki.png`
- manifest SMILES: `CN1CC[C@]23c4c5ccc(O)c4O[C@H]2[C@@H](O)C=C[C@H]3[C@H]1C5`
- notes: Wikimedia Commons: morphine Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **INFO** [wedges_lt_stereocenters] expected_features.wedges=4 < RDKit stereocenters=5 (may be intentional partial-stereo drawing or an undercount)

### W004 (image_to_smiles)
- fixture: `tests/scientific/images/images/wikipedia/nicotine_wiki.png`
- manifest SMILES: `CN1CCC[C@H]1c2cccnc2`
- RDKit canonical: `CN1CCC[C@H]1c1cccnc1`
- notes: Wikimedia Commons: nicotine Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CN1CCC[C@H]1c1cccnc1'

### W005 (image_to_smiles)
- fixture: `tests/scientific/images/images/wikipedia/penicillin_wiki.png`
- manifest SMILES: `CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)Cc3ccccc3)C(=O)O)C`
- RDKit canonical: `CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O`
- notes: Wikimedia Commons: penicillin G Grading: flat (connectivity) chemistry_gate + visual evaluator gate.
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O'

### W006 (image_to_smiles)
- fixture: `tests/scientific/images/images/wikipedia/glucose_wiki.png`
- manifest SMILES: `OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O`
- notes: Wikimedia Commons: α-D-glucose. Fixed 2026-05-20: previous expected SMILES was β-anomer despite the image and these notes naming the α-anomer; corrected to α-anomer canonical. Grading: flat (connectiv…
  - **INFO** [wedges_lt_stereocenters] expected_features.wedges=4 < RDKit stereocenters=5 (may be intentional partial-stereo drawing or an undercount)

### D006 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/paracetamol.png`
- manifest SMILES: `CC(Nc1ccc(O)cc1)=O`
- RDKit canonical: `CC(=O)Nc1ccc(O)cc1`
- notes: drug: Acetaminophen — para-hydroxyacetanilide. Source: PubChem CID 1983. Ketcher-rendered fixture (images/diverse/paracetamol.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC(=O)Nc1ccc(O)cc1'

### D008 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/diazepam.png`
- manifest SMILES: `CN1c2c(cc(cc2)Cl)C(c2ccccc2)=NCC1=O`
- RDKit canonical: `CN1C(=O)CN=C(c2ccccc2)c2cc(Cl)ccc21`
- notes: drug: 1,4-benzodiazepine, aryl chloride. Source: PubChem CID 3016. Ketcher-rendered fixture (images/diverse/diazepam.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CN1C(=O)CN=C(c2ccccc2)c2cc(Cl)ccc21'

### D009 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/ciprofloxacin.png`
- manifest SMILES: `O=C(c1c(=O)c2c(cc(c(c2)F)N2CCNCC2)[n](C2CC2)c1)O`
- RDKit canonical: `O=C(O)c1cn(C2CC2)c2cc(N3CCNCC3)c(F)cc2c1=O`
- notes: drug: Fluoroquinolone antibiotic. Source: PubChem CID 2764. Ketcher-rendered fixture (images/diverse/ciprofloxacin.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='O=C(O)c1cn(C2CC2)c2cc(N3CCNCC3)c(F)cc2c1=O'

### D010 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/chloramphenicol.png`
- manifest SMILES: `OC(c1ccc([N+]([O-])=O)cc1)C(CO)NC(C(Cl)Cl)=O`
- RDKit canonical: `O=C(NC(CO)C(O)c1ccc([N+](=O)[O-])cc1)C(Cl)Cl`
- notes: drug: Dichloroacetamide + nitroaromatic. Source: PubChem CID 5959. Ketcher-rendered fixture (images/diverse/chloramphenicol.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='O=C(NC(CO)C(O)c1ccc([N+](=O)[O-])cc1)C(Cl)Cl'

### D011 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/thiophene.png`
- manifest SMILES: `c1cscc1`
- RDKit canonical: `c1ccsc1`
- notes: heterocycle: 5-ring, sulfur. Source: PubChem CID 8030. Ketcher-rendered fixture (images/diverse/thiophene.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccsc1'

### D012 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/furan.png`
- manifest SMILES: `c1cocc1`
- RDKit canonical: `c1ccoc1`
- notes: heterocycle: 5-ring, oxygen. Source: PubChem CID 8029. Ketcher-rendered fixture (images/diverse/furan.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccoc1'

### D013 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/pyrrole.png`
- manifest SMILES: `c1c[nH]cc1`
- RDKit canonical: `c1cc[nH]c1`
- notes: heterocycle: 5-ring, NH. Source: PubChem CID 8027. Ketcher-rendered fixture (images/diverse/pyrrole.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1cc[nH]c1'

### D014 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/imidazole.png`
- manifest SMILES: `c1[nH]cnc1`
- RDKit canonical: `c1c[nH]cn1`
- notes: heterocycle: 5-ring, 1,3-diaza. Source: PubChem CID 795. Ketcher-rendered fixture (images/diverse/imidazole.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1c[nH]cn1'

### D015 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/pyrazole.png`
- manifest SMILES: `c1n[nH]cc1`
- RDKit canonical: `c1cn[nH]c1`
- notes: heterocycle: 5-ring, 1,2-diaza. Source: PubChem CID 1048. Ketcher-rendered fixture (images/diverse/pyrazole.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1cn[nH]c1'

### D016 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/thiazole.png`
- manifest SMILES: `c1ncsc1`
- RDKit canonical: `c1cscn1`
- notes: heterocycle: 5-ring, S+N. Source: PubChem CID 9275. Ketcher-rendered fixture (images/diverse/thiazole.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1cscn1'

### D017 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/oxazole.png`
- manifest SMILES: `c1cnco1`
- RDKit canonical: `c1cocn1`
- notes: heterocycle: 5-ring, O+N. Source: PubChem CID 9255. Ketcher-rendered fixture (images/diverse/oxazole.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1cocn1'

### D018 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/pyrimidine.png`
- manifest SMILES: `c1nccnc1`
- RDKit canonical: `c1cnccn1`
- notes: heterocycle: 6-ring, 1,3-diaza. Source: PubChem CID 9260. Ketcher-rendered fixture (images/diverse/pyrimidine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1cnccn1'

### D019 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/quinoline.png`
- manifest SMILES: `c1cc2c(nccc2)cc1`
- RDKit canonical: `c1ccc2ncccc2c1`
- notes: heterocycle: Benzo-fused pyridine. Source: PubChem CID 7047. Ketcher-rendered fixture (images/diverse/quinoline.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccc2ncccc2c1'

### D020 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/isoquinoline.png`
- manifest SMILES: `c1cc2c(cncc2)cc1`
- RDKit canonical: `c1ccc2cnccc2c1`
- notes: heterocycle: Benzo-fused pyridine, N at 2. Source: PubChem CID 8405. Ketcher-rendered fixture (images/diverse/isoquinoline.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccc2cnccc2c1'

### D021 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/naphthalene.png`
- manifest SMILES: `c1cc2c(cccc2)cc1`
- RDKit canonical: `c1ccc2ccccc2c1`
- notes: pah: Two fused benzenes. Source: PubChem CID 931. Ketcher-rendered fixture (images/diverse/naphthalene.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccc2ccccc2c1'

### D022 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/anthracene.png`
- manifest SMILES: `c1cc2c(cc3c(c2)cccc3)cc1`
- RDKit canonical: `c1ccc2cc3ccccc3cc2c1`
- notes: pah: Three linearly fused benzenes. Source: PubChem CID 8418. Ketcher-rendered fixture (images/diverse/anthracene.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccc2cc3ccccc3cc2c1'

### D023 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/phenanthrene.png`
- manifest SMILES: `c1cc2c(ccc3c2cccc3)cc1`
- RDKit canonical: `c1ccc2c(c1)ccc1ccccc12`
- notes: pah: Three angularly fused benzenes. Source: PubChem CID 995. Ketcher-rendered fixture (images/diverse/phenanthrene.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='c1ccc2c(c1)ccc1ccccc12'

### D024 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/norbornane.png`
- manifest SMILES: `C1C2CC(CC2)C1`
- RDKit canonical: `C1CC2CCC1C2`
- notes: cage: Bicyclo[2.2.1]heptane. Source: PubChem CID 9233. Ketcher-rendered fixture (images/diverse/norbornane.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C1CC2CCC1C2'

### D025 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/adamantane.png`
- manifest SMILES: `C1C2CC3CC(C2)CC1C3`
- RDKit canonical: `C1C2CC3CC1CC(C2)C3`
- notes: cage: Tricyclic cage hydrocarbon. Source: PubChem CID 9238. Ketcher-rendered fixture (images/diverse/adamantane.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C1C2CC3CC1CC(C2)C3'

### D026 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/camphor.png`
- manifest SMILES: `CC1(C2(C(CC1CC2)=O)C)C`
- RDKit canonical: `CC12CCC(CC1=O)C2(C)C`
- notes: cage: Bicyclic ketone (racemic representation). Source: PubChem CID 159055. Ketcher-rendered fixture (images/diverse/camphor.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC12CCC(CC1=O)C2(C)C'

### D027 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/dmso.png`
- manifest SMILES: `CS(=O)C`
- RDKit canonical: `CS(C)=O`
- notes: sulfur_phos: Dimethyl sulfoxide. Source: PubChem CID 679. Ketcher-rendered fixture (images/diverse/dmso.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CS(C)=O'

### D028 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/sulfanilamide.png`
- manifest SMILES: `Nc1ccc(S(=O)(=O)N)cc1`
- RDKit canonical: `Nc1ccc(S(N)(=O)=O)cc1`
- notes: sulfur_phos: Primary sulfonamide. Source: PubChem CID 5333. Ketcher-rendered fixture (images/diverse/sulfanilamide.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='Nc1ccc(S(N)(=O)=O)cc1'

### D029 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/methanesulfonic_acid.png`
- manifest SMILES: `CS(O)(=O)=O`
- RDKit canonical: `CS(=O)(=O)O`
- notes: sulfur_phos: Sulfonic acid. Source: PubChem CID 6395. Ketcher-rendered fixture (images/diverse/methanesulfonic_acid.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CS(=O)(=O)O'

### D031 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/ethylene_oxide.png`
- manifest SMILES: `C1OC1`
- RDKit canonical: `C1CO1`
- notes: strained: Epoxide. Source: PubChem CID 6354. Ketcher-rendered fixture (images/diverse/ethylene_oxide.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C1CO1'

### D032 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/aziridine.png`
- manifest SMILES: `C1NC1`
- RDKit canonical: `C1CN1`
- notes: strained: 3-ring with N. Source: PubChem CID 9148. Ketcher-rendered fixture (images/diverse/aziridine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C1CN1'

### D034 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/salicylic_acid.png`
- manifest SMILES: `O=C(c1c(O)cccc1)O`
- RDKit canonical: `O=C(O)c1ccccc1O`
- notes: drug: Ortho-hydroxy benzoic acid. Source: PubChem CID 338. Ketcher-rendered fixture (images/diverse/salicylic_acid.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='O=C(O)c1ccccc1O'

### D035 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/metformin.png`
- manifest SMILES: `CN(C(/N=C(/N)\N)=N)C`
- RDKit canonical: `CN(C)C(=N)N=C(N)N`
- notes: drug: Biguanide. Source: PubChem CID 4091. Ketcher-rendered fixture (images/diverse/metformin.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CN(C)C(=N)N=C(N)N'

### D036 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/sildenafil.png`
- manifest SMILES: `CCCc1c2nc([nH]c(=O)c2[n](C)n1)-c1c(OCC)ccc(S(N2CCN(C)CC2)(=O)=O)c1`
- RDKit canonical: `CCCc1nn(C)c2c(=O)[nH]c(-c3cc(S(=O)(=O)N4CCN(C)CC4)ccc3OCC)nc12`
- notes: drug: Pyrazolopyrimidinone + sulfonamide. Source: PubChem CID 5212. Ketcher-rendered fixture (images/diverse/sildenafil.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CCCc1nn(C)c2c(=O)[nH]c(-c3cc(S(=O)(=O)N4CCN(C)CC4)ccc3OCC)nc12'

### D037 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/oseltamivir.png`
- manifest SMILES: `CCOC(C1C[C@H](N)[C@H](NC(=O)C)[C@H](OC(CC)CC)C=1)=O`
- RDKit canonical: `CCOC(=O)C1=C[C@@H](OC(CC)CC)[C@@H](NC(C)=O)[C@@H](N)C1`
- notes: drug: Cyclohexene neuraminidase inhibitor, 3 stereocenters. Source: PubChem CID 65028. Ketcher-rendered fixture (images/diverse/oseltamivir.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CCOC(=O)C1=C[C@@H](OC(CC)CC)[C@@H](NC(C)=O)[C@@H](N)C1'

### D038 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/tamoxifen.png`
- manifest SMILES: `CC/C(/c1ccccc1)=C(/c1ccc(OCCN(C)C)cc1)\c1ccccc1`
- RDKit canonical: `CC/C(=C(\c1ccccc1)c1ccc(OCCN(C)C)cc1)c1ccccc1`
- notes: drug: (E)-tamoxifen tetrasubstituted alkene + tertiary amine. Source: PubChem CID 2733526. Ketcher-rendered fixture (images/diverse/tamoxifen.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC/C(=C(\c1ccccc1)c1ccc(OCCN(C)C)cc1)c1ccccc1'

### D039 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/l_tryptophan.png`
- manifest SMILES: `N[C@H](C(O)=O)Cc1c2c(cccc2)[nH]c1`
- RDKit canonical: `N[C@@H](Cc1c[nH]c2ccccc12)C(=O)O`
- notes: amino_acid: Indole side chain. Source: PubChem CID 6305. Ketcher-rendered fixture (images/diverse/l_tryptophan.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='N[C@@H](Cc1c[nH]c2ccccc12)C(=O)O'

### D040 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/l_histidine.png`
- manifest SMILES: `N[C@H](C(O)=O)Cc1[nH]cnc1`
- RDKit canonical: `N[C@@H](Cc1cnc[nH]1)C(=O)O`
- notes: amino_acid: Imidazole side chain. Source: PubChem CID 6274. Ketcher-rendered fixture (images/diverse/l_histidine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='N[C@@H](Cc1cnc[nH]1)C(=O)O'

### D041 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/l_cysteine.png`
- manifest SMILES: `N[C@H](C(O)=O)CS`
- RDKit canonical: `N[C@@H](CS)C(=O)O`
- notes: amino_acid: Thiol side chain. Source: PubChem CID 5862. Ketcher-rendered fixture (images/diverse/l_cysteine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='N[C@@H](CS)C(=O)O'

### D042 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/l_proline.png`
- manifest SMILES: `OC([C@H]1NCCC1)=O`
- RDKit canonical: `O=C(O)[C@@H]1CCCN1`
- notes: amino_acid: Cyclic secondary amine. Source: PubChem CID 145742. Ketcher-rendered fixture (images/diverse/l_proline.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='O=C(O)[C@@H]1CCCN1'

### D043 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/l_lysine.png`
- manifest SMILES: `NCCCC[C@@H](C(O)=O)N`
- RDKit canonical: `NCCCC[C@H](N)C(=O)O`
- notes: amino_acid: Diamine side chain. Source: PubChem CID 5962. Ketcher-rendered fixture (images/diverse/l_lysine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='NCCCC[C@H](N)C(=O)O'

### D044 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/adenine.png`
- manifest SMILES: `Nc1c2c([nH]cn2)ncn1`
- RDKit canonical: `Nc1ncnc2[nH]cnc12`
- notes: nucleobase: Purine. Source: PubChem CID 190. Ketcher-rendered fixture (images/diverse/adenine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='Nc1ncnc2[nH]cnc12'

### D045 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/thymine.png`
- manifest SMILES: `Cc1c(=O)[nH]c(=O)[nH]c1`
- RDKit canonical: `Cc1c[nH]c(=O)[nH]c1=O`
- notes: nucleobase: Pyrimidine, 5-methyl. Source: PubChem CID 1135. Ketcher-rendered fixture (images/diverse/thymine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='Cc1c[nH]c(=O)[nH]c1=O'

### D046 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/cytosine.png`
- manifest SMILES: `Nc1[nH]c(=O)ncc1`
- RDKit canonical: `Nc1ccnc(=O)[nH]1`
- notes: nucleobase: Pyrimidine, 4-amino. Source: PubChem CID 597. Ketcher-rendered fixture (images/diverse/cytosine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='Nc1ccnc(=O)[nH]1'

### D047 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/testosterone.png`
- manifest SMILES: `C[C@@]12[C@@H](O)CC[C@H]1[C@@H]1CCC3[C@@](C)([C@H]1CC2)CCC(=O)C=3`
- RDKit canonical: `C[C@]12CC[C@H]3[C@@H](CCC4=CC(=O)CC[C@@]43C)[C@@H]1CC[C@@H]2O`
- notes: steroid_polyene: 4-en-3-one steroid, 6 stereocenters. Source: PubChem CID 6013. Ketcher-rendered fixture (images/diverse/testosterone.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C[C@]12CC[C@H]3[C@@H](CCC4=CC(=O)CC[C@@]43C)[C@@H]1CC[C@@H]2O'

### D048 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/all_trans_retinal.png`
- manifest SMILES: `CC1CCCC(C)(C)C=1/C=C/C(=C/C=C/C(=C/C=O)/C)/C`
- RDKit canonical: `CC1=C(/C=C/C(C)=C/C=C/C(C)=C/C=O)C(C)(C)CCC1`
- notes: steroid_polyene: All-trans retinal (polyene aldehyde). Source: PubChem CID 638015. Ketcher-rendered fixture (images/diverse/all_trans_retinal.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC1=C(/C=C/C(C)=C/C=C/C(C)=C/C=O)C(C)(C)CCC1'

### D049 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/acetone.png`
- manifest SMILES: `CC(=O)C`
- RDKit canonical: `CC(C)=O`
- notes: small_fg: Methyl ketone. Source: PubChem CID 180. Ketcher-rendered fixture (images/diverse/acetone.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC(C)=O'

### D052 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/acetic_anhydride.png`
- manifest SMILES: `CC(OC(=O)C)=O`
- RDKit canonical: `CC(=O)OC(C)=O`
- notes: small_fg: Anhydride. Source: PubChem CID 7918. Ketcher-rendered fixture (images/diverse/acetic_anhydride.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='CC(=O)OC(C)=O'

### D053 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/uracil.png`
- manifest SMILES: `O=c1[nH]c(=O)[nH]cc1`
- RDKit canonical: `O=c1cc[nH]c(=O)[nH]1`
- notes: nucleobase: Pyrimidine, 2,4-dione (RNA base). Source: PubChem CID 1174. Ketcher-rendered fixture (images/diverse/uracil.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='O=c1cc[nH]c(=O)[nH]1'

### D054 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/d_ribose_furanose.png`
- manifest SMILES: `OC[C@@H]1[C@@H](O)[C@@H](O)[C@@H](O)O1`
- RDKit canonical: `OC[C@H]1O[C@H](O)[C@H](O)[C@@H]1O`
- notes: sugar: α-D-ribofuranose (5-ring sugar). Source: PubChem CID 5779. Ketcher-rendered fixture (images/diverse/d_ribose_furanose.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='OC[C@H]1O[C@H](O)[C@H](O)[C@@H]1O'

### D055 (image_to_smiles)
- fixture: `tests/scientific/images/images/diverse/porphine.png`
- manifest SMILES: `c1c2[nH]c(cc3nc(cc4[nH]c(cc5nc(c2)cc5)cc4)cc3)c1`
- RDKit canonical: `C1=Cc2cc3ccc(cc4nc(cc5ccc(cc1n2)[nH]5)C=C4)[nH]3`
- notes: macrocycle: Porphine — 4-pyrrole macrocycle, parent of porphyrins. Source: PubChem CID 66868. Ketcher-rendered fixture (images/diverse/porphine.png).
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C1=Cc2cc3ccc(cc4nc(cc5ccc(cc1n2)[nH]5)C=C4)[nH]3'

## tests/scientific/manifest.jsonl
- Rows: 77; flagged: 1

### S008 (stereochemistry)
- manifest SMILES: `C(=C\c1ccccc1)\c1ccccc1`
- RDKit canonical: `C(=C/c1ccccc1)/c1ccccc1`
- notes: E diaryl alkene
  - **WARN** [not_canonical] `expected_canonical_smiles` is not RDKit-canonical; canonical='C(=C/c1ccccc1)/c1ccccc1'

## tests/ketcher/mechanical-primitives/manifest.jsonl
- Rows: 5; flagged: 0

_No findings._
