/**
 * heimdall-pdf-extract — Tier C verification driver (render-back-and-compare).
 *
 * Renders each extracted SMILES back through Ketcher and emits a LaTeX
 * longtable comparing the paper crop against the Ketcher render of the SMILES
 * this pipeline emitted, with the SMILES printed below each pair. This is the
 * QA artifact: a SMILES that parses is not verified; the side-by-side is what
 * surfaces a transcription error a human can see.
 *
 * Mechanical only — SMILES are Ketcher-emitted (export_smiles), loaded back via
 * load_smiles, relaid-out via Indigo clean2d, re-rendered. No SMILES authored.
 *
 * USE: copy this file into the run dir (outputs/<slug>/render-compare.ts) so the
 * `../../server` import resolves, then:
 *   TITLE="<paper title>" KETCHER_AGENT_MODE=remote tsx outputs/<slug>/render-compare.ts
 *
 * Inputs (relative to this file's dir):
 *   data/smiles-results.json  — { "<id>": { smiles, name?, note? }, ... }
 *   crops/<id>.png            — the source crop per id
 * Outputs:
 *   images/<id>__render.png   — Ketcher render of each SMILES
 *   data/render-status.json   — per-id render result
 *   tex/<slug>.tex            — the compare longtable (compile with xelatex x2)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KetcherRuntime } from '../../server/src/mcp/runtime';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data', 'smiles-results.json');
const CROPS = path.join(HERE, 'crops');
const IMAGES = path.join(HERE, 'images');
const TEX_DIR = path.join(HERE, 'tex');
const SLUG = process.env.SLUG || 'extract-compare';
const TITLE = process.env.TITLE || 'PDF extraction — paper depiction vs. extracted SMILES';
const REMOTE = process.env.KETCHER_REMOTE_API_PATH || 'http://127.0.0.1:8002/v2/';
const RUNTIMES = Number(process.env.RUNTIMES || 3);

// Render style (RENDER_STYLE env, default 'publication'):
//   publication — skeletal paper figure: drop the on-canvas enhanced-stereo
//                 "abs" flags and terminal CH3 H-count labels (keep OH/NH).
//   annotated   — keep them: show the "abs" stereo flags AND terminal CH3.
// NOTE: Ketcher renders terminal methyls as the H-count label "CH3" — there is
// NO "Me" abbreviation render mode; the annotated style shows CH3, not Me.
const RENDER_STYLE = (process.env.RENDER_STYLE || 'publication').toLowerCase();
const RENDER_OPTIONS_BY_STYLE: Record<string, Record<string, unknown>> = {
  publication: {
    stereoLabelStyle: 'Off',
    ignoreChiralFlag: true,
    hideTerminalLabels: true,
    showStereoFlags: false,
    showHydrogenLabels: 'Hetero',
  },
  annotated: {
    // Verified: shows per-center "abs" enhanced-stereo labels AND terminal CH3.
    // Cosmetic: Ketcher also draws a molecule-level "undefined" chiral-flag label
    // for SMILES-loaded molecules (the flag isn't set on import) — harmless.
    ignoreChiralFlag: false, // show the per-center "abs" enhanced-stereo labels
    showStereoFlags: true,
    hideTerminalLabels: false, // show terminal carbon labels
    showHydrogenLabels: 'Terminal and Hetero', // CH3 on terminals + keep OH/NH
  },
};
const RENDER_OPTS =
  RENDER_OPTIONS_BY_STYLE[RENDER_STYLE] ?? RENDER_OPTIONS_BY_STYLE.publication;
if (!RENDER_OPTIONS_BY_STYLE[RENDER_STYLE]) {
  console.warn(`RENDER_STYLE='${RENDER_STYLE}' unknown — using 'publication'.`);
}

interface Rec {
  id: string;
  name?: string;
  smiles: string;
  note?: string;
}
interface RenderStatus extends Rec {
  renderPng?: string;
  cropPng?: string;
  ok: boolean;
  error?: string;
}

function escapeTex(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[&%$#_{}]/g, (m) => `\\${m}`)
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

async function chunkWorkers<T, R>(
  items: T[],
  nWorkers: number,
  setup: () => Promise<{ ctx: unknown; teardown: () => Promise<void> }>,
  fn: (item: T, ctx: unknown) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const w = Math.max(1, Math.min(nWorkers, items.length));
  const chunks: Array<Array<{ item: T; idx: number }>> = Array.from({ length: w }, () => []);
  items.forEach((item, idx) => chunks[idx % w].push({ item, idx }));
  await Promise.all(
    chunks.map(async (chunk) => {
      if (chunk.length === 0) return;
      const { ctx, teardown } = await setup();
      try {
        for (const { item, idx } of chunk) out[idx] = await fn(item, ctx);
      } finally {
        await teardown();
      }
    }),
  );
  return out;
}

async function main() {
  await fs.mkdir(IMAGES, { recursive: true });
  await fs.mkdir(TEX_DIR, { recursive: true });

  const raw = JSON.parse(await fs.readFile(DATA, 'utf8')) as Record<string, Omit<Rec, 'id'>>;
  // Sort by trailing integer in the id when present (mol-1, mol-2, …), else lexically.
  const trailingNum = (s: string) => {
    const m = s.match(/(\d+)\s*$/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  const recs: Rec[] = Object.entries(raw)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => trailingNum(a.id) - trailingNum(b.id) || a.id.localeCompare(b.id));

  console.log(`Rendering ${recs.length} molecules with ${RUNTIMES} runtimes...`);

  const statuses = await chunkWorkers<Rec, RenderStatus>(
    recs,
    RUNTIMES,
    async () => {
      const rt = new KetcherRuntime();
      await rt.start({ mode: 'remote', remoteApiPath: REMOTE });
      return { ctx: rt, teardown: () => rt.stop() };
    },
    async (rec, ctx) => {
      const rt = ctx as KetcherRuntime;
      const cropPng = path.join(CROPS, `${rec.id}.png`);
      const hasCrop = await fs.access(cropPng).then(() => true).catch(() => false);
      try {
        await rt.callBridge('clearCanvas');
        await rt.callBridge('loadSmiles', rec.smiles);
        try {
          await rt.callBridge('clean'); // Indigo clean2d relayout; best-effort
        } catch {
          /* keep import coords */
        }
        const base64 = await rt.callBridge<string>('renderCanvas', {
          format: 'png',
          cropToContent: true,
          cropPadding: 0.08,
          dearomatizeBeforeRender: true,
          renderOptions: RENDER_OPTS,
        });
        const renderPng = path.join(IMAGES, `${rec.id}__render.png`);
        await fs.writeFile(renderPng, Buffer.from(base64, 'base64'));
        console.log(`  ok  ${rec.id}`);
        return { ...rec, renderPng, cropPng: hasCrop ? cropPng : undefined, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.log(`  FAIL ${rec.id}: ${error}`);
        return { ...rec, cropPng: hasCrop ? cropPng : undefined, ok: false, error };
      }
    },
  );

  await fs.writeFile(
    path.join(HERE, 'data', 'render-status.json'),
    JSON.stringify(statuses, null, 1),
    'utf8',
  );

  // Self-contained minimal xelatex preamble for the compare longtable.
  // (No external skill dependency — embedded so this driver runs standalone.)
  const preamble = [
    '\\documentclass[11pt]{article}',
    '\\usepackage{fontspec}',
    '\\usepackage[margin=1.5cm]{geometry}',
    '\\usepackage{graphicx}',
    '\\usepackage{longtable}',
    '\\usepackage{array}',
    '\\usepackage{booktabs}',
    '\\usepackage{seqsplit}',
    '\\usepackage{parskip}',
    '\\setlength{\\LTpre}{0pt}\\setlength{\\LTpost}{0pt}',
    '\\pagestyle{empty}',
  ].join('\n');
  const rel = (p: string | undefined) =>
    p ? path.relative(TEX_DIR, p).split(path.sep).join('/') : '';
  const IMG = (p: string) =>
    `\\includegraphics[width=\\linewidth,height=3.6cm,keepaspectratio]{${p}}`;
  const MISSING = '\\textit{\\footnotesize (not available)}';

  const blocks = statuses.map((s) => {
    const titleName = s.name ? ` --- ${escapeTex(s.name)}` : '';
    const header = `\\multicolumn{2}{@{}l@{}}{\\textbf{${escapeTex(s.id)}${titleName}}} \\\\[1pt]`;
    const cropCell = s.cropPng ? IMG(rel(s.cropPng)) : MISSING;
    const renderCell = s.ok ? IMG(rel(s.renderPng)) : MISSING;
    const imgRow = `${cropCell} & ${renderCell} \\\\`;
    const smiLine = s.ok
      ? `{\\scriptsize\\texttt{\\seqsplit{${escapeTex(s.smiles)}}}}`
      : `\\textit{\\scriptsize render failed: ${escapeTex(s.error ?? '')}}`;
    const noteLine = s.note ? ` \\newline {\\scriptsize\\itshape ${escapeTex(s.note)}}` : '';
    const smiRow = `\\multicolumn{2}{@{}p{\\textwidth}@{}}{\\scriptsize\\textbf{SMILES:} ${smiLine}${noteLine}} \\\\[10pt]`;
    return [header, imgRow, smiRow].join('\n');
  });

  const colHeader =
    '\\textbf{\\small Paper depiction} & \\textbf{\\small Rendered from extracted SMILES} \\\\';
  const body = `
\\begin{center}\\Large\\bfseries ${escapeTex(TITLE)}\\end{center}
\\vspace{2pt}
\\begin{center}\\small Left: cropped from the PDF. Right: Ketcher render of the SMILES this pipeline emitted.\\end{center}
\\vspace{6pt}

\\begin{longtable}{m{0.47\\textwidth} m{0.47\\textwidth}}
${colHeader}
\\midrule
\\endfirsthead
${colHeader}
\\midrule
\\endhead
${blocks.join('\n')}
\\end{longtable}
`;
  const texPath = path.join(TEX_DIR, `${SLUG}.tex`);
  await fs.writeFile(texPath, `${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`, 'utf8');

  const okCount = statuses.filter((s) => s.ok).length;
  console.log(`\nRendered ${okCount}/${statuses.length}. tex -> ${texPath}`);
  console.log(
    `Compile: cd ${path.relative(process.cwd(), TEX_DIR)} && xelatex -interaction=nonstopmode -halt-on-error ${SLUG}.tex  (run twice for the longtable)`,
  );
  if (okCount < statuses.length) {
    console.log(
      'FAILED:',
      statuses.filter((s) => !s.ok).map((s) => `${s.id}(${s.error})`).join(', '),
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
