/**
 * Dynamic cover queries against known enemy states. Pure functions over World (+ the exposure field for the
 * static segment cost). No allocation; a call is 1-2 rays per enemy (about 0.5 us each) unless stated.
 */
import type { World } from "../../contracts.ts"
import { CELL, F_ROOF, F_STAND, MECH_H, type ExposureField } from "./exposure.ts"

/** what we know about one enemy; `cubes` scales its eye height (8 m x (1 + 0.05 cubes)), `sensors` = number of sensor upgrades */
export interface EnemyView {
  x: number
  y: number
  /** feet */
  z: number
  /** torso aim yaw */
  yaw: number
  cubes?: number
  sensors?: number
}

export interface VisionCfg {
  range: number
  fov_deg: number
  near_range: number
}
export const DEFAULT_VISION: VisionCfg = { range: 200, fov_deg: 120, near_range: 45 }

function eyeOf(e: EnemyView): number {
  return e.z + 8 * (1 + 0.05 * (e.cubes ?? 0))
}

/**
 * Index of the first enemy that sees a mech with feet at (x, y, z) and the given height right now (protocol §8,
 * exact: world.canSee), or -1. With anyYaw = true the yaw wedge is ignored (the enemy "could see us if it
 * looked": idle torsos in the showdown data sweep a full turn every 2-9 s, so use this for where to stand).
 */
export function visibleToAny(world: World, x: number, y: number, z: number, height: number, enemies: ArrayLike<EnemyView>, n: number, vision: VisionCfg = DEFAULT_VISION, anyYaw = false): number {
  for (let i = 0; i < n; i++) {
    const e = enemies[i]!
    const s = e.sensors ?? 0
    const range = vision.range + 25 * s
    const near = vision.near_range + 15 * s
    const ez = eyeOf(e)
    if (!anyYaw) {
      if (world.canSee(e.x, e.y, ez, e.yaw, x, y, z, height, range, vision.fov_deg, near)) return i
      continue
    }
    const dx = x - e.x
    const dy = y - e.y
    const dz = z + height * 0.5 - ez
    if (dx * dx + dy * dy + dz * dz > range * range) continue
    if (losToBody(world, e.x, e.y, ez, x, y, z, height, near)) return i
  }
  return -1
}

/** number of enemies that see the mech (same rule as visibleToAny) */
export function countVisible(world: World, x: number, y: number, z: number, height: number, enemies: ArrayLike<EnemyView>, n: number, vision: VisionCfg = DEFAULT_VISION, anyYaw = false): number {
  let c = 0
  for (let i = 0; i < n; i++) {
    tmp1[0] = enemies[i]!
    if (visibleToAny(world, x, y, z, height, tmp1, 1, vision, anyYaw) === 0) c++
  }
  return c
}
const tmp1: EnemyView[] = [{ x: 0, y: 0, z: 0, yaw: 0 }]

/** line of sight (either way, no wedge, no range) between an eye point and a mech's centre or top */
export function losToBody(world: World, ex: number, ey: number, ez: number, x: number, y: number, z: number, height: number, nearRange = 45): boolean {
  const zc = z + height * 0.5
  const dx = x - ex
  const dy = y - ey
  const dz = zc - ez
  if (dx * dx + dy * dy + dz * dz <= nearRange * nearRange) return world.segClear(ex, ey, ez, x, y, zc) || world.segClear(ex, ey, ez, x, y, z + height)
  return world.sightClear(ex, ey, ez, x, y, zc) || world.sightClear(ex, ey, ez, x, y, z + height)
}

export interface SafeStep {
  /** a covered point was found within maxDist */
  found: boolean
  /** unit direction to walk */
  dx: number
  dy: number
  /** metres to the covered point (straight line) */
  dist: number
  /** the covered point (feet) */
  x: number
  y: number
  z: number
}
export function createSafeStep(): SafeStep {
  return { found: false, dx: 0, dy: 0, dist: 0, x: 0, y: 0, z: 0 }
}

const RINGS = [4, 8, 12, 16, 22, 30, 40, 52]
const NDIR = 16
const COS = new Float64Array(NDIR)
const SIN = new Float64Array(NDIR)
for (let k = 0; k < NDIR; k++) {
  COS[k] = Math.cos((k * 2 * Math.PI) / NDIR)
  SIN[k] = Math.sin((k * 2 * Math.PI) / NDIR)
}

/** can a body walk the straight line (same surface, steps <= 1.2 m up / 2.5 m down per 2 m, no wall within radius at ground level) */
function walkable(world: World, wd: Float32Array, x: number, y: number, z: number, ux: number, uy: number, len: number, radius: number): number {
  let pz = z
  const b = world.bounds
  for (let d = 2; d <= len + 0.01; d += 2) {
    const px = x + ux * d
    const py = y + uy * d
    if (px < b.minX + radius || px > b.maxX - radius || py < b.minY + radius || py > b.maxY - radius) return NaN
    const fz = world.floorZ(px, py, pz + 1.2)
    if (fz > pz + 1.2 || fz < pz - 2.5) return NaN
    if (world.ceilZ(px, py, fz + 0.1) < fz + MECH_H) return NaN
    // at terrain level the wall-distance field applies; on a roof the surface continuity check above is the test
    if (Math.abs(fz - world.groundZ(px, py)) < 0.6) {
      const c = (Math.floor(py - world.minY) | 0) * world.nx + (Math.floor(px - world.minX) | 0)
      if (wd[c]! < radius - 0.5) return NaN
    }
    pz = fz
  }
  return pz
}

/**
 * Which way to step to break line of sight to ALL the given enemies soonest: the nearest point (rings of 4..52 m,
 * 16 directions, straight walkable line) from which no enemy eye sees our centre or top. Among points on the
 * same ring the one farthest from the first enemy wins. Typical cost 20-60 us (worst case ~250 rays when nothing
 * is found). out.found = false when no covered point exists within maxDist: then dx, dy point directly away
 * from the first enemy.
 */
export function safeDirection(world: World, x: number, y: number, z: number, height: number, enemies: ArrayLike<EnemyView>, n: number, maxDist: number, out: SafeStep, radius = 2.5): SafeStep {
  out.found = false
  out.dist = 0
  out.x = x
  out.y = y
  out.z = z
  if (n <= 0) {
    out.dx = 0
    out.dy = 0
    return out
  }
  const e0 = enemies[0]!
  let ax = x - e0.x
  let ay = y - e0.y
  const al = Math.hypot(ax, ay) || 1
  ax /= al
  ay /= al
  out.dx = ax
  out.dy = ay
  const wd = world.wallDist()
  for (let r = 0; r < RINGS.length; r++) {
    const len = RINGS[r]!
    if (len > maxDist) break
    let best = -1
    let bestD = -Infinity
    let bestZ = 0
    for (let k = 0; k < NDIR; k++) {
      const ux = COS[k]!
      const uy = SIN[k]!
      const pz = walkable(world, wd, x, y, z, ux, uy, len, radius)
      if (pz !== pz) continue
      const px = x + ux * len
      const py = y + uy * len
      let seen = false
      for (let i = 0; i < n && !seen; i++) {
        const e = enemies[i]!
        seen = losToBody(world, e.x, e.y, eyeOf(e), px, py, pz, height, 45 + 15 * (e.sensors ?? 0))
      }
      if (seen) continue
      const d = Math.hypot(px - e0.x, py - e0.y)
      if (d > bestD) {
        bestD = d
        best = k
        bestZ = pz
      }
    }
    if (best >= 0) {
      out.found = true
      out.dx = COS[best]!
      out.dy = SIN[best]!
      out.dist = len
      out.x = x + COS[best]! * len
      out.y = y + SIN[best]! * len
      out.z = bestZ
      return out
    }
  }
  return out
}

/**
 * Static exposure cost of a straight segment: the integral of the exposure field along it, in "exposed metres"
 * (0 = fully covered, length = fully open). Array lookups only (~0.05 us per 4 m). Use it as an additive edge
 * cost when choosing among candidate waypoints: cost = length + k * segmentExposure(...), k around 3-6.
 */
export function segmentExposure(f: ExposureField, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1e-6) return 0
  const steps = Math.max(1, Math.ceil(len / CELL))
  let acc = 0
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) / steps
    const x = ax + dx * t
    const y = ay + dy * t
    const z = az + (bz - az) * t
    let i = Math.floor((x - f.minX) / CELL)
    let j = Math.floor((y - f.minY) / CELL)
    if (i < 0) i = 0
    else if (i >= f.gnx) i = f.gnx - 1
    if (j < 0) j = 0
    else if (j >= f.gny) j = f.gny - 1
    let c = j * f.gnx + i
    if (f.flags[f.n + c]! & F_ROOF && Math.abs(z - f.z[f.n + c]!) < 2.5) c += f.n
    // a non-standable cell on the way (wall edge, doorway narrower than the grid): take the value as half exposed
    acc += f.flags[c]! & F_STAND ? f.expo[c]! / 255 : 0.5
  }
  return (acc / steps) * len
}

/** segmentExposure summed over a polyline of n points stored as x,y,z triples (a NavPath's pts / n): exposed metres of the route */
export function pathExposure(f: ExposureField, pts: ArrayLike<number>, n: number): number {
  let acc = 0
  for (let i = 1; i < n; i++) acc += segmentExposure(f, pts[3 * i - 3]!, pts[3 * i - 2]!, pts[3 * i - 1]!, pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!)
  return acc
}

/**
 * Dynamic cost of a straight segment: the share (0..1) of points every `step` metres on it from which at least
 * one known enemy could see a mech of this height (yaw wedge ignored: they turn at 4 rad/s). ~1 us per sample
 * and enemy.
 */
export function segmentSeenFrac(world: World, ax: number, ay: number, az: number, bx: number, by: number, bz: number, height: number, enemies: ArrayLike<EnemyView>, n: number, step = 6): number {
  if (n <= 0) return 0
  const dx = bx - ax
  const dy = by - ay
  const len = Math.sqrt(dx * dx + dy * dy)
  const steps = Math.max(1, Math.ceil(len / step))
  let seen = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const x = ax + dx * t
    const y = ay + dy * t
    const z = az + (bz - az) * t
    for (let i = 0; i < n; i++) {
      const e = enemies[i]!
      const ex = x - e.x
      const ey = y - e.y
      const range = 200 + 25 * (e.sensors ?? 0)
      if (ex * ex + ey * ey > range * range) continue
      if (losToBody(world, e.x, e.y, eyeOf(e), x, y, z, height, 45 + 15 * (e.sensors ?? 0))) {
        seen++
        break
      }
    }
  }
  return seen / (steps + 1)
}
