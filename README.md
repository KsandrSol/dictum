# dictum

**Type or dictate a thought. Get a polished prompt in your clipboard.**

`dictum` is a prompt-polishing CLI with built-in voice input. Type a rough idea
(or speak it — the audio is transcribed first), an LLM rewrites it into a clean,
structured prompt, and the result lands in your clipboard or on stdout — ready
to paste into Claude, an editor, or a shell pipe.
It works over SSH (via OSC52), runs fully self-hosted, and is provider-agnostic.
Connected [over MCP](#dictum-inside-your-agent-mcp), it becomes a prompt overlay
for the coding agent you already use: your model, your context, Dictum's rules.

<!-- demo: replace with an asciinema cast or GIF -->
```console
$ dictum
● recording — press Enter to stop
◌ transcribing   ✦ polishing   ✓ copied (2.1s)
# → clipboard: "Write a Python function that reads a JSON file of users and
#   returns only the active ones. Handle missing-file and invalid-JSON errors."
```
## Quick start

Prebuilt binary — linux/darwin, x64/arm64; the installer verifies the SHA-256
checksum against the release's `SHA256SUMS` before installing:

```sh
curl -fsSL https://raw.githubusercontent.com/KsandrSol/dictum/main/install.sh | bash
```

Or from npm (needs [Bun](https://bun.sh) ≥ 1.2): `npm i -g dictum-cli`, then
`dictum` — or one-off `bunx dictum-cli`.

When [Codex CLI](https://github.com/openai/codex) is installed, the release
installer also registers the Dictum MCP server and configures deterministic
`dictum:` routing — a `UserPromptSubmit` prefix hook plus a managed `$dictum`
skill (set `DICTUM_CODEX=0` to skip; `dictum codex setup --binary <path>` runs
the same setup manually). Start a new Codex session, open `/hooks`, and trust
“Routing Dictum prompt”. Then write directly in the chat:

```text
dictum: fix the failing test
dictum spec: add CSV export
dictum decompose: migrate authentication to OAuth
```

Codex first calls Dictum, shows the proposal in a native review panel — Act,
Keep original, Generate another version, or Enter my corrections — and starts
the underlying work only after you choose Act.

From source:

```sh
git clone https://github.com/KsandrSol/dictum && cd dictum
bun install --frozen-lockfile
bun run src/cli.ts doctor   # check mic / STT / polisher / clipboard
bun run src/cli.ts          # speak, then press Enter → polished prompt on your clipboard
```

## Why

- **Talking is faster than typing a good prompt.** Speak the messy version; let
  the model do the cleanup. You get a structured prompt, not a raw transcript.
- **Your agent's brains, Dictum's rules.** Inside Claude Code, Cursor & co.,
  Dictum doesn't call its own model at all: it hands *your* agent a rewriting
  brief, and the model you already pay for polishes the draft — with full
  knowledge of your project. See [Dictum inside your agent](#dictum-inside-your-agent-mcp).
- **Provider-agnostic & self-hosted.** Local STT (GigaAM/Whisper) + your choice
  of polisher (Claude CLI by subscription, Anthropic API, or any OpenAI-compatible
  endpoint). No vendor lock-in, no required cloud account.
- **SSH- and pipe-friendly.** Over SSH it copies to your *local* clipboard via
  OSC52; in a pipe it streams to stdout: `dictum --stdout | claude`.
- **Orthogonal & hackable.** record → transcribe → polish → emit, each stage a
  swappable module behind one tiny contract.

## Usage

```sh
dictum                       # record → polish → choose → copy to clipboard
dictum --text "fix the auth bug"   # polish typed text (no microphone)
echo "draft commit message" | dictum -m commit --stdout   # piped stdin = text
dictum --input note.wav --stdout
dictum -m commit --auto --stdout | git commit -F -
dictum --raw --stdout        # skip polishing; emit the raw transcript
dictum doctor                # diagnose mic / STT / polisher / clipboard
```

**Input — voice or text.** Speak (microphone), pass `--text "…"`, or pipe text
in (`echo … | dictum`). Text input skips recording and STT entirely.

**Choose, don't blindly replace.** On an interactive terminal Dictum shows the
polished result and lets you keep `[p]olished` (default), your `[o]riginal`, or
`[r]egenerate` a fresh one. In a pipe (`dictum | claude`) or with `--auto` it
emits the polished text automatically, so scripts and agent flows are unaffected.

| Flag | Meaning |
|------|---------|
| `-i, --input <file>` | Transcribe a WAV file instead of recording |
| `-t, --text <text>` | Polish the given text instead of recording (piped stdin works too) |
| `-m, --mode <name>` | Template: `agent-prompt` (default), `commit`, `note`, `spec`, `decompose` |
| `--raw` | Skip polishing; output the raw transcript |
| `--auto` | Skip the choice prompt; emit the polished text |
| `--stdout` | Print to stdout (for pipes) instead of the clipboard |
| `--format <text\|json>` | `json` emits a stable envelope: `{v, original, polished, template, score, rationale}` |
| `--help`, `--version` | The usual |

**Scores, not vibes.** A deterministic analyzer rates every draft 0–100 across
five dimensions (clarity, specificity, structure, actionability, context). The
interactive chooser shows the delta (`score 34 → 78 · structure +5`), and
`--format json` carries the full breakdown for scripts and integrations.

## Dictum inside your agent (MCP)

The flagship way to use Dictum: as a **prompt overlay for the coding agent you
already use**. Connect the MCP server and Dictum stops calling its own model —
instead it hands *your* agent a rewriting brief (canon rules + a deterministic
pre-analysis of your draft), and **the model you picked in your session does the
polishing, with full knowledge of your project**. Vague references like "that
failing test" become real file paths. Zero extra LLM calls, zero API keys.

```sh
dictum mcp        # serve host-brain prompts + tools over stdio
```

| Host | Host-brain channel | How you invoke it |
|------|--------------------|-------------------|
| Claude Code | MCP Prompts | `/mcp__dictum__polish <draft>` (also `__spec`, `__decompose`) |
| Cursor | MCP Prompts | type `/`, pick the dictum prompt |
| Windsurf | MCP Prompts | via Cascade |
| Claude Desktop | MCP Prompts | "+" menu → Add from dictum |
| Codex CLI | `polish_brief` tool | ask it to polish; it calls the tool and follows the brief |

Register the server. For Claude Code:

```sh
claude mcp add dictum -- dictum mcp
```

For Codex CLI, add to `~/.codex/config.toml`:

```toml
[mcp_servers.dictum]
command = "dictum"
args = ["mcp"]
```

For Cursor (`.cursor/mcp.json` project-level or `~/.cursor/mcp.json` global),
Windsurf, or Claude Desktop (`claude_desktop_config.json`) — the de-facto
standard JSON shape:

```json
{
  "mcpServers": {
    "dictum": { "command": "dictum", "args": ["mcp"] }
  }
}
```

**Prompts** (host-brain — your model, your context; the flagship):

- **`polish(draft?)`** — draft → clear, structured prompt. The brief embeds the
  deterministic 0–100 pre-analysis so the host fixes the *measured* weak spots.
- **`spec(draft?)`** — draft → compact task spec with requirements and
  acceptance criteria.
- **`decompose(draft?)`** — draft → ordered, dependency-tracked subtasks.

Every brief ends the same way: the agent shows the result and a numbered
choice — reply **1** to act on it, **2** to keep your original, **3** to tweak.
Dictum proposes; you decide.

**Tools:**

- **`polish_brief(text, mode?)`** — the same host-brain brief as a tool result,
  for hosts without MCP Prompts support (Codex CLI). Offline, no LLM call.
- **`polish_prompt(text, mode?)`** — server-side polish with Dictum's **own**
  model (no session context; useful from scripts or context-less hosts).
  `mode` is a template (`agent-prompt`, `commit`, `note`, `spec`, `decompose`,
  or any custom one).
- **`analyze_prompt(text)`** — deterministic 0–100 score across five dimensions
  plus weak spots, as JSON. Offline; lets an agent decide whether a draft needs
  polishing at all.
- **`build_spec(text)`** — server-side spec via the `spec` template.

The server speaks plain MCP over stdio; the only client-specific behavior is
the brief's vendor prompting tips, picked from `clientInfo.name` at initialize
(Claude → Anthropic tips, Codex → OpenAI, anything else → generic; see the
`provider` override on `polish_brief`).
`tests/mcp_server.test.ts` and `tests/mcp_prompts.test.ts` verify the protocol
surface (prompts + tools) against the official `@modelcontextprotocol/sdk`
client, the same library the hosts above are built on. Server-side tools reuse
the CLI's polisher and templates (config in `~/.config/dictum/config.toml`).

## /dictum in Claude Code (zero-install)

No MCP server connected? Dictum's slash command is a single markdown file that
does the same host-brain trick — Claude Code's own model polishes your draft
using the session context; no `dictum` binary required:

```sh
# in this repo it works out of the box (.claude/commands/dictum.md);
# install globally for all projects:
mkdir -p ~/.claude/commands
cp .claude/commands/dictum.md ~/.claude/commands/dictum.md
```

Then in any Claude Code session:

```
/dictum сделай миграцию на новую схему юзеров, но чтобы старые токены не отвалились
```

Claude shows the polished prompt, explains what changed, and acts only on the
version you choose. Mention that you want a full spec and it structures the
result with requirements and acceptance criteria.

## Configuration

`~/.config/dictum/config.toml` (every field optional; env vars override):

```toml
[recorder]
stopMode = "enter"        # enter | vad | ptt
silenceTimeout = 2.0      # seconds of silence for VAD auto-stop
energyThreshold = 0.015   # VAD voicing threshold (normalized RMS)

[stt]
providers = ["local_http", "openai_compat"]   # tried in order, with fallback
[stt.local_http]
baseUrl = "http://127.0.0.1:5500"             # GigaAM-compatible server
[stt.openai_compat]
baseUrl = "https://api.openai.com"
model = "whisper-1"
language = "ru"

[polisher]
provider = "claude_cli"   # claude_cli | anthropic | openai_compat
mode = "llm"              # llm | rules (offline, no LLM) | layered (LLM only when score < threshold)
scoreThreshold = 80       # layered mode: skip the LLM when the draft scores >= this
template = "agent-prompt"

[sink]
target = "clipboard"      # clipboard | stdout
```

Custom templates: drop `~/.config/dictum/templates/<name>.md` (frontmatter
`description` / `language` + instruction body) to override or add modes.
The file stem `<name>` is the mode ID — a portable ASCII slug (letters,
digits, `_`, `.`, `-`; e.g. `ru-contract-review.md`); the description and
body can be in any language. Files with other names are ignored.

Useful env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DICTUM_POLISHER`,
`DICTUM_POLISHER_MODE`, `DICTUM_SCORE_THRESHOLD`, `DICTUM_SINK`,
`DICTUM_STOP_MODE`, `DICTUM_CONFIG`.

## Requirements

- A polisher: the [Claude CLI](https://claude.com/claude-code) ≥ 2.1.169
  (default, uses your subscription; dictum runs it with project customizations
  disabled and all tools denied) **or** an `ANTHROPIC_API_KEY` /
  OpenAI-compatible key.
- An STT backend: a local GigaAM/Whisper HTTP server, or an OpenAI-compatible key.
- For live recording: [`sox`](http://sox.sourceforge.net/) (`apt install sox` /
  `brew install sox`). Not needed for `--input`.
- For `--input` with non-canonical WAV (not PCM16/16k/mono): `ffmpeg` to
  transcode. Canonical WAV plays without it.
- Clipboard: native (`pbcopy`/`wl-copy`/`xclip`) or, over SSH with an
  interactive terminal, OSC52 automatically (headless: use `--stdout`).

`dictum doctor` checks all of the above and tells you exactly what's missing.

## Supported platforms (v0.1)

| Platform | Status |
|---|---|
| Linux glibc x64 (modern CPUs) | **Supported** — primary development and test platform |
| Linux arm64, macOS 13+ (x64/arm64) | **Implemented, unverified** — cross-compiled binaries; promoted after native smoke |
| WSL / SSH / headless | Text flows via `--stdout` everywhere; clipboard via OSC52 needs an interactive terminal over SSH |
| Windows (native) | **Experimental, unverified** — text mode and the MCP server should run under Bun; microphone and clipboard flows are not implemented |

## Development

```sh
bun install
bun test            # unit + contract + e2e (mock servers; no mic needed)
bun run start --input tests/fixtures/sample-ru.wav --stdout
bun run build       # standalone binary → dist/dictum
```

TypeScript strict, linted with Biome. Architecture: each pluggable stage imports
only `src/core/types.ts`; assembly lives in `core/pipeline.ts` + `cli.ts` (an
import-orthogonality test enforces it).

## License

MIT
