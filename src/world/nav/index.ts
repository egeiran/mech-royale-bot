/**
 * Pathfinding and steering on the World raster. See README.md.
 *
 * createNav(world, mech?) -> NavEx (implements the Nav contract plus strategy-layer extras).
 * The graph and all search scratch are shared per (world, params): 16 bots in one process share one instance.
 * Everything is synchronous; returned scratch views (reachableFrom mask) are valid until the next call.
 */
import type { Nav, NavPath, NavQuery, Steer, World } from "../../contracts.ts"
import { buildGraph, CLR_Q, DEFAULT_PARAMS, DX, DY, E_DROP, E_JET, E_WALK, K_TOP, tierFor, type Graph, type MechNavParams } from "./graph.ts"

export { DEFAULT_PARAMS, navParamsFromMech, type Graph, type MechNavParams } from "./graph.ts"

/** how waypoint i is reached from waypoint i-1 */
export const WP_WALK = 0
export const WP_DROP = 1
export const WP_JET = 2

export interface NavPathEx extends NavPath {
  /** kinds[i] = WP_WALK | WP_DROP | WP_JET: how waypoint i is reached from waypoint i-1 */
  kinds: Uint8Array
  /** body the path was planned for */
  radius: number
  height: number
  /** bumped every time this (pooled) object is refilled */
  serial: number
  /** A* expansions used */
  expansions: number
}

export interface NavQueryEx extends NavQuery {
  /** a follower from newFollower(): jet edges it failed to climb are not used again by this plan */
  avoid?: object
}

export interface Reach {
  /** mask[node] = 1 when reachable; reused buffer, valid until the next reachableFrom call */
  mask: Uint8Array
  count: number
}

export interface FollowerInfo {
  /** index of the waypoint being steered at */
  idx: number
  /** within arrival distance of the last waypoint */
  done: boolean
  /** running a recovery manoeuvre (sidestep / jump / jet) */
  recovering: boolean
  /** waiting for energy at the foot of a jet edge */
  waiting: boolean
}

export interface NavEx extends Nav {
  readonly params: MechNavParams
  readonly graph: Graph
  /** like Nav.plan; `out` (a path from an earlier plan) is refilled instead of taking one from the pool */
  plan(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, q: NavQueryEx, out?: NavPath): NavPathEx | null
  /** hand a path back to the pool (optional; never use it afterwards) */
  releasePath(p: NavPath): void
  followerInfo(state: object): FollowerInfo
  /** node whose column contains (x, y): the highest surface at or below z (+1.5 m), else the lowest one. No validity check. */
  nearestNode(x: number, y: number, z: number): number
  /** nearest node a body of this size can stand on, within 8 m; -1 when none */
  nearestValidNode(x: number, y: number, z: number, q: NavQuery): number
  nodeSurfaceZ(node: number): number
  nodeX(node: number): number
  nodeY(node: number): number
  /** metres to the nearest wall for the base body at this point (capped at ~7) */
  clearanceAt(x: number, y: number, z: number): number
  /** directed flood from a point: walk + drop edges, plus jets when q.allowJet (limited by q.energy). null when off-grid. */
  reachableFrom(x: number, y: number, z: number, q: NavQuery): Reach | null
  /** component id per node over two-way walkable links (no jets), -1 for unusable nodes. Cached per body size. */
  components(q: NavQuery): Int32Array
  /** component id of the point (-1 when off-grid): equal ids = mutually reachable on foot */
  componentAt(x: number, y: number, z: number, q: NavQuery): number
  /** prism-top nodes more than 3 m above the terrain within r of (x, y); writes ids into out, returns the count */
  roofNodesNear(x: number, y: number, r: number, out: Int32Array): number
  /** estimated energy to climb dz with jump + jets */
  jetEnergy(dz: number): number
}

const cache = new WeakMap<World, Map<string, NavEx>>()

export function createNav(world: World, mech?: Partial<MechNavParams>): NavEx {
  const P: MechNavParams = { ...DEFAULT_PARAMS }
  if (mech) for (const k of Object.keys(mech) as (keyof MechNavParams)[]) if (typeof mech[k] === "number" && Number.isFinite(mech[k])) P[k] = mech[k]!
  const key = JSON.stringify(P)
  let m = cache.get(world)
  if (!m) cache.set(world, (m = new Map()))
  let nav = m.get(key)
  if (!nav) m.set(key, (nav = makeNav(world, P)))
  return nav
}

class Follower {
  path: NavPath | null = null
  serial = -1
  idx = 0
  bestDist = Infinity
  since = 0
  wait = 0
  jetTries = 0
  wasAir = false
  /** ticks hovering at rim height without horizontal progress */
  stall = 0
  lastX = 0
  lastY = 0
  /** rim nodes of jet edges that failed (ring buffer), see NavQueryEx.avoid */
  bad = new Int32Array(8).fill(-1)
  nbad = 0
  done = false
  recovering = false
  waiting = false
}

// direction index for (dI+1) + 3*(dJ+1)
const DIRLUT = new Int8Array(9)
for (let d = 0; d < 8; d++) DIRLUT[DX[d]! + 1 + 3 * (DY[d]! + 1)] = d
DIRLUT[4] = -1

const P_WALK = 1
const P_ADROP = 2
const P_AJET = 3
const P_XDROP = 4
const P_XJET = 5

function makeNav(world: World, P: MechNavParams): NavEx {
  const G = buildGraph(world, P)
  const { cs, gnx, gny, minX, minY, n: N, colStart, nz, nI, nJ, kind, roof, clr, nbr, nbrType, xStart, xTo, xType, xLen, xClr } = G

  // ---- search scratch (shared, synchronous use only)
  const gS = new Float32Array(N)
  const fS = new Float32Array(N)
  const parent = new Int32Array(N)
  const pedge = new Uint8Array(N)
  const stamp = new Uint32Array(N)
  const hpos = new Int32Array(N)
  const heap = new Int32Array(N)
  let gen = 0
  let hn = 0
  const CHAIN = 16384
  const chain = new Int32Array(CHAIN)
  const cedge = new Uint8Array(CHAIN)
  const WPCAP = 2048
  const wp = new Float32Array(WPCAP * 3)
  const wpk = new Uint8Array(WPCAP)
  let nwp = 0
  const pool: NavPathEx[] = []
  let serial = 0
  const mask = new Uint8Array(N)
  const queue = new Int32Array(N)
  const reach: Reach = { mask, count: 0 }
  const compCache = new Map<number, Int32Array>()

  // ---- per-query state
  let off = 0
  let thr = 0
  const maxThr = Math.floor((7.5 - 0.5) * CLR_Q) - 4
  function setBody(radius: number, height: number): void {
    const scale = Math.max(radius / P.radius, height / P.height)
    off = tierFor(scale) * N
    thr = Math.min(maxThr, Math.max(0, Math.ceil((radius - P.clearanceSlack) * CLR_Q)))
  }

  const colI = (x: number): number => {
    const I = Math.floor((x - minX - 0.5) / cs + 0.5)
    return I < 0 ? 0 : I >= gnx ? gnx - 1 : I
  }
  const colJ = (y: number): number => {
    const J = Math.floor((y - minY - 0.5) / cs + 0.5)
    return J < 0 ? 0 : J >= gny ? gny - 1 : J
  }
  const nodeX = (u: number): number => minX + nI[u]! * cs + 0.5
  const nodeY = (u: number): number => minY + nJ[u]! * cs + 0.5

  function nearestNode(x: number, y: number, z: number): number {
    const col = colJ(y) * gnx + colI(x)
    const s = colStart[col]!
    for (let v = colStart[col + 1]! - 1; v >= s; v--) if (nz[v]! <= z + 1.5) return v
    return s
  }

  /** nearest usable node (clearance >= thrS) around a point; prefers surfaces at or below z */
  function snap(x: number, y: number, z: number, thrS: number): number {
    const I0 = colI(x)
    const J0 = colJ(y)
    let best = -1
    let bestC = 1e30
    const R = Math.ceil(8 / cs)
    for (let J = Math.max(0, J0 - R); J <= Math.min(gny - 1, J0 + R); J++) {
      const dy = minY + J * cs + 0.5 - y
      for (let I = Math.max(0, I0 - R); I <= Math.min(gnx - 1, I0 + R); I++) {
        const dx = minX + I * cs + 0.5 - x
        const d2 = dx * dx + dy * dy
        if (d2 >= bestC) continue
        const col = J * gnx + I
        for (let v = colStart[col]!, e = colStart[col + 1]!; v < e; v++) {
          const dz = nz[v]! - z
          if (dz > 2.5) break
          if (clr[off + v]! < thrS) continue
          const c = d2 + (dz < 0 ? 0.09 : 1) * dz * dz
          if (c < bestC) {
            bestC = c
            best = v
          }
        }
      }
    }
    return best
  }

  /** neighbour of u in direction (dI, dJ) when it is walk/drop-connected with clearance >= thrL, else -1 */
  function stepTo(u: number, dI: number, dJ: number, thrL: number): number {
    if (dI > 1 || dI < -1 || dJ > 1 || dJ < -1) return -1
    const e = u * 8 + DIRLUT[dI + 1 + 3 * (dJ + 1)]!
    const v = nbr[e]!
    if (v < 0 || nbrType[e] === E_JET || clr[off + v]! < thrL) return -1
    return v
  }

  /**
   * Walk the graph along the segment from node u (whose column contains a) to b. Returns the node reached,
   * or -1 when a column on the way is not walk/drop-connected or lacks clearance thrL.
   */
  function lineWalk(u: number, ax: number, ay: number, bx: number, by: number, thrL: number): number {
    const dx = bx - ax
    const dy = by - ay
    const len = Math.sqrt(dx * dx + dy * dy)
    const steps = Math.ceil(len / (cs * 0.45))
    let cI = nI[u]!
    let cJ = nJ[u]!
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      let I = colI(ax + dx * t)
      let J = colJ(ay + dy * t)
      if (I === cI && J === cJ) continue
      let v = stepTo(u, I - cI, J - cJ, thrL)
      if (v < 0) {
        // the line may only clip the corner of that column: accept when the next sample is a direct (diagonal) neighbour
        if (s === steps) return -1
        s++
        const t2 = s / steps
        I = colI(ax + dx * t2)
        J = colJ(ay + dy * t2)
        if (I === cI && J === cJ) return -1
        v = stepTo(u, I - cI, J - cJ, thrL)
        if (v < 0) return -1
      }
      u = v
      cI = I
      cJ = J
    }
    return u
  }

  function walkClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): boolean {
    setBody(radius, (radius * P.height) / P.radius)
    const u = nearestNode(ax, ay, az)
    if (nz[u]! > az + 3) return false
    const e = lineWalk(u, ax, ay, bx, by, thr)
    return e >= 0 && Math.abs(nz[e]! - bz) <= 2.5
  }

  // ---- heap (min on fS)
  function hup(v: number): void {
    let i = hpos[v]!
    const fv = fS[v]!
    while (i > 0) {
      const pi = (i - 1) >> 1
      const pv = heap[pi]!
      if (fS[pv]! <= fv) break
      heap[i] = pv
      hpos[pv] = i
      i = pi
    }
    heap[i] = v
    hpos[v] = i
  }
  function hpop(): number {
    const top = heap[0]!
    hn--
    if (hn > 0) {
      const v = heap[hn]!
      const fv = fS[v]!
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= hn) break
        if (c + 1 < hn && fS[heap[c + 1]!]! < fS[heap[c]!]!) c++
        const cv = heap[c]!
        if (fS[cv]! >= fv) break
        heap[i] = cv
        hpos[cv] = i
        i = c
      }
      heap[i] = v
      hpos[v] = i
    }
    hpos[top] = -1
    return top
  }

  const jumpFree = ((P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity)) * 0.8
  function jetEnergy(dz: number): number {
    if (dz <= jumpFree * 0.9) return 0
    return P.jetEnergyBase + P.jetEnergyPerM * (dz - jumpFree)
  }
  function maxJetDz(q: NavQuery): number {
    if (!q.allowJet) return -1
    const e = q.energy * 0.9
    if (e < P.jetEnergyBase) return jumpFree * 0.9
    return Math.min(P.maxClimb, (e - P.jetEnergyBase) / P.jetEnergyPerM + jumpFree)
  }

  function emit(x: number, y: number, z: number, k: number): void {
    if (nwp >= WPCAP) return
    wp[nwp * 3] = x
    wp[nwp * 3 + 1] = y
    wp[nwp * 3 + 2] = z
    wpk[nwp] = k
    nwp++
  }
  const emitNode = (u: number, k: number): void => emit(nodeX(u), nodeY(u), nz[u]!, k)

  function plan(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, q: NavQueryEx, out?: NavPath): NavPathEx | null {
    setBody(q.radius, q.height)
    const start = snap(sx, sy, sz, thr)
    if (start < 0) return null
    let goal = snap(gx, gy, gz, thr)
    let maxExp = q.maxExpansions ?? P.maxExpansions
    let goalValid = true
    if (goal < 0) {
      // goal is not standable: aim at its column, with a reduced budget (it can only end as "closest")
      goal = nearestNode(gx, gy, gz)
      goalValid = false
      maxExp = Math.min(maxExp, 8000)
    }
    const gI = nI[goal]!
    const gJ = nJ[goal]!
    const axisT = cs / P.walkSpeed
    const diagT = axisT * Math.SQRT2
    const vertT = 0.5 / P.walkSpeed
    const hk = axisT * P.heuristicWeight
    const mjz = maxJetDz(q)
    const soft = thr + 24
    const grav = P.gravity
    const invWalk = 1 / P.walkSpeed
    const invRise = 1 / P.maxRiseSpeed
    const eCost = P.jetEnergyCost
    const avoid = (q as NavQueryEx).avoid as Follower | undefined
    const bad = avoid && avoid.nbad > 0 ? avoid.bad : null
    const thrJet = thr + 8

    gen++
    if (gen >= 0xffffffff) {
      stamp.fill(0)
      gen = 1
    }
    hn = 0
    let hdx = nI[start]! - gI
    let hdy = nJ[start]! - gJ
    if (hdx < 0) hdx = -hdx
    if (hdy < 0) hdy = -hdy
    let h0 = (hdx > hdy ? hdx + 0.4142 * hdy : hdy + 0.4142 * hdx) * hk
    stamp[start] = gen
    gS[start] = 0
    fS[start] = h0
    parent[start] = -1
    pedge[start] = 0
    heap[0] = start
    hpos[start] = 0
    hn = 1
    let best = start
    let bestH = h0
    let found = false
    let exp = 0
    while (hn > 0) {
      const u = hpop()
      if (u === goal && goalValid) {
        found = true
        break
      }
      const gu = gS[u]!
      const hu = fS[u]! - gu
      if (hu < bestH) {
        bestH = hu
        best = u
      }
      if (++exp > maxExp) break
      const zu = nz[u]!
      const e0 = u * 8
      const x0 = xStart[u]!
      const x1 = xStart[u + 1]!
      const ne = 8 + x1 - x0
      for (let k = 0; k < ne; k++) {
        let v: number
        let c: number
        let pe: number
        if (k < 8) {
          v = nbr[e0 + k]!
          if (v < 0) continue
          const cv = clr[off + v]!
          if (cv < thr) continue
          const t = nbrType[e0 + k]!
          const dz = nz[v]! - zu
          const base = (k & 1) === 1 ? diagT : axisT
          if (t === E_WALK) {
            c = base + (dz < 0 ? -dz : dz) * vertT
            pe = P_WALK
          } else if (t === E_DROP) {
            c = base + 0.5 * Math.sqrt((-2 * dz) / grav)
            pe = P_ADROP
          } else {
            if (dz > mjz) continue
            if (bad !== null && bad.indexOf(v) >= 0) continue
            c = base + 0.4 + dz * invRise + jetEnergy(dz) * eCost
            pe = P_AJET
          }
          if (cv < soft) c *= 1 + (0.6 * (soft - cv)) / 24
        } else {
          const e = x0 + k - 8
          v = xTo[e]!
          const cv = clr[off + v]!
          if (cv < thr || xClr[e]! < thr) continue
          const dz = nz[v]! - zu
          if (xType[e] === E_DROP) {
            c = xLen[e]! * invWalk + 0.5 * Math.sqrt((-2 * dz) / grav)
            pe = P_XDROP
          } else {
            if (dz > mjz || xClr[e]! < thrJet) continue
            if (bad !== null && bad.indexOf(v) >= 0) continue
            c = xLen[e]! * invWalk + 0.5 + dz * invRise + jetEnergy(dz) * eCost
            pe = P_XJET
          }
        }
        const ng = gu + c
        if (stamp[v] !== gen) {
          stamp[v] = gen
          let ddx = nI[v]! - gI
          let ddy = nJ[v]! - gJ
          if (ddx < 0) ddx = -ddx
          if (ddy < 0) ddy = -ddy
          gS[v] = ng
          fS[v] = ng + (ddx > ddy ? ddx + 0.4142 * ddy : ddy + 0.4142 * ddx) * hk
          parent[v] = u
          pedge[v] = pe
          hpos[v] = hn++
          hup(v)
        } else if (ng < gS[v]! && hpos[v]! >= 0) {
          fS[v] = fS[v]! - gS[v]! + ng
          gS[v] = ng
          parent[v] = u
          pedge[v] = pe
          hup(v)
        }
      }
    }
    let target = found ? goal : best
    let complete = found
    // chain start..target
    let count = 1
    for (let v = target; v !== start; v = parent[v]!) count++
    while (count > CHAIN) {
      target = parent[target]!
      count--
      complete = false
    }
    // refill the chain and sum the plain travel time (the search cost also carries wall and energy penalties)
    let time = 0
    for (let i = count - 1, v = target; i >= 0; i--) {
      chain[i] = v
      const pe = pedge[v]!
      cedge[i] = pe
      if (i > 0) {
        const u = parent[v]!
        const dz = nz[v]! - nz[u]!
        const hl = cs * Math.hypot(nI[v]! - nI[u]!, nJ[v]! - nJ[u]!)
        if (pe === P_WALK) time += Math.sqrt(hl * hl + dz * dz) * invWalk
        else if (pe === P_ADROP || pe === P_XDROP) time += Math.max(hl * invWalk, Math.sqrt((-2 * dz) / grav))
        else time += hl * invWalk + 0.3 + dz * invRise
        v = u
      }
    }
    // waypoints: string-pull walk runs, keep jet/long-drop edges explicit
    nwp = 0
    emitNode(chain[0]!, WP_WALK)
    const thrL = thr + 8
    let i = 0
    while (i < count - 1) {
      const e = cedge[i + 1]!
      if (e === P_WALK || e === P_ADROP) {
        let j = i + 1
        while (j + 1 < count && (cedge[j + 1] === P_WALK || cedge[j + 1] === P_ADROP)) j++
        let a = i
        while (a < j) {
          const ua = chain[a]!
          const ax = nodeX(ua)
          const ay = nodeY(ua)
          let lo = a + 1
          let step = 2
          let hi = -1
          while (lo < j) {
            const pr = Math.min(j, lo + step)
            const up = chain[pr]!
            if (lineWalk(ua, ax, ay, nodeX(up), nodeY(up), thrL) === up) {
              lo = pr
              step *= 2
            } else {
              hi = pr
              break
            }
          }
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1
            const um = chain[mid]!
            if (lineWalk(ua, ax, ay, nodeX(um), nodeY(um), thrL) === um) lo = mid
            else hi = mid
          }
          emitNode(chain[lo]!, WP_WALK)
          a = lo
        }
        i = j
      } else {
        emitNode(chain[i + 1]!, e === P_XDROP ? WP_DROP : WP_JET)
        i++
      }
    }
    if (complete && nwp > 0 && colI(gx) === gI && colJ(gy) === gJ) {
      // the goal lies in the reached column: finish exactly on it
      const o = (nwp - 1) * 3
      if (nwp === 1) emit(gx, gy, nz[goal]!, WP_WALK)
      else {
        wp[o] = gx
        wp[o + 1] = gy
      }
    }

    let p = out as NavPathEx | undefined
    if (!p) p = pool.pop()
    if (!p) p = { pts: new Float32Array(96), kinds: new Uint8Array(32), n: 0, complete: false, cost: 0, radius: 0, height: 0, serial: 0, expansions: 0 }
    if (!p.kinds || p.kinds.length < nwp || p.pts.length < nwp * 3) {
      const capN = Math.max(32, nwp * 2)
      p.pts = new Float32Array(capN * 3)
      p.kinds = new Uint8Array(capN)
    }
    p.pts.set(wp.subarray(0, nwp * 3))
    p.kinds.set(wpk.subarray(0, nwp))
    p.n = nwp
    p.complete = complete
    p.cost = time
    p.radius = q.radius
    p.height = q.height
    p.serial = ++serial
    p.expansions = exp
    return p
  }

  function releasePath(p: NavPath): void {
    const e = p as NavPathEx
    if (e.kinds && pool.length < 64 && pool.indexOf(e) < 0) pool.push(e)
  }

  // ---- steering
  const stuckTicks = Math.max(3, Math.round(1.0 / P.dt))
  const stageTicks = Math.max(2, Math.round(0.4 / P.dt))
  const waitTicks = Math.round(8 / P.dt)

  const stallTicks = Math.max(3, Math.round(0.5 / P.dt))

  function markBad(f: Follower, x: number, y: number, z: number): void {
    const u = nearestNode(x, y, z)
    if (f.bad.indexOf(u) >= 0) return
    f.bad[f.nbad % f.bad.length] = u
    f.nbad++
  }

  function kindOf(path: NavPath, i: number): number {
    const k = (path as NavPathEx).kinds
    if (k) return k[i]!
    if (i === 0) return WP_WALK
    const dz = path.pts[i * 3 + 2]! - path.pts[i * 3 - 1]!
    return dz > P.stepUp * 2 ? WP_JET : dz < -P.stepUp * 2 ? WP_DROP : WP_WALK
  }

  function steer(state: object, path: NavPath, x: number, y: number, z: number, vx: number, vy: number, vz: number, grounded: boolean, energy: number, out: Steer): void {
    const f = state as Follower
    out.mx = 0
    out.my = 0
    out.jump = false
    out.boost = false
    out.stuck = false
    const n = path ? path.n : 0
    if (n <= 0) return
    const ex = path as Partial<NavPathEx>
    const ser = ex.serial ?? 0
    if (f.path !== path || f.serial !== ser) {
      f.path = path
      f.serial = ser
      f.idx = 0
      f.bestDist = Infinity
      f.since = 0
      f.wait = 0
      f.jetTries = 0
      f.wasAir = false
      f.stall = 0
    }
    f.done = false
    f.recovering = false
    f.waiting = false
    setBody(ex.radius ?? P.radius, ex.height ?? P.height)
    const pts = path.pts
    const stepUp = P.stepUp
    const thrL = thr + 8
    let here = -1
    let i = f.idx
    if (i >= n) i = f.idx = n - 1
    let k = WP_WALK
    let tx = 0
    let ty = 0
    let tz = 0
    let dxy = 0
    for (let it = 0; it < 6; it++) {
      i = f.idx
      k = kindOf(path, i)
      tx = pts[i * 3]!
      ty = pts[i * 3 + 1]!
      tz = pts[i * 3 + 2]!
      dxy = Math.hypot(tx - x, ty - y)
      const onLevel = grounded && z >= tz - stepUp
      if (k === WP_JET && !onLevel) break
      if (i === n - 1) break
      const dzt = z - tz
      // a jet edge is done as soon as we stand on the roof (never walk back to the rim node: it is on the edge)
      if ((k === WP_JET && dzt < 3) || (dxy < (k === WP_DROP ? 2.5 : 1.3) && dzt < 3 && dzt > -2.5)) {
        f.idx++
        f.bestDist = Infinity
        f.since = 0
        f.wait = 0
        f.jetTries = 0
        f.wasAir = false
        continue
      }
      if (kindOf(path, i + 1) === WP_WALK && grounded && (k !== WP_DROP || dzt < 2)) {
        if (here < 0) here = nearestNode(x, y, z)
        // only when we really stand on that node's surface (on a roof edge the column under us may be the ground)
        if (Math.abs(nz[here]! - z) <= 2) {
          const bx = pts[i * 3 + 3]!
          const by = pts[i * 3 + 4]!
          const e = lineWalk(here, x, y, bx, by, thrL)
          if (e >= 0 && nI[e] === colI(bx) && nJ[e] === colJ(by) && Math.abs(nz[e]! - pts[i * 3 + 5]!) < 1.5) {
            f.idx++
            f.bestDist = Infinity
            f.since = 0
            continue
          }
        }
      }
      break
    }
    let dirx = dxy > 1e-6 ? (tx - x) / dxy : 0
    let diry = dxy > 1e-6 ? (ty - y) / dxy : 0

    if (k === WP_JET && !(grounded && z >= tz - stepUp)) {
      // ---- jet edge: S = waypoint i-1 (foot), R = waypoint i (rim)
      if (grounded) {
        if (f.wasAir) {
          f.jetTries++
          f.wasAir = false
        }
        f.stall = 0
        if (f.jetTries >= 2) {
          markBad(f, tx, ty, tz)
          out.stuck = true
        }
        const sxp = i > 0 ? pts[i * 3 - 3]! : x
        const syp = i > 0 ? pts[i * 3 - 2]! : y
        const dS = Math.hypot(sxp - x, syp - y)
        if (dS > 3 && dxy > Math.hypot(tx - sxp, ty - syp) + 1) {
          // wandered away from the foot: walk back to it
          out.mx = (sxp - x) / dS
          out.my = (syp - y) / dS
          return
        }
        const need = Math.min(jetEnergy(tz - z) + 3, P.maxEnergy * 0.97)
        if (energy < need) {
          f.waiting = true
          if (++f.wait > waitTicks) out.stuck = true
          return
        }
        out.jump = true
        out.boost = true
        out.mx = dirx
        out.my = diry
        return
      }
      f.wasAir = true
      // climb, then hold a little above the rim while drifting onto it
      const above = z > tz - 0.1
      if (above && world.floorZ(x, y, z + 0.5, 0) >= tz - stepUp) {
        // centre is over the roof: cut the jets and land, braking so we do not overshoot the rim node
        const m = dxy < 3 ? Math.max(0.2, dxy / 3) : 1
        out.mx = dirx * m
        out.my = diry * m
        f.stall = 0
        return
      }
      out.boost = z + vz * 0.3 < tz + 0.8
      if (above) {
        const moved = Math.hypot(x - f.lastX, y - f.lastY)
        if (moved < 0.03) f.stall++
        else if (f.stall > 0 && moved > 0.15) f.stall = 0
      }
      f.lastX = x
      f.lastY = y
      if (f.stall >= stallTicks) {
        // held at rim height by something beside the rim: try both sides, then give the edge up
        const s = f.stall - stallTicks
        const side = s < stageTicks ? 1 : s < 3 * stageTicks ? -1 : 0
        if (side === 0) {
          markBad(f, tx, ty, tz)
          out.stuck = true
          out.boost = false
        } else {
          f.recovering = true
          const px = -diry * side
          const py = dirx * side
          dirx = px * 0.9 + dirx * 0.4
          diry = py * 0.9 + diry * 0.4
          const l = Math.hypot(dirx, diry)
          dirx /= l
          diry /= l
        }
      }
      out.mx = dirx
      out.my = diry
      return
    }

    // ---- walk / drop
    let sp = 1
    if (i === n - 1) {
      if (dxy < 0.35) {
        f.done = true
        f.since = 0
        return
      }
      if (dxy < 1.5) sp = dxy / 1.5
    }
    if (k === WP_DROP && z - tz > 2.5) {
      // long drop: leave the rim (and steer in the air) at the speed that lands near the planned spot, not beyond it
      const h = z - tz
      const tf = grounded ? Math.sqrt((2 * h) / P.gravity) : (vz + Math.sqrt(vz * vz + 2 * P.gravity * h)) / P.gravity
      const want = (dxy - (grounded ? 1 : 0)) / (Math.max(0.1, tf) * P.walkSpeed)
      sp = want > 1 ? 1 : want < (grounded ? 0.3 : 0) ? (grounded ? 0.3 : 0) : want
    }
    if (grounded) {
      // wall-avoidance nudge along the clearance gradient
      if (here < 0) here = nearestNode(x, y, z)
      const c = clr[off + here]!
      const band = thr + 16
      if (c < band && Math.abs(nz[here]! - z) <= 1.5) {
        let gx = 0
        let gy = 0
        for (let d = 0; d < 8; d++) {
          const v = nbr[here * 8 + d]!
          const cv = v < 0 || nbrType[here * 8 + d] === E_JET ? 0 : clr[off + v]!
          const w = (d & 1) === 1 ? 0.7071 : 1
          gx += DX[d]! * w * (cv - c)
          gy += DY[d]! * w * (cv - c)
        }
        const gl = Math.hypot(gx, gy)
        if (gl > 1e-6) {
          const w = Math.min(0.8, (0.7 * (band - c)) / 16)
          dirx += (gx / gl) * w
          diry += (gy / gl) * w
          const l = Math.hypot(dirx, diry)
          if (l > 1e-6) {
            dirx /= l
            diry /= l
          }
        }
      }
    }
    // stuck watchdog
    if (dxy < f.bestDist - 0.25) {
      f.bestDist = dxy
      f.since = 0
    } else f.since++
    if (f.since >= stuckTicks) {
      const s = f.since - stuckTicks
      const stage = Math.floor(s / stageTicks)
      const px = -diry
      const py = dirx
      f.recovering = true
      if (stage === 0) {
        dirx = px * 0.9 + dirx * 0.35
        diry = py * 0.9 + diry * 0.35
      } else if (stage === 1 || stage === 2) {
        dirx = -px * 0.9 + dirx * 0.35
        diry = -py * 0.9 + diry * 0.35
      } else if (stage === 3) {
        out.jump = grounded
      } else if (stage === 4 || stage === 5) {
        out.jump = grounded
        out.boost = !grounded || s % stageTicks === 0
      } else {
        out.stuck = true
        f.recovering = false
      }
      const l = Math.hypot(dirx, diry)
      if (l > 1) {
        dirx /= l
        diry /= l
      }
      sp = 1
    }
    if (!grounded && sp < 1 && !f.recovering) {
      // in the air the command is a velocity target reached slowly (air_accel): brake when already faster than wanted
      const vAlong = vx * dirx + vy * diry
      if (vAlong > sp * P.walkSpeed + 1) sp = 0
    }
    out.mx = dirx * sp
    out.my = diry * sp
  }

  function followerInfo(state: object): FollowerInfo {
    const f = state as Follower
    return { idx: f.idx, done: f.done, recovering: f.recovering, waiting: f.waiting }
  }

  // ---- extras
  function reachableFrom(x: number, y: number, z: number, q: NavQuery): Reach | null {
    setBody(q.radius, q.height)
    const s = snap(x, y, z, thr)
    if (s < 0) return null
    const mjz = maxJetDz(q)
    mask.fill(0)
    let qh = 0
    let qt = 0
    queue[qt++] = s
    mask[s] = 1
    while (qh < qt) {
      const u = queue[qh++]!
      const zu = nz[u]!
      for (let d = 0; d < 8; d++) {
        const v = nbr[u * 8 + d]!
        if (v < 0 || mask[v] === 1 || clr[off + v]! < thr) continue
        if (nbrType[u * 8 + d] === E_JET && nz[v]! - zu > mjz) continue
        mask[v] = 1
        queue[qt++] = v
      }
      for (let e = xStart[u]!, e1 = xStart[u + 1]!; e < e1; e++) {
        const v = xTo[e]!
        if (mask[v] === 1 || clr[off + v]! < thr || xClr[e]! < thr) continue
        if (xType[e] === E_JET && (nz[v]! - zu > mjz || xClr[e]! < thr + 8)) continue
        mask[v] = 1
        queue[qt++] = v
      }
    }
    reach.count = qt
    return reach
  }

  function components(q: NavQuery): Int32Array {
    setBody(q.radius, q.height)
    const key = off * 256 + thr
    let comp = compCache.get(key)
    if (comp) return comp
    if (compCache.size >= 6) compCache.clear()
    comp = new Int32Array(N).fill(-1)
    let id = 0
    for (let s0 = 0; s0 < N; s0++) {
      if (comp[s0] !== -1 || clr[off + s0]! < thr) continue
      let qh = 0
      let qt = 0
      queue[qt++] = s0
      comp[s0] = id
      while (qh < qt) {
        const u = queue[qh++]!
        for (let d = 0; d < 8; d++) {
          const v = nbr[u * 8 + d]!
          if (v < 0 || comp[v] !== -1 || clr[off + v]! < thr) continue
          if (nbrType[u * 8 + d] === E_JET) continue
          const back = v * 8 + ((d + 4) & 7)
          if (nbr[back] !== u || nbrType[back] === E_JET) continue
          comp[v] = id
          queue[qt++] = v
        }
      }
      id++
    }
    compCache.set(key, comp)
    return comp
  }

  function componentAt(x: number, y: number, z: number, q: NavQuery): number {
    const comp = components(q)
    const s = snap(x, y, z, thr)
    return s < 0 ? -1 : comp[s]!
  }

  function roofNodesNear(x: number, y: number, r: number, out: Int32Array): number {
    const R = Math.ceil(r / cs)
    const I0 = colI(x)
    const J0 = colJ(y)
    const r2 = r * r
    let cnt = 0
    for (let J = Math.max(0, J0 - R); J <= Math.min(gny - 1, J0 + R); J++) {
      const dy = minY + J * cs + 0.5 - y
      for (let I = Math.max(0, I0 - R); I <= Math.min(gnx - 1, I0 + R); I++) {
        const dx = minX + I * cs + 0.5 - x
        if (dx * dx + dy * dy > r2) continue
        const col = J * gnx + I
        for (let v = colStart[col]!, e = colStart[col + 1]!; v < e; v++) {
          if (kind[v] === K_TOP && roof[v] === 1) {
            if (cnt >= out.length) return cnt
            out[cnt++] = v
          }
        }
      }
    }
    return cnt
  }

  return {
    params: P,
    graph: G,
    plan,
    releasePath,
    steer,
    newFollower: () => new Follower(),
    followerInfo,
    walkClear,
    nearestNode,
    nearestValidNode(x, y, z, q) {
      setBody(q.radius, q.height)
      return snap(x, y, z, thr)
    },
    nodeSurfaceZ: (u) => nz[u]!,
    nodeX,
    nodeY,
    clearanceAt(x, y, z) {
      const u = nearestNode(x, y, z)
      const c = clr[u]!
      return c === 255 ? 7 : c / CLR_Q
    },
    reachableFrom,
    components,
    componentAt,
    roofNodesNear,
    jetEnergy,
  }
}
