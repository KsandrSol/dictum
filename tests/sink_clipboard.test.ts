import { describe, expect, test } from "bun:test"
import { ClipboardSink, buildOsc52, detectClipboard } from "../src/sink/clipboard.ts"

const ESC = "\x1b"
const BEL = "\x07"

/** which-stub: returns a fake path only for the listed binaries. */
function whichFor(...present: string[]): (b: string) => string | null {
  return (b) => (present.includes(b) ? `/usr/bin/${b}` : null)
}

describe("detectClipboard mechanism selection", () => {
  test("SSH session → OSC52 (regardless of installed tools)", () => {
    const m = detectClipboard({ SSH_CONNECTION: "1 2 3 4" } as NodeJS.ProcessEnv, whichFor("xclip"))
    expect(m.kind).toBe("osc52")
    expect(m.label).toMatch(/OSC52/)
  })

  test("SSH_TTY also triggers OSC52", () => {
    expect(detectClipboard({ SSH_TTY: "/dev/pts/0" } as NodeJS.ProcessEnv, whichFor()).kind).toBe(
      "osc52",
    )
  })

  test("Wayland with wl-copy → wl-copy", () => {
    const m = detectClipboard(
      { WAYLAND_DISPLAY: "wayland-0" } as NodeJS.ProcessEnv,
      whichFor("wl-copy"),
    )
    expect(m).toEqual({ kind: "command", label: "wl-copy (wayland)", argv: ["wl-copy"] })
  })

  test("macOS pbcopy", () => {
    const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor("pbcopy"))
    expect(m).toEqual({ kind: "command", label: "pbcopy (macOS)", argv: ["pbcopy"] })
  })

  test("X11 xclip with selection arg", () => {
    const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor("xclip"))
    expect(m).toEqual({
      kind: "command",
      label: "xclip (x11)",
      argv: ["xclip", "-selection", "clipboard"],
    })
  })

  test("nothing available → none", () => {
    expect(detectClipboard({} as NodeJS.ProcessEnv, whichFor()).kind).toBe("none")
  })

  test("pbcopy preferred over xclip when both present (non-SSH)", () => {
    const m = detectClipboard({} as NodeJS.ProcessEnv, whichFor("pbcopy", "xclip"))
    expect(m.kind).toBe("command")
    expect(m.label).toMatch(/pbcopy/)
  })
})

describe("buildOsc52", () => {
  test("plain sequence is ESC ]52;c;<base64> BEL", () => {
    const b64 = Buffer.from("hello", "utf8").toString("base64")
    expect(buildOsc52("hello")).toBe(`${ESC}]52;c;${b64}${BEL}`)
  })

  test("base64 encodes UTF-8 (Cyrillic) correctly", () => {
    const text = "привет"
    const seq = buildOsc52(text)
    const b64 = seq.slice(`${ESC}]52;c;`.length, -1)
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(text)
  })

  test("tmux passthrough wraps with DCS and doubles ESC", () => {
    const seq = buildOsc52("hi", { tmux: true })
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true)
    expect(seq.endsWith(`${ESC}\\`)).toBe(true)
    // inner ESCs are doubled
    expect(seq).toContain(`${ESC}${ESC}]52;c;`)
  })
})

describe("ClipboardSink", () => {
  test("throws an actionable error when no mechanism is available", async () => {
    const sink = new ClipboardSink({} as NodeJS.ProcessEnv, () => null)
    await expect(sink.emit("x")).rejects.toThrow(/No clipboard tool found.*--stdout/s)
  })
})
