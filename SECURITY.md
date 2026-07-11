# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab). You should
receive a response within 7 days. Please do not open public issues for
security reports.

## Data flow — where your audio and text go

Dictum is local-first; nothing is sent anywhere except the backends you
configure:

| Stage | Data | Destination |
|---|---|---|
| Recording | audio | stays on disk (temp WAV), deleted after the run |
| STT `local_http` | audio file path | your local STT server (same host) |
| STT `openai_compat` | audio bytes | the HTTPS endpoint you configured |
| Polisher `claude_cli` | transcript text | Anthropic, via your own `claude` CLI auth; runs `--safe-mode --no-session-persistence`, all tools denied, prompt passed via stdin |
| Polisher `anthropic` / `openai_compat` | transcript text | the HTTPS endpoint you configured |
| Polisher `rules` mode | — | fully offline, no network calls |
| MCP prompts / `polish_brief` / `analyze_prompt` | draft text | computed offline by the server; your agent's own model does the rewriting inside your session |

Dictum itself has no telemetry, no accounts, and stores no transcripts
(the interactive chooser holds text in memory only; the clipboard is your
system clipboard).

## Supported versions

Only the latest release receives security fixes.
