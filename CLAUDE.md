# Dictum — prompt-polishing CLI

Open-source tool: type or speak a thought → STT (voice only) → LLM polishing → a sharp prompt in your clipboard / stdout. The MCP host-brain overlay (prompts `polish`/`spec`/`decompose`, the `polish_brief` tool, and the zero-install `/dictum` command) is the flagship surface.

## Architecture — orthogonality (the prime rule)

```
Recorder → STTProvider → Polisher → Sink     (interfaces in src/core/types.ts)
```

Modules `recorder/`, `stt/`, `polisher/`, `sink/` import ONLY `core/types.ts` and their own files. Assembly happens exclusively in `core/pipeline.ts` and `cli.ts`; `mcp/` (host-brain briefs + tools) is assembly-level too and may import `polisher/*`. Cross-module imports are a bug — enforced by `tests/orthogonality.test.ts`.

The polishing canon lives in two places kept in sync manually: `src/mcp/prompts.ts` ↔ `.claude/commands/dictum.md` — drift is caught by `tests/canon_sync.test.ts`.

## Conventions

- Bun + TypeScript strict + biome. Dependencies: the minimum (smol-toml is ok; CLI parsing — `util.parseArgs`, no commander).
- Code, identifiers, comments, README — English.
- Conventional commits, atomic after each logical step.
- Tests land with the code: unit tests for logic, provider contract tests against mock servers (ports 7000–7999).
- Machine- or person-specific facts (local services, paths, private notes) belong in `CLAUDE.local.md` (gitignored), never in this file.
