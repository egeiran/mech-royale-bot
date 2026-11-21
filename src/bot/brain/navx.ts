/**
 * Thin adapter over src/world/nav (plan / steer / walkClear) with re-plan throttling, plus the static
 * "exposure" field and the cover / hide-spot searches the strategies use.
 * Per-bot state lives in Mover; the exposure cache is a pure function of the map and is shared per World.
 */
import type { NavPath, NavQuery, Steer, World } from "../../contracts.ts"
import { createNav, navParamsFromMech, WP_JET, type NavEx, type NavPathEx } from "../../world/nav/index.ts"
import type { Config } from "../../protocol/mechfight.ts"
import type { Blackboard } from "./blackboard.ts"
import type { Track } from "../perception/tracker.ts"

const TAU = Math.PI * 2

// ---------------------------------------------------------------- exposure (static, shared per world)
const EXP_CELL = 6
const EXP_RAYS = 12
interface ExposureField {
  nx: number
  ny: number
  v: Float32Array
}
const exposureCache = new WeakMap<World, ExposureField>()

function exposureField(world: World): ExposureField {
  let f = exposureCache.get(world)
  if (!f) {
    const nx = Math.ceil((world.maxX - world.minX) / EXP_CELL)
    const ny = Math.ceil((world.maxY - world.minY) / EXP_CELL)
    f = { nx, ny, v: new Float32Array(nx * ny).fill(-1) }
    exposureCache.set(world, f)
  }
  return f
}

/**
 * 0..1: how far one can see (and be seen) from a mech standing on the ground at (x, y): mean free length of
 * EXP_RAYS horizontal rays at head height, relative to `rayLen`. Courtyards and alleys are low, lawns high.
 */
export function exposureAt(world: World, x: number, y: number, rayLen: number): number {
  const f = exposureField(world)
  const i = Math.floor((x - world.minX) / EXP_CELL)
  const j = Math.floor((y - world.minY) / EXP_CELL)
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return 1
  const c = j * f.nx + i
  let e = f.v[c]
  if (e >= 0) return e
  const cx = world.minX + (i + 0.5) * EXP_CELL
  const cy = world.minY + (j + 0.5) * EXP_CELL
  const z = world.groundZ(cx, cy) + 8.5
  let sum = 0
  for (let k = 0; k < EXP_RAYS; k++) {
    const a = (k + 0.5) * (TAU / EXP_RAYS)
    sum += world.raycast(cx, cy, z, Math.cos(a), Math.sin(a), 0, rayLen)
  }
  e = sum / (EXP_RAYS * rayLen)
  f.v[c] = e
  return e
}

export interface Spot {
  x: number
  y: number
  z: number
  ok: boolean
  score: number
}
export const newSpot = (): Spot => ({ x: 0, y: 0, z: 0, ok: false, score: 0 })

// ---------------------------------------------------------------- mover
export class Mover {
  readonly nav: NavEx | null
  readonly world: World
  private follower: object | null
  private path: NavPath | null = null
  private havePath = false
  private goalX = 1e9
  private goalY = 1e9
  private goalZ = 0
  private planTick = -1e9
  private lastGotoTick = -1e9
  private plannedTick = -1
  private readonly q: NavQuery & { avoid?: object } = { radius: 2.5, height: 9, allowJet: true, energy: 100, maxExpansions: 30000 }
  private readonly so: Steer = { mx: 0, my: 0, jump: false, boost: false, stuck: false }
  private stuckFor = 0
  private bugSign = 1
  private bugUntil = -1
  /** output of goto() */
  mx = 0
  my = 0
  jump = false
  boost = false
  /** straight-line distance to the goal */
  dist = 0
  arrived = false
  /** the path does not reach the goal */
  incomplete = false
  /** the last plan did not reach its goal (unreachable, or the search budget ran out) */
  unreachable = false
  /** the follower is on a jet leg or waiting for energy: callers must not add their own boost */
  noBoost = false
  /** counters for the eval */
  plans = 0
  stuckEvents = 0

  constructor(world: World, mech?: Config["mech"]) {
    this.world = world
    let nav: NavEx | null = null
    try {
      if (world) nav = mech ? createNav(world, navParamsFromMech(mech)) : createNav(world)
    } catch {
      nav = null
    }
    this.nav = nav
    this.follower = nav ? nav.newFollower() : null
  }

  /** standable floor height near a point for a body currently at height z */
  floor(x: number, y: number, z: number): number {
    return this.world.floorZ(x, y, z + 1.3, 0)
  }

  /** straight walkable line from the bot to (tx, ty)? */
  walkOk(bb: Blackboard, tx: number, ty: number): boolean {
    const b = this.world.bounds
    const m = bb.radius + 0.8
    if (tx < b.minX + m || tx > b.maxX - m || ty < b.minY + m || ty > b.maxY - m) return false
    if (this.nav) return this.nav.walkClear(bb.x, bb.y, bb.z, tx, ty, this.floor(tx, ty, bb.z), bb.radius)
    return this.localOk(bb.x, bb.y, bb.z, tx, ty, bb.height)
  }

  walkOkFrom(ax: number, ay: number, az: number, tx: number, ty: number, radius: number): boolean {
    if (this.nav) return this.nav.walkClear(ax, ay, az, tx, ty, this.floor(tx, ty, az), radius)
    return this.localOk(ax, ay, az, tx, ty, 9)
  }

  /** map-only fallback: no step above 1.2 m per metre and head room along the line */
  private localOk(ax: number, ay: number, az: number, bx: number, by: number, height: number): boolean {
    const w = this.world
    const d = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(d))
    let z = az
    for (let i = 1; i <= n; i++) {
      const f = i / n
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f
      if (px < w.bounds.minX + 3 || px > w.bounds.maxX - 3 || py < w.bounds.minY + 3 || py > w.bounds.maxY - 3) return false
      const fz = w.floorZ(px, py, z + 1.2, 0)
      if (fz > z + 1.25) return false
      if (w.solid(px, py, fz + 1.5) || w.solid(px, py, fz + height - 0.5)) return false
      z = fz
    }
    return true
  }

  /** is a unit direction blocked within `dist` metres (for strafing / dodging) */
  blocked(bb: Blackboard, dx: number, dy: number, dist: number): boolean {
    return !this.walkOk(bb, bb.x + dx * dist, bb.y + dy * dist)
  }

  /** can a body stand at (x, y) near height z; returns the floor z or NaN */
  standZ(bb: Blackboard, x: number, y: number, z: number): number {
    const w = this.world
    if (x < w.bounds.minX + 4 || x > w.bounds.maxX - 4 || y < w.bounds.minY + 4 || y > w.bounds.maxY - 4) return NaN
    const fz = this.floor(x, y, z)
    if (this.nav) {
      if (this.nav.clearanceAt(x, y, fz) < bb.radius + 0.3) return NaN
      return fz
    }
    if (w.solid(x, y, fz + 1.5) || w.solid(x, y, fz + bb.height - 0.5)) return NaN
    return fz
  }

  /**
   * Path-follow toward a goal. Plans at most once per decision, and only when the goal moved, the plan is
   * old, the follower is stuck, or path following was interrupted. Writes mx/my/jump/boost/dist/arrived.
   */
  goto(bb: Blackboard, gx: number, gy: number, gz: number, allowJet: boolean, arrive: number): void {
    const P = bb.P
    this.mx = this.my = 0
    this.jump = this.boost = false
    const dx = gx - bb.x, dy = gy - bb.y
    const d = Math.hypot(dx, dy)
    this.dist = d
    this.arrived = d <= arrive && Math.abs(gz - bb.z) < 4
    this.incomplete = false
    this.noBoost = false
    if (this.arrived) {
      this.lastGotoTick = bb.tick
      return
    }
    const nav = this.nav
    if (nav && this.follower) {
      const moved = Math.hypot(gx - this.goalX, gy - this.goalY) + Math.abs(gz - this.goalZ)
      const interrupted = bb.tick - this.lastGotoTick > (bb.cfg.match.decide_every ?? 2) * 2
      const old = bb.tick - this.planTick >= P.replanTicks * 2
      const need = !this.havePath || moved > Math.min(P.replanGoalDist, 0.25 * d + 1) || interrupted || old || this.stuckFor >= 1
      if (need && this.plannedTick !== bb.tick && (bb.grounded || !this.havePath)) {
        this.plannedTick = bb.tick
        const q = this.q
        q.radius = bb.radius
        q.height = bb.height
        q.allowJet = allowJet
        q.energy = Math.max(bb.energy, bb.maxEnergy * 0.95)
        // budget grows with the distance: a nearby goal that needs a huge search is unreachable anyway
        const cap = Math.min(P.navMaxExp, Math.round(2500 + 70 * d))
        q.maxExpansions = cap
        q.avoid = this.stuckFor >= 1 ? this.follower : undefined
        const p = nav.plan(bb.x, bb.y, bb.z, gx, gy, gz, q, this.path ?? undefined)
        this.plans++
        if (p) {
          this.path = p
          this.havePath = true
          this.unreachable = !p.complete
        } else {
          this.havePath = false
          this.unreachable = false
        }
        this.goalX = gx
        this.goalY = gy
        this.goalZ = gz
        this.planTick = bb.tick
        if (this.stuckFor > 0) this.stuckFor = -30
      }
      this.lastGotoTick = bb.tick
      if (this.havePath && this.path) {
        const so = this.so
        nav.steer(this.follower, this.path, bb.x, bb.y, bb.z, bb.vx, bb.vy, bb.me.vel[2], bb.grounded, bb.energy, so)
        this.mx = so.mx
        this.my = so.my
        this.jump = so.jump
        this.boost = so.boost
        this.incomplete = !this.path.complete
        const fi = nav.followerInfo(this.follower)
        const kinds = (this.path as NavPathEx).kinds
        this.noBoost = fi.waiting || so.boost || so.jump || (kinds !== undefined && fi.idx < this.path.n && kinds[fi.idx] === WP_JET)
        if (so.stuck) {
          if (this.stuckFor <= 0) this.stuckEvents++
          this.stuckFor = 1
        } else if (this.stuckFor < 0) this.stuckFor++
        if (so.mx !== 0 || so.my !== 0 || so.jump || so.boost) return
        // follower says done / waiting: if we are not there, fall through to the local steering
        if (fi.waiting) return
        if (d <= arrive + 1.5) return
      }
    }
    this.lastGotoTick = bb.tick
    this.local(bb, dx / (d || 1), dy / (d || 1))
  }

  /** local "bug" steering: straight when free, else follow the wall on one side for a while */
  private local(bb: Blackboard, ux: number, uy: number): void {
    const probe = 5
    if (!this.blocked(bb, ux, uy, probe) && bb.t >= this.bugUntil) {
      this.mx = ux
      this.my = uy
      return
    }
    if (bb.t >= this.bugUntil) {
      this.bugSign = bb.rng.next() < 0.5 ? 1 : -1
      this.bugUntil = bb.t + 1.5
    }
    for (let k = 1; k <= 5; k++) {
      const a = k * 0.5 * this.bugSign
      const c = Math.cos(a), s = Math.sin(a)
      const rx = ux * c - uy * s, ry = ux * s + uy * c
      if (!this.blocked(bb, rx, ry, probe)) {
        this.mx = rx
        this.my = ry
        return
      }
    }
    this.mx = ux
    this.my = uy
    this.jump = bb.grounded
    this.boost = !bb.grounded && bb.energy > 20
  }

  // ---------------------------------------------------------------- cover / hide
  /**
   * Nearest standable point within maxDist that none of the given mechs has a line to (their eye to our
   * centre and top). Prefers points we can walk to in a straight line and that do not lead toward a threat.
   */
  findCover(bb: Blackboard, threats: Track[], n: number, maxDist: number, out: Spot): boolean {
    out.ok = false
    if (n <= 0) return false
    const w = this.world
    let best = 1e9
    const base = bb.rng.next() * TAU
    for (let ring = 0; ring < 6; ring++) {
      const r = ring === 0 ? 6 : ring === 1 ? 10 : ring === 2 ? 15 : ring === 3 ? 22 : ring === 4 ? 32 : 45
      if (r > maxDist) break
      if (best < r) break // nothing further out can beat what we have (score >= distance)
      for (let k = 0; k < 16; k++) {
        const a = base + (k * TAU) / 16
        const px = bb.x + r * Math.cos(a), py = bb.y + r * Math.sin(a)
        const pz = this.standZ(bb, px, py, bb.z)
        if (pz !== pz) continue
        if (bb.zone.margin(px, py) < 6) continue
        let hidden = true
        let toward = 0
        for (let i = 0; i < n && hidden; i++) {
          const e = threats[i]
          const ez = e.z + (8 / 9) * e.height
          if (w.segClear(e.x, e.y, ez, px, py, pz + 0.5 * bb.height) || w.segClear(e.x, e.y, ez, px, py, pz + bb.height)) hidden = false
          const ed = e.dist > 1 ? e.dist : 1
          const dot = ((e.x - bb.x) * (px - bb.x) + (e.y - bb.y) * (py - bb.y)) / (ed * r)
          if (dot > toward) toward = dot
        }
        if (!hidden) continue
        let score = r + toward * 12
        if (!this.walkOk(bb, px, py)) score += 14
        if (score < best) {
          best = score
          out.x = px
          out.y = py
          out.z = pz
          out.ok = true
          out.score = score
        }
      }
    }
    return out.ok
  }

  /**
   * Hide-spot search for the ghost: samples points within P.hideSearchR and scores them by low exposure,
   * distance from known enemies and sound heat, travel distance, being hidden from every known enemy right
   * now, and staying inside the circle. `cur` (if ok) competes with a switch margin. Writes the best into out.
   */
  findHide(bb: Blackboard, cur: Spot | null, samples: number, out: Spot): boolean {
    const P = bb.P
    const w = this.world
    const zn = bb.zone
    out.ok = false
    let best = -1e9
    const nav = this.nav
    const myComp = nav ? nav.componentAt(bb.x, bb.y, bb.z, this.qFor(bb)) : 0
    for (let s = -1; s < samples; s++) {
      let px: number, py: number
      if (s < 0) {
        if (!cur || !cur.ok) continue
        px = cur.x
        py = cur.y
      } else {
        const a = bb.rng.next() * TAU
        const r = 8 + Math.sqrt(bb.rng.next()) * P.hideSearchR
        px = bb.x + r * Math.cos(a)
        py = bb.y + r * Math.sin(a)
      }
      const gz = w.groundZ(px, py)
      const pz = this.standZ(bb, px, py, gz)
      if (pz !== pz || Math.abs(pz - gz) > 1.5) continue
      if (nav && myComp >= 0 && nav.componentAt(px, py, pz, this.q) !== myComp) continue
      const score = this.hideScore(bb, px, py, pz) + (s < 0 ? P.hideSwitchMargin : 0)
      if (score > best) {
        best = score
        out.x = px
        out.y = py
        out.z = pz
        out.ok = true
        out.score = score - (s < 0 ? P.hideSwitchMargin : 0)
      }
    }
    void zn
    return out.ok
  }

  hideScore(bb: Blackboard, px: number, py: number, pz: number): number {
    const P = bb.P
    const w = this.world
    const zn = bb.zone
    const d = Math.hypot(px - bb.x, py - bb.y)
    let score = -P.hideWExposure * exposureAt(w, px, py, P.exposureRay) - P.hideWDist * d
    // zone: must be inside the circle we will have when we get there, prefer inside the next one
    const eta = d / bb.walk + 6
    const mNow = zn.marginAt(px, py, bb.t + eta)
    if (mNow < 12) score -= 500 + (12 - mNow) * 5
    const mNext = zn.marginNext(px, py)
    const untilShrink = zn.t0 - bb.t
    if (mNext < 15) score -= untilShrink < 40 ? 200 + (15 - mNext) : 12 + 0.1 * (15 - mNext)
    // enemies: distance from every known mech, and no line from any of them
    const tr = bb.tracker.mechs
    let minD = 150
    for (let i = 0; i < tr.length; i++) {
      const e = tr[i]
      if (!e.known || e.dead || e.id === bb.me.id) continue
      const age = e.age(bb.t)
      if (age > P.enemyMemoryS) continue
      const ed = Math.hypot(px - e.x, py - e.y)
      if (ed < minD) minD = ed
      if (age < 6 && ed < 220) {
        const ez = e.z + (8 / 9) * e.height
        if (w.segClear(e.x, e.y, ez, px, py, pz + 0.5 * bb.height) || w.segClear(e.x, e.y, ez, px, py, pz + bb.height)) score -= 60
      }
    }
    score += P.hideWEnemy * minD
    const npcs = bb.tracker.npcs
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i]
      if (e.known && e.hp !== 0 && Math.hypot(px - e.x, py - e.y) < 60) score -= 40
    }
    score -= P.hideWHeat * Math.min(3, bb.sounds.heatAt(px, py))
    return score
  }

  private qFor(bb: Blackboard): NavQuery {
    const q = this.q
    q.radius = bb.radius
    q.height = bb.height
    q.allowJet = false
    q.energy = bb.energy
    return q
  }
}
