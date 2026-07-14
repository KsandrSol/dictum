/** Devin Desktop MCP and project-rule integration. */

import { DEVIN_RULE_SOURCE, DICTUM_RULE_MARKER } from "./rule.ts"
import {
  type FileUpdateResult,
  type ManagedFileState,
  assertManagedFileInstallable,
  installManagedFile,
  installMcpServer,
} from "./shared.ts"

export { DEVIN_RULE_SOURCE }

export async function installDevinMcp(path: string, binaryPath: string): Promise<FileUpdateResult> {
  return installMcpServer(path, binaryPath, "Devin MCP server")
}

export async function assertDevinRuleInstallable(path: string): Promise<void> {
  await assertManagedFileInstallable(path, DICTUM_RULE_MARKER, "Devin rule")
}

export async function installDevinRule(path: string): Promise<ManagedFileState> {
  return installManagedFile(path, DEVIN_RULE_SOURCE, DICTUM_RULE_MARKER, "Devin rule")
}
