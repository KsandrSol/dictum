/** Timed, check-only release lookup for `dictum update --check`. */

import { basename } from "node:path"

export const LATEST_RELEASE_URL = "https://api.github.com/repos/KsandrSol/dictum/releases/latest"

export type UpdateCheckResult =
  | { status: "up-to-date"; currentVersion: string; latestVersion: string }
  | { status: "available"; currentVersion: string; latestVersion: string }
  | { status: "error"; currentVersion: string }

export type InstallMethod = "installer" | "npm" | "source"

type UpdateCheckOptions = {
  endpoint?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error("Invalid semantic version")
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return Math.sign(delta)
  }
  return 0
}

function releaseVersion(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null
  const tag = (payload as Record<string, unknown>).tag_name
  if (typeof tag !== "string") return null
  const parsed = parseVersion(tag)
  return parsed ? parsed.join(".") : null
}

/** One HTTP request, bounded by a timeout; every remote failure is a soft result. */
export async function checkForUpdates(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  const endpoint = options.endpoint ?? LATEST_RELEASE_URL
  const fetchFn = options.fetchFn ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000)
  try {
    const response = await fetchFn(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `dictum-cli/${currentVersion}`,
      },
    })
    if (!response.ok) return { status: "error", currentVersion }
    const latestVersion = releaseVersion(await response.json())
    if (!latestVersion || !parseVersion(currentVersion)) {
      return { status: "error", currentVersion }
    }
    return compareVersions(latestVersion, currentVersion) > 0
      ? { status: "available", currentVersion, latestVersion }
      : { status: "up-to-date", currentVersion, latestVersion }
  } catch {
    return { status: "error", currentVersion }
  } finally {
    clearTimeout(timeout)
  }
}

export function detectInstallMethod(
  executable = process.execPath,
  entrypoint = Bun.argv[1],
): InstallMethod {
  const runtime = basename(executable).toLowerCase()
  if (runtime !== "bun" && runtime !== "bun.exe") return "installer"
  const normalized = entrypoint?.replaceAll("\\", "/") ?? ""
  if (normalized.includes("/node_modules/dictum-cli/") || normalized.endsWith("/bin/dictum.js")) {
    return "npm"
  }
  if (normalized.endsWith("/src/cli.ts")) return "source"
  return "installer"
}

export function updateHint(method: InstallMethod): string {
  if (method === "npm") return "npm i -g dictum-cli@latest"
  if (method === "source") return "git pull && bun install --frozen-lockfile"
  return "re-run the installer from the README"
}
