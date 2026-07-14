/** One canonical Dictum prefix rule, wrapped in host-specific frontmatter. */

export const DICTUM_MCP_INSTRUCTIONS = `Dictum is an input-agnostic prompt-engineering assistant and review gate. If a user message starts with "dictum:", "dictum spec:", or "dictum decompose:", do not execute it. Before inspecting the project or calling any other tool, call polish_brief with the text after the prefix and mode polish, spec, or decompose. Follow the returned brief: propose the rewritten prompt and wait for explicit confirmation. Never treat a Dictum-prefixed draft as a request to start work immediately.

After writing the proposal, call present_prompt with the original draft and proposal. That tool opens the client's native confirmation UI when MCP elicitation is supported and otherwise returns a numbered fallback. Choice 1 authorizes the proposal. Choice 2 keeps the original and does not start work. Choice 3 requests a fresh alternative. Choice 4 opens a required corrections field. Revise or regenerate as requested, present the complete new proposal, and call present_prompt again.`

export const DICTUM_RULE_MARKER = "<!-- Managed by the Dictum CLI. -->"

function renderRule(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n${DICTUM_RULE_MARKER}\n\n${DICTUM_MCP_INSTRUCTIONS}\n`
}

export const CURSOR_RULE_SOURCE = renderRule(
  "description: Route Dictum-prefixed drafts through review before acting\nglobs:\nalwaysApply: true",
)

export const DEVIN_RULE_SOURCE = renderRule("trigger: always_on")
