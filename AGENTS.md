# Dictum — agent instructions

Voice-to-prompt CLI: speak a thought → STT → LLM polishing → a sharp prompt in your clipboard / stdout. The MCP host-brain overlay (prompts `polish`/`spec`/`decompose`, the `polish_brief` tool, and the `/dictum` command) is the flagship surface: YOUR model executes Dictum's brief with this session's context.

## Architecture — orthogonality (the prime rule)

```
Recorder → STTProvider → Polisher → Sink     (interfaces in src/core/types.ts)
```

Modules `recorder/`, `stt/`, `polisher/`, `sink/` import ONLY `core/types.ts` and their own files. Assembly happens exclusively in `core/pipeline.ts` and `cli.ts`; `mcp/` (host-brain briefs + tools) is assembly-level too and may import `polisher/*`. Cross-module imports are a bug — enforced by `tests/orthogonality.test.ts`.

The polishing canon lives in two places kept in sync manually: `src/mcp/prompts.ts` ↔ `.claude/commands/dictum.md` — drift is caught by `tests/canon_sync.test.ts`.

## Verify

```bash
bun install --frozen-lockfile
bun test                        # full suite, offline (mock servers on ports 7000–7999)
bunx tsc --noEmit && bunx biome check .
bun build --compile src/cli.ts --outfile dist/dictum && ./dist/dictum --version
```

## Conventions

- Bun + TypeScript strict + biome. Dependencies: the minimum (smol-toml is ok; CLI parsing — `util.parseArgs`, no commander).
- Code, identifiers, comments, README — English.
- Conventional commits, atomic after each logical step. Tests land with the code.

## Release safety (hard rules)

- NEVER commit, push, publish (npm/GitHub) or tag without explicit maintainer approval.
- Only the `main` branch is public history. Never push other branches or a mirror; never merge a dev branch into `main` (a tree-diff snapshot commit is the only way changes reach `main`).
- Release tags: push exactly one maintainer-approved `vX.Y.Z` pointing at a commit on the public `main` (`git push origin vX.Y.Z`). Never `git push --tags`.
- Pushing a tag uploads its git objects BEFORE any workflow runs — the CI gate protects release artifacts, not the pushed history. Always verify against the PUBLISHED branch first (the local `main` may be ahead of it): `git fetch origin main && git merge-base --is-ancestor '<tag>^{commit}' refs/remotes/origin/main`.
- Machine- or person-specific facts (local services, paths, private notes) belong in gitignored local files or user-scoped agent config — never in tracked files.
