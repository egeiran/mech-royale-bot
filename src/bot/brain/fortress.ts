/**
 * ROOF FORTRESS (squad variant; params fort*, all off by default - see params.ts).
 *
 * A 9 m mech standing well inside a tall, large roof cannot be shot from the ground: a ground muzzle (7 m) at D m
 * from the edge has a line to the centre of a mech standing d m back from the edge of an h m roof only when
 * D >= d (h - 7) / 4.5. A hunter has to jet up and comes over the edge airborne, one at a time, with little energy
 * left. From a trigger (several mechs on us / match time / low HP with pursuers / kills) we climb the best roof in
 * the next circle and hold its interior, out of the line of known shooters, shooting arrivals; relocate before the
 * zone leaves it; release after a quiet spell (normal play takes over: it comes down to fight).
 *
 * Roof catalogue: static per World (module cache), from the exposure field's roof layer (4 m cells): candidate
 * cells (standable roof, >= 6 m from every edge, >= 8 m above the terrain, not on the stadium) grouped by roof
 * surface (4-connected cells within 1.2 m height). Built once (~2 ms; warmup.ts fetches it before `ready`).
 * Per-bot state lives in FortState (SquadScratch.fort).
 */
import type { World } from "../../contracts.ts"
import type { Track } from "../perception/tracker.ts"
import { CELL, F_ROOF, getExposure, type ExposureField } from "../cover/exposure.ts"
import { L_CUBE, type Blackboard } from "./blackboard.ts"
import { FACE_SCAN, FACE_THREATS, FACE_YAW, PACE_BOOST, PACE_WALK, type Intent } from "./intent.ts"
import type { Mover } from "./navx.ts"

// stadium footprint + 8 m (its upper rim holds the known nav follower failures)
const ST_X0 = -390, ST_X1 = -162, ST_Y0 = -21, ST_Y1 = 275
const MIN_EDGE = 6
const MIN_H = 8

export interface RoofCat {
  readonly f: ExposureField
  /** roof surface id per layer cell (-1 = no roof) */
  readonly cl: Int32Array
  readonly nCl: number
  /** candidate cells, grouped by surface: surface s owns [clStart[s], clStart[s + 1]) */
  readonly n: number
  readonly clStart: Int32Array
  readonly clOf: Int32Array
  readonly x: Float32Array
  readonly y: Float32Array
  /** roof (feet) height and height above the terrain */
  readonly z: Float32Array
  readonly h: Float32Array
  /** m to the nearest roof edge (capped at 60), static ground exposure 0..1 */
  readonly edge: Uint8Array
  readonly expo: Float32Array
  readonly buildMs: number
}

const cache = new WeakMap<World, RoofCat>()

export function getRoofs(world: World): RoofCat {
  const hit = cache.get(world)
  if (hit) return hit
  const t0 = performance.now()
  const f = getExposure(world)
  const { gnx, gny, n } = f
  const cl = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  let nCl = 0
  for (let s = 0; s < n; s++) {
    if (cl[s] !== -1 || !(f.flags[n + s]! & F_ROOF)) continue
    let qh = 0, qt = 0
    queue[qt++] = s
    cl[s] = nCl
    while (qh < qt) {
      const c = queue[qh++]!
      const i = c % gnx, j = (c - i) / gnx
      const zc = f.z[n + c]!
      for (let d = 0; d < 4; d++) {
        const ii = d === 0 ? i + 1 : d === 1 ? i - 1 : i
        const jj = d === 2 ? j + 1 : d === 3 ? j - 1 : j
        if (ii < 0 || jj < 0 || ii >= gnx || jj >= gny) continue
        const v = jj * gnx + ii
        if (cl[v] !== -1 || !(f.flags[n + v]! & F_ROOF) || Math.abs(f.z[n + v]! - zc) > 1.2) continue
        cl[v] = nCl
        queue[qt++] = v
      }
    }
    nCl++
  }
  // candidates, counting sort by surface
  const keep = new Int32Array(n).fill(-1)
  const cnt = new Int32Array(nCl + 1)
  let m = 0
  for (let c = 0; c < n; c++) {
    if (cl[c] < 0 || f.edge[n + c]! < MIN_EDGE) continue
    const i = c % gnx, j = (c - i) / gnx
    const x = f.minX + (i + 0.5) * CELL, y = f.minY + (j + 0.5) * CELL
    if (x > ST_X0 && x < ST_X1 && y > ST_Y0 && y < ST_Y1) continue
    if (f.z[n + c]! - world.groundZ(x, y) < MIN_H) continue
    keep[c] = 1
    cnt[cl[c]! + 1]!++
    m++
  }
  const clStart = new Int32Array(nCl + 1)
  for (let s = 0; s < nCl; s++) clStart[s + 1] = clStart[s]! + cnt[s + 1]!
  const fill = clStart.slice()
  const cat = {
    f, cl, nCl, n: m, clStart, clOf: new Int32Array(m), x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m), h: new Float32Array(m),
    edge: new Uint8Array(m), expo: new Float32Array(m), buildMs: 0,
  }
  for (let c = 0; c < n; c++) {
    if (keep[c] !== 1) continue
    const s = cl[c]!
    const k = fill[s]!++
    const i = c % gnx, j = (c - i) / gnx
    const x = f.minX + (i + 0.5) * CELL, y = f.minY + (j + 0.5) * CELL
    cat.clOf[k] = s
    cat.x[k] = x
    cat.y[k] = y
    cat.z[k] = f.z[n + c]!
    cat.h[k] = f.z[n + c]! - world.groundZ(x, y)
    cat.edge[k] = f.edge[n + c]!
    cat.expo[k] = f.expo[n + c]! / 255
  }
  cat.buildMs = performance.now() - t0
  cache.set(world, cat)
  return cat
}

/** the roof surface id under a mech with feet at z (-1 = not on a roof) */
export function roofAt(cat: RoofCat, x: number, y: number, z: number): number {
  const f = cat.f
  let i = Math.floor((x - f.minX) / CELL)
  let j = Math.floor((y - f.minY) / CELL)
  if (i < 0 || j < 0 || i >= f.gnx || j >= f.gny) return -1
  const c = j * f.gnx + i
  const s = cat.cl[c]!
  if (s < 0) return -1
  const rz = f.z[f.n + c]!
  return z > rz - 1.2 && z < rz + 6 ? s : -1
}

/** is a mech with feet at z standing on surface s (its cell or a neighbour cell: 4 m cells mix wall and roof) */
export function onSurface(cat: RoofCat, x: number, y: number, z: number, s: number): boolean {
  if (s < 0) return false
  const f = cat.f
  const i0 = Math.floor((x - f.minX) / CELL)
  const j0 = Math.floor((y - f.minY) / CELL)
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj
      if (i < 0 || j < 0 || i >= f.gnx || j >= f.gny) continue
      const c = j * f.gnx + i
      if (cat.cl[c] !== s) continue
      const rz = f.z[f.n + c]!
      if (z > rz - 1.2 && z < rz + 6) return true
    }
  return false
}

export class FortState {
  /** latched fortress mode, since, released at / no new trigger before */
  on = false
  tOn = -1e9
  retryT = -1e9
  /** chosen candidate cell (travel goal, then the hold spot) and its surface */
  ci = -1
  clId = -1
  /** first time on the roof in this stint, travel start / straight distance at the pick */
  arrT = -1
  travelT0 = 0
  travelD = 0
  fails = 0
  relocT = -1e9
  /** where we hold near the spot */
  holdX = 0
  holdY = 0
  holdZ = 0
  holdT = -1
  lastPurT = -1e9
  spotT = -1e9
  /** blacklist per surface (until time) */
  bad: Float64Array | null = null
  /** peek-snipe */
  peekOn = false
  peekT0 = 0
  peekNext = 0
  peekTgt = -1
  peekX = 0
  peekY = 0
  peekZ = 0
  /** stats (eval) */
  nTrig = 0
  nReloc = 0
  trigT = -1
  roofT = -1
  roofS = 0
  peeks = 0
  /** straight distance to the first roof at the first trigger */
  trigD = -1
  /** last reason for a (re)pick / release (debug) */
  why = ""
}

/** any fortress trigger configured */
export function fortEnabled(bb: Blackboard): boolean {
  const P = bb.P
  return P.fortOnUs > 0 || P.fortT < 999 || P.fortHp > 0 || P.fortKills > 0
}

/**
 * safe radius of candidate k for a body of height H: no ground muzzle (7 m above its terrain) closer than this
 * (horizontally, to us) has a line to our centre over the nearest edge: edge + edge (h - 7) / (H / 2)
 */
function safeR(cat: RoofCat, k: number, H: number): number {
  const e = cat.edge[k]!
  return e + (e * Math.max(0, cat.h[k]! - 7)) / (0.5 * H)
}

/** can a mech eye at (ex, ey, ez) shoot / see the centre or top of a body of height h with feet at (x, y, z) */
function lineTo(w: World, ex: number, ey: number, ez: number, x: number, y: number, z: number, h: number): boolean {
  return w.segClear(ex, ey, ez, x, y, z + 0.5 * h) || w.segClear(ex, ey, ez, x, y, z + h)
}

function release(st: FortState, t: number, retry: number): void {
  st.on = false
  st.peekOn = false
  st.retryT = t + retry
  st.ci = -1
  st.clId = -1
}

/**
 * best fortress cell: tall enough, climbable with full energy, interior, inside the next circle with margin and
 * inside the circle on arrival + fortStayS, near (travel time), low static exposure, deep and high, not behind the
 * pursuers. Into st.ci / st.clId; false when none.
 */
function pickRoof(bb: Blackboard, mv: Mover, st: FortState, cat: RoofCat, onUs: number, relax = 1): boolean {
  const P = bb.P
  const nav = mv.nav
  const n = cat.n
  if (!st.bad || st.bad.length !== cat.nCl) st.bad = new Float64Array(cat.nCl)
  const bad = st.bad
  // highest climb with 85 % of full energy (nav.jetEnergy: 8 + 1.7 per m above the free jump)
  let maxH = 45
  if (nav) {
    const e = 0.85 * bb.maxEnergy
    maxH = 8
    while (maxH < 70 && nav.jetEnergy(maxH + 1) <= e) maxH++
  }
  let best = -1, bs = 1e9
  for (let k = 0; k < n; k++) {
    if (cat.edge[k]! < P.fortEdge || cat.h[k]! < P.fortMinH || cat.h[k]! > maxH) continue
    const sr = safeR(cat, k, bb.height)
    if (sr < P.fortSafeR * relax) continue
    const s0 = cat.clOf[k]!
    if (bad[s0]! > bb.t) continue
    const x = cat.x[k]!, y = cat.y[k]!
    const dx = x - bb.x, dy = y - bb.y
    const d = Math.hypot(dx, dy)
    if (d > P.fortMaxDist) continue
    if (bb.zone.marginNext(x, y) < P.fortZoneMargin * relax) continue
    const travel = d / bb.walk + cat.h[k]! / 8 + 1
    // every second of travel under fire costs more
    let s = travel * (1 + 0.25 * onUs) + 8 * cat.expo[k]! - Math.min(sr, 180) / 12
    if (s >= bs) continue
    // pursuers nearer to the roof than we are (they would be waiting at its foot / on the way)
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      const de = Math.hypot(e.x - x, e.y - y)
      if (de < d) s += 4 * (1 - de / (d + 1))
    }
    if (s >= bs) continue
    if (bb.zone.marginAt(x, y, bb.t + travel + P.fortStayS) < 5) continue
    if (bb.isBadGoal(x, y) || !fits(bb, mv, cat, k)) continue
    bs = s
    best = k
  }
  if (best < 0) return false
  st.ci = best
  st.clId = cat.clOf[best]!
  st.travelT0 = bb.t
  st.travelD = Math.hypot(cat.x[best]! - bb.x, cat.y[best]! - bb.y)
  st.arrT = -1
  st.spotT = -1e9
  return true
}

const SPOT_K = 10
const _ks = new Int32Array(SPOT_K)
const _ss = new Float64Array(SPOT_K)

/** a body of our (grown) size can stand at candidate k (nav clearance) */
function fits(bb: Blackboard, mv: Mover, cat: RoofCat, k: number): boolean {
  const nav = mv.nav
  return !nav || nav.clearanceAt(cat.x[k]!, cat.y[k]!, cat.z[k]!) >= bb.radius + 0.3
}

/** static spot score (lower = better): safe radius, exposure, distance from us, far side from the pursuers */
function spotStatic(bb: Blackboard, cat: RoofCat, k: number, cx: number, cy: number, cw: number, dUs: number): number {
  const x = cat.x[k]!, y = cat.y[k]!
  let s = 0.5 * cat.expo[k]! - Math.min(safeR(cat, k, bb.height), 180) / 100 + Math.hypot(x - bb.x, y - bb.y) / 60
  if (cw > 0) s -= (0.15 * (Math.hypot(x - cx, y - cy) - dUs)) / 30
  return s
}

/** number of known enemies (fresh tracks within 260 m, at most 8) plus the phantom with a line to spot k */
function spotSeen(bb: Blackboard, cat: RoofCat, k: number, ph: Track | null): number {
  const w = bb.world
  const x = cat.x[k]!, y = cat.y[k]!, z = cat.z[k]!
  const h = bb.height
  const trs = bb.tracker.mechs
  let n = 0, ne = 0
  for (let i = 0; i < trs.length && ne < 8; i++) {
    const e = trs[i]
    if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > 8 || e.dist > 260) continue
    ne++
    if (lineTo(w, e.x, e.y, e.z + 0.89 * e.height, x, y, z, h)) n++
  }
  if (ph && lineTo(w, ph.x, ph.y, ph.z + 8, x, y, z, h)) n++
  return n
}

/**
 * hold spot on our surface: among the interior cells within 50 m, the best static score (largest safe radius, low
 * exposure, near, far side from the pursuers), then the fewest known enemies with a line (0.5 each). The current
 * spot is kept unless the new one is better by 0.25 (or by a line).
 */
function chooseSpot(bb: Blackboard, mv: Mover, cat: RoofCat, st: FortState, ph: Track | null): void {
  const P = bb.P
  const s0 = cat.clStart[st.clId]!, s1 = cat.clStart[st.clId + 1]!
  // known pursuers: centroid
  let cx = 0, cy = 0, cw = 0
  const trs = bb.tracker.mechs
  for (let i = 0; i < trs.length; i++) {
    const e = trs[i]
    if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > 15 || e.dist > 250) continue
    cx += e.x
    cy += e.y
    cw++
  }
  if (cw > 0) {
    cx /= cw
    cy /= cw
  }
  const dUs = cw > 0 ? Math.hypot(bb.x - cx, bb.y - cy) : 0
  let nk = 0
  for (let pass = 0; pass < 2 && nk === 0; pass++) {
    for (let k = s0; k < s1; k++) {
      if (k === st.ci || (pass === 0 && cat.edge[k]! < P.fortEdge)) continue
      if (Math.hypot(cat.x[k]! - bb.x, cat.y[k]! - bb.y) > 50) continue
      // a big roof may be partly outside the coming circle
      if (bb.zone.marginAt(cat.x[k]!, cat.y[k]!, bb.t + P.fortRelocS + 10) < 8) continue
      const s = spotStatic(bb, cat, k, cx, cy, cw, dUs)
      // keep the SPOT_K best (insertion); the (grown) body must fit there
      if ((nk < SPOT_K || s < _ss[nk - 1]!) && fits(bb, mv, cat, k)) {
        let p = nk < SPOT_K ? nk++ : SPOT_K - 1
        while (p > 0 && _ss[p - 1]! > s) {
          _ss[p] = _ss[p - 1]!
          _ks[p] = _ks[p - 1]!
          p--
        }
        _ss[p] = s
        _ks[p] = k
      }
    }
  }
  const cur = st.ci
  const curS = cur >= 0 && cat.clOf[cur] === st.clId ? spotStatic(bb, cat, cur, cx, cy, cw, dUs) + 0.5 * spotSeen(bb, cat, cur, ph) : 1e9
  let best = cur, bs = curS - 0.25
  for (let q = 0; q < nk; q++) {
    if (_ss[q]! >= bs) break
    const k = _ks[q]!
    const s = _ss[q]! + 0.5 * spotSeen(bb, cat, k, ph)
    if (s < bs) {
      bs = s
      best = k
    }
  }
  st.ci = best
}

/**
 * peek point toward enemy e: walking from us toward it on our surface (2 m steps, >= 3 m from the edge), the first
 * point with a muzzle line to its centre, within 26 m; into st.peekX/Y/Z
 */
function findPeek(bb: Blackboard, cat: RoofCat, st: FortState, e: Track): boolean {
  const w = bb.world
  const d = Math.max(1, e.dist)
  const ux = (e.x - bb.x) / d, uy = (e.y - bb.y) / d
  const tz = e.z + 0.5 * e.height
  for (let r = 2; r <= 26; r += 2) {
    const x = bb.x + ux * r, y = bb.y + uy * r
    // stay on the surface with 3 m to spare
    const xa = bb.x + ux * (r + 3), ya = bb.y + uy * (r + 3)
    if (roofAt(cat, xa, ya, bb.z) !== st.clId || !onSurface(cat, x, y, bb.z, st.clId)) return false
    const z = w.floorZ(x, y, bb.z + 1.3, 0)
    if (w.segClear(x, y, z + bb.muzzleH, e.x, e.y, tz)) {
      st.peekX = x
      st.peekY = y
      st.peekZ = z
      return true
    }
  }
  return false
}

/**
 * The fortress step (squad.ts, right after the urgent zone step). Returns true when it filled the intent.
 * `target` = pickTarget's choice, `kills` = our kills so far, `ph` = a phantom for an unseen shooter (or null).
 */
export function fortress(bb: Blackboard, mv: Mover, st: FortState, it: Intent, target: Track | null, kills: number, ph: Track | null): boolean {
  const P = bb.P
  const w = bb.world
  if (!w) return false
  const cat = getRoofs(w)
  // pursuers in sight
  let onUs = 0, near = 0
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    const shooting = bb.t - e.tShotAtUs < 3 || (e.aimingAtUs && bb.los[e.id] === 1)
    if (shooting || e.dist < P.fortNearR) onUs++
    if (shooting || e.dist < P.fortR) near++
  }
  const hurtByMech = bb.t - bb.tHurt < 2 && bb.lastHurtBy >= 0 && bb.lastHurtBy < 100
  if (near > 0 || hurtByMech || bb.sounds.movementNear(1.5)) st.lastPurT = bb.t

  if (!st.on) {
    if (bb.t < P.fortFrom || bb.t < st.retryT) return false
    if (P.fortLaser > 0 && !bb.haveLaser) return false
    const again = st.nTrig === 0 || near > 0
    const trig =
      (P.fortOnUs > 0 && onUs >= P.fortOnUs) ||
      (P.fortHp > 0 && bb.hpFrac < P.fortHp && near >= 2) ||
      (P.fortT < 999 && bb.t >= P.fortT && again) ||
      (P.fortKills > 0 && kills >= P.fortKills && again)
    if (!trig) return false
    if (!pickRoof(bb, mv, st, cat, onUs)) {
      st.retryT = bb.t + 5
      return false
    }
    st.on = true
    st.tOn = bb.t
    st.nTrig++
    if (st.trigT < 0) {
      st.trigT = bb.t
      st.trigD = st.travelD
    }
    st.fails = 0
    st.lastPurT = bb.t
  }

  // zone: relocate before the circle leaves the spot (plan early)
  let ci = st.ci
  if (bb.zone.marginAt(cat.x[ci]!, cat.y[ci]!, bb.t + P.fortRelocS) < 5) {
    st.why = "zone"
    // loop guard: two relocations within 3 s -> give the fortress up for a while
    if (bb.t - st.relocT < 3) {
      release(st, bb.t, 20)
      return false
    }
    st.relocT = bb.t
    // relocation (late circles hold few big roofs): accept 60 % of the safe radius / zone margin
    if (!pickRoof(bb, mv, st, cat, onUs, 0.6)) {
      release(st, bb.t, 20)
      return false
    }
    st.nReloc++
    ci = st.ci
  }
  const onRoof = onSurface(cat, bb.x, bb.y, bb.z, st.clId)

  if (!onRoof) {
    // travel (jets allowed under fire); give the roof up when it does not work out
    const sx = cat.x[ci]!, sy = cat.y[ci]!, sz = cat.z[ci]!
    const late = bb.t - st.travelT0 > st.travelD / 7 + 20
    const noPath = mv.unreachable && bb.t - st.travelT0 > 1.5
    if (late || noPath || bb.isBadGoal(sx, sy)) {
      st.why = late ? "late" : noPath ? "nopath" : "badgoal"
      if (st.bad) st.bad[st.clId] = bb.t + 90
      if (++st.fails >= 3 || !pickRoof(bb, mv, st, cat, onUs)) {
        release(st, bb.t, 30)
        return false
      }
      ci = st.ci
    }
    st.arrT = -1
    const gx = cat.x[ci]!, gy = cat.y[ci]!, gz = cat.z[ci]!
    const need = mv.nav ? mv.nav.jetEnergy(cat.h[ci]!) : 40
    const d = Math.hypot(gx - bb.x, gy - bb.y)
    it.goto(gx, gy, gz, d > 25 && bb.energy > need + 25 ? PACE_BOOST : PACE_WALK, "fortGo")
    it.arrive = 2
    it.allowJet = true
    it.forceJet = true
    it.face = FACE_THREATS
    if (target) it.targetId = target.id
    return true
  }

  // ---- on the roof
  if (st.arrT < 0) {
    st.arrT = bb.t
    if (st.roofT < 0) st.roofT = bb.t
  }
  st.roofS += bb.dt
  st.fails = 0
  // knocked / stepped off: the travel clock starts from the last moment up here
  st.travelT0 = bb.t
  st.travelD = 30
  if (bb.t - st.lastPurT > P.fortQuietS && bb.t - st.arrT > P.fortQuietS) {
    st.why = "quiet"
    release(st, bb.t, 0)
    return false
  }
  // shoot: a mech with a line first (arrivals), else pickTarget's choice
  let tg = target
  if (!tg || bb.los[tg.id] !== 1) {
    let bd = 1e9
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      if (bb.los[e.id] === 1 && e.dist < bd) {
        bd = e.dist
        tg = e
      }
    }
  }
  let anyLine = false, closeLine = false
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (bb.los[e.id] !== 1) continue
    anyLine = true
    if (e.dist < 45) closeLine = true
  }
  // spot: re-chosen every 0.5 s while far shooters have a line, every 2 s otherwise; never while fighting an arrival
  if (!closeLine && bb.t - st.spotT > (anyLine || bb.t - bb.tHurt < 2 ? 0.5 : 2)) {
    st.spotT = bb.t
    chooseSpot(bb, mv, cat, st, ph)
    ci = st.ci
  }

  // peek-snipe: laser ready, nobody with a line on us, a visible ground mech in laser range without a line
  if (P.fortPeek > 0 && bb.las && bb.lasSlot >= 0) {
    const las = bb.las
    if (st.peekOn) {
      const e = bb.tracker.get(st.peekTgt)
      const fired = bb.t - st.peekT0 > 0.4 && las.cooldown > 0.05 && (las.charge ?? 0) <= 0
      if (fired || bb.t - st.peekT0 > 4 || !e || !e.visible || e.dead || (bb.t - bb.tHurt < 0.3 && bb.t - st.peekT0 > 1.5)) {
        st.peekOn = false
        st.peekNext = bb.t + 2
      } else {
        if (bb.los[e.id] === 1) it.hold(bb.x, bb.y, bb.z, "fortPk")
        else it.goto(st.peekX, st.peekY, st.peekZ, PACE_WALK, "fortPk")
        it.arrive = 0.8
        it.stayUp = true
        it.allowJet = false
        it.targetId = e.id
        it.face = FACE_THREATS
        return true
      }
    } else if (bb.t >= st.peekNext && !anyLine && las.cooldown <= 0.05 && bb.t - bb.tHurt > 1) {
      let pe: Track | null = null
      let bd = P.fortPeek
      for (let i = 0; i < bb.nEn; i++) {
        const e = bb.en[i]
        if (e.dist >= bd || e.dist > P.laserMaxDist || e.z > bb.z - 5) continue
        bd = e.dist
        pe = e
      }
      if (pe && findPeek(bb, cat, st, pe)) {
        st.peekOn = true
        st.peekT0 = bb.t
        st.peekTgt = pe.id
        st.peeks++
        it.goto(st.peekX, st.peekY, st.peekZ, PACE_WALK, "fortPk")
        it.arrive = 0.8
        it.stayUp = true
        it.allowJet = false
        it.targetId = pe.id
        it.face = FACE_THREATS
        return true
      }
    }
  }

  // cubes on our roof (kills up here drop them here)
  if (P.fortCubeDist > 0 && !anyLine) {
    const items = bb.loot.items
    let cube = null
    let cd = P.fortCubeDist
    for (let i = 0; i < items.length; i++) {
      const c = items[i]
      if (c.type !== L_CUBE || c.badUntil > bb.t) continue
      const d = Math.hypot(c.x - bb.x, c.y - bb.y)
      if (d >= cd || !onSurface(cat, c.x, c.y, c.z, st.clId)) continue
      cd = d
      cube = c
    }
    if (cube) {
      it.goto(cube.x, cube.y, cube.z, PACE_WALK, "fortCube")
      it.arrive = 0.6
      it.stayUp = true
      it.allowJet = false
      it.face = FACE_THREATS
      if (tg) it.targetId = tg.id
      return true
    }
  }

  const sx = cat.x[ci]!, sy = cat.y[ci]!, sz = cat.z[ci]!
  // within 2.5 m of the spot: hold where we stand (a 4 m cell centre may sit closer to a wall than the body allows)
  if (Math.hypot(sx - bb.x, sy - bb.y) > 2.5) {
    it.goto(sx, sy, sz, PACE_WALK, "fortMv")
    it.arrive = 2
  } else {
    if (st.holdT < 0 || Math.hypot(st.holdX - sx, st.holdY - sy) > 3) {
      st.holdX = bb.x
      st.holdY = bb.y
      st.holdZ = bb.z
      st.holdT = bb.t
    }
    it.hold(st.holdX, st.holdY, st.holdZ, "fort")
    it.arrive = 1.2
  }
  it.stayUp = true
  it.allowJet = false
  if (tg) {
    it.targetId = tg.id
    it.face = FACE_THREATS
  } else {
    // face the side the pursuers were last seen on
    let bd = 1e9, by = 0
    const trs = bb.tracker.mechs
    for (let i = 0; i < trs.length; i++) {
      const e = trs[i]
      if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > 20) continue
      if (e.dist < bd) {
        bd = e.dist
        by = Math.atan2(e.y - bb.y, e.x - bb.x)
      }
    }
    if (bd < 1e9 && bb.t - bb.tHurt > 1.5) {
      it.face = FACE_YAW
      it.faceYaw = by + 0.6 * Math.sin(bb.t * 1.3)
    } else it.face = bb.t - bb.tHurt < 1.5 ? FACE_THREATS : FACE_SCAN
  }
  return true
}
