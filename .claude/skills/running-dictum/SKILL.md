---
name: running-dictum
description: How to run, test, and verify Dictum (voice-to-prompt CLI) in this repo — commands, environment facts, e2e paths. Use when asked to run the app, verify a change, or debug locally.
---

# Running Dictum

Requires [Bun](https://bun.sh) ≥ 1.2 on PATH (1.1 breaks the embedded template text imports).

## Run

```bash
bun run src/cli.ts doctor                                   # environment diagnostics
bun run src/cli.ts --input tests/fixtures/sample-ru.wav --stdout    # file-mode e2e (works without a mic)
bun run src/cli.ts --input ... -m commit --stdout           # template selection
bun run src/cli.ts --input ... --raw --stdout               # skip polishing
```

On machines without a microphone, live recording (sox) is unavailable — always verify via `--input`.

## Test / verify

```bash
bun test                      # full suite
bunx tsc --noEmit && bunx biome check .
bun build --compile src/cli.ts --outfile dist/dictum && ./dist/dictum --version
```

Real e2e dependencies (must be alive): a local STT server on `http://127.0.0.1:5500` (`GET /health` → `{loaded:true}`) and the `claude` CLI on PATH (default polisher). Mock servers in tests use ports 7000–7999 — no live services needed for `bun test`.

## Architecture invariant

Orthogonality: `recorder/`, `stt/`, `polisher/`, `sink/` import ONLY `core/types.ts` + own files. Wiring only in `core/pipeline.ts`, `cli.ts`, and `mcp/`. Enforced by tests/orthogonality.test.ts — keep it green.

## Distribution

`npm pack` → tarball installs cleanly. Do NOT `npm publish` / push without explicit maintainer approval.
