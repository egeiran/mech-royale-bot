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
 *
 * Evidence log (EVID_OUT=<file>; also hooked into eval_ffa/run.ts for FFA fields): per match one "s" line, one "d" line
 * per death we did not cause (t, alive, death-sound label heard within 0.3 s, quiet / combat state, our kills so far),
 * one "c" line per soft-detector cue the first time it fires (kind, t), "m" lines with logOdds at 10/20/30/45 s.
 * Offline: bun data/tmp/final/evid.ts <file> (rules: recall / time on FFA files, false-flip rate on squad files).
 */
import { appendFileSync, readFileSync } from "node:fs"
import type { Bot, BotContext, BotFactory, Observation } from "../../../contracts.ts"
import { createBrain, type BrainBot } from "../../brain/index.ts"

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
  const ev = evidenceLogger(b, ctx)
  const act = (obs: Observation) => {
    const a = b.act(obs)
    ev?.(obs)
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

/** evidence logger for one brain (null when EVID_OUT is not set); call after b.act(obs) */
export function evidenceLogger(b: BrainBot, ctx: BotContext, tag: Record<string, unknown> = {}): ((obs: Observation) => void) | null {
  const out = process.env.EVID_OUT ?? ""
  if (!out) return null
  const key = `${process.pid}-${instances++}-${ctx.hello.seed}`
  const log = (o: Record<string, unknown>) => appendFileSync(out, JSON.stringify({ key, ...tag, ...o }) + "\n")
  let prevAlive = -1
  let kills = 0
  let tNearDeath = -1e9
  let tMidDeath = -1e9
  let tFarDeath = -1e9
  const cues = ["beamHits", "hpDrops", "strayBullets", "crossAimObs", "farSounds", "peaceObs"] as const
  const cueT: Record<string, number> = {}
  const marks = [10, 20, 30, 45]
  let mi = 0
  return (obs: Observation) => {
    const bb = b.bb
    if (prevAlive < 0) {
      prevAlive = obs.alive
      log({ e: "s", seat: obs.self.id })
    }
    for (const e of obs.events) if (e.type === "kill") kills++
    for (const s of obs.sounds) {
      if (s.kind !== "death") continue
      if (s.dist === "near") tNearDeath = obs.t
      else if (s.dist === "mid") tMidDeath = obs.t
      else tFarDeath = obs.t
    }
    let died = prevAlive - obs.alive
    prevAlive = obs.alive
    if (died > 0) {
      for (const e of obs.events) if (e.type === "kill") died--
      if (died > 0) {
        const lab = obs.t - tNearDeath < 0.35 ? "near" : obs.t - tMidDeath < 0.35 ? "mid" : obs.t - tFarDeath < 0.35 ? "far" : "none"
        log({ e: "d", t: obs.t, n: died, alive: obs.alive, lab, quiet: obs.t - bb.tCombat > bb.P.quietDeathS && bb.nThreats === 0 ? 1 : 0, combatAgo: Math.round((obs.t - bb.tCombat) * 10) / 10, hurtAgo: Math.round((obs.t - bb.tHurt) * 10) / 10, thr: bb.nThreats, nEn: bb.nEn, kills, hp: Math.round(100 * bb.hpFrac), zr: Math.round(obs.zone.radius) })
      }
    }
    const md = bb.modeDet as unknown as Record<string, number>
    for (const c of cues) {
      if (cueT[c] === undefined && (md[c] ?? 0) > 0) {
        cueT[c] = obs.t
        log({ e: "c", k: c, t: obs.t })
      }
    }
    while (mi < marks.length && obs.t >= marks[mi]!) log({ e: "m", t: marks[mi++], L: Math.round(bb.modeDet.logOdds * 100) / 100, mode: bb.mode })
  }
}

if (import.meta.main) {
  const rows = readFileSync(process.argv[2]!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { key: string; e: string; mode?: number; t?: number; alive?: number })
  const starts = rows.filter((r) => r.e === "s").length
  const ffa = rows.filter((r) => r.e === "f" && r.mode === 2)
  const sq = rows.filter((r) => r.e === "f" && r.mode === 1)
  const ts = ffa.map((r) => r.t!).sort((a, b) => a - b)
  console.log(`matches ${starts}; flipped to FFA in ${ffa.length} (${((100 * ffa.length) / Math.max(1, starts)).toFixed(1)} %) at t = ${ts.map((t) => t.toFixed(0)).join(", ")}; SQUAD reached in ${sq.length}`)
}
