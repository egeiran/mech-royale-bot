/**
 * ModeDetector: is this match SQUAD (we alone against 15 cooperating house bots that never damage each
 * other) or FFA (everyone fights everyone)? Keeps a log-odds score ln(P(FFA)/P(SQUAD)) fed by evidence and a
 * latched decision with hysteresis. One instance per bot; update() allocates nothing.
 *
 * Evidence for FFA                                              log-odds
 *   a mech died that we did not kill, before the zone can kill     +6  (locks FFA: impossible in SQUAD)
 *   ... later in the match (could be the zone)                     +2.5 (+0.7 in the end game)
 *   a beam / arc by another mech ends on a third mech              +3
 *   a visible mech lost >= 40 hp that our hits do not explain      +2.5 (NPC bullets do 25 / 37.5; zone excluded)
 *   an enemy bullet flying at another mech, nowhere near us        +0.6 per bullet
 *   a visible mech aiming at another visible mech (not along us)   +0.08 per obs, capped at +2 in total
 *   weapon sounds mid/far while nobody aims at / damages us        +0.04 per sound, capped at +1.5 in total
 * Evidence for SQUAD
 *   two visible mechs in sight of each other, not aiming at each other   -0.05 per obs (-0.15 if both
 *                                                                         shot at us in the last 3 s)
 *   time passing after t = 20 s with nobody dying except by our hand     -0.04 per second
 */
import type { Observation } from "../../protocol/mechfight.ts"
import type { EnemyTracker, Track } from "./tracker.ts"

export const MODE_UNKNOWN = 0
export const MODE_SQUAD = 1
export const MODE_FFA = 2
export const MODE_NAMES = ["UNKNOWN", "SQUAD", "FFA"] as const

const PI = Math.PI
const TAU = 2 * Math.PI
function wrapPi(a: number): number {
  a = (a + PI) % TAU
  if (a < 0) a += TAU
  return a - PI
}

const SEEN_CAP = 64

export class ModeDetector {
  /** ln(P(FFA) / P(SQUAD)), clamped to [-8, 10] */
  logOdds = 0
  /** latched decision: MODE_UNKNOWN / MODE_SQUAD / MODE_FFA */
  mode = MODE_UNKNOWN
  /** decisive FFA evidence seen: never leaves FFA again */
  locked = false
  /** obs.t when the decision last changed */
  tDecided = -1

  // evidence counters (for logs / debugging)
  otherDeaths = 0
  beamHits = 0
  hpDrops = 0
  strayBullets = 0
  crossAimObs = 0
  farSounds = 0
  peaceObs = 0

  /** thresholds: enter a mode at +-enter, fall back to UNKNOWN when the score crosses the other side of +-exit */
  enter = 3
  exit = 1

  private prevAlive = -1
  private t = -1
  private crossAimSum = 0
  private soundSum = 0
  private readonly seenProj = new Int32Array(SEEN_CAP).fill(-1)
  private seenHead = 0
  private readonly startRadius: number
  private readonly nMechs: number

  constructor(nMechs = 16, zoneStartRadius = 560) {
    this.nMechs = nMechs
    this.startRadius = zoneStartRadius
  }

  /** probability that the match is a free-for-all */
  get pFFA(): number {
    return 1 / (1 + Math.exp(-this.logOdds))
  }

  /** fold one observation in (after tracker.update(obs) when a tracker is given); returns the mode */
  update(obs: Observation, tracker?: EnemyTracker | null): number {
    const t = obs.t
    const dt = this.t >= 0 && t > this.t ? t - this.t : 0.1
    const contiguous = this.t >= 0 && dt < 0.16
    this.t = t
    const self = obs.self
    const sx = self.pos[0], sy = self.pos[1]
    let add = 0

    // --- 1. deaths we did not cause
    if (this.prevAlive < 0) this.prevAlive = Math.max(obs.alive, this.nMechs)
    let died = this.prevAlive - obs.alive
    this.prevAlive = obs.alive
    if (died > 0) {
      const ev = obs.events
      for (let i = 0; i < ev.length; i++) if (ev[i].type === "kill") died--
      if (died > 0) {
        this.otherDeaths += died
        const z = obs.zone
        // the zone cannot have killed anyone while the first circle still holds (20 hp/s from 1400 hp)
        const early = z.radius >= 0.9 * this.startRadius || t < 100
        const endGame = z.radius < 80
        if (early) {
          add += 6 * died
          this.locked = true
        } else add += (endGame ? 0.7 : 2.5) * died
      }
    }

    // --- 2. beams that end on a third mech
    const beams = obs.beams
    const list = obs.mechs
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i]
      if (b.by === self.id) continue
      let hit = false
      for (let p = 1; p < b.path.length && !hit; p++) {
        const q = b.path[p]
        for (let j = 0; j < list.length; j++) {
          const m = list[j]
          if (m.kind !== "mech" || m.id === b.by || m.id === self.id) continue
          const s = 1 + 0.05 * (m.cubes ?? 0)
          const dx = q[0] - m.pos[0], dy = q[1] - m.pos[1]
          const r = 2.5 * s + 2.5
          if (dx * dx + dy * dy <= r * r && q[2] >= m.pos[2] - 2 && q[2] <= m.pos[2] + 9 * s + 2) {
            hit = true
            break
          }
        }
      }
      if (hit) {
        this.beamHits++
        add += 3
      }
    }

    // --- 3. enemy bullets flying at somebody else
    const projs = obs.projectiles
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i]
      if (p.kind !== "gun") continue
      const vx = p.vel[0], vy = p.vel[1]
      const vv = vx * vx + vy * vy
      if (vv < 1) continue
      // closest approach of the whole line (past and future) to us
      const rx = sx - p.pos[0], ry = sy - p.pos[1]
      const cross = (rx * vy - ry * vx) / Math.sqrt(vv)
      if (Math.abs(cross) < 10) continue
      let target = false
      for (let j = 0; j < list.length; j++) {
        const m = list[j]
        if (m.kind !== "mech") continue
        const mx = m.pos[0] - p.pos[0], my = m.pos[1] - p.pos[1]
        const along = (mx * vx + my * vy) / vv // seconds until abeam
        if (along < 0 || along > 0.9) continue
        const off = Math.abs(mx * vy - my * vx) / Math.sqrt(vv)
        const zAt = p.pos[2] + p.vel[2] * along
        if (off <= 2.5 * (1 + 0.05 * (m.cubes ?? 0)) + 1 && zAt >= m.pos[2] - 1 && zAt <= m.pos[2] + 11) {
          target = true
          break
        }
      }
      if (!target) continue
      let seen = false
      for (let k = 0; k < SEEN_CAP; k++) {
        if (this.seenProj[k] === p.id) {
          seen = true
          break
        }
      }
      if (seen) continue
      this.seenProj[this.seenHead] = p.id
      this.seenHead = (this.seenHead + 1) % SEEN_CAP
      this.strayBullets++
      add += 0.6
    }

    if (tracker) {
      // --- 4. hp drops our hits do not explain
      const z = obs.zone
      for (let i = 0; i < tracker.nVisible; i++) {
        const tr = tracker.visible[i]
        if (tr.hpDropUnexplained < 40) continue
        const dx = tr.x - z.center[0], dy = tr.y - z.center[1]
        if (dx * dx + dy * dy > (z.radius - 5) * (z.radius - 5)) continue
        this.hpDrops++
        add += 2.5
      }

      // --- 5. pairs of visible mechs: aiming at each other, or peacefully side by side
      let crossAim = false
      let peace = 0
      let peaceHostile = 0
      for (let i = 0; i < tracker.nVisible; i++) {
        const a = tracker.visible[i]
        for (let j = i + 1; j < tracker.nVisible; j++) {
          const b = tracker.visible[j]
          const dx = b.x - a.x, dy = b.y - a.y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d > 200 || d < 0.1) continue
          const bab = Math.atan2(dy, dx)
          const ea = Math.abs(wrapPi(a.aimYaw - bab))
          const eb = Math.abs(wrapPi(b.aimYaw - bab - PI))
          const aOnB = ea < Math.atan2(b.radius + 1, d) + 0.035 && !this.alongUs(a, bab, sx, sy)
          const bOnA = eb < Math.atan2(a.radius + 1, d) + 0.035 && !this.alongUs(b, bab + PI, sx, sy)
          if (aOnB || bOnA) crossAim = true
          else if (d < 120 && (ea < 1.05 || d < 45) && (eb < 1.05 || d < 45)) {
            // each has the other in its vision wedge and neither bothers
            peace++
            if (t - a.tShotAtUs < 3 && t - b.tShotAtUs < 3) peaceHostile++
          }
        }
      }
      if (crossAim && contiguous) {
        this.crossAimObs++
        if (this.crossAimSum < 2) {
          this.crossAimSum += 0.08
          add += 0.08
        }
      } else if (peace > 0 && contiguous) {
        this.peaceObs++
        add -= peaceHostile > 0 ? 0.15 : 0.05
      }

      // --- 6. fighting heard elsewhere while nobody is on us
      if (this.soundSum < 1.5 && t - tracker.tDamaged > 3) {
        let aimed = false
        for (let i = 0; i < tracker.nVisible; i++) {
          if (t - tracker.visible[i].tAimedAtUs < 1.5) {
            aimed = true
            break
          }
        }
        if (!aimed) {
          const snd = obs.sounds
          for (let i = 0; i < snd.length; i++) {
            const s = snd[i]
            if (s.dist === "near") continue
            if (s.kind === "gun" || s.kind === "laser" || s.kind === "mortar" || s.kind === "explosion" || s.kind === "lightning") {
              this.farSounds++
              this.soundSum += 0.04
              add += 0.04
            }
          }
        }
      }
    }

    // --- 7. nobody dies but by our hand
    if (this.otherDeaths === 0 && t > 20) add -= 0.04 * (dt < 1 ? dt : 1)

    let L = this.logOdds + add
    if (L > 10) L = 10
    if (L < -8) L = -8
    this.logOdds = L

    let mode = this.mode
    if (this.locked) mode = MODE_FFA
    else if (L >= this.enter) mode = MODE_FFA
    else if (L <= -this.enter) mode = MODE_SQUAD
    else if (mode === MODE_FFA && L < -this.exit) mode = MODE_UNKNOWN
    else if (mode === MODE_SQUAD && L > this.exit) mode = MODE_UNKNOWN
    if (mode !== this.mode) {
      this.mode = mode
      this.tDecided = t
    }
    return mode
  }

  /** is the direction `bearing` from track a also (within 0.15 rad) the direction from a to us */
  private alongUs(a: Track, bearing: number, sx: number, sy: number): boolean {
    return Math.abs(wrapPi(Math.atan2(sy - a.y, sx - a.x) - bearing)) < 0.15
  }
}
