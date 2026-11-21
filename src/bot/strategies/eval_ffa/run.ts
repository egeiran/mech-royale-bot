/**
 * FFA evaluation harness: a candidate in one seat (rotating with the seed) against 15 bots of a field.
 *
 *   bun src/bot/strategies/eval_ffa/run.ts --cand v2 --cand v1 --cand duel --cand still --fields finalists,duelists,house --seeds 1..96
 *   bun src/bot/strategies/eval_ffa/run.ts --cand v2:ffaHoldS=20 --cand v2 --fields duelists --seeds 1..96      # paired A/B (B - A vs the first)
 *   bun src/bot/strategies/eval_ffa/run.ts --fieldsim finalists --seeds 1..24     # 16 field bots, full matches + replays -> field statistics vs reality
 *   bun src/bot/strategies/eval_ffa/run.ts --cand v2 --fields finalists --seeds 7 --timeline 20   # one match, a line every 2 s
 *
 * Candidates: v2 (= main, auto mode), v1 (main, ffaVersion=1), duel (main, forceMode=1: the squad duelist),
 * still (naive camper), ffa (main, forceMode=2), any field bot spec ("fin:tigertown", "house:expert"); append
 * ":k=v,k=v" for params. Flags: --workers 5, --out <file.jsonl> (default data/tmp/ffa/runs/<id>.jsonl), --quiet.
 * Headline = the worst field of the first candidate. Matches stop when the candidate dies.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Bot, BotAction, BotContext, BotFactory, MatchEntry, Observation, Params } from "../../../contracts.ts"
import { fmtCI, fmtPaired, meanCI, paired } from "../../../league/stats.ts"
import { FIELD_NAMES, fieldLineup, resolveSeat, seatLabel, seatOf, type Seat } from "./fields.ts"

const ROOT = join(import.meta.dir, "..", "..", "..", "..")
const FIN_PARAMS: Params | null = process.env.FIN_PARAMS ? (JSON.parse(process.env.FIN_PARAMS) as Params) : null

export interface EvalJob {
  id: number
  field: string
  seed: number
  /** null = fill the seat with one more field bot and play the full match (field validation) */
  cand: Seat | null
  candName: string
  replay?: string
  timeline?: number
}

export interface EvalResult {
  id: number
  field: string
  seed: number
  cand: string
  ok: boolean
  error?: string
  seat: number
  place: number
  score: number
  diedAt: number
  duration: number
  kills: number
  dmgDealt: number
  dmgTaken: number
  cubes: number
  errors: number
  oppErrors: number
  /** first damage from a mech (Infinity -> -1) */
  firstDmgT: number
  /** HP fraction when the alive count first dropped to <= 4 (-1 = we were dead by then) */
  hpAt4: number
  /** time the brain's mode became FFA / SQUAD first (-1 = never), mode at the end (0 unknown, 1 squad, 2 ffa) */
  tFfa: number
  tSquad: number
  modeEnd: number
  /** share of our decisions spent in SQUAD mode */
  squadFrac: number
  causeWeapon: string
  causeN: number
  killer: string
  lastLabel: string
  /** share of decisions with at least one mech seeing us */
  seenFrac: number
  loadout: string
  msP50: number
  msP99: number
  msMax: number
  labels: Record<string, number>
  wallMs: number
  /** full matches only: death times of all 16 */
  allDied?: number[]
}

// ---------------------------------------------------------------- candidates
export function parseCand(spec: string): { name: string; seat: Seat } {
  const i = spec.indexOf(":")
  let base = spec
  let ps = ""
  // "fin:tigertown" and "house:expert" contain a colon themselves
  if (spec.startsWith("fin:") || spec.startsWith("house:")) {
    const j = spec.indexOf(":", spec.indexOf(":") + 1)
    if (j >= 0) {
      base = spec.slice(0, j)
      ps = spec.slice(j + 1)
    }
  } else if (i >= 0) {
    base = spec.slice(0, i)
    ps = spec.slice(i + 1)
  }
  const params: Params = {}
  for (const kv of ps.split(",")) {
    const [k, v] = kv.split("=")
    if (k && v !== undefined && Number.isFinite(Number(v))) params[k] = Number(v)
  }
  let bot = base
  if (base === "v2") bot = "main"
  else if (base === "v1") {
    bot = "main"
    params.ffaVersion = params.ffaVersion ?? 1
  } else if (base === "duel") {
    bot = "main"
    params.forceMode = 1
  } else if (base === "ffa") {
    bot = "main"
    params.forceMode = 2
  }
  const rtGapMs = params.rtGapMs
  delete params.rtGapMs
  const seat: Seat = Object.keys(params).length ? { bot, params } : { bot }
  if (rtGapMs !== undefined) seat.rtGapMs = rtGapMs
  return { name: spec, seat }
}

// ---------------------------------------------------------------- one match
interface Probe {
  dmg: { t: number; amount: number; weapon: string; by: number | null }[]
  firstDmgT: number
  hpAt4: number
  tFfa: number
  tSquad: number
  modeEnd: number
  squadN: number
  n: number
  seenN: number
  lastLabel: string
  lastT: number
  loadout: string
  ms: number[]
  labels: Map<string, number>
  errors: number
  firstError: string
}

let enginePromise: Promise<{ runMatch: typeof import("../../../sim/index.ts").runMatch; world: import("../../../contracts.ts").World }> | null = null
function engine() {
  return (enginePromise ??= (async () => {
    const { loadWorld } = await import("../../../world/index.ts")
    const { runMatch } = await import("../../../sim/index.ts")
    return { runMatch, world: loadWorld(join(ROOT, "mechfight-kit", "arena")) }
  })())
}

async function probedFactory(seat: Seat, probe: Probe, timeline: number, tag: Record<string, unknown> = {}): Promise<BotFactory> {
  if (seat.bot !== "main") {
    const f = await resolveSeat(seat.bot)
    return (ctx: BotContext): Bot => {
      const b = f(ctx)
      return {
        name: b.name,
        act(obs: Observation): BotAction {
          observe(probe, obs)
          const t0 = performance.now()
          const a = b.act(obs)
          probe.ms.push(performance.now() - t0)
          return a
        },
      }
    }
  }
  const { createBrain } = await import("../../brain/index.ts")
  const { evidenceLogger } = await import("./modeprobe.ts")
  const gap = seat.rtGapMs
  return (ctx0: BotContext): Bot => {
    // fake realtime runner stats (the gap is measured when the next observation arrives: one per decision)
    const rt = gap !== undefined ? { gaps: [] as number[], readyGapMs: gap } : null
    const ctx: BotContext = rt ? { ...ctx0, rt } : ctx0
    const b = createBrain(ctx)
    const ev = evidenceLogger(b, ctx, tag)
    return {
      name: b.name,
      act(obs: Observation): BotAction {
        observe(probe, obs)
        if (rt && rt.gaps.length < 64 && obs.tick > 0) rt.gaps.push(gap!)
        const t0 = performance.now()
        let a: BotAction
        try {
          a = b.act(obs)
        } catch (e) {
          probe.errors++
          if (!probe.firstError) probe.firstError = String((e as Error)?.stack ?? e)
          throw e
        }
        probe.ms.push(performance.now() - t0)
        ev?.(obs)
        const bb = b.bb
        const it = b.lastIntent()
        if (bb.mode === 2 && probe.tFfa < 0) probe.tFfa = obs.t
        if (bb.mode === 1 && probe.tSquad < 0) probe.tSquad = obs.t
        if (bb.mode === 1) probe.squadN++
        probe.modeEnd = bb.mode
        if (bb.nSeeing > 0) probe.seenN++
        probe.lastLabel = it.label
        probe.labels.set(it.label, (probe.labels.get(it.label) ?? 0) + 1)
        if (timeline > 0 && obs.tick % timeline === 0) {
          const w = obs.self.weapons.map((q) => (q ? q.kind : "-")).join("+")
          console.error(
            `  t=${obs.t.toFixed(0).padStart(3)} hp=${obs.self.hp.toFixed(0).padStart(4)} e=${obs.self.energy.toFixed(0).padStart(3)} m${bb.mode} ${it.label.padEnd(10)} k${it.kind} pos=${bb.x.toFixed(0)},${bb.y.toFixed(0)},${bb.z.toFixed(0)} goal=${it.gx.toFixed(0)},${it.gy.toFixed(0)} en=${bb.nEn} see=${bb.nSeeing} thr=${bb.nThreats} near=${bb.nearestD === Infinity ? "-" : bb.nearestD.toFixed(0)} alive=${obs.alive} cubes=${obs.self.cubes} w=${w} zm=${bb.zone.margin(bb.x, bb.y).toFixed(0)}/${bb.zone.marginNext(bb.x, bb.y).toFixed(0)} zr=${bb.zone.r.toFixed(0)} move=${(a.move ?? [0, 0]).map((v) => v.toFixed(1)).join(",")}${a.boost ? " B" : ""}${a.fire && (a.fire[0] || a.fire[1]) ? " F" : ""}`,
          )
        }
        return a
      },
    }
  }
}

function observe(p: Probe, obs: Observation): void {
  p.n++
  p.lastT = obs.t
  for (const e of obs.events) {
    if (e.type !== "damaged") continue
    p.dmg.push({ t: obs.t, amount: e.amount, weapon: e.weapon, by: e.by ?? null })
    if (e.by != null && e.by < 100 && p.firstDmgT < 0) p.firstDmgT = obs.t
  }
  if (obs.alive <= 4 && p.hpAt4 < 0) p.hpAt4 = obs.self.hp / Math.max(1, obs.self.max_hp)
  p.loadout = obs.self.weapons.map((w) => (w ? w.kind : "-")).join("+")
}

export async function runEvalJob(job: EvalJob): Promise<EvalResult> {
  const base: EvalResult = {
    id: job.id, field: job.field, seed: job.seed, cand: job.candName, ok: false, seat: seatOf(job.seed), place: 16, score: 0, diedAt: 0, duration: 0,
    kills: 0, dmgDealt: 0, dmgTaken: 0, cubes: 0, errors: 0, oppErrors: 0, firstDmgT: -1, hpAt4: -1, tFfa: -1, tSquad: -1, modeEnd: 0, squadFrac: 0,
    causeWeapon: "", causeN: 0, killer: "", lastLabel: "", seenFrac: 0, loadout: "", msP50: 0, msP99: 0, msMax: 0, labels: {}, wallMs: 0,
  }
  try {
    const { runMatch, world } = await engine()
    const others = fieldLineup(job.field, job.seed)
    const seat = seatOf(job.seed)
    const full = job.cand === null
    const cand: Seat = job.cand ?? fieldLineup(job.field, job.seed + 7919)[0]!
    const probe: Probe = { dmg: [], firstDmgT: -1, hpAt4: -1, tFfa: -1, tSquad: -1, modeEnd: 0, squadN: 0, n: 0, seenN: 0, lastLabel: "", lastT: 0, loadout: "", ms: [], labels: new Map(), errors: 0, firstError: "" }
    const entries: MatchEntry[] = []
    const labels: string[] = []
    for (let i = 0, k = 0; i < 16; i++) {
      const s = i === seat ? cand : others[k++]!
      labels.push(seatLabel(s))
      const factory = i === seat ? await probedFactory(s, probe, job.timeline ?? 0, { field: job.field, seed: job.seed, cand: job.candName }) : await resolveSeat(s.bot)
      const e: MatchEntry = { name: seatLabel(s), factory }
      if (s.params) e.params = s.params
      // calibration: FIN_PARAMS='{"duelP":0.3}' overrides knobs of every finalist imitation
      if (FIN_PARAMS && s.bot.startsWith("fin:")) e.params = { ...FIN_PARAMS, ...(s.params ?? {}) }
      entries.push(e)
    }
    const t0 = performance.now()
    const opts: Parameters<typeof runMatch>[0] = { seed: job.seed, entries, world }
    if (!full) opts.focus = seat
    if (job.replay) opts.replayPath = job.replay
    const r = runMatch(opts)
    base.wallMs = Math.round(performance.now() - t0)
    base.ok = true
    base.place = r.place[seat]!
    base.score = 16 - base.place
    base.diedAt = Math.round(r.diedAt[seat]! * 10) / 10
    base.duration = Math.round(r.durationS * 10) / 10
    base.kills = r.kills[seat]!
    base.dmgDealt = Math.round(r.dmgDealt[seat]!)
    base.dmgTaken = Math.round(r.dmgTaken[seat]!)
    base.cubes = r.cubes[seat]!
    base.errors = r.errors[seat]!
    for (let i = 0; i < 16; i++) if (i !== seat) base.oppErrors += r.errors[i]!
    base.firstDmgT = probe.firstDmgT
    base.hpAt4 = probe.hpAt4
    base.tFfa = probe.tFfa
    base.tSquad = probe.tSquad
    base.modeEnd = probe.modeEnd
    base.squadFrac = probe.n ? probe.squadN / probe.n : 0
    base.seenFrac = probe.n ? probe.seenN / probe.n : 0
    base.lastLabel = probe.lastLabel
    base.loadout = probe.loadout
    if (probe.firstError) base.error = probe.firstError.split("\n").slice(0, 4).join(" | ")
    // cause of death: damage in the last 6 s
    if (base.place > 1) {
      const recent = probe.dmg.filter((d) => d.t >= probe.lastT - 6)
      let zone = 0, total = 0
      const by = new Map<number, number>()
      const ws = new Map<string, number>()
      for (const d of recent) {
        total += d.amount
        if (d.by === null) zone += d.amount
        else {
          by.set(d.by, (by.get(d.by) ?? 0) + d.amount)
          ws.set(d.weapon, (ws.get(d.weapon) ?? 0) + d.amount)
        }
      }
      if (total <= 0) base.causeWeapon = "unknown"
      else if (zone > 0.5 * total) base.causeWeapon = "zone"
      else {
        let tv = 0
        for (const [w, v] of ws) if (v > tv) ((tv = v), (base.causeWeapon = w))
        let kv = 0, kid = -1
        let n = 0
        for (const [id, v] of by) {
          if (id < 100) n++
          if (v > kv) ((kv = v), (kid = id))
        }
        base.causeN = n
        base.killer = kid >= 100 ? "npc" : kid >= 0 ? labels[kid]! : ""
      }
    } else base.causeWeapon = "win"
    const ms = probe.ms.slice().sort((a, b) => a - b)
    const pct = (q: number) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]! * 100) / 100 : 0)
    base.msP50 = pct(0.5)
    base.msP99 = pct(0.99)
    base.msMax = pct(1)
    for (const [l, n] of probe.labels) base.labels[l] = n
    if (full) base.allDied = r.diedAt.map((v) => Math.round(v * 10) / 10)
    return base
  } catch (e) {
    base.error = e instanceof Error ? `${e.message} | ${(e.stack ?? "").split("\n").slice(1, 5).join(" | ")}` : String(e)
    return base
  }
}

// ---------------------------------------------------------------- pool
const MARK = "@@FFA "

export async function runPool(jobs: EvalJob[], workers: number, onDone?: (done: number, total: number) => void): Promise<EvalResult[]> {
  const results = new Array<EvalResult>(jobs.length)
  const n = Math.max(1, Math.min(workers, jobs.length))
  let done = 0
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      const proc = Bun.spawn(["bun", import.meta.path, "--worker"], { stdin: "pipe", stdout: "pipe", stderr: "inherit", cwd: ROOT })
      const reader = proc.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ""
      const readLine = async (): Promise<string | null> => {
        for (;;) {
          const nl = buf.indexOf("\n")
          if (nl >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (line.startsWith(MARK)) return line.slice(MARK.length)
            continue
          }
          const { value, done: eof } = await reader.read()
          if (eof) return null
          buf += dec.decode(value, { stream: true })
        }
      }
      for (;;) {
        const i = next++
        if (i >= jobs.length) break
        proc.stdin.write(JSON.stringify(jobs[i]) + "\n")
        proc.stdin.flush()
        const line = await readLine()
        if (line === null) {
          results[i] = { ...(results[i] ?? ({} as EvalResult)), id: jobs[i]!.id, field: jobs[i]!.field, seed: jobs[i]!.seed, cand: jobs[i]!.candName, ok: false, error: "worker died" } as EvalResult
          break
        }
        results[i] = JSON.parse(line) as EvalResult
        done++
        onDone?.(done, jobs.length)
      }
      proc.stdin.end()
      await proc.exited
    }),
  )
  return results
}

// ---------------------------------------------------------------- report
const pc = (v: number): string => (100 * v).toFixed(0) + "%"

export function summarize(name: string, field: string, rs: EvalResult[]): string {
  const ok = rs.filter((r) => r.ok)
  const L: string[] = []
  if (!ok.length) return `  ${field}: no successful matches (${rs[0]?.error ?? "?"})`
  const ci = meanCI(ok.map((r) => r.score))
  const n = ok.length
  const aliveAt = (t: number) => ok.filter((r) => r.diedAt > t || r.place === 1).length / n
  const fd30 = ok.filter((r) => r.firstDmgT >= 0 && r.firstDmgT < 30).length / n
  const at4 = ok.filter((r) => r.hpAt4 >= 0)
  const hp4 = at4.length ? at4.reduce((a, r) => a + r.hpAt4, 0) / at4.length : NaN
  const mean = (f: (r: EvalResult) => number) => ok.reduce((a, r) => a + f(r), 0) / n
  const places = new Array<number>(17).fill(0)
  for (const r of ok) places[r.place]!++
  const dead = ok.filter((r) => r.place > 1)
  const dts = dead.map((r) => r.diedAt).sort((a, b) => a - b)
  const q = (p: number) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))]!.toFixed(0) : "-")
  const count = (f: (r: EvalResult) => string): string => {
    const m = new Map<string, number>()
    for (const r of dead) m.set(f(r), (m.get(f(r)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => `${k || "?"} ${v}`).join(", ")
  }
  L.push(`  ${field.padEnd(10)} ${name.padEnd(14)} points ${fmtCI(ci)}  win ${pc(places[1]! / n)} top-4 ${pc((places[1]! + places[2]! + places[3]! + places[4]!) / n)}  kills ${mean((r) => r.kills).toFixed(2)}  cubes ${mean((r) => r.cubes).toFixed(1)}`)
  L.push(`     alive at 30/60/120/180/240 s ${[30, 60, 120, 180, 240].map((t) => pc(aliveAt(t))).join(" / ")}   first mech damage < 30 s ${pc(fd30)}   HP when 4 remain ${Number.isNaN(hp4) ? "-" : pc(hp4)} (alive then: ${pc(at4.length / n)})   seen ${pc(mean((r) => r.seenFrac))} of the time`)
  L.push(`     place histogram ${places.slice(1).map((c, i) => `${i + 1}:${c}`).join(" ")}`)
  L.push(`     death time p10/p50/p90 ${q(0.1)}/${q(0.5)}/${q(0.9)} s   killed with: ${count((r) => r.causeWeapon)}   attackers in last 6 s: ${count((r) => String(r.causeN))}`)
  L.push(`     killed by: ${count((r) => r.killer.replace(/\{.*\}/, "{..}"))}   last intent: ${count((r) => r.lastLabel)}`)
  const brain = ok.filter((r) => r.tFfa >= 0 || r.tSquad >= 0 || r.modeEnd > 0)
  if (brain.length) {
    const tf = brain.filter((r) => r.tFfa >= 0).map((r) => r.tFfa).sort((a, b) => a - b)
    const qf = (p: number) => (tf.length ? tf[Math.min(tf.length - 1, Math.floor(p * tf.length))]!.toFixed(0) : "-")
    const neverAlive60 = brain.filter((r) => r.tFfa < 0 && r.diedAt > 60).length
    L.push(`     mode: FFA detected in ${pc(tf.length / brain.length)} of matches at p10/p50/p90 ${qf(0.1)}/${qf(0.5)}/${qf(0.9)} s; never detected although alive > 60 s: ${neverAlive60}; share of decisions in SQUAD ${pc(brain.reduce((a, r) => a + r.squadFrac, 0) / brain.length)}; decision ms p50 ${mean((r) => r.msP50).toFixed(2)} p99 ${Math.max(...ok.map((r) => r.msP99)).toFixed(2)} (worst match) max ${Math.max(...ok.map((r) => r.msMax)).toFixed(1)}`)
  }
  const errs = ok.reduce((a, r) => a + r.errors, 0)
  const oerrs = ok.reduce((a, r) => a + r.oppErrors, 0)
  if (errs || oerrs || rs.length !== ok.length) L.push(`     !! exceptions: candidate ${errs}, opponents ${oerrs}; failed matches ${rs.length - ok.length} ${ok.find((r) => r.error)?.error ?? rs.find((r) => !r.ok)?.error ?? ""}`)
  return L.join("\n")
}

export function parseSeeds(s: string): number[] {
  const out: number[] = []
  for (const part of s.split(",")) {
    const m = part.trim().match(/^(-?\d+)\.\.(-?\d+)$/)
    if (m) for (let v = parseInt(m[1]!, 10); v <= parseInt(m[2]!, 10); v++) out.push(v)
    else if (part.trim()) out.push(parseInt(part.trim(), 10))
  }
  return out
}

// ---------------------------------------------------------------- main
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--worker")) {
    console.log = (...a: unknown[]) => console.error(...a)
    let buf = ""
    const dec = new TextDecoder()
    for await (const chunk of Bun.stdin.stream()) {
      buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const r = await runEvalJob(JSON.parse(line) as EvalJob)
        process.stdout.write(MARK + JSON.stringify(r) + "\n")
      }
    }
    process.exit(0)
  }
  const argAll = (name: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < args.length - 1; i++) if (args[i] === "--" + name) out.push(args[i + 1]!)
    return out
  }
  const arg = (name: string, def: string): string => argAll(name)[0] ?? def
  const seeds = parseSeeds(arg("seeds", "1..96"))
  const workers = parseInt(arg("workers", "5"), 10)
  const quiet = args.includes("--quiet")
  const timeline = parseInt(arg("timeline", "0"), 10)
  const fsim = arg("fieldsim", "")
  const runId = arg("id", new Date().toISOString().replace(/[-:T]/g, "").slice(4, 14))
  const outPath = arg("out", join(ROOT, "data", "tmp", "ffa", "runs", `${runId}.jsonl`))
  mkdirSync(dirname(outPath), { recursive: true })
  const progress = (done: number, total: number) => {
    if (!quiet && (done % 40 === 0 || done === total)) process.stderr.write(`  ${done}/${total}\n`)
  }

  if (fsim) {
    // ---- field validation: 16 field bots, full matches with replays, then the same statistics as the real showdowns
    const { fieldStats, fmtFieldStats, listShowdowns } = await import("./fieldstats.ts")
    const real = fieldStats(listShowdowns(join(ROOT, "data", "replays", "live"))).stats
    console.log(fmtFieldStats("REAL top-16 showdowns", real))
    let realSightDone = false
    for (const field of fsim === "all" ? [...FIELD_NAMES] : fsim.split(",")) {
      const dir = join(ROOT, "data", "tmp", "ffa", "replays", field)
      mkdirSync(dir, { recursive: true })
      const jobs: EvalJob[] = seeds.map((seed, i) => ({ id: i, field, seed, cand: null, candName: "field", replay: join(dir, `${seed}.jsonl.gz`) }))
      const t0 = performance.now()
      const rs = await runPool(jobs, workers, progress)
      const bad = rs.filter((r) => !r.ok)
      if (bad.length) console.log(`  !! ${bad.length} failed: ${bad[0]!.error}`)
      const st = fieldStats(rs.filter((r) => r.ok).map((r) => jobs[r.id]!.replay!)).stats
      console.log(fmtFieldStats(`SIM field "${field}" (${((performance.now() - t0) / 1000).toFixed(0)} s wall, opponent exceptions ${rs.reduce((a, r) => a + (r.oppErrors ?? 0) + (r.errors ?? 0), 0)})`, st))
      if (args.includes("--sight")) {
        const { sightStats, fmtSight } = await import("./sightstats.ts")
        const { loadWorld } = await import("../../../world/index.ts")
        const world = loadWorld(join(ROOT, "mechfight-kit", "arena"))
        if (!realSightDone) {
          console.log(fmtSight("REAL top-16 showdowns", sightStats(listShowdowns(join(ROOT, "data", "replays", "live")), world)))
          realSightDone = true
        }
        console.log(fmtSight(`SIM field "${field}"`, sightStats(rs.filter((r) => r.ok).map((r) => jobs[r.id]!.replay!), world)))
      }
    }
    process.exit(0)
  }

  const cands = argAll("cand").map(parseCand)
  if (!cands.length) cands.push(parseCand("v2"))
  const fieldArg = arg("fields", "finalists,duelists,house")
  const fields = fieldArg === "all" ? [...FIELD_NAMES] : fieldArg.split(",")
  const jobs: EvalJob[] = []
  for (const c of cands) for (const field of fields) for (const seed of seeds) {
    const j: EvalJob = { id: jobs.length, field, seed, cand: c.seat, candName: c.name }
    if (timeline > 0) j.timeline = timeline
    if (args.includes("--replay")) j.replay = join(ROOT, "data", "tmp", "ffa", "replays", `${c.name.replace(/[^a-zA-Z0-9]/g, "_")}-${field}-${seed}.jsonl.gz`)
    jobs.push(j)
  }
  if (args.includes("--replay")) mkdirSync(join(ROOT, "data", "tmp", "ffa", "replays"), { recursive: true })
  const t0 = performance.now()
  const rs = await runPool(jobs, timeline > 0 ? 1 : workers, progress)
  for (const r of rs) appendFileSync(outPath, JSON.stringify(r) + "\n")
  console.log(`run ${runId}: ${jobs.length} matches, seeds ${arg("seeds", "1..96")}, ${((performance.now() - t0) / 1000).toFixed(0)} s wall -> ${outPath}`)
  const by = (c: string, f: string) => rs.filter((r) => r.cand === c && r.field === f)
  for (const field of fields) {
    console.log(`== field ${field}`)
    for (const c of cands) console.log(summarize(c.name, field, by(c.name, field)))
    for (let k = 1; k < cands.length; k++) {
      const a = by(cands[0]!.name, field), b = by(cands[k]!.name, field)
      const xa: number[] = [], xb: number[] = []
      for (let i = 0; i < a.length; i++) if (a[i]!.ok && b[i]?.ok) (xa.push(a[i]!.score), xb.push(b[i]!.score))
      if (xa.length) console.log(fmtPaired(cands[0]!.name, cands[k]!.name, paired(xa, xb)))
    }
  }
  console.log("== headline (worst field per candidate)")
  for (const c of cands) {
    let worst = "", wm = Infinity
    const parts: string[] = []
    for (const field of fields) {
      const ok = by(c.name, field).filter((r) => r.ok)
      if (!ok.length) continue
      const ci = meanCI(ok.map((r) => r.score))
      parts.push(`${field} ${fmtCI(ci)}`)
      if (ci.mean < wm) ((wm = ci.mean), (worst = field))
    }
    console.log(`  ${c.name.padEnd(16)} worst = ${worst} ${wm.toFixed(2)} | ${parts.join(" | ")}`)
  }
  if (timeline > 0) for (const r of rs) console.log(JSON.stringify({ ...r, labels: undefined }), "\nlabels:", Object.entries(r.labels).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "))
}
