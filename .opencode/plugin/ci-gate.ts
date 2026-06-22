import type { Plugin } from "@opencode-ai/plugin"

const CI_TIMEOUT_MS = 5 * 60_000
const MAX_AUTOFIX_TURNS = 2
const SENTINEL = "[CI-GATE-AUTO]"

type TurnState = { edited: boolean; ciRanByAssistant: boolean }

const turn = new Map<string, TurnState>()
const autofixCount = new Map<string, number>()
const inflightAutoRun = new Set<string>()

const RESET = "\x1b[0m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])

const isCiCommand = (cmd: string) => /^npm\s+(?:run\s+)?ci(?:\s|$)/.test(cmd.trim())

const firstTextPart = (parts: any[]): string => {
  for (const p of parts ?? []) {
    if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") return p.text
  }
  return ""
}

const DEBUG_FILE = process.env.CI_GATE_DEBUG ? "/tmp/ci-gate-debug.log" : ""
const debug = (...args: any[]) => {
  if (!DEBUG_FILE) return
  try {
    const line =
      new Date().toISOString() +
      " " +
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") +
      "\n"
    const fs = require("fs")
    fs.appendFileSync(DEBUG_FILE, line)
  } catch {}
}

export default (async ({ client, $, directory }) => {
  debug("plugin init", { directory, hasClient: !!client, hasShell: !!$ })
  return {
    "tool.execute.after": async (input, _output) => {
      const sid: string | undefined = input?.sessionID
      debug("tool.execute.after", { tool: input?.tool, sid })
      if (!sid) return

      if (EDIT_TOOLS.has(input.tool)) {
        const s = turn.get(sid) ?? { edited: false, ciRanByAssistant: false }
        s.edited = true
        turn.set(sid, s)
        debug("marked edited", sid)
        return
      }

      if (input.tool === "bash") {
        const cmd: string =
          typeof input.args?.command === "string" ? input.args.command : ""
        debug("bash command", { sid, cmd, isCi: isCiCommand(cmd) })
        if (isCiCommand(cmd)) {
          const s = turn.get(sid) ?? { edited: false, ciRanByAssistant: false }
          s.ciRanByAssistant = true
          turn.set(sid, s)
        }
      }
    },

    event: async ({ event }) => {
      const ev = event as { type: string; properties: any }
      debug("event", { type: ev.type, props: ev.properties })
      if (ev.type !== "session.idle") return

      const sid: string = ev.properties?.sessionID
      if (!sid) return

      const st = turn.get(sid) ?? { edited: false, ciRanByAssistant: false }
      turn.delete(sid)

      if (!st.edited) return
      if (st.ciRanByAssistant) {
        console.log(`${DIM}[ci-gate]${RESET} assistant already ran \`npm run ci\`; skipping.`)
        return
      }
      if (inflightAutoRun.has(sid)) return

      const count = autofixCount.get(sid) ?? 0
      if (count >= MAX_AUTOFIX_TURNS) {
        console.error(
          `${RED}[ci-gate]${RESET} autofix cap reached (${count}); not injecting. ` +
            `Run ${DIM}npm run ci${RESET} manually, or send any prompt to reset the cap.`,
        )
        return
      }

      inflightAutoRun.add(sid)
      try {
        const proc = $`npm run ci`.cwd(directory).nothrow().quiet()
        const result: any = await Promise.race([
          proc,
          new Promise<null>((r) => setTimeout(() => r(null), CI_TIMEOUT_MS)),
        ])

        if (result === null) {
          console.error(`${RED}[ci-gate]${RESET} \`npm run ci\` timed out after ${CI_TIMEOUT_MS / 1000}s.`)
          return
        }

        const exitCode: number = result.exitCode
        const stdout: string =
          (result.stdout?.toString("utf8") ?? "") + (result.stderr?.toString("utf8") ?? "")

        if (exitCode === 0) {
          console.log(`${GREEN}[ci-gate]${RESET} \`npm run ci\` PASSED (auto).`)
          autofixCount.delete(sid)
          return
        }

        const nextCount = count + 1
        autofixCount.set(sid, nextCount)
        console.error(
          `${RED}[ci-gate]${RESET} \`npm run ci\` FAILED (exit ${exitCode}); ` +
            `injecting feedback turn ${nextCount}/${MAX_AUTOFIX_TURNS}.`,
        )

        const tail = stdout.length > 12_000 ? "…" + stdout.slice(-12_000) : stdout
        const body =
          `${SENTINEL}\n` +
          `The CI gate plugin auto-ran \`npm run ci\` after your edits this turn and it ` +
          `failed with exit code ${exitCode}. Read the failure output below, fix every ` +
          `issue (typecheck / lint / test / format), then either re-run \`npm run ci\` ` +
          `yourself or stop editing so the gate can re-run. Do not reply with only text — ` +
          `make the code fixes.\n\n<ci-output>\n${tail}\n</ci-output>\n`

        await client.session.prompt({
          path: { id: sid },
          body: { parts: [{ type: "text", text: body }] },
        })
      } finally {
        inflightAutoRun.delete(sid)
      }
    },

    "chat.message": async (input, output) => {
      const sid: string | undefined = input?.sessionID
      if (!sid) return
      const text = firstTextPart(output?.parts ?? []) || (output?.message as any)?.text || ""
      if (text.startsWith(SENTINEL)) return
      autofixCount.delete(sid)
    },
  }
}) satisfies Plugin