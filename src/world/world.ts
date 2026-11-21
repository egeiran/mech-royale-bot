/**
 * World implementation: terrain + prism raster queries, raycast, sight (trees), visibility rule (protocol §8).
 * Hot paths take scalars and allocate nothing. Instance scratch (tree stamps, lastHit) is only valid
 * until the next call on the same instance (single-threaded use).
 */
import type { World } from "../contracts.ts"
import { bilinear, type Raster } from "./raster.ts"

export interface WorldRules {
  maxStep: number
  maxSlopeDeg: number
  canopyDensity: number
  canopyBlockT: number
}

export interface TreeSet {
  n: number
  /** trunk axis */
  x: Float64Array
  y: Float64Array
  /** trunk bottom / tree top (absolute z) */
  z0: Float64Array
  z1: Float64Array
  trunkR: Float64Array
  /** crown ellipsoid: centre, horizontal radius, vertical semi-axis */
  cx: Float64Array
  cy: Float64Array
  cz: Float64Array
  crownR: Float64Array
  crownV: Float64Array
}

export const HIT_NONE = 0
export const HIT_TERRAIN = 1
export const HIT_PRISM = 2

/** bucket size (m) of the tree spatial hash */
const TREE_BUCKET = 16

// ====================================================================================================
// CANOPY MODEL -- the only place that turns "metres of crown along the sight line" into blocked / not.
// The spec names only rules.canopyDensity (0.35) and rules.canopyBlockT (0.25). Natural reading:
//   transmittance T = exp(-density * metresInsideCrowns); the line is blocked when T < canopyBlockT.
// => blocked once the path through crowns exceeds ln(1/blockT)/density (= 3.96 m with the defaults).
// Recalibrate here if observations disagree.
// ====================================================================================================
export function canopyTransmittance(metresInCrowns: number, density: number): number {
  return Math.exp(-density * metresInCrowns)
}
/** metres of crown beyond which a sight line is blocked (inverse of the rule above) */
export function canopyBlockLength(density: number, blockT: number): number {
  if (!(density > 0) || !(blockT > 0)) return Infinity
  return -Math.log(blockT) / density
}

export class GridWorld implements World {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly nx: number
  readonly ny: number
  readonly bounds: { minX: number; maxX: number; minY: number; maxY: number }
  readonly spanStart: Int32Array
  readonly spanData: Float32Array
  readonly topZ: Float32Array

  /** terrain vertex heights (metres), index j*nx+i at x = minX+i, y = minY+j */
  readonly terrain: Float32Array
  readonly rules: WorldRules
  readonly trees: TreeSet
  /** highest solid z anywhere on the map */
  readonly maxTopZ: number
  /** what the last raycast()/segClear() hit: HIT_NONE | HIT_TERRAIN | HIT_PRISM */
  lastHit = 0

  private readonly canopyMaxPath: number
  private readonly bnx: number
  private readonly bny: number
  private readonly bucketStart: Int32Array
  private readonly bucketItems: Int32Array
  private readonly treeStamp: Int32Array
  private stamp = 0
  private wallDistField: Float32Array | null = null

  constructor(r: Raster, bounds: { minX: number; maxX: number; minY: number; maxY: number }, rules: WorldRules, trees: TreeSet) {
    this.minX = r.minX
    this.minY = r.minY
    this.nx = r.nx
    this.ny = r.ny
    this.maxX = r.minX + r.nx
    this.maxY = r.minY + r.ny
    this.bounds = bounds
    this.spanStart = r.spanStart
    this.spanData = r.spanData
    this.topZ = r.topZ
    this.terrain = r.terrain
    this.rules = rules
    this.trees = trees
    let m = -Infinity
    for (let c = 0; c < r.topZ.length; c++) if (r.topZ[c]! > m) m = r.topZ[c]!
    this.maxTopZ = m
    this.canopyMaxPath = canopyBlockLength(rules.canopyDensity, rules.canopyBlockT)

    // tree spatial hash (CSR): a tree is listed in every bucket its trunk or crown bounding box touches
    const B = TREE_BUCKET
    const bnx = (this.bnx = Math.ceil(r.nx / B))
    const bny = (this.bny = Math.ceil(r.ny / B))
    const start = new Int32Array(bnx * bny + 1)
    const n = trees.n
    const range = new Int32Array(n * 4)
    for (let k = 0; k < n; k++) {
      const x0 = Math.min(trees.x[k]! - trees.trunkR[k]!, trees.cx[k]! - trees.crownR[k]!)
      const x1 = Math.max(trees.x[k]! + trees.trunkR[k]!, trees.cx[k]! + trees.crownR[k]!)
      const y0 = Math.min(trees.y[k]! - trees.trunkR[k]!, trees.cy[k]! - trees.crownR[k]!)
      const y1 = Math.max(trees.y[k]! + trees.trunkR[k]!, trees.cy[k]! + trees.crownR[k]!)
      const i0 = clampInt(Math.floor((x0 - r.minX) / B), 0, bnx - 1)
      const i1 = clampInt(Math.floor((x1 - r.minX) / B), 0, bnx - 1)
      const j0 = clampInt(Math.floor((y0 - r.minY) / B), 0, bny - 1)
      const j1 = clampInt(Math.floor((y1 - r.minY) / B), 0, bny - 1)
      range[4 * k] = i0
      range[4 * k + 1] = i1
      range[4 * k + 2] = j0
      range[4 * k + 3] = j1
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * bnx + i + 1]!++
    }
    for (let b = 0; b < bnx * bny; b++) start[b + 1]! += start[b]!
    const items = new Int32Array(start[bnx * bny]!)
    const fill = new Int32Array(bnx * bny)
    for (let k = 0; k < n; k++) {
      for (let j = range[4 * k + 2]!; j <= range[4 * k + 3]!; j++)
        for (let i = range[4 * k]!; i <= range[4 * k + 1]!; i++) {
          const b = j * bnx + i
          items[start[b]! + fill[b]!++] = k
        }
    }
    this.bucketStart = start
    this.bucketItems = items
    this.treeStamp = new Int32Array(n)
  }

  // ------------------------------------------------------------------------------------------ cells
  /** raster cell index of a point (clamped to the grid) */
  cellIndex(x: number, y: number): number {
    let i = Math.floor(x - this.minX)
    let j = Math.floor(y - this.minY)
    if (i < 0) i = 0
    else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0
    else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  /** does the cell under (x, y) have any prism span */
  inPrism(x: number, y: number): boolean {
    const c = this.cellIndex(x, y)
    return this.spanStart[c + 1]! > this.spanStart[c]!
  }

  // ------------------------------------------------------------------------------------------ heights
  groundZ(x: number, y: number): number {
    return bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY)
  }

  /** topmost surface seen from above: max(terrain, highest prism top) */
  surfaceZ(x: number, y: number): number {
    const g = bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY)
    const c = this.cellIndex(x, y)
    const e = this.spanStart[c + 1]!
    if (e > this.spanStart[c]!) {
      const t = this.spanData[2 * e - 1]!
      if (t > g) return t
    }
    return g
  }

  /**
   * Highest standable surface (terrain, unless buried inside a span, or a span top) with height <= z + tol.
   * When every surface is above z + tol (the point is underground) the lowest surface is returned.
   */
  floorZ(x: number, y: number, z: number, tol: number = 0.05): number {
    const g = bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY)
    const c = this.cellIndex(x, y)
    const s = this.spanStart[c]!
    const e = this.spanStart[c + 1]!
    if (e === s) return g
    const sd = this.spanData
    const lim = z + tol
    let best = -Infinity
    let lowest = Infinity
    let buried = false
    for (let k = s; k < e; k++) {
      const b = sd[2 * k]!
      const t = sd[2 * k + 1]!
      if (b <= g && g < t) buried = true
      if (t >= g) {
        // tops below the terrain are not surfaces
        if (t < lowest) lowest = t
        if (t <= lim && t > best) best = t
      }
    }
    if (!buried) {
      if (g < lowest) lowest = g
      if (g <= lim && g > best) best = g
    }
    return best > -Infinity ? best : lowest < Infinity ? lowest : g
  }

  /**
   * Lowest prism underside above z (Infinity if open sky). If z is strictly inside a span the base of that
   * span is returned (<= z, i.e. no headroom). A z within 0.05 m of a span top counts as standing on it.
   */
  ceilZ(x: number, y: number, z: number): number {
    const c = this.cellIndex(x, y)
    const e = this.spanStart[c + 1]!
    const sd = this.spanData
    for (let k = this.spanStart[c]!; k < e; k++) {
      if (sd[2 * k + 1]! > z + 0.05) return sd[2 * k]!
    }
    return Infinity
  }

  solid(x: number, y: number, z: number): boolean {
    // nothing is solid outside the grid rectangle (same convention as raycast)
    if (x < this.minX || x >= this.maxX || y < this.minY || y >= this.maxY) return false
    if (z < bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY)) return true
    const c = this.cellIndex(x, y)
    const e = this.spanStart[c + 1]!
    const sd = this.spanData
    for (let k = this.spanStart[c]!; k < e; k++) {
      if (z > sd[2 * k]! && z < sd[2 * k + 1]!) return true
    }
    return false
  }

  // ------------------------------------------------------------------------------------------ rays
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    this.lastHit = HIT_NONE
    if (!(maxDist > 0)) return 0
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(len > 0)) return maxDist
    const inv = 1 / len
    dx *= inv
    dy *= inv
    dz *= inv
    const nx = this.nx
    const ny = this.ny
    const px = ox - this.minX
    const py = oy - this.minY
    let t = 0
    if (px < 0 || px >= nx || py < 0 || py >= ny) {
      // origin outside the grid: advance to the grid rectangle (nothing solid outside)
      let t0 = 0
      let t1 = maxDist
      if (dx !== 0) {
        const a = -px / dx
        const b = (nx - px) / dx
        t0 = Math.max(t0, Math.min(a, b))
        t1 = Math.min(t1, Math.max(a, b))
      } else if (px < 0 || px >= nx) return maxDist
      if (dy !== 0) {
        const a = -py / dy
        const b = (ny - py) / dy
        t0 = Math.max(t0, Math.min(a, b))
        t1 = Math.min(t1, Math.max(a, b))
      } else if (py < 0 || py >= ny) return maxDist
      if (t0 >= t1) return maxDist
      t = t0
    }
    if (dz >= 0 && oz + dz * t > this.maxTopZ) return maxDist

    let i = Math.floor(px + dx * t)
    let j = Math.floor(py + dy * t)
    if (i < 0) i = 0
    else if (i >= nx) i = nx - 1
    if (j < 0) j = 0
    else if (j >= ny) j = ny - 1
    const stepI = dx > 0 ? 1 : -1
    const stepJ = dy > 0 ? 1 : -1
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tMaxX = dx > 0 ? (i + 1 - px) / dx : dx < 0 ? (i - px) / dx : Infinity
    let tMaxY = dy > 0 ? (j + 1 - py) / dy : dy < 0 ? (j - py) / dy : Infinity
    const topZ = this.topZ
    const spanStart = this.spanStart
    const sd = this.spanData
    const h = this.terrain
    let zIn = oz + dz * t

    for (;;) {
      const c = j * nx + i
      let tOut = tMaxX < tMaxY ? tMaxX : tMaxY
      let last = false
      if (tOut >= maxDist) {
        tOut = maxDist
        last = true
      }
      const zOut = oz + dz * tOut
      const zlo = zIn < zOut ? zIn : zOut
      if (zlo <= topZ[c]!) {
        const zhi = zIn < zOut ? zOut : zIn
        let best = Infinity
        let kind = HIT_NONE
        const e = spanStart[c + 1]!
        for (let k = spanStart[c]!; k < e; k++) {
          const b = sd[2 * k]!
          const tp = sd[2 * k + 1]!
          if (zlo < tp && zhi > b) {
            // side entry (or start inside) -> at t; otherwise through the roof (dz < 0) or the underside (dz > 0)
            const th = zIn > b && zIn < tp ? t : zIn >= tp ? (tp - oz) / dz : (b - oz) / dz
            if (th < best) {
              best = th
              kind = HIT_PRISM
            }
          }
        }
        // terrain: compare the ray with the bilinear ground at the cell entry and exit
        const fIn = zIn - bilinear(h, nx, ny, px + dx * t, py + dy * t)
        if (fIn < 0) {
          if (t <= best) {
            best = t
            kind = HIT_TERRAIN
          }
        } else {
          const fOut = zOut - bilinear(h, nx, ny, px + dx * tOut, py + dy * tOut)
          if (fOut < 0) {
            // the ground along the ray is quadratic inside a cell (and very steep in places): bisect the crossing
            let lo = t
            let hi = tOut
            let flo = fIn
            let fhi = fOut
            for (let it = 0; it < 6; it++) {
              const mid = 0.5 * (lo + hi)
              const fm = oz + dz * mid - bilinear(h, nx, ny, px + dx * mid, py + dy * mid)
              if (fm < 0) {
                hi = mid
                fhi = fm
              } else {
                lo = mid
                flo = fm
              }
            }
            const th = lo + ((hi - lo) * flo) / (flo - fhi)
            if (th < best) {
              best = th
              kind = HIT_TERRAIN
            }
          }
        }
        if (kind !== HIT_NONE) {
          this.lastHit = kind
          return best < t ? t : best > maxDist ? maxDist : best
        }
      }
      if (last) return maxDist
      if (tMaxX < tMaxY) {
        i += stepI
        if (i < 0 || i >= nx) return maxDist
        tMaxX += tDeltaX
      } else {
        j += stepJ
        if (j < 0 || j >= ny) return maxDist
        tMaxY += tDeltaY
      }
      t = tOut
      zIn = zOut
    }
  }

  /** Shots: no terrain/prism between the two points. Exactly symmetric in (a, b). */
  segClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    // canonical direction so that segClear(a, b) === segClear(b, a) bit for bit
    if (ax > bx || (ax === bx && (ay > by || (ay === by && az > bz)))) {
      const sx = ax
      const sy = ay
      const sz = az
      ax = bx
      ay = by
      az = bz
      bx = sx
      by = sy
      bz = sz
    }
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(len > 0)) return !this.solid(ax, ay, az)
    return this.raycast(ax, ay, az, dx, dy, dz, len) >= len
  }

  /** Sight: segClear, and no trunk on the line, and canopy path below the block length (see CANOPY MODEL). */
  sightClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    if (!this.segClear(ax, ay, az, bx, by, bz)) return false
    return !this.treesBlock(ax, ay, az, bx, by, bz)
  }

  /** metres of the segment that lie inside tree crowns (Infinity when a trunk is hit) */
  canopyPath(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    return this.treeWalk(ax, ay, az, bx, by, bz, Infinity)
  }

  /** trees only (no terrain/prisms): does a trunk or too much canopy block the sight line */
  treesBlock(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.treeWalk(ax, ay, az, bx, by, bz, this.canopyMaxPath) > this.canopyMaxPath
  }

  /**
   * Walks the tree buckets along the segment. Returns the accumulated crown path length, Infinity when a
   * trunk blocks; stops early (returning a value > limit) once the path exceeds `limit`.
   */
  private treeWalk(ax: number, ay: number, az: number, bx: number, by: number, bz: number, limit: number): number {
    if (ax > bx || (ax === bx && (ay > by || (ay === by && az > bz)))) {
      const sx = ax
      const sy = ay
      const sz = az
      ax = bx
      ay = by
      az = bz
      bx = sx
      by = sy
      bz = sz
    }
    const B = TREE_BUCKET
    const bnx = this.bnx
    const bny = this.bny
    const lx0 = (ax - this.minX) / B
    const ly0 = (ay - this.minY) / B
    const lx1 = (bx - this.minX) / B
    const ly1 = (by - this.minY) / B
    let i = Math.floor(lx0)
    let j = Math.floor(ly0)
    const iEnd = Math.floor(lx1)
    const jEnd = Math.floor(ly1)
    const ddx = lx1 - lx0
    const ddy = ly1 - ly0
    const stepI = ddx > 0 ? 1 : -1
    const stepJ = ddy > 0 ? 1 : -1
    const tDX = ddx !== 0 ? Math.abs(1 / ddx) : Infinity
    const tDY = ddy !== 0 ? Math.abs(1 / ddy) : Infinity
    let tMX = ddx > 0 ? (i + 1 - lx0) / ddx : ddx < 0 ? (i - lx0) / ddx : Infinity
    let tMY = ddy > 0 ? (j + 1 - ly0) / ddy : ddy < 0 ? (j - ly0) / ddy : Infinity
    let steps = Math.abs(iEnd - i) + Math.abs(jEnd - j)

    const Dx = bx - ax
    const Dy = by - ay
    const Dz = bz - az
    const a2 = Dx * Dx + Dy * Dy
    const segLen = Math.sqrt(a2 + Dz * Dz)
    const tr = this.trees
    const stampArr = this.treeStamp
    const stamp = ++this.stamp
    const bs = this.bucketStart
    const items = this.bucketItems
    let acc = 0

    for (;;) {
      if (i >= 0 && i < bnx && j >= 0 && j < bny) {
        const b = j * bnx + i
        const e = bs[b + 1]!
        for (let q = bs[b]!; q < e; q++) {
          const k = items[q]!
          if (stampArr[k] === stamp) continue
          stampArr[k] = stamp
          // ---- trunk: vertical cylinder
          {
            const rx = ax - tr.x[k]!
            const ry = ay - tr.y[k]!
            const r = tr.trunkR[k]!
            const cc = rx * rx + ry * ry - r * r
            let s0 = 0
            let s1 = 1
            let hit = false
            if (a2 < 1e-12) hit = cc <= 0
            else {
              const hb = rx * Dx + ry * Dy
              const disc = hb * hb - a2 * cc
              if (disc >= 0) {
                const sq = Math.sqrt(disc)
                s0 = (-hb - sq) / a2
                s1 = (-hb + sq) / a2
                if (s0 < 0) s0 = 0
                if (s1 > 1) s1 = 1
                hit = s0 <= s1
              }
            }
            if (hit) {
              const za = az + Dz * s0
              const zb = az + Dz * s1
              if ((za > zb ? za : zb) >= tr.z0[k]! && (za < zb ? za : zb) <= tr.z1[k]!) return Infinity
            }
          }
          // ---- crown: ellipsoid (z scaled so that it becomes a sphere of radius crownR)
          {
            const R = tr.crownR[k]!
            const V = tr.crownV[k]!
            if (R > 0 && V > 0) {
              const kz = R / V
              const rx = ax - tr.cx[k]!
              const ry = ay - tr.cy[k]!
              const rz = (az - tr.cz[k]!) * kz
              const ez = Dz * kz
              const a3 = a2 + ez * ez
              if (a3 > 1e-12) {
                const hb = rx * Dx + ry * Dy + rz * ez
                const disc = hb * hb - a3 * (rx * rx + ry * ry + rz * rz - R * R)
                if (disc > 0) {
                  const sq = Math.sqrt(disc)
                  let s0 = (-hb - sq) / a3
                  let s1 = (-hb + sq) / a3
                  if (s0 < 0) s0 = 0
                  if (s1 > 1) s1 = 1
                  if (s1 > s0) {
                    acc += (s1 - s0) * segLen
                    if (acc > limit) return acc
                  }
                }
              }
            }
          }
        }
      }
      if (steps-- <= 0) break
      if (tMX < tMY) {
        i += stepI
        tMX += tDX
      } else {
        j += stepJ
        tMY += tDY
      }
    }
    return acc
  }

  /**
   * Protocol §8. Distance is measured in 3D from the eye to the target's centre. Within nearRange: any
   * direction, only terrain/prisms block. Otherwise within range and inside the yaw wedge: terrain/prisms,
   * trunks and canopy block. The target is seen if either its centre or its top is visible.
   */
  canSee(ex: number, ey: number, ez: number, yaw: number, tx: number, ty: number, tz: number, th: number, range: number, fovDeg: number, nearRange: number): boolean {
    const dx = tx - ex
    const dy = ty - ey
    const zc = tz + th * 0.5
    const dzc = zc - ez
    const d2 = dx * dx + dy * dy + dzc * dzc
    const zt = tz + th
    if (d2 <= nearRange * nearRange) {
      return this.segClear(ex, ey, ez, tx, ty, zc) || this.segClear(ex, ey, ez, tx, ty, zt)
    }
    if (d2 > range * range) return false
    if (dx !== 0 || dy !== 0) {
      let da = Math.atan2(dy, dx) - yaw
      da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI
      if (Math.abs(da) > (fovDeg * Math.PI) / 360) return false
    }
    return this.sightClear(ex, ey, ez, tx, ty, zc) || this.sightClear(ex, ey, ez, tx, ty, zt)
  }

  // ------------------------------------------------------------------------------------------ extras
  /**
   * Does a prism span block a body of the given height standing on the terrain in this cell?
   * (span overlaps [ground + stepUp, ground + height] at the cell centre)
   */
  cellWalled(c: number, stepUp: number = 1.2, height: number = 9): boolean {
    const s = this.spanStart[c]!
    const e = this.spanStart[c + 1]!
    if (e === s) return false
    const i = c % this.nx
    const j = (c - i) / this.nx
    const g = bilinear(this.terrain, this.nx, this.ny, i + 0.5, j + 0.5)
    const sd = this.spanData
    for (let k = s; k < e; k++) {
      if (sd[2 * k + 1]! > g + stepUp && sd[2 * k]! < g + height) return true
    }
    return false
  }

  /**
   * Lazily built field: horizontal distance (m) from each cell centre to the nearest ground-level wall cell
   * (cellWalled with the default 1.2 m step / 9 m height), minus 0.5 m (cell half-width), >= 0.
   * Walled cells hold 0. Cells outside the playable bounds count as walls. Exact Euclidean transform.
   */
  wallDist(): Float32Array {
    if (this.wallDistField) return this.wallDistField
    const nx = this.nx
    const ny = this.ny
    const INF = 1e12
    const f = new Float64Array(nx * ny)
    const bd = this.bounds
    for (let j = 0; j < ny; j++) {
      const y = this.minY + j + 0.5
      for (let i = 0; i < nx; i++) {
        const x = this.minX + i + 0.5
        const c = j * nx + i
        const outside = x < bd.minX || x > bd.maxX || y < bd.minY || y > bd.maxY
        f[c] = outside || this.cellWalled(c) ? 0 : INF
      }
    }
    const n = Math.max(nx, ny)
    const d = new Float64Array(n)
    const v = new Int32Array(n)
    const z = new Float64Array(n + 1)
    const g = new Float64Array(n)
    const edt1d = (m: number): void => {
      let k = 0
      v[0] = 0
      z[0] = -INF
      z[1] = INF
      for (let q = 1; q < m; q++) {
        let s = 0
        for (;;) {
          const p = v[k]!
          s = (g[q]! + q * q - (g[p]! + p * p)) / (2 * q - 2 * p)
          if (s <= z[k]! && k > 0) k--
          else break
        }
        k++
        v[k] = q
        z[k] = s
        z[k + 1] = INF
      }
      k = 0
      for (let q = 0; q < m; q++) {
        while (z[k + 1]! < q) k++
        const p = v[k]!
        d[q] = (q - p) * (q - p) + g[p]!
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) g[j] = f[j * nx + i]!
      edt1d(ny)
      for (let j = 0; j < ny; j++) f[j * nx + i] = d[j]!
    }
    const out = new Float32Array(nx * ny)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) g[i] = f[j * nx + i]!
      edt1d(nx)
      for (let i = 0; i < nx; i++) {
        const r = Math.sqrt(d[i]!) - 0.5
        out[j * nx + i] = r > 0 ? r : 0
      }
    }
    this.wallDistField = out
    return out
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
