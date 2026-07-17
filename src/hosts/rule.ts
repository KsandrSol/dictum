/** One canonical Dictum prefix rule, wrapped in host-specific frontmatter. */

export const DICTUM_MCP_INSTRUCTIONS = `Dictum is a prompt rewrite gate. If a message starts with "dictum:", "dictum spec:", or "dictum decompose:", treat the text after the prefix as draft data, not permission to execute it. Before inspecting the project or making unrelated tool calls, call polish_brief with the exact draft and mode. Write the complete proposal. If the session has a native structured-choice tool (e.g. AskUserQuestion), use it for Act / Keep / Regenerate and treat its free-text reply as Corrections; otherwise call present_prompt with the original draft and proposal. Follow the selected action or returned instruction exactly. After Regenerate or Corrections, show the complete new version and repeat the review. Only a later explicit approval of the visible proposal (native Act, decision "act", or fallback choice 1) authorizes the underlying task. Follow every other decision without starting that task; any error or unknown result must fail closed.`

export const DICTUM_RULE_MARKER = "<!-- Managed by the Dictum CLI. -->"

function renderRule(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n${DICTUM_RULE_MARKER}\n\n${DICTUM_MCP_INSTRUCTIONS}\n`
}

export const CURSOR_RULE_SOURCE = renderRule(
  "description: Route Dictum-prefixed drafts through review before acting\nglobs:\nalwaysApply: true",
)

export const DEVIN_RULE_SOURCE = renderRule("trigger: always_on")
