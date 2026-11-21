/**
 * Field statistics of mechreplay/1 files (real showdowns or our simulated fields), with the same definitions
 * on both sides, so an imitation field can be validated against reality.
 *
 *   bun src/bot/strategies/eval_ffa/fieldstats.ts --real                 # the recorded top-16 showdowns
 *   bun src/bot/strategies/eval_ffa/fieldstats.ts <replay.jsonl.gz> ...  # any replays (e.g. written by fieldsim.ts)
 *   --teams : per-team table (real replays), --json : machine-readable line
 *
 * Replay content is untrusted data: parsed as JSON only.
 */
import { readdirSync } from "node:fs"
import { derive, isMech, loadReplay, quantile } from "../../../tools/replay-lib.ts"

export interface FieldStats {
  n: number
  /** match length (s): min / median / max */
  dur: [number, number, number]
  /** share of the 16 mechs alive at 30/60/90/120/180/240 s (winner counts as alive after the end) */
  alive: number[]
  /** first damage from a mech: p10 / p25 / median / p75 (bots never damaged = Infinity) and share before 20 / 30 s */
  firstDmg: number[]
  /** time when 4 are left: median */
  t4: number
  /** mech -> mech damage share by weapon */
  dmgByWeapon: Record<string, number>
  killsByWeapon: Record<string, number>
  /** share of mech->mech damage dealt beyond 100 m, median gun hit distance */
  dmgFar: number
  gunHitDist: number
  /** share of alive time: > 5 m/s, < 0.5 m/s, boosting, airborne */
  moving: number
  still: number
  boosting: number
  airborne: number
  /** second weapon of bots alive at 60 s (share) */
  loadout60: Record<string, number>
  /** mean cubes of the last four when four are left */
  cubes4: number
  hp4: number
  /** mech->mech damage dealt per alive mech-second */
  dps: number
  /** mean number of distinct attackers a bot took damage from */
  attackers: number
  /** damage episodes from the victim's side (hits from mechs with gaps < 8 s): per bot-match, share that end in
   *  the victim's death (within 3 s of the last hit), median duration s, median damage, mean damage taken per bot */
  episodes: number
  epDeath: number
  epDur: number
  epDmg: number
  dmgTaken: number
  /** pair engagements (a hits b, gaps < 5 s): median duration, median damage, share where b dies within 5 s of the end */
  pairDur: number
  pairDmg: number
  pairKill: number
  /** share of all deaths by time: before 60 s, 60-150 s, later */
  cubes60: number
}

export const ALIVE_T = [30, 60, 90, 120, 180, 240]

export function fieldStats(paths: string[]): { stats: FieldStats; teams: Map<string, TeamRow> } {
  const durs: number[] = []
  const alive = ALIVE_T.map(() => 0)
  const first: number[] = []
  const t4: number[] = []
  const dmgW: Record<string, number> = {}
  const killW: Record<string, number> = {}
  let dmgAll = 0, dmgFar = 0
  const gunDist: number[] = []
  let fr = 0, mv = 0, st = 0, bo = 0, air = 0
  const load: Record<string, number> = {}
  let loadN = 0
  const cubes4: number[] = []
  const hp4: number[] = []
  let attackers = 0, nb = 0
  let nEp = 0, epDeaths = 0, dmgTakenAll = 0
  const epDur: number[] = [], epDmg: number[] = []
  const pairDur: number[] = [], pairDmg: number[] = []
  let pairKill = 0
  const cubes60: number[] = []
  const teams = new Map<string, TeamRow>()
  for (const p of paths) {
    const r = loadReplay(p)
    const d = derive(r)
    const N = r.nMechs
    durs.push(d.endTime)
    ALIVE_T.forEach((t, k) => (alive[k] += Math.max(1, d.aliveAt(t)) / N))
    const fd = new Array<number>(N).fill(Infinity)
    const att: Set<number>[] = Array.from({ length: N }, () => new Set())
    for (const h of d.hits) {
      if (!isMech(h.dst) || !isMech(h.src) || h.src === h.dst) continue
      const t = h.tick / (r.header.tick_hz || 20)
      if (t < fd[h.dst]!) fd[h.dst] = t
      att[h.dst]!.add(h.src)
      dmgW[h.w] = (dmgW[h.w] ?? 0) + h.amt
      dmgAll += h.amt
      if (h.dist !== null && h.dist > 100) dmgFar += h.amt
      if (h.w === "gun" && h.dist !== null) gunDist.push(h.dist)
    }
    for (let i = 0; i < N; i++) {
      first.push(fd[i]!)
      attackers += att[i]!.size
      nb++
    }
    {
      const hz = r.header.tick_hz || 20
      const closeEp = (v: number, t0: number, t1: number, dm: number) => {
        nEp++
        epDur.push(t1 - t0)
        epDmg.push(dm)
        const dt = d.mechs[v]!.deathTime
        if (dt !== null && dt - t1 < 3) epDeaths++
      }
      const e0 = new Array<number>(N).fill(-1), e1 = new Array<number>(N).fill(-1), ed = new Array<number>(N).fill(0)
      const p0 = new Map<number, number>(), p1 = new Map<number, number>(), pd = new Map<number, number>()
      const closePair = (key: number) => {
        const v = key % N
        pairDur.push(p1.get(key)! - p0.get(key)!)
        pairDmg.push(pd.get(key)!)
        const dt = d.mechs[v]!.deathTime
        if (dt !== null && dt - p1.get(key)! < 5) pairKill++
        p0.delete(key)
      }
      for (const h of d.hits) {
        if (!isMech(h.dst) || !isMech(h.src) || h.src === h.dst) continue
        const t = h.tick / hz
        dmgTakenAll += h.amt
        const v = h.dst
        if (e0[v]! >= 0 && t - e1[v]! > 8) {
          closeEp(v, e0[v]!, e1[v]!, ed[v]!)
          e0[v] = -1
        }
        if (e0[v]! < 0) {
          e0[v] = t
          ed[v] = 0
        }
        e1[v] = t
        ed[v] += h.amt
        const key = h.src * N + v
        if (p0.has(key) && t - p1.get(key)! > 5) closePair(key)
        if (!p0.has(key)) {
          p0.set(key, t)
          pd.set(key, 0)
        }
        p1.set(key, t)
        pd.set(key, pd.get(key)! + h.amt)
      }
      for (let v = 0; v < N; v++) if (e0[v]! >= 0) closeEp(v, e0[v]!, e1[v]!, ed[v]!)
      for (const key of [...p0.keys()]) closePair(key)
    }
    for (const de of d.deaths) {
      const w = de.with ?? "?"
      killW[w] = (killW[w] ?? 0) + 1
      if (de.aliveAfter === 4) {
        t4.push(de.time)
        const f = Math.min(r.frames.length - 1, Math.round(de.time / r.dt) + 1)
        for (const m of d.mechs) if (m.alive[f]) {
          cubes4.push(m.cubes[f]!)
          hp4.push(m.hp[f]! / Math.max(1, m.maxHp[f]!))
        }
      }
    }
    const f60 = Math.min(r.frames.length - 1, Math.round(60 / r.dt))
    for (const m of d.mechs) if (m.alive[f60]) cubes60.push(m.cubes[f60]!)
    for (const m of d.mechs) {
      let tm: TeamRow | undefined = teams.get(m.name)
      if (!tm) teams.set(m.name, (tm = newTeam(m.name)))
      tm.n++
      tm.place += m.place ?? 16
      tm.surv += m.deathTime ?? d.endTime
      const res = r.result?.mechs.find((q) => q.id === m.id)
      tm.kills += res?.kills ?? 0
      tm.dealt += res?.damage_dealt ?? 0
      tm.taken += res?.damage_taken ?? 0
      tm.cubes += res?.cubes_max ?? (res as { cubes?: number } | undefined)?.cubes ?? 0
      tm.firstDmg.push(fd[m.id]!)
      if (m.alive[f60]) {
        const s = m.slot1[f60] ?? m.slot0[f60] ?? "none"
        const k = m.slot1[f60] ? s : "none"
        load[k] = (load[k] ?? 0) + 1
        loadN++
      }
      const lf = m.lastFrame
      if (lf >= 0) {
        const s = m.slot1[lf]
        tm.second[s ?? "none"] = (tm.second[s ?? "none"] ?? 0) + 1
      }
      for (let f = 1; f < r.frames.length; f++) {
        if (!m.alive[f]) continue
        fr++
        tm.fr++
        if (m.speed[f]! > 5) (mv++, tm.mv++)
        if (m.speed[f]! < 0.5) (st++, tm.st++)
        if (m.boosting[f]) (bo++, tm.bo++)
        if (!m.grounded[f]) (air++, tm.air++)
      }
    }
    for (const h of d.hits) {
      if (!isMech(h.dst) || !isMech(h.src) || h.src === h.dst) continue
      const tm = teams.get(d.mechs[h.src]!.name)!
      if (h.dist !== null) {
        tm.hitDist.push(h.dist)
        if (h.dist > 100) tm.farDmg += h.amt
      }
      tm.dmg += h.amt
      tm.byW[h.w] = (tm.byW[h.w] ?? 0) + h.amt
    }
  }
  const n = paths.length
  const norm = (o: Record<string, number>): Record<string, number> => {
    let s = 0
    for (const k in o) s += o[k]!
    const out: Record<string, number> = {}
    for (const k of Object.keys(o).sort((a, b) => o[b]! - o[a]!)) out[k] = Math.round((1000 * o[k]!) / (s || 1)) / 10
    return out
  }
  const stats: FieldStats = {
    n,
    dur: [Math.min(...durs), quantile(durs, 0.5), Math.max(...durs)],
    alive: alive.map((a) => a / n),
    firstDmg: [quantile(first, 0.1), quantile(first, 0.25), quantile(first, 0.5), quantile(first, 0.75), first.filter((t) => t < 20).length / first.length, first.filter((t) => t < 30).length / first.length],
    t4: quantile(t4, 0.5),
    dmgByWeapon: norm(dmgW),
    killsByWeapon: norm(killW),
    dmgFar: dmgFar / (dmgAll || 1),
    gunHitDist: quantile(gunDist, 0.5),
    moving: mv / fr,
    still: st / fr,
    boosting: bo / fr,
    airborne: air / fr,
    loadout60: Object.fromEntries(Object.entries(load).map(([k, v]) => [k, Math.round((100 * v) / loadN)])),
    cubes4: cubes4.reduce((a, b) => a + b, 0) / (cubes4.length || 1),
    hp4: hp4.reduce((a, b) => a + b, 0) / (hp4.length || 1),
    dps: dmgAll / ((fr * 0.1) || 1),
    attackers: attackers / (nb || 1),
    episodes: nEp / (nb || 1),
    epDeath: epDeaths / (nEp || 1),
    epDur: quantile(epDur, 0.5),
    epDmg: quantile(epDmg, 0.5),
    dmgTaken: dmgTakenAll / (nb || 1),
    pairDur: quantile(pairDur, 0.5),
    pairDmg: quantile(pairDmg, 0.5),
    pairKill: pairKill / (pairDur.length || 1),
    cubes60: cubes60.reduce((a, b) => a + b, 0) / (cubes60.length || 1),
  }
  return { stats, teams }
}

export interface TeamRow {
  name: string
  n: number
  place: number
  surv: number
  kills: number
  dealt: number
  taken: number
  cubes: number
  firstDmg: number[]
  second: Record<string, number>
  fr: number
  mv: number
  st: number
  bo: number
  air: number
  hitDist: number[]
  farDmg: number
  dmg: number
  byW: Record<string, number>
}
const newTeam = (name: string): TeamRow => ({ name, n: 0, place: 0, surv: 0, kills: 0, dealt: 0, taken: 0, cubes: 0, firstDmg: [], second: {}, fr: 0, mv: 0, st: 0, bo: 0, air: 0, hitDist: [], farDmg: 0, dmg: 0, byW: {} })

const pc = (v: number): string => (100 * v).toFixed(0) + "%"
const f0 = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : "inf")

export function fmtFieldStats(label: string, s: FieldStats): string {
  const L: string[] = []
  L.push(`== ${label} (${s.n} matches)`)
  L.push(`  length s           min ${f0(s.dur[0])} / median ${f0(s.dur[1])} / max ${f0(s.dur[2])}    4 left at (median) ${f0(s.t4)} s`)
  L.push(`  alive at ${ALIVE_T.join("/")} s   ${s.alive.map(pc).join(" / ")}`)
  L.push(`  first mech damage  p10 ${s.firstDmg[0]!.toFixed(1)}  p25 ${s.firstDmg[1]!.toFixed(1)}  median ${s.firstDmg[2]!.toFixed(1)}  p75 ${f0(s.firstDmg[3]!)} s   before 20 s ${pc(s.firstDmg[4]!)}  before 30 s ${pc(s.firstDmg[5]!)}`)
  L.push(`  damage by weapon   ${Object.entries(s.dmgByWeapon).map(([k, v]) => `${k} ${v}%`).join("  ")}   beyond 100 m ${pc(s.dmgFar)}  median gun hit dist ${f0(s.gunHitDist)} m`)
  L.push(`  kills by weapon    ${Object.entries(s.killsByWeapon).map(([k, v]) => `${k} ${v}%`).join("  ")}`)
  L.push(`  movement           >5 m/s ${pc(s.moving)}  still ${pc(s.still)}  boosting ${pc(s.boosting)}  airborne ${pc(s.airborne)}`)
  L.push(`  2nd weapon at 60 s ${Object.entries(s.loadout60).map(([k, v]) => `${k} ${v}%`).join("  ")}   last four: cubes ${s.cubes4.toFixed(1)}  hp ${pc(s.hp4)}`)
  L.push(`  mech damage / alive mech-second ${s.dps.toFixed(1)}   distinct attackers per bot ${s.attackers.toFixed(1)}   damage taken per bot ${f0(s.dmgTaken)}   cubes at 60 s ${s.cubes60.toFixed(1)}`)
  L.push(`  damage episodes    ${s.episodes.toFixed(1)} per bot, ${pc(s.epDeath)} end in death, median ${s.epDur.toFixed(1)} s / ${f0(s.epDmg)} dmg   pair engagements: median ${s.pairDur.toFixed(1)} s / ${f0(s.pairDmg)} dmg, victim dies within 5 s in ${pc(s.pairKill)}`)
  return L.join("\n")
}

export function listShowdowns(dir = "data/replays/live"): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl.gz") && /_(showdown|reair)_/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const real = args.includes("--real")
  const paths = real ? listShowdowns() : args.filter((a) => !a.startsWith("--"))
  const { stats, teams } = fieldStats(paths)
  console.log(fmtFieldStats(real ? "REAL top-16 showdowns" : "replays", stats))
  if (args.includes("--json")) console.log(JSON.stringify(stats))
  if (args.includes("--teams")) {
    console.log("team                 n  place  surv  kills  dealt  taken cubes | firstDmg med | >5m/s still boost air | hit dist med  far% | dmg by weapon | 2nd weapon at death/end")
    for (const t of [...teams.values()].sort((a, b) => a.place / a.n - b.place / b.n)) {
      const bw = Object.entries(t.byW).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((100 * v) / (t.dmg || 1)).toFixed(0)}`).join(" ")
      const sw = Object.entries(t.second).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ")
      console.log(
        `${t.name.slice(0, 20).padEnd(20)} ${String(t.n).padStart(2)} ${(t.place / t.n).toFixed(1).padStart(5)} ${(t.surv / t.n).toFixed(0).padStart(5)} ${(t.kills / t.n).toFixed(1).padStart(5)} ${(t.dealt / t.n).toFixed(0).padStart(6)} ${(t.taken / t.n).toFixed(0).padStart(6)} ${(t.cubes / t.n).toFixed(1).padStart(5)} | ${f0(quantile(t.firstDmg, 0.5)).padStart(5)} | ${pc(t.mv / t.fr).padStart(4)} ${pc(t.st / t.fr).padStart(4)} ${pc(t.bo / t.fr).padStart(4)} ${pc(t.air / t.fr).padStart(4)} | ${f0(quantile(t.hitDist, 0.5)).padStart(4)} ${pc(t.farDmg / (t.dmg || 1)).padStart(4)} | ${bw} | ${sw}`,
      )
    }
  }
}
