/**
 * Test-only kinematic mech: a cylinder moved by the protocol §7 rules directly on the World raster
 * (independent of the nav graph, so it checks the graph's idea of walkable). Not the real simulator.
 */
import type { NavPath, NavQuery, Steer, World } from "../../contracts.ts"
import type { NavEx } from "./index.ts"

export interface KinParams {
  walkSpeed: number
  boostSpeed: number
  groundAccel: number
  airAccel: number
  gravity: number
  jumpSpeed: number
  jetAccel: number
  maxRiseSpeed: number
  jetDrain: number
  boostDrain: number
  maxEnergy: number
  energyRegen: number
  energyRegenDelay: number
  stepUp: number
  maxSlopeDeg: number
}

export const KIN_DEFAULTS: KinParams = {
  walkSpeed: 11.7,
  boostSpeed: 19.5,
  groundAccel: 58.5,
  airAccel: 12,
  gravity: 22,
  jumpSpeed: 11,
  jetAccel: 34,
  maxRiseSpeed: 10,
  jetDrain: 15,
  boostDrain: 17,
  maxEnergy: 100,
  energyRegen: 18,
  energyRegenDelay: 0.6,
  stepUp: 1.2,
  maxSlopeDeg: 50,
}

export interface KinState {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  grounded: boolean
  energy: number
  sinceSpend: number
  radius: number
  height: number
}

export function kinState(x: number, y: number, z: number, radius = 2.5, height = 9): KinState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, energy: 100, sinceSpend: 10, radius, height }
}

/** does the cylinder at (x, y) with feet at z overlap a wall (span crossing [z+stepUp, z+height]) or leave the map */
export function bodyBlocked(w: World, P: KinParams, x: number, y: number, z: number, r: number, h: number): boolean {
  const b = w.bounds
  if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return true
  const i0 = Math.max(0, Math.floor(x - r - w.minX))
  const i1 = Math.min(w.nx - 1, Math.floor(x + r - w.minX))
  const j0 = Math.max(0, Math.floor(y - r - w.minY))
  const j1 = Math.min(w.ny - 1, Math.floor(y + r - w.minY))
  const lo = z + P.stepUp
  const hi = z + h
  for (let j = j0; j <= j1; j++) {
    const cy0 = w.minY + j
    const ny = y < cy0 ? cy0 : y > cy0 + 1 ? cy0 + 1 : y
    for (let i = i0; i <= i1; i++) {
      const c = j * w.nx + i
      const s0 = w.spanStart[c]!
      const s1 = w.spanStart[c + 1]!
      if (s0 === s1) continue
      const cx0 = w.minX + i
      const nx = x < cx0 ? cx0 : x > cx0 + 1 ? cx0 + 1 : x
      if ((nx - x) * (nx - x) + (ny - y) * (ny - y) >= r * r) continue
      for (let k = s0; k < s1; k++) if (w.spanData[2 * k + 1]! > lo && w.spanData[2 * k]! < hi) return true
    }
  }
  return false
}

/** push direction out of overlapping wall cells (unnormalised); 0,0 when free */
function pushOut(w: World, P: KinParams, s: KinState, out: [number, number]): void {
  const r = s.radius
  const i0 = Math.max(0, Math.floor(s.x - r - w.minX))
  const i1 = Math.min(w.nx - 1, Math.floor(s.x + r - w.minX))
  const j0 = Math.max(0, Math.floor(s.y - r - w.minY))
  const j1 = Math.min(w.ny - 1, Math.floor(s.y + r - w.minY))
  const lo = s.z + P.stepUp
  const hi = s.z + s.height
  let px = 0
  let py = 0
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = j * w.nx + i
      let hit = false
      for (let k = w.spanStart[c]!; k < w.spanStart[c + 1]!; k++) if (w.spanData[2 * k + 1]! > lo && w.spanData[2 * k]! < hi) hit = true
      if (!hit) continue
      const dx = s.x - (w.minX + i + 0.5)
      const dy = s.y - (w.minY + j + 0.5)
      const d = Math.hypot(dx, dy)
      if (d > r + 0.71 || d < 1e-6) continue
      px += dx / d
      py += dy / d
    }
  out[0] = px
  out[1] = py
}

const tmp: [number, number] = [0, 0]

/** try to put the body at (nx, ny); returns true and updates the state when allowed */
function tryMove(w: World, P: KinParams, s: KinState, nx: number, ny: number, tanMax: number): boolean {
  const hd = Math.hypot(nx - s.x, ny - s.y)
  if (hd < 1e-9) return true
  if (s.grounded) {
    const f = w.floorZ(nx, ny, s.z, P.stepUp)
    const rise = f - s.z
    // terrain slope limit (prism ledges up to stepUp are fine)
    if (rise > tanMax * hd + 0.02 && Math.abs(f - w.groundZ(nx, ny)) < 1e-3) return false
    const feet = rise > 0 ? f : s.z
    if (bodyBlocked(w, P, nx, ny, feet, s.radius, s.height)) return false
    s.x = nx
    s.y = ny
    if (rise > -0.5) s.z = f
    else s.grounded = false
    return true
  }
  if (w.groundZ(nx, ny) > s.z + P.stepUp) return false
  if (bodyBlocked(w, P, nx, ny, s.z, s.radius, s.height)) return false
  s.x = nx
  s.y = ny
  const f = w.floorZ(nx, ny, s.z, P.stepUp)
  if (f > s.z) {
    s.z = f
    if (s.vz <= 0) {
      s.vz = 0
      s.grounded = true
    }
  }
  return true
}

export function kinStep(w: World, P: KinParams, s: KinState, mx: number, my: number, jump: boolean, boost: boolean, dt: number): void {
  const tanMax = Math.tan((P.maxSlopeDeg * Math.PI) / 180)
  let ml = Math.hypot(mx, my)
  if (ml > 1) {
    mx /= ml
    my /= ml
    ml = 1
  }
  let spent = false
  let speed = P.walkSpeed
  if (boost && s.grounded && ml > 0.01 && s.energy > 0) {
    speed = P.boostSpeed
    s.energy -= P.boostDrain * dt
    spent = true
  }
  const acc = (s.grounded ? P.groundAccel : P.airAccel) * dt
  const dvx = mx * speed - s.vx
  const dvy = my * speed - s.vy
  const dv = Math.hypot(dvx, dvy)
  if (dv <= acc) {
    s.vx += dvx
    s.vy += dvy
  } else {
    s.vx += (dvx / dv) * acc
    s.vy += (dvy / dv) * acc
  }
  if (jump && s.grounded) {
    s.vz = P.jumpSpeed
    s.grounded = false
  }
  // already inside a wall edge (came down past a roof edge): slide out, up to 0.6 m per tick
  if (bodyBlocked(w, P, s.x, s.y, s.z, s.radius, s.height)) {
    pushOut(w, P, s, tmp)
    const pl = Math.hypot(tmp[0], tmp[1])
    if (pl > 1e-6) {
      s.x += (tmp[0] / pl) * 0.6
      s.y += (tmp[1] / pl) * 0.6
    }
  } else {
    const nx = s.x + s.vx * dt
    const ny = s.y + s.vy * dt
    if (!tryMove(w, P, s, nx, ny, tanMax)) {
      const okx = tryMove(w, P, s, nx, s.y, tanMax)
      if (!okx) s.vx = 0
      const oky = tryMove(w, P, s, s.x, ny, tanMax)
      if (!oky) s.vy = 0
    }
  }
  // vertical
  if (!s.grounded) {
    // same order as src/sim/physics.ts: jets (capped), then gravity -> steady climb = maxRise - g*dt
    if (boost && s.energy > 0) {
      s.vz = Math.min(P.maxRiseSpeed, s.vz + P.jetAccel * dt)
      s.energy -= P.jetDrain * dt
      spent = true
    }
    s.vz -= P.gravity * dt
    const zPrev = s.z
    s.z += s.vz * dt
    const c = w.ceilZ(s.x, s.y, zPrev)
    if (c > zPrev && s.z + s.height > c) {
      s.z = c - s.height
      if (s.vz > 0) s.vz = 0
    }
    const f = w.floorZ(s.x, s.y, zPrev, 0.01)
    if (s.z <= f) {
      s.z = f
      s.vz = 0
      s.grounded = true
    }
  } else {
    const f = w.floorZ(s.x, s.y, s.z, P.stepUp)
    if (f < s.z - 0.5) s.grounded = false
    else s.z = f
    s.vz = 0
  }
  if (s.energy < 0) s.energy = 0
  if (spent) s.sinceSpend = 0
  else {
    s.sinceSpend += dt
    if (s.sinceSpend >= P.energyRegenDelay) s.energy = Math.min(P.maxEnergy, s.energy + P.energyRegen * dt)
  }
}

export interface FollowResult {
  ok: boolean
  time: number
  cost: number
  replans: number
  /** final state, for debugging failures */
  x: number
  y: number
  z: number
}

/** plan from (sx,sy,sz) to (gx,gy,gz) and drive the kinematic mech along it with nav.steer, replanning when it reports stuck */
export function kinFollow(nav: NavEx, w: World, sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, q: NavQuery, P: KinParams = KIN_DEFAULTS): FollowResult {
  const s = kinState(sx, sy, sz, q.radius, q.height)
  const fol = nav.newFollower()
  const qa = { ...q, avoid: fol }
  let path: NavPath | null = nav.plan(s.x, s.y, s.z, gx, gy, gz, qa)
  if (!path || !path.complete) return { ok: false, time: 0, cost: 0, replans: 0, x: sx, y: sy, z: sz }
  const cost = path.cost
  const out: Steer = { mx: 0, my: 0, jump: false, boost: false, stuck: false }
  const limit = cost * 3 + 20
  let t = 0
  let replans = 0
  while (t < limit) {
    nav.steer(fol, path, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.grounded, s.energy, out)
    if (out.stuck) {
      if (++replans > 8) break
      const np = nav.plan(s.x, s.y, s.z, gx, gy, gz, qa, path)
      if (!np) break
      path = np
      nav.steer(fol, path, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.grounded, s.energy, out)
    }
    kinStep(w, P, s, out.mx, out.my, out.jump, out.boost, 0.05)
    kinStep(w, P, s, out.mx, out.my, false, out.boost, 0.05)
    t += 0.1
    if (Math.hypot(s.x - gx, s.y - gy) < 1.5 && Math.abs(s.z - gz) < 2 && s.grounded) {
      nav.releasePath(path)
      return { ok: true, time: t, cost, replans, x: s.x, y: s.y, z: s.z }
    }
  }
  nav.releasePath(path)
  return { ok: false, time: t, cost, replans, x: s.x, y: s.y, z: s.z }
}
