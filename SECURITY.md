# Security Policy

## Supported versions

Heimdall is pre-1.0. Security fixes are applied to the latest `0.1.x` release
and the `main` branch.

| Version | Supported |
|---|---|
| 0.1.x   | ✅ |
| < 0.1   | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately to **ethan@cavall.ai**. Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- the affected version / commit.

You will get an acknowledgement within a few business days. We will work with
you on a fix and coordinate a disclosure timeline before any public write-up.

## Handling notes

- Never paste secrets, API keys, tokens, or private data into issues, pull
  requests, or reproduction steps.
- Heimdall runs a local stdio MCP server that drives a headless Chromium
  instance and (optionally) a local Indigo shim. It does not phone home. If you
  find behavior that contradicts this, treat it as a security report.
