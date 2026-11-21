/**
 * Raster of the static map: 1 m cells, per-cell solid vertical spans from prisms, terrain vertex grid.
 *
 * Cell (i, j) covers [minX+i, minX+i+1) x [minY+j, minY+j+1); index c = j*nx + i.
 * Spans of cell c: for k in [spanStart[c], spanStart[c+1]): base = spanData[2k], top = spanData[2k+1]
 * (sorted by base, overlapping spans merged). A prism contributes to a cell when the cell CENTRE is
 * inside its ring and outside all of its holes.
 */

export interface PrismJson {
  kind: "building" | "stadium" | "bridge" | string
  base: number
  top: number
  /** flat [x0, y0, x1, y1, ...] */
  ring: number[]
  holes?: number[][]
}

export interface Raster {
  minX: number
  minY: number
  nx: number
  ny: number
  /** terrain heights in metres at the grid vertices (x = minX+i, y = minY+j), index j*nx+i */
  terrain: Float32Array
  spanStart: Int32Array
  spanData: Float32Array
  /** max solid height in the cell: max of the 4 terrain corners and the highest span top (conservative) */
  topZ: Float32Array
}

/** Decode terrain.i16 (int16 LE centimetres) into metres. */
export function decodeTerrain(buf: Uint8Array, nx: number, ny: number, scale: number): Float32Array {
  const n = nx * ny
  if (buf.byteLength < n * 2) throw new Error(`terrain.i16 too small: ${buf.byteLength} < ${n * 2}`)
  const out = new Float32Array(n)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let k = 0; k < n; k++) out[k] = dv.getInt16(k * 2, true) * scale
  return out
}

/** Bilinear terrain sample in grid-local coordinates (lx = x - minX, ly = y - minY), clamped to the grid. */
export function bilinear(h: Float32Array, nx: number, ny: number, lx: number, ly: number): number {
  if (lx < 0) lx = 0
  else if (lx > nx - 1) lx = nx - 1
  if (ly < 0) ly = 0
  else if (ly > ny - 1) ly = ny - 1
  let i = lx | 0
  let j = ly | 0
  if (i > nx - 2) i = nx - 2
  if (j > ny - 2) j = ny - 2
  const fx = lx - i
  const fy = ly - j
  const k = j * nx + i
  const a = h[k]!
  const b = h[k + 1]!
  const c = h[k + nx]!
  const d = h[k + nx + 1]!
  const ab = a + (b - a) * fx
  const cd = c + (d - c) * fx
  return ab + (cd - ab) * fy
}

/** x-crossings of a closed ring with the horizontal line y = yc, appended to xs from index n; returns new n. */
function ringCrossings(ring: number[], yc: number, xs: Float64Array, n: number): number {
  const m = ring.length >> 1
  if (m < 3) return n
  let x0 = ring[2 * (m - 1)]!
  let y0 = ring[2 * (m - 1) + 1]!
  for (let v = 0; v < m; v++) {
    const x1 = ring[2 * v]!
    const y1 = ring[2 * v + 1]!
    if (y0 <= yc !== y1 <= yc) {
      xs[n++] = x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0)
    }
    x0 = x1
    y0 = y1
  }
  return n
}

function sortPrefix(xs: Float64Array, n: number): void {
  for (let a = 1; a < n; a++) {
    const v = xs[a]!
    let b = a - 1
    while (b >= 0 && xs[b]! > v) {
      xs[b + 1] = xs[b]!
      b--
    }
    xs[b + 1] = v
  }
}

/** Set mask[i] = val for all cells of the row whose centre x lies in the crossing pairs (even-odd). */
function fillPairs(xs: Float64Array, n: number, minX: number, nx: number, mask: Uint8Array, val: number): void {
  for (let p = 0; p + 1 < n; p += 2) {
    let i0 = Math.ceil(xs[p]! - minX - 0.5)
    let i1 = Math.ceil(xs[p + 1]! - minX - 0.5) - 1
    if (i0 < 0) i0 = 0
    if (i1 > nx - 1) i1 = nx - 1
    for (let i = i0; i <= i1; i++) mask[i] = val
  }
}

/**
 * Scanline rasterisation of all prisms (ring minus holes, cell-centre test) into per-cell span lists.
 */
export function buildRaster(terrain: Float32Array, nx: number, ny: number, minX: number, minY: number, prisms: PrismJson[]): Raster {
  const ncell = nx * ny
  const counts = new Int32Array(ncell + 1)
  let cap = 1 << 18
  let eCell = new Int32Array(cap)
  let ePrism = new Int32Array(cap)
  let ne = 0

  let maxVerts = 8
  for (const p of prisms) {
    let v = p.ring.length >> 1
    if (p.holes) for (const h of p.holes) v = Math.max(v, h.length >> 1)
    if (v > maxVerts) maxVerts = v
  }
  const xs = new Float64Array(maxVerts + 4)
  const mask = new Uint8Array(nx)

  for (let pi = 0; pi < prisms.length; pi++) {
    const p = prisms[pi]!
    const ring = p.ring
    if (!(p.top > p.base) || ring.length < 6) continue
    let bx0 = Infinity
    let bx1 = -Infinity
    let by0 = Infinity
    let by1 = -Infinity
    for (let v = 0; v < ring.length; v += 2) {
      const x = ring[v]!
      const y = ring[v + 1]!
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
    let j0 = Math.ceil(by0 - minY - 0.5)
    let j1 = Math.ceil(by1 - minY - 0.5) - 1
    if (j0 < 0) j0 = 0
    if (j1 > ny - 1) j1 = ny - 1
    let i0 = Math.floor(bx0 - minX) - 1
    let i1 = Math.ceil(bx1 - minX) + 1
    if (i0 < 0) i0 = 0
    if (i1 > nx - 1) i1 = nx - 1
    const holes = p.holes
    for (let j = j0; j <= j1; j++) {
      const yc = minY + j + 0.5
      let n = ringCrossings(ring, yc, xs, 0)
      if (n < 2) continue
      sortPrefix(xs, n)
      fillPairs(xs, n, minX, nx, mask, 1)
      if (holes) {
        for (let h = 0; h < holes.length; h++) {
          n = ringCrossings(holes[h]!, yc, xs, 0)
          if (n < 2) continue
          sortPrefix(xs, n)
          fillPairs(xs, n, minX, nx, mask, 0)
        }
      }
      const row = j * nx
      for (let i = i0; i <= i1; i++) {
        if (mask[i]) {
          mask[i] = 0
          if (ne === cap) {
            cap *= 2
            const a = new Int32Array(cap)
            a.set(eCell)
            eCell = a
            const b = new Int32Array(cap)
            b.set(ePrism)
            ePrism = b
          }
          eCell[ne] = row + i
          ePrism[ne] = pi
          ne++
          counts[row + i + 1]!++
        }
      }
    }
  }

  // prefix sums -> provisional slots
  for (let c = 0; c < ncell; c++) counts[c + 1]! += counts[c]!
  const slotBase = new Float32Array(ne)
  const slotTop = new Float32Array(ne)
  const fill = new Int32Array(ncell)
  for (let e = 0; e < ne; e++) {
    const c = eCell[e]!
    const s = counts[c]! + fill[c]!++
    const p = prisms[ePrism[e]!]!
    slotBase[s] = p.base
    slotTop[s] = p.top
  }

  // sort by base within each cell, merge overlapping, compact
  const spanStart = new Int32Array(ncell + 1)
  const data = new Float32Array(ne * 2)
  const topZ = new Float32Array(ncell)
  let ns = 0
  for (let j = 0; j < ny; j++) {
    const jn = j < ny - 1 ? j + 1 : j
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      const inx = i < nx - 1 ? i + 1 : i
      let tz = terrain[c]!
      const t1 = terrain[j * nx + inx]!
      const t2 = terrain[jn * nx + i]!
      const t3 = terrain[jn * nx + inx]!
      if (t1 > tz) tz = t1
      if (t2 > tz) tz = t2
      if (t3 > tz) tz = t3
      spanStart[c] = ns
      const s0 = counts[c]!
      const s1 = counts[c + 1]!
      if (s1 > s0) {
        for (let a = s0 + 1; a < s1; a++) {
          const vb = slotBase[a]!
          const vt = slotTop[a]!
          let b = a - 1
          while (b >= s0 && slotBase[b]! > vb) {
            slotBase[b + 1] = slotBase[b]!
            slotTop[b + 1] = slotTop[b]!
            b--
          }
          slotBase[b + 1] = vb
          slotTop[b + 1] = vt
        }
        let cb = slotBase[s0]!
        let ct = slotTop[s0]!
        for (let a = s0 + 1; a < s1; a++) {
          if (slotBase[a]! <= ct) {
            if (slotTop[a]! > ct) ct = slotTop[a]!
          } else {
            data[2 * ns] = cb
            data[2 * ns + 1] = ct
            ns++
            cb = slotBase[a]!
            ct = slotTop[a]!
          }
        }
        data[2 * ns] = cb
        data[2 * ns + 1] = ct
        ns++
        if (ct > tz) tz = ct
      }
      topZ[c] = tz
    }
  }
  spanStart[ncell] = ns
  return { minX, minY, nx, ny, terrain, spanStart, spanData: data.slice(0, ns * 2), topZ }
}

/** Exact (non-rasterised) point-in-prism footprint test: inside ring and outside all holes. */
export function pointInRing(ring: number[], x: number, y: number): boolean {
  const m = ring.length >> 1
  let inside = false
  let x0 = ring[2 * (m - 1)]!
  let y0 = ring[2 * (m - 1) + 1]!
  for (let v = 0; v < m; v++) {
    const x1 = ring[2 * v]!
    const y1 = ring[2 * v + 1]!
    if (y0 <= y !== y1 <= y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside
    x0 = x1
    y0 = y1
  }
  return inside
}

export function pointInFootprint(p: PrismJson, x: number, y: number): boolean {
  if (!pointInRing(p.ring, x, y)) return false
  if (p.holes) for (const h of p.holes) if (pointInRing(h, x, y)) return false
  return true
}
