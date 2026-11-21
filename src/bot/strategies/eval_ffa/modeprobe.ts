/**
 * Mode-safety probe: the real brain (mainBot) that logs when its runtime mode detector flips to FFA / SQUAD.
 * Use it as a league candidate in SQUAD sims to measure the false-flip rate to FFA:
 *
 *   MODEPROBE_OUT=data/tmp/ffa/modeprobe.jsonl bun src/league/batch.ts --mode squad \
 *     --candidate 'bot/strategies/eval_ffa/modeprobe.ts#probeBot' --seeds 1..96
 *   bun src/bot/strategies/eval_ffa/modeprobe.ts data/tmp/ffa/modeprobe.jsonl     # summary
 *
 * One line per match start ("s") and one per first flip ("f", t, alive, mode). Lines carry a per-process
 * random-free key (pid + instance counter) so start and flip pair up.
 */
import { appendFileSync, readFileSync } from "node:fs"
import type { Bot, BotContext, BotFactory, Observation } from "../../../contracts.ts"
import { createBrain } from "../../brain/index.ts"

let instances = 0

export const probeBot: BotFactory = (ctx: BotContext): Bot => {
  const b = createBrain(ctx)
  const out = process.env.MODEPROBE_OUT ?? ""
  const key = `${process.pid}-${instances++}`
  let started = false
  let tFfa = -1
  let tSquad = -1
  const log = (o: Record<string, unknown>) => {
    if (out) appendFileSync(out, JSON.stringify({ key, ...o }) + "\n")
  }
  const act = (obs: Observation) => {
    const a = b.act(obs)
    if (!started) {
      started = true
      log({ e: "s" })
    }
    const m = b.bb.mode
    if (m === 2 && tFfa < 0) {
      tFfa = obs.t
      log({ e: "f", mode: 2, t: obs.t, alive: obs.alive })
    }
    if (m === 1 && tSquad < 0) {
      tSquad = obs.t
      log({ e: "f", mode: 1, t: obs.t, alive: obs.alive })
    }
    return a
  }
  return { name: b.name, act }
}

if (import.meta.main) {
  const rows = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { key: string; e: string; mode?: number; t?: number; alive?: number })
  const starts = rows.filter((r) => r.e === "s").length
  const ffa = rows.filter((r) => r.e === "f" && r.mode === 2)
  const sq = rows.filter((r) => r.e === "f" && r.mode === 1)
  const ts = ffa.map((r) => r.t!).sort((a, b) => a - b)
  console.log(`matches ${starts}; flipped to FFA in ${ffa.length} (${((100 * ffa.length) / Math.max(1, starts)).toFixed(1)} %) at t = ${ts.map((t) => t.toFixed(0)).join(", ")}; SQUAD reached in ${sq.length}`)
}
