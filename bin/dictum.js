#!/usr/bin/env bun
// npm entry point. Dictum is a Bun program (uses Bun.spawn / Bun.file / text
// imports), so it runs under Bun — installed globally (`npm i -g dictum-cli`)
// or one-off via `bunx dictum-cli`. Requires Bun ≥ 1.1 on PATH.
import { main } from "../src/cli.ts"

process.exit(await main(Bun.argv.slice(2)))
