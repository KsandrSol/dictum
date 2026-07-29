import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import pkg from "../package.json" with { type: "json" }
import { checkForUpdates, compareVersions, detectInstallMethod, updateHint } from "../src/update.ts"

const CLI = new URL("../src/cli.ts", import.meta.url).pathname
const PORT = 7420
const BASE_URL = `http://127.0.0.1:${PORT}`
const CURRENT_VERSION = pkg.version
const currentParts = CURRENT_VERSION.split(".").map(Number)
const NEWER_VERSION = `${currentParts[0]}.${currentParts[1]}.${currentParts[2]! + 1}`
const requestCounts = new Map<string, number>()
let server: ReturnType<typeof Bun.serve>

async function runCli(endpoint: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI, "update", "--check"], {
    env: { ...process.env, DICTUM_UPDATE_CHECK_URL: endpoint },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1)
      if (path === "/available") return Response.json({ tag_name: `v${NEWER_VERSION}` })
      if (path === "/current") return Response.json({ tag_name: `v${CURRENT_VERSION}` })
      if (path === "/slow") {
        await Bun.sleep(100)
        return Response.json({ tag_name: `v${NEWER_VERSION}` })
      }
      return new Response("unavailable", { status: 503 })
    },
  })
})

afterAll(() => server.stop(true))

describe("update version logic", () => {
  test("compares numeric semantic versions", () => {
    expect(compareVersions("0.3.3", "0.3.2")).toBe(1)
    expect(compareVersions("0.3.2", "0.3.2")).toBe(0)
    expect(compareVersions("0.3.2", "0.10.0")).toBe(-1)
  })

  test("tailors hints to the detectable install method", () => {
    expect(detectInstallMethod("/usr/bin/bun", "/opt/node_modules/dictum-cli/bin/dictum.js")).toBe(
      "npm",
    )
    expect(detectInstallMethod("/usr/bin/bun", "/work/dictum/src/cli.ts")).toBe("source")
    expect(detectInstallMethod("/home/me/.local/bin/dictum", "/$bunfs/root/src/cli.ts")).toBe(
      "installer",
    )
    expect(updateHint("npm")).toContain("npm i -g")
    expect(updateHint("installer")).toContain("installer")
  })
})

describe("update --check contract", () => {
  test("reports a newer latest release from one mock request", async () => {
    const requestsBefore = requestCounts.get("/available") ?? 0
    expect(await checkForUpdates(CURRENT_VERSION, { endpoint: `${BASE_URL}/available` })).toEqual({
      status: "available",
      currentVersion: CURRENT_VERSION,
      latestVersion: NEWER_VERSION,
    })
    expect(requestCounts.get("/available")).toBe(requestsBefore + 1)
    const cli = await runCli(`${BASE_URL}/available`)
    expect(cli.code).toBe(0)
    expect(cli.stdout).toContain(`${NEWER_VERSION} available`)
    expect(cli.stdout).toContain("Update:")
  })

  test("reports the running version as up to date", async () => {
    expect(await checkForUpdates(CURRENT_VERSION, { endpoint: `${BASE_URL}/current` })).toEqual({
      status: "up-to-date",
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
    })
    const cli = await runCli(`${BASE_URL}/current`)
    expect(cli.code).toBe(0)
    expect(cli.stdout).toContain(`${CURRENT_VERSION} is up to date`)
  })

  test("non-200 and offline failures degrade to a soft message", async () => {
    expect(await checkForUpdates(CURRENT_VERSION, { endpoint: `${BASE_URL}/error` })).toEqual({
      status: "error",
      currentVersion: CURRENT_VERSION,
    })
    const httpFailure = await runCli(`${BASE_URL}/error`)
    expect(httpFailure.code).toBe(0)
    expect(httpFailure.stdout).toContain("could not check for updates")

    const offline = await runCli("http://127.0.0.1:7499/releases/latest")
    expect(offline.code).toBe(0)
    expect(offline.stdout).toContain("could not check for updates")
  })

  test("a stalled response is aborted at the configured timeout", async () => {
    expect(
      await checkForUpdates(CURRENT_VERSION, {
        endpoint: `${BASE_URL}/slow`,
        timeoutMs: 10,
      }),
    ).toEqual({ status: "error", currentVersion: CURRENT_VERSION })
  })
})
