#!/usr/bin/env python3
"""Userspace Indigo HTTP shim — emulates the epmlsop/indigo-service /v2/ API
endpoints the Heimdall server calls, backed by the epam.indigo pip wheel.
No docker, no root, no Flask (stdlib http.server only).

Why this exists: canonical SMILES (`export_smiles canonical=true`) and the
geometry ops (layout / clean / aromatize / dearomatize) need an Indigo backend
over HTTP at KETCHER_REMOTE_API_PATH. On boxes where docker is unusable
(no docker group, no root, no LAN Indigo host) this shim is the drop-in
replacement (the no-docker userspace route).

Endpoints implemented:
  GET  /v2/info               — health (version)
  POST /v2/indigo/convert     — KET/molfile/SMILES -> canonical SMILES or stereo molfile
  POST /v2/indigo/check       — {types:['stereo']} -> {stereo:"...(ids)"}
  POST /v2/indigo/layout      — 2D coordinate generation
  POST /v2/indigo/clean       — 2D clean (clean2d)
  POST /v2/indigo/aromatize   — aromatize
  POST /v2/indigo/dearomatize — dearomatize

NOT implemented: /v2/indigo/render (PDF rasterize) and /v2/indigo/calculate.
For molecule PDFs use render_canvas (Chromium) + xelatex instead. `calculate`
is not exercised by the MCP surface or the e2e suite; add a handler if a future
caller needs it.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from indigo import Indigo

HOST, PORT = "127.0.0.1", 8002


def _set_options(ind, opts):
    """Apply caller options, ignoring ones the wheel doesn't know.

    Ketcher's struct-service client sends service-level options the hosted
    epmlsop/indigo-service silently ignores (monomerLibrary, output-content-type,
    smart-layout, …). The bare epam.indigo wheel THROWS on unknown options
    (`option manager: Property "X" not defined`), so we must mirror the service's
    leniency or every layout/convert from Ketcher 400s as "Convert error!".
    """
    for k, v in opts.items():
        if k == "smiles":                   # meta-flag, not a real Indigo option
            continue
        try:
            ind.setOption(k, v)
        except Exception:
            pass                            # unknown option -> ignore (service parity)


def _dump(mol, out_fmt):
    """Serialize a molecule in the format Ketcher's struct-service asked for."""
    out_fmt = out_fmt or ""
    if "ket" in out_fmt or "json" in out_fmt:
        return mol.json()
    if "smiles" in out_fmt or "daylight" in out_fmt:
        return mol.canonicalSmiles()
    return mol.molfile()


def _load(ind, body):
    return ind.loadMolecule(body["struct"])  # auto-detects KET / molfile / SMILES


def do_convert(body):
    opts = body.get("options") or {}
    out_fmt = body.get("output_format", "") or ""
    ind = Indigo()                          # fresh per request -> thread-safe
    _set_options(ind, opts)
    mol = _load(ind, body)
    if "smiles" in out_fmt or "daylight" in out_fmt:
        struct = mol.canonicalSmiles() if opts.get("smiles") == "canonical" else mol.smiles()
    elif "molfile" in out_fmt or "mdl" in out_fmt:
        struct = mol.molfile()
    elif "ket" in out_fmt or "json" in out_fmt:
        struct = mol.json()
    else:
        struct = mol.canonicalSmiles()
    return {"struct": struct}


def do_check(body):
    types = body.get("types") or ["stereo"]
    ind = Indigo()
    mol = _load(ind, body)
    return json.loads(mol.check(" ".join(types)))


def _geom_op(method_name):
    """Build a handler that loads, applies a mutating geometry op, and dumps."""
    def handler(body):
        opts = body.get("options") or {}
        ind = Indigo()
        _set_options(ind, opts)
        mol = _load(ind, body)
        getattr(mol, method_name)()         # layout() / clean2d() / aromatize() / dearomatize()
        return {"struct": _dump(mol, body.get("output_format", ""))}
    return handler


ROUTES = {
    "/v2/indigo/convert": do_convert,
    "/v2/indigo/check": do_check,
    "/v2/indigo/layout": _geom_op("layout"),
    "/v2/indigo/clean": _geom_op("clean2d"),
    "/v2/indigo/aromatize": _geom_op("aromatize"),
    "/v2/indigo/dearomatize": _geom_op("dearomatize"),
}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.rstrip("/") == "/v2/info":
            self._send(200, {"indigo_version": Indigo().version()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        fn = ROUTES.get(self.path.rstrip("/"))
        if fn is None:
            return self._send(404, {"error": f"no route {self.path}"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            self._send(200, fn(json.loads(self.rfile.read(n) or b"{}")))
        except Exception as e:
            self._send(400, {"error": str(e)})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"Indigo shim on http://{HOST}:{PORT}/v2/  (indigo {Indigo().version()})")
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
