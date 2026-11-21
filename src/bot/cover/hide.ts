/**
 * Hide-spot index and ranking on top of the exposure field.
 *
 * buildHideIndex() (startup, a few ms) collects candidate cells: local minima of exposure in a 5x5 cell window
 * (20 m) on each layer, with static features. bestHideSpots() scores the candidates inside a circle and writes
 * the best few into a preallocated HideSpots. No allocation per query; ~10-30 us for the whole map.
 *
 * Score = expected danger, lower is better (weights fitted on data/intel/ghost.md, section b):
 *   exposure (0..1)  + magnets (traffic)  + travel  + roof / jet penalties  + dead-end penalty  + zone centre pull
 *   + known enemies (line of sight now, or closer than 60 m), checked with rays for the best `refine` only.
 */
import type { NavQuery, World } from "../../contracts.ts"
import { CELL, F_ROOF, F_SKY, F_STAND, MECH_H, EYE_H, type ExposureField } from "./exposure.ts"

/** the subset of src/world/nav's NavEx this module needs (kept structural so cover does not import nav) */
export interface HideNav {
  nearestNode(x: number, y: number, z: number): number
  components(q: NavQuery): Int32Array
  componentAt(x: number, y: number, z: number, q: NavQuery): number
  jetEnergy(dz: number): number
}

export interface HideIndex {
  readonly field: ExposureField
  readonly n: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  /** index into the field arrays (layer included) */
  readonly cell: Int32Array
  readonly expo: Float32Array
  readonly near: Float32Array
  readonly roofSeen: Float32Array
  /** ground: metres to the nearest wall; roof: metres to the roof edge */
  readonly edge: Float32Array
  /** height above the terrain (0 for ground cells) */
  readonly agl: Float32Array
  readonly roof: Uint8Array
  readonly sky: Uint8Array
  /** of the 8 compass directions, how many can be walked for 12 m on the same layer (0 = sealed pocket) */
  readonly exits: Uint8Array
  /** standable cells within 8 m whose exposure is at most this cell's + 0.05 (room to shift without showing) */
  readonly lowNbrs: Uint8Array
  /** nav node per candidate (-1 without nav) */
  readonly node: Int32Array
  readonly buildMs: number
}

export interface HideWeights {
  expo: number
  near: number
  roofSeen: number
  /** penalty at distance 0 from a magnet, falling linearly to 0 at magnetR */
  magnet: number
  magnetR: number
  /** penalty per 300 m of straight-line travel */
  travel: number
  roof: number
  jet: number
  /** exits == 0 */
  trap: number
  /** penalty at the circle centre, falling to 0 at 2/3 of the radius */
  centre: number
  /** an enemy with line of sight to the spot / an enemy within enemyR */
  enemySees: number
  enemyNear: number
  enemyR: number
}
export const DEFAULT_WEIGHTS: HideWeights = {
  expo: 1, near: 0.03, roofSeen: 0.03, magnet: 0.12, magnetR: 80, travel: 0.4, roof: 0.06, jet: 0.08, trap: 0.03, centre: 0.04,
  enemySees: 0.6, enemyNear: 0.3, enemyR: 60,
}

export interface HideOpts {
  /** current feet height (default: the ground under from) */
  fromZ?: number
  /** keep this many metres inside the circle edge (default 10) */
  minMargin?: number
  /** traffic magnets: crates, NPC homes, weapon pickups, supply drops as x,y pairs */
  magnets?: ArrayLike<number>
  nMagnets?: number
  /** known enemies as x,y,z triples (feet) */
  enemies?: ArrayLike<number>
  nEnemies?: number
  /** reachability: on foot when in the same nav component; otherwise the spot needs jets */
  nav?: HideNav | null
  navQuery?: NavQuery
  /** may the spot need jets, and the energy available for the climb (use max energy: the follower waits for regen) */
  allowJet?: boolean
  energy?: number
  allowRoof?: boolean
  /** ignore spots farther than this (straight line, m) */
  maxDist?: number
  /** ignore spots with exposure above this (default 1) */
  maxExpo?: number
  /** how many of the best static candidates get the enemy ray checks (default 12) */
  refine?: number
  weights?: Partial<HideWeights>
}

export interface HideSpots {
  /** number of valid entries, best first */
  n: number
  readonly cap: number
  /** candidate id in the HideIndex, or -1 - fieldCell when the spot came from the dense scan (small circles) */
  readonly id: Int32Array
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly score: Float32Array
  readonly expo: Float32Array
  readonly near: Float32Array
  /** straight-line distance from the query position */
  readonly dist: Float32Array
  /** metres to the nearest wall (ground) or roof edge (roof): how far to step to peek */
  readonly edge: Float32Array
  /** distance to the nearest magnet passed in (Infinity when none) */
  readonly magnetDist: Float32Array
  readonly exits: Uint8Array
  readonly lowNbrs: Uint8Array
  readonly roof: Uint8Array
  /** 0 = reachable on foot (same nav component), 1 = needs jets; always 0 without nav for ground cells */
  readonly needJet: Uint8Array
  /** estimated jet energy to get there (0 on foot) */
  readonly jetEnergy: Float32Array
  /** 1 when a known enemy has line of sight to the spot right now */
  readonly seenNow: Uint8Array
}

export function createHideSpots(cap = 16): HideSpots {
  return {
    n: 0, cap, id: new Int32Array(cap), x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap), score: new Float32Array(cap),
    expo: new Float32Array(cap), near: new Float32Array(cap), dist: new Float32Array(cap), edge: new Float32Array(cap), magnetDist: new Float32Array(cap),
    exits: new Uint8Array(cap), lowNbrs: new Uint8Array(cap), roof: new Uint8Array(cap), needJet: new Uint8Array(cap), jetEnergy: new Float32Array(cap), seenNow: new Uint8Array(cap),
  }
}

const DI = [1, 1, 0, -1, -1, -1, 0, 1]
const DJ = [0, 1, 1, 1, 0, -1, -1, -1]

export function buildHideIndex(world: World, f: ExposureField, nav?: HideNav | null): HideIndex {
  const t0 = performance.now()
  const { gnx, gny, n } = f
  const ids: number[] = []
  for (let layer = 0; layer < 2; layer++) {
    const base = layer * n
    for (let j = 0; j < gny; j++) {
      for (let i = 0; i < gnx; i++) {
        const c = base + j * gnx + i
        if (!(f.flags[c]! & F_STAND)) continue
        const e = f.expo[c]!
        let isMin = true
        for (let dj = -2; dj <= 2 && isMin; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= gny) continue
          for (let di = -2; di <= 2; di++) {
            const ii = i + di
            if (ii < 0 || ii >= gnx || (di === 0 && dj === 0)) continue
            const v = base + jj * gnx + ii
            if (!(f.flags[v]! & F_STAND)) continue
            const ev = f.expo[v]!
            if (ev < e || (ev === e && v < c)) {
              isMin = false
              break
            }
          }
        }
        if (isMin) ids.push(c)
      }
    }
  }
  const m = ids.length
  const ix: HideIndex = {
    field: f, n: m, x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m), cell: Int32Array.from(ids), expo: new Float32Array(m), near: new Float32Array(m),
    roofSeen: new Float32Array(m), edge: new Float32Array(m), agl: new Float32Array(m), roof: new Uint8Array(m), sky: new Uint8Array(m), exits: new Uint8Array(m),
    lowNbrs: new Uint8Array(m), node: new Int32Array(m).fill(-1), buildMs: 0,
  }
  for (let k = 0; k < m; k++) {
    const c = ids[k]!
    const layer = c >= n ? 1 : 0
    const base = layer * n
    const cc = c - base
    const i = cc % gnx
    const j = (cc - i) / gnx
    const x = f.minX + (i + 0.5) * CELL
    const y = f.minY + (j + 0.5) * CELL
    const z = f.z[c]!
    ix.x[k] = x
    ix.y[k] = y
    ix.z[k] = z
    ix.expo[k] = f.expo[c]! / 255
    ix.near[k] = f.near[c]! / 255
    ix.roofSeen[k] = f.roofSeen[c]! / 255
    ix.edge[k] = f.edge[c]!
    ix.roof[k] = layer
    ix.sky[k] = f.flags[c]! & F_SKY ? 1 : 0
    ix.agl[k] = layer ? z - world.groundZ(x, y) : 0
    let exits = 0
    for (let d = 0; d < 8; d++) {
      let ok = true
      let pz = z
      for (let s = 1; s <= 3 && ok; s++) {
        const ii = i + DI[d]! * s
        const jj = j + DJ[d]! * s
        if (ii < 0 || jj < 0 || ii >= gnx || jj >= gny) {
          ok = false
          break
        }
        const v = base + jj * gnx + ii
        if (!(f.flags[v]! & F_STAND) || Math.abs(f.z[v]! - pz) > 4.5) ok = false
        else pz = f.z[v]!
      }
      if (ok) exits++
    }
    ix.exits[k] = exits
    let low = 0
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const ii = i + di
        const jj = j + dj
        if ((di === 0 && dj === 0) || ii < 0 || jj < 0 || ii >= gnx || jj >= gny) continue
        const v = base + jj * gnx + ii
        if (f.flags[v]! & F_STAND && f.expo[v]! <= f.expo[c]! + 13) low++
      }
    ix.lowNbrs[k] = low
    if (nav) ix.node[k] = nav.nearestNode(x, y, z)
  }
  ;(ix as { buildMs: number }).buildMs = performance.now() - t0
  return ix
}

/** circles up to this radius are scanned cell by cell (at most ~3000 cells) instead of through the local-minimum index */
export const DENSE_R = 100

const scratchW: HideWeights = { ...DEFAULT_WEIGHTS }
const DEFAULT_Q: NavQuery = { radius: 2.5, height: MECH_H, allowJet: false, energy: 0 }

/**
 * Rank hide spots inside the circle (zoneCx, zoneCy, zoneR) for a mech at (fromX, fromY). Writes up to out.cap
 * entries, best first, and returns the count. Pass the circle the zone is closing TO, so the spot stays legal.
 */
export function bestHideSpots(ix: HideIndex, world: World, zoneCx: number, zoneCy: number, zoneR: number, fromX: number, fromY: number, opts: HideOpts | null | undefined, out: HideSpots): number {
  const o = opts ?? {}
  const W = scratchW
  const wo = o.weights
  W.expo = wo?.expo ?? DEFAULT_WEIGHTS.expo
  W.near = wo?.near ?? DEFAULT_WEIGHTS.near
  W.roofSeen = wo?.roofSeen ?? DEFAULT_WEIGHTS.roofSeen
  W.magnet = wo?.magnet ?? DEFAULT_WEIGHTS.magnet
  W.magnetR = wo?.magnetR ?? DEFAULT_WEIGHTS.magnetR
  W.travel = wo?.travel ?? DEFAULT_WEIGHTS.travel
  W.roof = wo?.roof ?? DEFAULT_WEIGHTS.roof
  W.jet = wo?.jet ?? DEFAULT_WEIGHTS.jet
  W.trap = wo?.trap ?? DEFAULT_WEIGHTS.trap
  W.centre = wo?.centre ?? DEFAULT_WEIGHTS.centre
  W.enemySees = wo?.enemySees ?? DEFAULT_WEIGHTS.enemySees
  W.enemyNear = wo?.enemyNear ?? DEFAULT_WEIGHTS.enemyNear
  W.enemyR = wo?.enemyR ?? DEFAULT_WEIGHTS.enemyR
  const margin = o.minMargin ?? 10
  const rIn = zoneR - margin
  const rIn2 = rIn > 0 ? rIn * rIn : 0
  const maxDist = o.maxDist ?? Infinity
  const maxExpo = o.maxExpo ?? 1
  const allowRoof = o.allowRoof ?? true
  const allowJet = o.allowJet ?? false
  const energy = o.energy ?? 100
  const mags = o.magnets
  const nMag = mags ? (o.nMagnets ?? Math.floor(mags.length / 2)) : 0
  const en = o.enemies
  const nEn = en ? (o.nEnemies ?? Math.floor(en.length / 3)) : 0
  const nav = o.nav ?? null
  const q = o.navQuery ?? DEFAULT_Q
  const fromZ = o.fromZ ?? world.groundZ(fromX, fromY)
  let comps: Int32Array | null = null
  let compFrom = -1
  if (nav) {
    comps = nav.components(q)
    compFrom = nav.componentAt(fromX, fromY, fromZ, q)
  }
  const cap = out.cap
  out.n = 0
  const magR = W.magnetR
  const f = ix.field
  // one candidate: filter, score, insert into the sorted output. id = candidate index, or -1 - fieldCell for the dense scan.
  const consider = (id: number, x: number, y: number, z: number, e: number, near: number, roofSeen: number, roof: number, agl: number, exits: number, lowNbrs: number, node: number, edge: number): void => {
    const dzx = x - zoneCx
    const dzy = y - zoneCy
    const dc2 = dzx * dzx + dzy * dzy
    if (dc2 > rIn2) return
    if (e > maxExpo) return
    if (roof && !allowRoof) return
    const dx = x - fromX
    const dy = y - fromY
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > maxDist) return
    // reachability
    let needJet = 0
    let jetE = 0
    if (comps) {
      // an index built without nav has no node ids: look the node up on demand
      const nd = node >= 0 ? node : nav!.nearestNode(x, y, z)
      const comp = nd >= 0 ? comps[nd]! : -1
      if (comp < 0 || comp !== compFrom) {
        needJet = 1
        // roof: climb its height; ground in another component (walled yard): guess a 12 m wall to cross
        jetE = nav!.jetEnergy(roof ? agl : Math.max(6, z - fromZ + 12))
      }
    } else if (roof && Math.abs(z - fromZ) > 1.2) {
      needJet = 1
      jetE = 8 + 1.7 * Math.max(0, z - fromZ)
    }
    if (needJet && (!allowJet || jetE > 0.9 * energy)) return
    let s = W.expo * e + W.near * near + W.roofSeen * roofSeen + (W.travel * dist) / 300
    if (roof) s += W.roof
    if (needJet) s += W.jet * (1 + jetE / 100)
    if (exits === 0) s += W.trap
    const rf = zoneR > 0 ? Math.sqrt(dc2) / zoneR : 0
    if (rf < 0.66) s += W.centre * (1 - rf / 0.66)
    let md = Infinity
    for (let m = 0; m < nMag; m++) {
      const mx = mags![2 * m]! - x
      const my = mags![2 * m + 1]! - y
      const d2 = mx * mx + my * my
      if (d2 < md) md = d2
    }
    md = Math.sqrt(md)
    if (md < magR) s += W.magnet * (1 - md / magR)
    // cheap enemy proximity (rays only in the refine pass)
    for (let m = 0; m < nEn; m++) {
      const ex = en![3 * m]! - x
      const ey = en![3 * m + 1]! - y
      if (ex * ex + ey * ey < W.enemyR * W.enemyR) {
        s += W.enemyNear
        break
      }
    }
    let n = out.n
    if (n === cap && s >= out.score[n - 1]!) return
    let p = n < cap ? n : cap - 1
    while (p > 0 && out.score[p - 1]! > s) {
      copySlot(out, p - 1, p)
      p--
    }
    out.id[p] = id
    out.x[p] = x
    out.y[p] = y
    out.z[p] = z
    out.score[p] = s
    out.expo[p] = e
    out.near[p] = near
    out.dist[p] = dist
    out.edge[p] = edge
    out.magnetDist[p] = md
    out.exits[p] = exits
    out.lowNbrs[p] = lowNbrs
    out.roof[p] = roof
    out.needJet[p] = needJet
    out.jetEnergy[p] = jetE
    out.seenNow[p] = 0
    if (n < cap) out.n = n + 1
  }
  if (zoneR > DENSE_R) {
    for (let k = 0; k < ix.n; k++) consider(k, ix.x[k]!, ix.y[k]!, ix.z[k]!, ix.expo[k]!, ix.near[k]!, ix.roofSeen[k]!, ix.roof[k]!, ix.agl[k]!, ix.exits[k]!, ix.lowNbrs[k]!, ix.node[k]!, ix.edge[k]!)
  }
  if (out.n === 0) {
    // small circle (late zone) or nothing reachable among the local minima: scan every field cell in the circle
    const i0 = Math.max(0, Math.floor((zoneCx - zoneR - f.minX) / CELL))
    const i1 = Math.min(f.gnx - 1, Math.floor((zoneCx + zoneR - f.minX) / CELL))
    const j0 = Math.max(0, Math.floor((zoneCy - zoneR - f.minY) / CELL))
    const j1 = Math.min(f.gny - 1, Math.floor((zoneCy + zoneR - f.minY) / CELL))
    for (let layer = 0; layer < 2; layer++) {
      if (layer === 1 && !allowRoof) break
      for (let j = j0; j <= j1; j++) {
        const y = f.minY + (j + 0.5) * CELL
        for (let i = i0; i <= i1; i++) {
          const c = layer * f.n + j * f.gnx + i
          if (!(f.flags[c]! & F_STAND)) continue
          const x = f.minX + (i + 0.5) * CELL
          const ddx = x - zoneCx
          const ddy = y - zoneCy
          if (ddx * ddx + ddy * ddy > rIn2) continue
          const z = f.z[c]!
          consider(-1 - c, x, y, z, f.expo[c]! / 255, f.near[c]! / 255, f.roofSeen[c]! / 255, layer, layer ? z - world.groundZ(x, y) : 0, 8, 0, nav ? nav.nearestNode(x, y, z) : -1, f.edge[c]!)
        }
      }
    }
  }
  // refine: line of sight from known enemies (eye 8 m above their feet) to the best few, then re-sort
  if (nEn > 0 && out.n > 0) {
    const R = Math.min(out.n, o.refine ?? 12)
    for (let p = 0; p < R; p++) {
      const x = out.x[p]!
      const y = out.y[p]!
      const z = out.z[p]!
      for (let m = 0; m < nEn; m++) {
        const ex = en![3 * m]!
        const ey = en![3 * m + 1]!
        const ez = en![3 * m + 2]! + EYE_H
        const dx = ex - x
        const dy = ey - y
        if (dx * dx + dy * dy > 225 * 225) continue
        if (world.sightClear(ex, ey, ez, x, y, z + MECH_H * 0.5) || world.sightClear(ex, ey, ez, x, y, z + MECH_H)) {
          out.seenNow[p] = 1
          out.score[p] = out.score[p]! + W.enemySees
          break
        }
      }
    }
    // insertion sort (tiny)
    for (let a = 1; a < out.n; a++) {
      let b = a
      while (b > 0 && out.score[b - 1]! > out.score[b]!) {
        swapSlot(out, b - 1, b)
        b--
      }
    }
  }
  return out.n
}

function copySlot(o: HideSpots, a: number, b: number): void {
  o.id[b] = o.id[a]!
  o.x[b] = o.x[a]!
  o.y[b] = o.y[a]!
  o.z[b] = o.z[a]!
  o.score[b] = o.score[a]!
  o.expo[b] = o.expo[a]!
  o.near[b] = o.near[a]!
  o.dist[b] = o.dist[a]!
  o.edge[b] = o.edge[a]!
  o.magnetDist[b] = o.magnetDist[a]!
  o.exits[b] = o.exits[a]!
  o.lowNbrs[b] = o.lowNbrs[a]!
  o.roof[b] = o.roof[a]!
  o.needJet[b] = o.needJet[a]!
  o.jetEnergy[b] = o.jetEnergy[a]!
  o.seenNow[b] = o.seenNow[a]!
}

const tmpF = new Float64Array(8)
const tmpI = new Int32Array(8)
function swapSlot(o: HideSpots, a: number, b: number): void {
  tmpI[0] = o.id[a]!; tmpF[0] = o.x[a]!; tmpF[1] = o.y[a]!; tmpF[2] = o.z[a]!; tmpF[3] = o.score[a]!; tmpF[4] = o.expo[a]!; tmpF[5] = o.near[a]!
  tmpF[6] = o.dist[a]!; tmpF[7] = o.edge[a]!
  const md = o.magnetDist[a]!
  const je = o.jetEnergy[a]!
  tmpI[1] = o.exits[a]!; tmpI[2] = o.lowNbrs[a]!; tmpI[3] = o.roof[a]!; tmpI[4] = o.needJet[a]!; tmpI[5] = o.seenNow[a]!
  copySlot(o, b, a)
  o.id[b] = tmpI[0]!; o.x[b] = tmpF[0]!; o.y[b] = tmpF[1]!; o.z[b] = tmpF[2]!; o.score[b] = tmpF[3]!; o.expo[b] = tmpF[4]!; o.near[b] = tmpF[5]!
  o.dist[b] = tmpF[6]!; o.edge[b] = tmpF[7]!; o.magnetDist[b] = md; o.jetEnergy[b] = je
  o.exits[b] = tmpI[1]!; o.lowNbrs[b] = tmpI[2]!; o.roof[b] = tmpI[3]!; o.needJet[b] = tmpI[4]!; o.seenNow[b] = tmpI[5]!
}
