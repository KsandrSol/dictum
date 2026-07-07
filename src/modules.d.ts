// Ambient declarations for non-code imports embedded by Bun.

// Markdown templates imported as text: `import x from "./t.md" with { type: "text" }`
declare module "*.md" {
  const content: string
  export default content
}
