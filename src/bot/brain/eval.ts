/**
 * Eval harness for the brain in our simulator.
 *
 *   bun src/bot/brain/eval.ts [--seeds 30] [--seed0 1] [--mode auto|squad|ffa] [--opp simple|main-squad|mix|squad]
 *       (--opp squad = the league's 15 house-bot imitations under one squad director, src/league/housebots)
 *       [--baseline] [--params k=v,k=v] [--oppParams k=v] [--timeline <seed>] [--quiet] [--replay <dir>]
 *
 * Our bot sits in seat (seed % 16); the other 15 seats are the opponents. Prints one line per match (place,
 * score = 16 - place, kills, time of death, cause) and a summary: mean score, kills, death causes, exceptions,
 * stuck episodes, decision time. --baseline runs simpleBot in the same seat on the same seeds for comparison.
 */
import type { Bot, BotAction, BotContext, BotFactory, MatchEntry, Observation } from "../../contracts.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { loadWorld } from "../../world/index.ts"
import { runMatch } from "../../sim/index.ts"
import { simpleBot } from "../simple.ts"
import { createBrain, type BrainBot } from "./index.ts"
import { MODE_NAMES } from "../perception/mode.ts"

const args = process.argv.slice(2)
const arg = (name: string, def: string): string => {
  const i = args.indexOf("--" + name)
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : def
}
const flag = (name: string) => args.includes("--" + name)
const parseParams = (s: string): Record<string, number> => {
  const o: Record<string, number> = {}
  for (const kv of s.split(",")) {
    const [k, v] = kv.split("=")
    if (k && v !== undefined && Number.isFinite(Number(v))) o[k] = Number(v)
  }
  return o
}

const nSeeds = parseInt(arg("seeds", "30"), 10)
const seed0 = parseInt(arg("seed0", "1"), 10)
const mode = arg("mode", "auto")
const opp = arg("opp", "simple")
const params = parseParams(arg("params", ""))
const oppParams = parseParams(arg("oppParams", ""))
const timelineSeed = parseInt(arg("timeline", "-1"), 10)
const quiet = flag("quiet")
const tlEvery = parseInt(arg("tlEvery", "40"), 10)
const replayDir = arg("replay", "")
/** --trace <dir>: one JSONL per match with our bot's per-decision state + events (for data/tmp/squad analysis) */
const traceDir = arg("trace", "")
if (mode === "squad") params.forceMode = 1
else if (mode === "ffa") params.forceMode = 2

// ---- optional: the league's house-bot squad (15 imitations sharing one director)
type DirectorLike = { truth(slot: number, x: number, y: number, z: number, vx: number, vy: number, hp: number, t: number): void }
let squadKit: { mk: (seed: number) => { director: DirectorLike; entry: (k: number) => MatchEntry } } | null = null
if (opp === "squad") {
  const { Director } = await import("../../league/housebots/director.ts")
  const { makeHouseBot } = await import("../../league/housebots/bot.ts")
  const { SQUAD_COMPOSITION } = await import("../../league/housebots/presets.ts")
  const { loadSquadParams } = await import("../../league/batch.ts")
  const { makeRng } = await import("../../util/rng.ts")
  const sp = loadSquadParams(oppParams)
  squadKit = {
    mk: (seed: number) => {
      const director = new Director(sp, makeRng((seed ^ 0x5d1ec7) >>> 0))
      return {
        director: director as unknown as DirectorLike,
        entry: (k: number) => {
          const preset = SQUAD_COMPOSITION[k % SQUAD_COMPOSITION.length]!
          let over: Record<string, number> | undefined
          for (const key of Object.keys(sp)) {
            const dot = key.indexOf(".")
            if (dot < 0) continue
            const who = key.slice(0, dot)
            if (who === preset || who === "all") (over ??= {})[key.slice(dot + 1)] = sp[key]!
          }
          return { name: "house:" + preset, factory: makeHouseBot(preset, director), params: over }
        },
      }
    },
  }
}

const world = loadWorld(new URL("../../../mechfight-kit/arena", import.meta.url).pathname)

interface Probe {
  trace: string[] | null
  dmg: { t: number; amount: number; weapon: string; by: number | null }[]
  lastLabel: string
  lastMode: number
  lastHp: number
  lastT: number
  labels: Map<string, number>
  ms: number[]
  errors: number
  firstError: string
  brain: BrainBot | null
  maxCubes: number
  weapons: string
  seenBy: number
  stuckSeen: number
  ltgT: number
  ltgSeenT: number
  ltgSeenD: number
  lasT: number
}

let curDirector: DirectorLike | null = null

function probed(seed: number, tl: boolean): { factory: BotFactory; probe: Probe } {
  const probe: Probe = { trace: traceDir ? [] : null, dmg: [], lastLabel: "", lastMode: 0, lastHp: 0, lastT: 0, labels: new Map(), ms: [], errors: 0, firstError: "", brain: null, maxCubes: 0, weapons: "", seenBy: 0, stuckSeen: 0, ltgT: -1, ltgSeenT: -1, ltgSeenD: -1, lasT: -1 }
  const factory: BotFactory = (ctx: BotContext): Bot => {
    const b = createBrain(ctx)
    probe.brain = b
    return {
      name: b.name,
      act(obs: Observation): BotAction {
        for (const e of obs.events) if (e.type === "damaged") probe.dmg.push({ t: obs.t, amount: e.amount, weapon: e.weapon, by: e.by })
        if (curDirector) curDirector.truth(obs.self.id, obs.self.pos[0], obs.self.pos[1], obs.self.pos[2], obs.self.vel[0], obs.self.vel[1], obs.self.hp, obs.t)
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
        const it = b.lastIntent()
        if (b.exec.stats.stuckEpisodes > probe.stuckSeen) {
          probe.stuckSeen = b.exec.stats.stuckEpisodes
          if (flag("stuck")) console.log(`  stuck: seed ${seed} t=${obs.t.toFixed(1)} label=${it.label} kind=${it.kind} pos=${b.bb.x.toFixed(1)},${b.bb.y.toFixed(1)},${b.bb.z.toFixed(1)} goal=${it.gx.toFixed(0)},${it.gy.toFixed(0)},${it.gz.toFixed(0)} move=${a.move?.map((v) => v.toFixed(2))} grounded=${obs.self.grounded} e=${obs.self.energy.toFixed(0)} tgt=${it.targetId}`)
        }
        probe.lastLabel = it.label
        probe.lastMode = b.bb.mode
        probe.lastHp = obs.self.hp
        probe.lastT = obs.t
        probe.maxCubes = Math.max(probe.maxCubes, obs.self.cubes)
        probe.weapons = obs.self.weapons.map((w) => (w ? w.kind : "-")).join("+")
        if (b.bb.nSeeing > 0) probe.seenBy++
        if (probe.ltgT < 0 && b.bb.haveLightning) probe.ltgT = obs.t
        if (probe.ltgSeenT < 0) {
          for (const p of obs.pickups) if (p.kind === "lightning") {
            probe.ltgSeenT = obs.t
            probe.ltgSeenD = Math.hypot(p.pos[0] - obs.self.pos[0], p.pos[1] - obs.self.pos[1])
          }
        }
        if (probe.lasT < 0 && b.bb.haveLaser) probe.lasT = obs.t
        probe.labels.set(it.label, (probe.labels.get(it.label) ?? 0) + 1)
        if (probe.trace) {
          const bb = b.bb
          const on: number[] = []
          const vis: number[] = []
          for (let i = 0; i < bb.nEn; i++) {
            const e = bb.en[i]!
            vis.push(e.id, Math.round(e.dist))
            if (obs.t - e.tShotAtUs < 3 || (e.aimingAtUs && bb.los[e.id] === 1)) on.push(e.id)
          }
          const ev: unknown[] = []
          for (const e of obs.events) {
            if (e.type === "damaged") ev.push(["d", e.by, Math.round(e.amount), e.weapon])
            else if (e.type === "hit") ev.push(["h", e.target, Math.round(e.amount), e.weapon])
            else if (e.type === "kill") ev.push(["k", e.target])
            else if (e.type === "drop") ev.push(["D"])
          }
          const ws = obs.self.weapons
          const las = bb.las
          probe.trace.push(JSON.stringify({
            t: obs.t, hp: Math.round(obs.self.hp), mx: Math.round(obs.self.max_hp), c: obs.self.cubes,
            w: ws.map((w) => (w ? w.kind[0] : "-")).join(""), l: it.label, tg: it.targetId,
            on, vis, x: Math.round(bb.x), y: Math.round(bb.y), ev,
            dr: obs.drops.map((d) => [Math.round(d.pos[0]), Math.round(d.pos[1]), Math.round(d.lands_in * 10) / 10, d.holder, Math.round(d.progress * 10) / 10]),
            f: a.fire ? (a.fire[0] ? 1 : 0) + (a.fire[1] ? 2 : 0) : 0,
            lc: las ? Math.round((las.charge ?? 0) * 100) / 100 : -1, lcd: las ? Math.round(las.cooldown * 100) / 100 : -1,
            zm: Math.round(bb.zone.margin(bb.x, bb.y)), e: Math.round(obs.self.energy),
          }))
        }
        if (tl && obs.tick % tlEvery === 0) {
          const bb = b.bb
          console.log(
            `  t=${obs.t.toFixed(0).padStart(3)} hp=${obs.self.hp.toFixed(0).padStart(4)}/${obs.self.max_hp.toFixed(0)} e=${obs.self.energy.toFixed(0).padStart(3)} ${MODE_NAMES[bb.mode]} ${it.label.padEnd(9)} pos=${bb.x.toFixed(0)},${bb.y.toFixed(0)},${bb.z.toFixed(0)} en=${bb.nEn} see=${bb.nSeeing} thr=${bb.nThreats} near=${bb.nearestD === Infinity ? "-" : bb.nearestD.toFixed(0)} alive=${obs.alive} cubes=${obs.self.cubes} w=${probe.weapons} loot=${bb.loot.items.length} zoneM=${bb.zone.margin(bb.x, bb.y).toFixed(0)}` +
              (it.targetId >= 0 ? ` | tgt=${it.targetId} thp=${bb.tracker.get(it.targetId)?.hp.toFixed(0)} d=${bb.tracker.get(it.targetId)?.dist.toFixed(0)} los=${it.targetId < 16 ? bb.los[it.targetId] : "-"} ammo=${obs.self.weapons[0]?.ammo} cd=${obs.self.weapons[0]?.cooldown.toFixed(2)} rl=${obs.self.weapons[0]?.reload?.toFixed(1)} fire=${a.fire ? (a.fire[0] ? "G" : "") + (a.fire[1] ? "X" : "") : ""} tw=${bb.tracker.get(it.targetId)?.weapons}` : ""),
          )
        }
        return a
      },
    }
  }
  return { factory, probe }
}

function cause(p: Probe): string {
  const recent = p.dmg.filter((d) => d.t >= p.lastT - 6)
  let zone = 0
  let total = 0
  const by = new Set<number>()
  const wsum = new Map<string, number>()
  for (const d of recent) {
    total += d.amount
    if (d.by === null || d.by === undefined) zone += d.amount
    else {
      if (d.by < 100) by.add(d.by)
      wsum.set(d.weapon, (wsum.get(d.weapon) ?? 0) + d.amount)
    }
  }
  if (total <= 0) return "unknown"
  if (zone > 0.5 * total) return "zone"
  let top = ""
  let tv = 0
  for (const [w, v] of wsum) if (v > tv) ((tv = v), (top = w))
  return `${Math.min(by.size, 3)}${by.size > 3 ? "+" : ""}x:${top}`
}

let curSquad: { director: DirectorLike; entry: (k: number) => MatchEntry } | null = null
let squadK = 0
function beginMatch(seed: number): void {
  curSquad = squadKit ? squadKit.mk(seed) : null
  curDirector = curSquad ? curSquad.director : null
  squadK = 0
}

function oppEntry(i: number): MatchEntry {
  if (curSquad) return curSquad.entry(squadK++)
  if (opp === "main-squad") return { name: "duelist", factory: (ctx) => createBrain(ctx), params: { forceMode: 1, ...oppParams } }
  if (opp === "mix" && i % 2 === 1) return { name: "duelist", factory: (ctx) => createBrain(ctx), params: { forceMode: 1, ...oppParams } }
  return { name: "simple", factory: simpleBot, params: { prefDist: 25 + 10 * (i % 4), ...oppParams } }
}

function runSet(label: string, ours: ((seed: number) => { factory: BotFactory; probe: Probe | null })): { mean: number } {
  let sumScore = 0, sumKills = 0, sumT = 0, errs = 0, stuck = 0, slow = 0, dec = 0, oppErrs = 0, wins = 0
  let nLtg = 0, sumLtgT = 0, nLas = 0, sumCubes = 0, nLtgSeen = 0, sumLtgSeenT = 0, sumLtgSeenD = 0
  const causes = new Map<string, number>()
  const allLabels = new Map<string, number>()
  const allMs: number[] = []
  const scores: number[] = []
  const t00 = performance.now()
  for (let k = 0; k < nSeeds; k++) {
    const seed = seed0 + k
    const seat = seed % 16
    beginMatch(seed)
    const { factory, probe } = ours(seed)
    const entries: MatchEntry[] = []
    for (let i = 0; i < 16; i++) entries.push(i === seat ? { name: label, factory, params } : oppEntry(i))
    const res = runMatch({ seed, entries, world, replayPath: replayDir && probe ? `${replayDir}/${label}-${seed}.jsonl.gz` : undefined })
    const place = res.place[seat]!
    const score = 16 - place
    if (probe && probe.trace) {
      mkdirSync(traceDir, { recursive: true })
      const head = JSON.stringify({ seed, seat, names: entries.map((e) => e.name), place, kills: res.kills[seat], diedAt: res.diedAt[seat], diedAll: res.diedAt, dur: res.durationS })
      writeFileSync(`${traceDir}/m${seed}.jsonl`, head + "\n" + probe.trace.join("\n") + "\n")
    }
    scores.push(score)
    sumScore += score
    sumKills += res.kills[seat]!
    sumT += res.diedAt[seat]!
    errs += res.errors[seat]!
    for (let i = 0; i < 16; i++) if (i !== seat) oppErrs += res.errors[i]!
    if (place === 1) wins++
    let c = place === 1 ? "win" : "?"
    if (probe) {
      if (place !== 1) c = cause(probe)
      for (const m of probe.ms) allMs.push(m)
      if (probe.ltgT >= 0) ((nLtg++), (sumLtgT += probe.ltgT))
      if (probe.ltgSeenT >= 0) ((nLtgSeen++), (sumLtgSeenT += probe.ltgSeenT), (sumLtgSeenD += probe.ltgSeenD))
      if (probe.lasT >= 0) nLas++
      sumCubes += probe.maxCubes
      for (const [l, n] of probe.labels) allLabels.set(l, (allLabels.get(l) ?? 0) + n)
      const st = probe.brain!.exec.stats
      stuck += st.stuckEpisodes
      slow += st.slow
      dec += st.decisions
      if (probe.firstError) console.log(`  !! seed ${seed} exception: ${probe.firstError}`)
    }
    causes.set(c, (causes.get(c) ?? 0) + 1)
    if (!quiet) {
      const extra = probe ? ` cause=${c.padEnd(12)} last=${probe.lastLabel.padEnd(9)} mode=${MODE_NAMES[probe.lastMode]} cubes=${probe.maxCubes} w=${probe.weapons} seen=${((100 * probe.seenBy) / Math.max(1, probe.ms.length)).toFixed(0)}% stuck=${probe.brain!.exec.stats.stuckEpisodes} ltgSeen=${probe.ltgSeenT >= 0 ? probe.ltgSeenT.toFixed(0) + "s@" + probe.ltgSeenD.toFixed(0) + "m" : "-"} ltgT=${probe.ltgT >= 0 ? probe.ltgT.toFixed(0) : "-"}` : ""
      console.log(`${label} seed ${String(seed).padStart(3)} seat ${String(seat).padStart(2)}: place ${String(place).padStart(2)} score ${String(score).padStart(2)} kills ${res.kills[seat]} died ${res.diedAt[seat]!.toFixed(0).padStart(3)}/${res.durationS.toFixed(0)} dmg ${res.dmgDealt[seat]!.toFixed(0)}/${res.dmgTaken[seat]!.toFixed(0)}${extra}`)
    }
  }
  const mean = sumScore / nSeeds
  const sd = Math.sqrt(scores.reduce((a, s) => a + (s - mean) * (s - mean), 0) / Math.max(1, nSeeds - 1))
  allMs.sort((a, b) => a - b)
  const pct = (q: number) => (allMs.length ? allMs[Math.min(allMs.length - 1, Math.floor(q * allMs.length))]!.toFixed(2) : "-")
  console.log(`== ${label}: mean score ${mean.toFixed(2)} +- ${(sd / Math.sqrt(nSeeds)).toFixed(2)} (n=${nSeeds}) wins ${wins} kills ${(sumKills / nSeeds).toFixed(2)} survive ${(sumT / nSeeds).toFixed(0)} s | exceptions ${errs} (opp ${oppErrs}) | stuck episodes ${stuck}, slow decisions ${slow}/${dec} | ms p50 ${pct(0.5)} p99 ${pct(0.99)} max ${pct(1)} | ${((performance.now() - t00) / nSeeds).toFixed(0)} ms/match`)
  console.log(`   lightning pickup ever seen in ${nLtgSeen}/${nSeeds} (first seen mean t=${(sumLtgSeenT / Math.max(1, nLtgSeen)).toFixed(0)} s at ${(sumLtgSeenD / Math.max(1, nLtgSeen)).toFixed(0)} m)`)
  console.log(`   loadout: lightning in ${nLtg}/${nSeeds} (mean t=${(sumLtgT / Math.max(1, nLtg)).toFixed(0)} s), laser in ${nLas}/${nSeeds}, max cubes mean ${(sumCubes / nSeeds).toFixed(1)}`)
  let nLab = 0
  for (const v of allLabels.values()) nLab += v
  console.log(`   time share by intent: ${[...allLabels].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${((100 * n) / Math.max(1, nLab)).toFixed(0)}%`).join(" ")} (${(nLab / 10 / nSeeds).toFixed(0)} s/match)`)
  console.log(`   causes: ${[...causes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(" ")}`)
  return { mean }
}

if (timelineSeed >= 0) {
  const seat = timelineSeed % 16
  beginMatch(timelineSeed)
  const { factory, probe } = probed(timelineSeed, true)
  const entries: MatchEntry[] = []
  for (let i = 0; i < 16; i++) entries.push(i === seat ? { name: "main", factory, params } : oppEntry(i))
  const res = runMatch({ seed: timelineSeed, entries, world, replayPath: replayDir ? `${replayDir}/tl-${timelineSeed}.jsonl.gz` : undefined })
  console.log(`place ${res.place[seat]} kills ${res.kills[seat]} died ${res.diedAt[seat]!.toFixed(1)} of ${res.durationS.toFixed(1)} cause ${cause(probe)} errors ${res.errors[seat]} ${probe.firstError}`)
  console.log(`labels: ${[...probe.labels].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}=${n}`).join(" ")}`)
  console.log(`last damage: ${probe.dmg.slice(-12).map((d) => `${d.t.toFixed(1)}:${d.weapon}:${d.amount.toFixed(0)}:${d.by}`).join(" ")}`)
  console.log(`deaths at: ${res.diedAt.map((t) => t.toFixed(0)).join(" ")}`)
  const md = probe.brain!.bb.modeDet
  console.log(`mode: logOdds ${md.logOdds.toFixed(2)} locked ${md.locked} otherDeaths ${md.otherDeaths} beamHits ${md.beamHits} hpDrops ${md.hpDrops} stray ${md.strayBullets} crossAim ${md.crossAimObs} farSounds ${md.farSounds} peace ${md.peaceObs}`)
  const ms = probe.ms
  let worst = 0
  for (let i = 1; i < ms.length; i++) if (ms[i]! > ms[worst]!) worst = i
  console.log(`slowest decision ${ms[worst]!.toFixed(2)} ms at t=${(worst * 0.1).toFixed(1)}; plans ${probe.brain!.mover.plans}`)
} else {
  runSet("main", (seed) => probed(seed, false))
  if (flag("baseline")) {
    runSet("simple", () => ({
      factory: (ctx) => {
        const b = simpleBot({ ...ctx, params: { prefDist: 25 } })
        return { name: b.name, act: (obs) => (curDirector?.truth(obs.self.id, obs.self.pos[0], obs.self.pos[1], obs.self.pos[2], obs.self.vel[0], obs.self.vel[1], obs.self.hp, obs.t), b.act(obs)) }
      },
      probe: null,
    }))
  }
}
