/**
 * Evasion: projectile threat analysis, a combined dodge vector, strafe jitter and rear-arc protection.
 * No module state except scratch; per-bot state lives in the caller-owned ThreatList / StrafeJitter objects.
 */
import type { ActorObs, ProjectileObs, SelfObs } from "../../protocol/mechfight.ts"
import type { Rng } from "../../contracts.ts"
import { wrapPi } from "./aim.ts"

export const THREAT_GUN = 0
export const THREAT_MORTAR = 1
export const THREAT_NPC = 2

/** struct-of-arrays list of projectile threats, reused every decision */
export class ThreatList {
  n = 0
  readonly cap: number
  readonly id: Int32Array
  readonly kind: Uint8Array
  /** seconds until closest approach (bullets) or impact (shells) */
  readonly tHit: Float32Array
  /** metres between the projectile (shell: impact point) and our cylinder surface at that time; 0 = hit */
  readonly miss: Float32Array
  /** unit horizontal direction in which moving increases the miss distance fastest */
  readonly dirX: Float32Array
  readonly dirY: Float32Array
  /** closest point (bullets) or predicted impact point (shells) */
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  /** 0..1: how much this projectile deserves a dodge (0 = will clearly miss or cannot be avoided anyway) */
  readonly urgency: Float32Array
  constructor(cap = 48) {
    this.cap = cap
    this.id = new Int32Array(cap)
    this.kind = new Uint8Array(cap)
    this.tHit = new Float32Array(cap)
    this.miss = new Float32Array(cap)
    this.dirX = new Float32Array(cap)
    this.dirY = new Float32Array(cap)
    this.px = new Float32Array(cap)
    this.py = new Float32Array(cap)
    this.pz = new Float32Array(cap)
    this.urgency = new Float32Array(cap)
  }
}

/**
 * Analyse every visible enemy projectile against our cylinder.
 *  - gun / npc bullets fly straight: closest approach in OUR frame (our current velocity is assumed to
 *    continue, which is what the shooter led for), over at most maxBulletT seconds.
 *  - mortar shells fall at `gravity`: impact point and time where the shell reaches ground height
 *    (groundZ(x,y) when given, else our feet height); we must be outside splashRadius + our radius.
 * Fills `out` (overwrites), returns the number of threats with urgency > 0.
 */
export function threatsFromProjectiles(projectiles: ProjectileObs[], self: SelfObs, out: ThreatList, gravity = 22, splashRadius = 7, groundZ?: (x: number, y: number) => number, maxBulletT = 1.2): number {
  const sx = self.pos[0], sy = self.pos[1], sz = self.pos[2]
  const svx = self.vel[0], svy = self.vel[1], svz = self.vel[2]
  const R = self.stats.radius ?? 2.5
  const H = self.stats.height ?? 9
  const walk = self.stats.walk_speed ?? 11.7
  let n = 0, hot = 0
  for (let i = 0; i < projectiles.length && n < out.cap; i++) {
    const p = projectiles[i]
    const rx = p.pos[0] - sx, ry = p.pos[1] - sy, rz = p.pos[2] - sz
    let tHit = 0, miss = 0, dx = 0, dy = 0, px = 0, py = 0, pz = 0, urg = 0
    let kind = THREAT_GUN
    if (p.kind === "mortar") {
      kind = THREAT_MORTAR
      const vz = p.vel[2]
      let gz = sz
      let t = 0
      for (let it = 0; it < (groundZ ? 3 : 1); it++) {
        const dz = p.pos[2] - gz
        const disc = vz * vz + 2 * gravity * dz
        t = disc <= 0 ? 0 : (vz + Math.sqrt(disc)) / gravity
        if (t < 0) t = 0
        px = p.pos[0] + p.vel[0] * t
        py = p.pos[1] + p.vel[1] * t
        if (groundZ) gz = groundZ(px, py)
      }
      pz = gz
      tHit = t
      // where should we not be: relative to where we stand now (we choose where to go)
      let ex = sx - px, ey = sy - py
      let d = Math.sqrt(ex * ex + ey * ey)
      if (d < 0.5) {
        // dead centre: leave sideways to the shell's ground track, preferring our current heading
        const hv = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1])
        if (hv > 1e-3) {
          ex = -p.vel[1] / hv
          ey = p.vel[0] / hv
        } else {
          ex = 1
          ey = 0
        }
        if (ex * svx + ey * svy < 0) {
          ex = -ex
          ey = -ey
        }
        d = 1
      }
      dx = ex / d
      dy = ey / d
      const dTrue = Math.sqrt((sx - px) * (sx - px) + (sy - py) * (sy - py))
      miss = dTrue - R
      if (miss < 0) miss = 0
      const danger = splashRadius + R + 1.5
      if (dTrue < danger) {
        // time needed to walk out of the blast vs time left
        const need = (danger - dTrue) / walk
        const slack = tHit - need
        urg = slack > 1.5 ? 0.5 : slack > 0.6 ? 0.8 : 1
      } else if (dTrue < danger + 6) {
        urg = 0.25 * (1 - (dTrue - danger) / 6)
      }
    } else {
      if (p.kind === "npc") kind = THREAT_NPC
      const vx = p.vel[0] - svx, vy = p.vel[1] - svy, vz = p.vel[2] - svz
      const vv = vx * vx + vy * vy
      let t = vv > 1e-6 ? -(rx * vx + ry * vy) / vv : 0
      if (t < 0) t = 0
      if (t > maxBulletT) t = maxBulletT
      tHit = t
      const cx = rx + vx * t, cy = ry + vy * t, cz = rz + vz * t
      px = sx + cx
      py = sy + cy
      pz = sz + cz
      const dh = Math.sqrt(cx * cx + cy * cy)
      const dv = cz < 0 ? -cz : cz > H ? cz - H : 0
      const lat = dh - R - 0.3
      miss = lat > 0 ? Math.sqrt(lat * lat + dv * dv) : dv
      if (dh > 0.05) {
        // we are on this side of the bullet's path: keep going that way
        dx = -cx / dh
        dy = -cy / dh
      } else {
        const hv = Math.sqrt(vv)
        if (hv > 1e-3) {
          dx = -vy / hv
          dy = vx / hv
        } else {
          dx = 1
          dy = 0
        }
        if (dx * svx + dy * svy < 0) {
          dx = -dx
          dy = -dy
        }
      }
      // moving away already, or passing more than 2.5 m clear: no dodge needed
      const approaching = rx * vx + ry * vy < 0
      if (approaching && miss < 2.5) {
        urg = 1 - miss / 2.5
        // too late to change anything meaningful within one tick
        if (tHit < 0.06) urg *= 0.3
        if (kind === THREAT_NPC) urg *= 0.6
      }
    }
    out.id[n] = p.id
    out.kind[n] = kind
    out.tHit[n] = tHit
    out.miss[n] = miss
    out.dirX[n] = dx
    out.dirY[n] = dy
    out.px[n] = px
    out.py[n] = py
    out.pz[n] = pz
    out.urgency[n] = urg
    if (urg > 0) hot++
    n++
  }
  out.n = n
  return hot
}

// ---------------------------------------------------------------- strafe jitter
/**
 * Strafe direction generator: +1 = strafe to the left of the axis (counter-clockwise perpendicular),
 * -1 = right. The side flips after a random period (0.3..0.8 s from the Rng). It never reverses into a wall:
 * a flip is skipped when blocked() says the new side is blocked, and it flips early when the current side is.
 */
export class StrafeJitter {
  sign = 1
  tFlip = -1
  minPeriod: number
  maxPeriod: number
  constructor(minPeriod = 0.3, maxPeriod = 0.8) {
    this.minPeriod = minPeriod
    this.maxPeriod = maxPeriod
  }
  /** t = obs.t; (axisX, axisY) = unit direction toward the threat. Returns the side to strafe to (+1/-1). */
  step(t: number, rng: Rng, axisX: number, axisY: number, blocked?: (dx: number, dy: number) => boolean): number {
    if (this.tFlip < 0) {
      this.sign = rng.next() < 0.5 ? 1 : -1
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod)
    } else if (t >= this.tFlip) {
      const want = -this.sign
      if (!blocked || !blocked(-axisY * want, axisX * want)) this.sign = want
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod)
    }
    if (blocked && blocked(-axisY * this.sign, axisX * this.sign) && !blocked(axisY * this.sign, -axisX * this.sign)) {
      this.sign = -this.sign
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod)
    }
    return this.sign
  }
  reset(): void {
    this.tFlip = -1
  }
}

// ---------------------------------------------------------------- dodge vector
export interface DodgeOut {
  /** recommended move direction (unit, or 0,0 when there is nothing to dodge) */
  mx: number
  my: number
  /** 0..1: 0 = ignore, ~0.35 = being aimed at (strafe if nothing better to do), >= 0.8 = act now */
  urgency: number
  /** a charging laser has us (nearly) on its line: get out of its line of sight if cover is close */
  breakLos: boolean
  /** id of that laser mech, or -1 */
  laserBy: number
  /** number of visible actors whose aim is on us */
  aimers: number
  /** id of the most dangerous aimer (the strafe axis), or -1 */
  primary: number
}

export function newDodgeOut(): DodgeOut {
  return { mx: 0, my: 0, urgency: 0, breakLos: false, laserBy: -1, aimers: 0, primary: -1 }
}

const DEG = Math.PI / 180

/**
 * Yaw error (rad) of an actor's aim relative to the bearing from it to a point; small = it is aiming there.
 */
export function aimOffTarget(m: ActorObs, x: number, y: number): number {
  return Math.abs(wrapPi(m.aim[0] - Math.atan2(y - m.pos[1], x - m.pos[0])))
}

/**
 * Combine projectile threats and visible actors aiming at us into one move recommendation.
 *   - shells: leave the blast circle (weight 3); bullets: step out of the path (weight 1, npc 0.6)
 *   - a `charging` laser whose aim is within ~0.5 rad of us: move perpendicular to its beam line, away from
 *     the line (urgency 1 when the aim is on us), and set breakLos
 *   - gun aimers (aim within our angular size + aimTolDeg): strafe perpendicular to the line to the most
 *     dangerous one, side chosen by the StrafeJitter (random 0.3..0.8 s reversals, wall-aware)
 * `blocked(dx,dy)` (optional) says a unit direction runs into a wall within a few metres; the result is then
 * mirrored or rotated to the first free alternative. Writes `out`.
 */
export function dodgeVector(self: SelfObs, mechs: ActorObs[], threats: ThreatList | null, t: number, rng: Rng, jitter: StrafeJitter, out: DodgeOut, blocked?: (dx: number, dy: number) => boolean, aimTolDeg = 4, maxAimerDist = 290): void {
  const sx = self.pos[0], sy = self.pos[1]
  const R = self.stats.radius ?? 2.5
  let ax = 0, ay = 0, urg = 0
  let bestW = 0, bestX = 0, bestY = 0
  out.breakLos = false
  out.laserBy = -1
  out.aimers = 0
  out.primary = -1

  if (threats) {
    for (let i = 0; i < threats.n; i++) {
      const u = threats.urgency[i]
      if (u <= 0) continue
      const w = u * (threats.kind[i] === THREAT_MORTAR ? 3 : threats.kind[i] === THREAT_NPC ? 0.6 : 1)
      ax += w * threats.dirX[i]
      ay += w * threats.dirY[i]
      if (u > urg) urg = u
      if (w > bestW) {
        bestW = w
        bestX = threats.dirX[i]
        bestY = threats.dirY[i]
      }
    }
  }

  // find the primary aimer first (the jitter needs one axis)
  let primI = -1, primScore = 0
  for (let i = 0; i < mechs.length; i++) {
    const m = mechs[i]
    const rx = sx - m.pos[0], ry = sy - m.pos[1]
    const d = Math.sqrt(rx * rx + ry * ry)
    if (d > maxAimerDist || d < 1e-3) continue
    const err = Math.abs(wrapPi(m.aim[0] - Math.atan2(ry, rx)))
    const half = Math.atan2(R + 1, d)
    const onUs = err < half + aimTolDeg * DEG
    const charging = m.charging === true && err < 0.5
    if (!onUs && !charging) continue
    if (onUs) out.aimers++
    let score = m.kind === "npc" ? 0.3 : 1
    if (charging) score += onUs ? 3 : 1.5
    score *= 1 + 40 / (d + 20)
    if (score > primScore) {
      primScore = score
      primI = i
    }
  }

  if (primI >= 0) {
    const pm = mechs[primI]
    out.primary = pm.id
    let px = pm.pos[0] - sx, py = pm.pos[1] - sy
    const pd = Math.sqrt(px * px + py * py)
    px /= pd
    py /= pd
    const side = jitter.step(t, rng, px, py, blocked)
    for (let i = 0; i < mechs.length; i++) {
      const m = mechs[i]
      const rx = sx - m.pos[0], ry = sy - m.pos[1]
      const d = Math.sqrt(rx * rx + ry * ry)
      if (d > maxAimerDist || d < 1e-3) continue
      const err = Math.abs(wrapPi(m.aim[0] - Math.atan2(ry, rx)))
      const half = Math.atan2(R + 1, d)
      const onUs = err < half + aimTolDeg * DEG
      const charging = m.charging === true && err < 0.5
      if (charging) {
        // perpendicular to the beam line, away from it
        const cyaw = Math.cos(m.aim[0]), syaw = Math.sin(m.aim[0])
        const cross = cyaw * ry - syaw * rx // > 0: we are to the left of the beam
        let s = cross > 0.5 ? 1 : cross < -0.5 ? -1 : side
        let nx = -syaw * s, ny = cyaw * s
        if (blocked && blocked(nx, ny) && !blocked(-nx, -ny)) {
          s = -s
          nx = -nx
          ny = -ny
        }
        const u = onUs ? 1 : 0.7
        const w = 2.5 * u
        ax += w * nx
        ay += w * ny
        if (u > urg) urg = u
        if (w > bestW) {
          bestW = w
          bestX = nx
          bestY = ny
        }
        out.breakLos = true
        if (out.laserBy < 0 || i === primI) out.laserBy = m.id
      } else if (onUs && i === primI) {
        // strafe across the primary aimer's line of fire; closer = more worth it
        const u = m.kind === "npc" ? 0.2 : 0.35 + 0.25 * (d < 60 ? 1 : d > 200 ? 0 : (200 - d) / 140)
        const w = 0.8
        const nx = -py * side, ny = px * side
        ax += w * nx
        ay += w * ny
        if (u > urg) urg = u
        if (w > bestW) {
          bestW = w
          bestX = nx
          bestY = ny
        }
      }
    }
  }

  let l = Math.sqrt(ax * ax + ay * ay)
  if (l < 0.25 * bestW) {
    // contributions cancel: obey the heaviest one
    ax = bestX
    ay = bestY
    l = Math.sqrt(ax * ax + ay * ay)
  }
  if (l < 1e-6 || urg <= 0) {
    out.mx = 0
    out.my = 0
    out.urgency = 0
    return
  }
  ax /= l
  ay /= l
  if (blocked && blocked(ax, ay)) {
    // alternatives in order: rotate 90 deg either way (toward the heaviest direction first), then reverse
    const c1x = -ay, c1y = ax
    const first = c1x * bestX + c1y * bestY >= 0 ? 1 : -1
    if (!blocked(c1x * first, c1y * first)) {
      const tx = c1x * first
      ay = c1y * first
      ax = tx
    } else if (!blocked(-c1x * first, -c1y * first)) {
      const tx = -c1x * first
      ay = -c1y * first
      ax = tx
    } else if (!blocked(-ax, -ay)) {
      ax = -ax
      ay = -ay
    }
  }
  out.mx = ax
  out.my = ay
  out.urgency = urg
}

// ---------------------------------------------------------------- rear arc
/** true when a hit arriving from `bearing` (world yaw from us toward the attacker) would land in our rear arc */
export function isRear(aimYaw: number, bearing: number, frontArcDeg = 180): boolean {
  return Math.abs(wrapPi(bearing - aimYaw)) > 0.5 * frontArcDeg * DEG
}

/**
 * Yaw to hold so that the attackers (world bearings from us toward each, with weights) are inside our front
 * arc. If all fit, the arc is centred on them (maximum margin on both sides); otherwise the yaw covering the
 * most weight is chosen (ties: closest to curYaw). n = 0 returns curYaw.
 */
export function faceThreatYaw(bearings: ArrayLike<number>, weights: ArrayLike<number> | null, n: number, curYaw: number, frontArcDeg = 180): number {
  if (n <= 0) return curYaw
  if (n === 1) return bearings[0]
  const half = 0.5 * frontArcDeg * DEG
  // 1. do they all fit? find the largest angular gap; the span is the rest of the circle
  let gapMax = -1, gapStart = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    total += weights ? weights[i] : 1
    // gap from bearing i counter-clockwise to the next bearing
    let g = 2 * Math.PI
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      let d = bearings[j] - bearings[i]
      d = d % (2 * Math.PI)
      if (d < 0) d += 2 * Math.PI
      if (d < 1e-9) continue // same bearing: not a gap
      if (d < g) g = d
    }
    if (g > gapMax) {
      gapMax = g
      gapStart = bearings[i]
    }
  }
  const span = 2 * Math.PI - gapMax
  if (span <= 2 * half - 1e-9) {
    // centre of the occupied arc = opposite the middle of the largest gap
    return wrapPi(gapStart + 0.5 * gapMax + Math.PI)
  }
  // 2. cannot cover all: try each bearing as an arc edge (both ways) and as the centre
  let bestYaw = curYaw, bestW = -1, bestTurn = Infinity
  for (let i = 0; i < n; i++) {
    for (let e = -1; e <= 1; e++) {
      const yaw = wrapPi(bearings[i] + e * (half - 0.02))
      let w = 0
      for (let j = 0; j < n; j++) {
        if (Math.abs(wrapPi(bearings[j] - yaw)) <= half) w += weights ? weights[j] : 1
      }
      const turn = Math.abs(wrapPi(yaw - curYaw))
      if (w > bestW + 1e-9 || (w > bestW - 1e-9 && turn < bestTurn)) {
        bestW = w
        bestYaw = yaw
        bestTurn = turn
      }
    }
  }
  return bestYaw
}
