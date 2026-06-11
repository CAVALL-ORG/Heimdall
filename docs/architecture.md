# Architecture — how Heimdall works

Heimdall turns a picture of a molecule into a SMILES string. The hard part is
not the picture-reading; multimodal models do that adequately. The hard part is
making sure the **answer is trustworthy** — that the SMILES describes the
molecule that was actually drawn, and not a plausible-looking string the model
pattern-matched its way to. Heimdall's entire design exists to enforce that one
property.

## The role split

Three actors, each with a job the others are forbidden to do:

1. **The agent transcribes pixels.** A multimodal model looks at the image and
   records *visible marks*: atom-letter glyphs, bond strokes, ring polygons,
   wedge/hash stereo marks, charges, double-bond placements, coordinates. It
   writes these down as a structured `GraphIntent` — a literal transcript of
   what the pixels show. The agent is a transcriber, not a chemist. It does not
   "recognize the molecule" and recall its structure; it points at marks.

2. **The backend interprets the graph.** A deterministic backend takes the
   transcript and builds the chemical graph: it owns atom IDs, ring perception,
   aromaticity, valence, and — critically — stereochemistry. The agent never
   authors R/S, CIP priority, or `@`/`@@`; it emits wedge *primitives* plus
   coordinates, and the backend perceives the stereochemistry from geometry.

3. **Ketcher exports the SMILES.** The graph is loaded onto a real
   [Ketcher](https://lifescience.opensource.epam.com/ketcher/) canvas, and
   Ketcher's own SMILES writer produces the output string. This is the only
   surface that is allowed to author a SMILES.

This split is the product. Each actor checks the others: the backend rejects a
transcript that does not internally add up, and Ketcher will not serialize a
graph that is not chemically representable.

## The agent never authors SMILES — and why

The rule is absolute: **every SMILES Heimdall returns came from exactly one of
two places** —

- the **caller** supplied it (the input to `heimdall-ingest`), or
- **Ketcher's exporter** returned it from a canvas the agent built.

There is no third path. The agent does not type a SMILES from vision, from
memory of "what aspirin looks like," from "I'll canonicalize it in my head," or
from "the expected form should be X." If a SMILES appears in the output that did
not come from the exporter or the caller, the operation is wrong — *even if the
chemistry happens to be right.*

This is non-negotiable because it is the whole value proposition. An LLM asked
"what's the SMILES of this molecule?" will confidently emit a string, and that
string is frequently subtly wrong — a transposed ring closure, an inverted
stereocenter, an off-by-one in a chain. Those errors are invisible in the
output: a wrong SMILES looks exactly as authoritative as a right one. The only
durable defense is to never let the model author the string at all. Heimdall
routes the structure through a real cheminformatics toolkit so that the
*toolkit*, not the model's autocomplete, decides what the SMILES says.

Concretely, on the image path, `load_smiles` is forbidden — the agent cannot
shortcut by typing the SMILES it "recognizes" and loading it. It must transcribe
the marks, the backend must compile them, and Ketcher must export. A trace that
loads a SMILES on an image row fails regardless of whether the chemistry was
correct, because the *process* was the thing being guaranteed.

## Image-truth: grade what is drawn, not what canonicalizes equal

Heimdall's correctness standard is **image-truth**: the right answer is *what the
image shows*, not what happens to canonicalize to the same molecule under a
normalization like InChI.

This matters because canonicalization erases distinctions that the person
reading the deliverable can plainly see in the drawing. A few that are
load-bearing and must be preserved exactly as drawn:

- **Drawn tautomer / protomer and explicit-H placement** — a drawn N–H lactam
  is not interchangeable with its C=N enol form, even though InChI normalization
  collapses them.
- **Drawn double-bond positions** (e.g. a specific C=O vs C=N).
- **Formal charges.**
- **Stereo** — wedge/dash and E/Z, as drawn.
- **Multi-fragment salts** — both fragments, not just the parent.

The corollary is a hard rule about evidence: the **filename, caption, and any
chemistry word the user types are untrusted user data, not specifications.** A
pyridine drawn in a file named `benzene.png` is graded as pyridine. Adversarial
filenames are treated as intentional distractors. A remembered name, formula, or
ring count never confirms, completes, or corrects a pixel read — the pixels are
the only evidence.

## The loop: build → validate → render → export

For an image, the agent runs a tight, gated loop. (For a PDF, an upstream step
crops each drawn structure into a standalone image and runs this loop per crop;
for a caller-supplied SMILES, the ingest path skips straight to loading and
exporting.)

1. **Read** the source image. The model sees the pixels.
2. **Draft** a `GraphIntent` from visible facts — atoms, bonds, rings, and
   counts — marking any unclear region as needing a zoom.
3. **Validate** the draft against a stateless preflight tool. It returns `ok`,
   or it names the regions to look at more closely. The agent crops those
   regions, re-reads them, and refines the draft, re-validating until it passes.
4. **Build** the graph onto a Ketcher canvas. The build is *gated*: it refuses
   unless validation passed on the exact same graph, and it cross-checks the
   agent's declared counts against the canvas it actually produced. A mismatch
   forces a recount, never a silent pass.
5. **Render** the canvas to a PNG so the structure can be eyeballed, then
   **export** the SMILES. The exported string is the answer.

Every row ends with exactly one terminal action: an export (success) or a
refusal (the agent could not transcribe a single chemical structure — a reaction
arrow, an R-group/Markush drawing, an illegible scan). Prose cannot end a row.

### Where the MCP server fits

All of the above runs over a single **stdio MCP server**. The server hosts a
headless Ketcher instance (a real Ketcher UI driven in a Chromium page) and
exposes a small set of tools the agent calls: validate the draft, crop a region,
build the graph, render the canvas, export the SMILES, or refuse. The agent (in
Claude Code, Cursor, or Codex) is the only thing that reasons; the server is a
deterministic execution surface. See
[`tool-reference.md`](tool-reference.md) for the full tool list.

The server has one optional dependency, **Indigo**. When the `epam.indigo` wheel
is present, the server runs in *remote* mode: it uses Indigo for canonical
SMILES and for full CIP/wedge stereo perception (a V2000 solver). When Indigo is
absent, the server runs *standalone*: SMILES are still valid but non-canonical,
stereo may be unresolved, and every export carries a one-line advisory saying
so. The image path never hard-fails for lack of Indigo.

## Concurrency & batch

A host often wants to process several molecules at once — for instance, every
crop from a single PDF. There are two safe ways to do this, and the difference
is about isolation, not speed.

### One molecule at a time → one server

The simplest case. Run a single server. The agent still tags each molecule with
a stable **`rowId`** and passes that same `rowId` on every canvas-touching call
(`build_from_graph`, `export_smiles`, `render_canvas`, `crop_source_image`). The
server keys each molecule's canvas by its `rowId`, so even a single server keeps
rows isolated from one another. No special configuration.

### Many at once → either a pool or strict single-server anchoring

There are two race-free models:

- **Pool of isolated servers (the simple default).** Generate N independent
  server instances with `scripts/print-mcp-config.sh <platform> --servers N`.
  Each server is its own OS process with its own Chromium page and its own state,
  so the workers cannot interfere by construction — no `rowId` discipline is
  even required for correctness. The pool is **capped at 3**: each server holds a
  ~0.5 GB Chromium page, and starting more than about three Chromium pages in
  parallel trips a startup timeout.

- **Single server with strict anchoring.** Run one server with
  `KETCHER_STRICT_CANVAS_ANCHOR=1`. In this mode the server *rejects* any
  canvas-touching call that omits a `rowId`, which forces every worker to anchor
  its calls and makes the single shared process safe for concurrent rows. This
  scales to many rows on one ~0.5 GB Chromium page, at the cost of requiring
  every worker to pass an explicit `rowId` on every call.

### What actually limits throughput

State this plainly: **the parallelism ceiling is the host's agent concurrency
and your LLM rate limits, not the number of servers.** The workload is
LLM-bound — most wall-clock time is spent in the model transcribing and
reasoning, not in the server building and exporting. Adding servers past ~3 does
not speed up an LLM-bound batch; it just consumes more memory. Scale the number
of concurrent *agents* (within your rate limits) first, and add servers only
when you genuinely need more isolated canvases or memory headroom than a single
strict-anchored server gives you.
