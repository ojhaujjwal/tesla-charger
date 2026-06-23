import type { Plugin } from "@opencode-ai/plugin"
import { execSync, spawnSync } from "node:child_process"

const CI_TIMEOUT_MS = 5 * 60_000
const MAX_AUTOFIX_TURNS = 5
const SENTINEL = "[CI-GATE-AUTO]"

const lastSeenHash = new Map<string, string>()
const ciRanThisTurn = new Set<string>()
const autofixCount = new Map<string, number>()
const inflightAutoRun = new Set<string>()

const isCiCommand = (cmd: string) => /^npm\s+(?:run\s+)?ci(?:\s|$)/.test(cmd.trim())

const treeHash = (directory: string): string => {
  try {
    return execSync("git stash create --include-untracked", {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return ""
  }
}

const firstTextPart = (parts: any[]): string => {
  for (const p of parts ?? []) {
    if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") return p.text
  }
  return ""
}

type ToastVariant = "info" | "success" | "warning" | "error"

const notify = (
  client: { tui?: { showToast: (opts: any) => Promise<any> } },
  message: string,
  variant: ToastVariant,
  title = "ci-gate",
): void => {
  try {
    void client.tui?.showToast({
      body: { title, message, variant, duration: variant === "error" ? 10_000 : 4_000 },
    })
  } catch {}
}

const runCiSynchronously = (directory: string): { exitCode: number; stdout: string } => {
  try {
    const result = spawnSync("npm", ["run", "ci"], {
      cwd: directory,
      encoding: "utf8",
      timeout: CI_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    })
    return {
      exitCode: result.status ?? 1,
      stdout: (result.stdout ?? "") + (result.stderr ?? ""),
    }
  } catch (e: any) {
    return { exitCode: -1, stdout: `Failed to spawn npm run ci: ${e?.message ?? e}` }
  }
}

export default (async ({ client, directory }) => {
  const note = (message: string, variant: ToastVariant = "info", title = "ci-gate") =>
    notify(client as any, message, variant, title)

  return {
    "chat.message": async (input, output) => {
      const sid: string | undefined = input?.sessionID
      if (!sid) return
      const text = firstTextPart(output?.parts ?? []) || (output?.message as any)?.text || ""
      if (text.startsWith(SENTINEL)) return
      lastSeenHash.set(sid, treeHash(directory))
      autofixCount.delete(sid)
      ciRanThisTurn.delete(sid)
    },

    event: async ({ event }) => {
      const ev = event as { type: string; properties: any }

      if (ev.type === "session.next.shell.started") {
        const sid: string = ev.properties?.sessionID
        if (sid && isCiCommand(ev.properties?.command ?? "")) ciRanThisTurn.add(sid)
        return
      }

      if (ev.type !== "session.idle") return

      const sid: string = ev.properties?.sessionID
      if (!sid || inflightAutoRun.has(sid)) return

      const current = treeHash(directory)
      const last = lastSeenHash.get(sid) ?? ""
      const changed = current !== last

      if (ciRanThisTurn.has(sid)) {
        note("working tree changed but assistant already ran `npm run ci`; skipping.", "info")
        lastSeenHash.set(sid, current)
        ciRanThisTurn.delete(sid)
        return
      }

      lastSeenHash.set(sid, current)
      ciRanThisTurn.delete(sid)

      if (!changed) return

      const count = autofixCount.get(sid) ?? 0
      if (count >= MAX_AUTOFIX_TURNS) {
        note(
          `autofix cap reached (${count}); not injecting. Run \`npm run ci\` manually, or send any prompt to reset the cap.`,
          "warning",
        )
        return
      }

      inflightAutoRun.add(sid)
      try {
        note("running `npm run ci` synchronously (files changed this turn)...", "info")
        const { exitCode, stdout } = runCiSynchronously(directory)
        lastSeenHash.set(sid, treeHash(directory))

        if (exitCode === 0) {
          note("`npm run ci` PASSED (auto) after detected file changes.", "success")
          autofixCount.delete(sid)
          return
        }

        const nextCount = count + 1
        autofixCount.set(sid, nextCount)
        note(
          `\`npm run ci\` FAILED (exit ${exitCode}); injecting feedback turn ${nextCount}/${MAX_AUTOFIX_TURNS}.`,
          "error",
        )

        const tail = stdout.length > 12_000 ? "…" + stdout.slice(-12_000) : stdout
        const body =
          `${SENTINEL}\n` +
          `The CI gate plugin detected file changes this turn and auto-ran \`npm run ci\`, ` +
          `which failed with exit code ${exitCode}. Read the failure output below, fix every ` +
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
  }
}) satisfies Plugin