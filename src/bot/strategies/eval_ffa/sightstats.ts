/**
 * "What happens to a mech that is seen" on mechreplay/1 files (real or simulated), with the definitions of
 * data/intel/ghost.md section c, so the opponent field can be validated on exactly what matters to a ghost:
 * sighting episode = observer o starts seeing v after >= 5 s of not seeing it (protocol section 8 via world.canSee).
 *
 *   bun src/bot/strategies/eval_ffa/sightstats.ts --real
 *   bun src/bot/strategies/eval_ffa/sightstats.ts data/tmp/ffa/replays/finalists/*.gz
 */
import { join } from "node:path"
import type { World } from "../../../contracts.ts"
import { derive, isMech, loadReplay } from "../../../tools/replay-lib.ts"
import { listShowdowns } from "./fieldstats.ts"

export const BANDS = [45, 100, 150, 225]

export interface SightStats {
  /** per distance band at first sight */
  n: number[]
  dmg5: number[]
  dmg20: number[]
  dead30: number[]
  /** damage dealt to visible victims per visible second, by current distance band */
  dps: number[]
  /** share of (alive bot, time) in which the bot is seen by at least one other */
  seenShare: number
  /** after line of sight was lost for > 5 s: observer closed > 50 % of the distance to v's last seen position within 15 s */
  chase: number
  chaseN: number
}

const band = (d: number): number => (d < BANDS[0]! ? 0 : d < BANDS[1]! ? 1 : d < BANDS[2]! ? 2 : d < BANDS[3]! ? 3 : -1)

export function sightStats(paths: string[], world: World): SightStats {
  const nb = BANDS.length
  const n = new Array<number>(nb).fill(0), dmg5 = new Array<number>(nb).fill(0), dmg20 = new Array<number>(nb).fill(0), dead30 = new Array<number>(nb).fill(0)
  const visS = new Array<number>(nb).fill(0), visDmg = new Array<number>(nb).fill(0)
  let seen = 0, aliveF = 0, chase = 0, chaseN = 0
  for (const p of paths) {
    const r = loadReplay(p)
    const d = derive(r)
    const N = r.nMechs
    const F = r.frames.length
    const hz = r.header.tick_hz || 20
    const step = 2 // 5 Hz
    const lastSeen = new Float64Array(N * N).fill(-100)
    const curVis = new Uint8Array(N * N)
    // hits indexed by pair
    const hitT: number[][] = Array.from({ length: N * N }, () => [])
    const hitFrame = new Map<number, { key: number; amt: number }[]>()
    for (const h of d.hits) {
      if (!isMech(h.src) || !isMech(h.dst) || h.src === h.dst) continue
      hitT[h.src * N + h.dst]!.push(h.tick / hz)
      const fr = Math.floor(h.frame / step) * step
      let l = hitFrame.get(fr)
      if (!l) hitFrame.set(fr, (l = []))
      l.push({ key: h.src * N + h.dst, amt: h.amt })
    }
    const lostAt: { o: number; v: number; f: number; x: number; y: number; d: number }[] = []
    for (let f = 0; f < F; f += step) {
      const ms = r.frames[f]!.mechs
      const t = r.frames[f]!.time
      const seenNow = new Uint8Array(N)
      for (let a = 0; a < N; a++) {
        const A = ms[a]
        if (!A) continue
        aliveF++
        const ez = A.z + 8 * (1 + 0.05 * A.cubes)
        for (let b = 0; b < N; b++) {
          if (a === b) continue
          const B = ms[b]
          const key = a * N + b
          const vis = B ? world.canSee(A.x, A.y, ez, A.yaw, B.x, B.y, B.z, 9 * (1 + 0.05 * B.cubes), 200, 120, 45) : false
          if (vis) {
            const dist = Math.hypot(A.x - B!.x, A.y - B!.y)
            seenNow[b] = 1
            if (t - lastSeen[key]! >= 5) {
              const k = band(dist)
              if (k >= 0) {
                n[k]!++
                const hs = hitT[key]!
                let first = Infinity
                for (const ht of hs) if (ht >= t - 0.2) {
                  first = ht
                  break
                }
                if (first - t <= 5) dmg5[k]!++
                if (first - t <= 20) dmg20[k]!++
                const dt = d.mechs[b]!.deathTime
                if (dt !== null && dt - t <= 30) dead30[k]!++
              }
            }
            lastSeen[key] = t
            const kb = band(dist)
            if (kb >= 0) visS[kb]! += step * r.dt
          } else if (curVis[key] && B) {
            lostAt.push({ o: a, v: b, f, x: B.x, y: B.y, d: Math.hypot(A.x - B.x, A.y - B.y) })
          }
          curVis[key] = vis ? 1 : 0
        }
      }
      for (let b = 0; b < N; b++) if (seenNow[b]) seen++
      const hl = hitFrame.get(f)
      if (hl) {
        for (const h of hl) {
          const a = (h.key / N) | 0, b = h.key % N
          const A = ms[a], B = ms[b]
          if (!A || !B) continue
          const kb = band(Math.hypot(A.x - B.x, A.y - B.y))
          if (kb >= 0) visDmg[kb]! += h.amt
        }
      }
    }
    // chase: LOS lost and not regained for > 5 s; did o close > 50 % of the distance to the last seen position within 15 s
    for (const l of lostAt) {
      if (l.d < 30) continue
      const f5 = l.f + Math.round(5 / r.dt)
      const f15 = l.f + Math.round(15 / r.dt)
      if (f15 >= F) continue
      let regained = false
      const O0 = r.frames[l.f]!.mechs[l.o]
      if (!O0) continue
      let minD = l.d
      let ok = true
      for (let f = l.f + step; f <= f15; f += step) {
        const O = r.frames[f]!.mechs[l.o]
        const V = r.frames[f]!.mechs[l.v]
        if (!O) {
          ok = false
          break
        }
        if (f <= f5 && V) {
          const ez = O.z + 8 * (1 + 0.05 * O.cubes)
          if (world.canSee(O.x, O.y, ez, O.yaw, V.x, V.y, V.z, 9 * (1 + 0.05 * V.cubes), 200, 120, 45)) {
            regained = true
            break
          }
        }
        const dd = Math.hypot(O.x - l.x, O.y - l.y)
        if (dd < minD) minD = dd
      }
      if (!ok || regained) continue
      chaseN++
      if (minD < 0.5 * l.d) chase++
    }
  }
  return {
    n,
    dmg5: dmg5.map((v, i) => v / (n[i] || 1)),
    dmg20: dmg20.map((v, i) => v / (n[i] || 1)),
    dead30: dead30.map((v, i) => v / (n[i] || 1)),
    dps: visDmg.map((v, i) => v / (visS[i] || 1)),
    seenShare: seen / (aliveF || 1),
    chase: chase / (chaseN || 1),
    chaseN,
  }
}

const pc = (v: number): string => (100 * v).toFixed(0).padStart(3) + "%"

export function fmtSight(label: string, s: SightStats): string {
  const L = [`== sightings: ${label}`]
  L.push(`  first seen at        ${["< 45 m", "45-100", "100-150", "150-225"].map((b) => b.padStart(8)).join("")}`)
  L.push(`  episodes             ${s.n.map((v) => String(v).padStart(8)).join("")}`)
  L.push(`  damaged within 5 s   ${s.dmg5.map((v) => pc(v).padStart(8)).join("")}`)
  L.push(`  damaged within 20 s  ${s.dmg20.map((v) => pc(v).padStart(8)).join("")}`)
  L.push(`  victim dead in 30 s  ${s.dead30.map((v) => pc(v).padStart(8)).join("")}`)
  L.push(`  damage / visible s   ${s.dps.map((v) => v.toFixed(0).padStart(8)).join("")}`)
  L.push(`  a bot is seen by somebody ${pc(s.seenShare)} of its alive time; after losing sight for > 5 s the observer closes > 50 % of the distance in ${pc(s.chase)} (n=${s.chaseN})`)
  return L.join("\n")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = join(import.meta.dir, "..", "..", "..", "..")
  const { loadWorld } = await import("../../../world/index.ts")
  const world = loadWorld(join(root, "mechfight-kit", "arena"))
  const real = args.includes("--real")
  const paths = real ? listShowdowns(join(root, "data", "replays", "live")) : args.filter((a) => !a.startsWith("--"))
  console.log(fmtSight(real ? "REAL top-16 showdowns" : `${paths.length} replays`, sightStats(paths, world)))
}
