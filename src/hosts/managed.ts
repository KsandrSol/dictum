/** User-scoped managed host files: read-only status and best-effort self-heal. */

import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import claudeCommandSource from "../../.claude/commands/dictum.md" with { type: "text" }
import { DICTUM_RULE_MARKER } from "./rule.ts"
import { atomicWrite, errorCode, installManagedFile, readOptional } from "./shared.ts"
import codexSkillSource from "./skills/dictum/SKILL.md" with { type: "text" }
import codexSkillMetadataSource from "./skills/dictum/agents/openai.yaml" with { type: "text" }

export const DICTUM_MANAGED_MARKER = DICTUM_RULE_MARKER
export const CLAUDE_COMMAND_SOURCE = claudeCommandSource
export const CODEX_SKILL_SOURCE = codexSkillSource
export const CODEX_SKILL_METADATA_SOURCE = codexSkillMetadataSource
export const CODEX_SKILL_METADATA_LEGACY_SOURCE = codexSkillMetadataSource.replace(
  `# ${DICTUM_MANAGED_MARKER}\n\n`,
  "",
)

export type ManagedHostName = "claude" | "codex"
export type ManagedFileStatusName = "up-to-date" | "stale" | "unmanaged" | "absent"

type ManagedCompanionFile = {
  path: string
  contents: string
  marker: string
  legacyContents: string[]
}

export type ManagedFileTarget = {
  host: ManagedHostName
  label: string
  path: string
  contents: string
  marker: string
  companionFiles: ManagedCompanionFile[]
  detectionPaths: string[]
}

export type ManagedFileStatus = {
  host: ManagedHostName
  label: string
  path: string
  status: ManagedFileStatusName
  hash: string | null
  expectedHash: string
}

type Environment = Readonly<Record<string, string | undefined>>

/**
 * The only startup-reconciled paths. They are rooted in the user's home, so a
 * hook launched from a project can never rewrite that project's checked-in
 * `.cursor/rules` or `.devin/rules` files.
 */
export function userManagedFileTargets(
  home: string,
  environment: Environment = process.env,
): ManagedFileTarget[] {
  const codexHome = environment.CODEX_HOME?.trim() || join(home, ".codex")
  return [
    {
      host: "claude",
      label: "Claude command",
      path: join(home, ".claude", "commands", "dictum.md"),
      contents: CLAUDE_COMMAND_SOURCE,
      marker: DICTUM_MANAGED_MARKER,
      companionFiles: [],
      detectionPaths: [join(home, ".claude")],
    },
    {
      host: "codex",
      label: "Codex skill",
      path: join(home, ".agents", "skills", "dictum", "SKILL.md"),
      contents: CODEX_SKILL_SOURCE,
      marker: DICTUM_MANAGED_MARKER,
      companionFiles: [
        {
          path: join(home, ".agents", "skills", "dictum", "agents", "openai.yaml"),
          contents: CODEX_SKILL_METADATA_SOURCE,
          marker: DICTUM_MANAGED_MARKER,
          legacyContents: [CODEX_SKILL_METADATA_LEGACY_SOURCE],
        },
      ],
      detectionPaths: [codexHome, join(home, ".agents", "skills", "dictum")],
    },
  ]
}

/** Stable eight-character SHA-256 prefix for compact human and JSON reports. */
export function shortHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 8)
}

export function classifyManagedContents(
  existing: string | undefined,
  expected: string,
  marker: string,
): Pick<ManagedFileStatus, "status" | "hash" | "expectedHash"> {
  const expectedHash = shortHash(expected)
  if (existing === undefined) return { status: "absent", hash: null, expectedHash }
  const hash = shortHash(existing)
  if (!existing.includes(marker)) return { status: "unmanaged", hash, expectedHash }
  return { status: existing === expected ? "up-to-date" : "stale", hash, expectedHash }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

function targetFiles(target: ManagedFileTarget): ManagedCompanionFile[] {
  return [
    { path: target.path, contents: target.contents, marker: target.marker, legacyContents: [] },
    ...target.companionFiles,
  ]
}

function combinedHashContents(contents: Array<string | undefined>): string {
  if (contents.length === 1) return contents[0] ?? ""
  return contents.map((value, index) => `${index}\0${value ?? "<absent>"}`).join("\0")
}

function classifyManagedTarget(
  target: ManagedFileTarget,
  existing: Array<string | undefined>,
): Pick<ManagedFileStatus, "status" | "hash" | "expectedHash"> {
  const files = targetFiles(target)
  const expectedHash = shortHash(combinedHashContents(files.map((file) => file.contents)))
  if (existing[0] === undefined) return { status: "absent", hash: null, expectedHash }
  const hash = shortHash(combinedHashContents(existing))
  if (
    files.some(
      (file, index) =>
        existing[index] !== undefined &&
        existing[index]?.includes(file.marker) === false &&
        !file.legacyContents.includes(existing[index]!),
    )
  ) {
    return { status: "unmanaged", hash, expectedHash }
  }
  const current = files.every((file, index) => existing[index] === file.contents)
  return { status: current ? "up-to-date" : "stale", hash, expectedHash }
}

/** Inspect every detected host without modifying any file or directory. */
export async function inspectUserManagedFiles(
  home = homedir(),
  environment: Environment = process.env,
): Promise<ManagedFileStatus[]> {
  const inspected = await Promise.all(
    userManagedFileTargets(home, environment).map(async (target) => {
      const existing = await Promise.all(targetFiles(target).map((file) => readOptional(file.path)))
      const detected =
        existing[0] !== undefined ||
        (await Promise.all(target.detectionPaths.map(pathExists))).some(Boolean)
      if (!detected) return null
      return {
        host: target.host,
        label: target.label,
        path: target.path,
        ...classifyManagedTarget(target, existing),
      }
    }),
  )
  return inspected.filter((status): status is ManagedFileStatus => status !== null)
}

/**
 * Reconcile only existing, marker-owned files. Every target is isolated so an
 * unreadable path, unmanaged collision, or failed atomic write cannot affect
 * another target or the hook/MCP startup that called this function.
 */
export async function reconcileUserManagedFiles(
  home?: string,
  environment: Environment = process.env,
): Promise<void> {
  try {
    const targets = userManagedFileTargets(home ?? homedir(), environment)
    await Promise.all(
      targets.flatMap((target) =>
        targetFiles(target).map(async (file) => {
          try {
            const existing = await readOptional(file.path)
            if (existing === undefined) return
            if (existing.includes(file.marker)) {
              await installManagedFile(file.path, file.contents, file.marker, target.label)
            } else if (file.legacyContents.includes(existing)) {
              // Exact previously-shipped bytes are safe to adopt into the
              // marker-owned format; any edited/unrecognized file is skipped.
              await atomicWrite(file.path, file.contents)
            }
          } catch {
            // One file must not prevent the remaining target files from healing.
          }
        }),
      ),
    )
  } catch {
    // Even target discovery is best-effort: startup repair must never escape.
  }
}

/** Await hot-path repair briefly; output is written before this wait begins. */
export async function settleReconcile(reconcile: Promise<void>, timeoutMs = 100): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    reconcile.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}
