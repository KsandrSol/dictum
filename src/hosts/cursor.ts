/** Cursor MCP and project-rule integration. */

import { CURSOR_RULE_SOURCE, DICTUM_RULE_MARKER } from "./rule.ts"
import {
  type FileUpdateResult,
  type ManagedFileState,
  assertManagedFileInstallable,
  installManagedFile,
  installMcpServer,
} from "./shared.ts"

export { CURSOR_RULE_SOURCE }

export async function installCursorMcp(
  path: string,
  binaryPath: string,
): Promise<FileUpdateResult> {
  return installMcpServer(path, binaryPath, "Cursor MCP server")
}

export async function assertCursorRuleInstallable(path: string): Promise<void> {
  await assertManagedFileInstallable(path, DICTUM_RULE_MARKER, "Cursor rule")
}

export async function installCursorRule(path: string): Promise<ManagedFileState> {
  return installManagedFile(path, CURSOR_RULE_SOURCE, DICTUM_RULE_MARKER, "Cursor rule")
}
