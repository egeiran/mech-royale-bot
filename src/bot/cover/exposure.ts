/**
 * Static exposure field: how visible is a 9 m mech standing on a given 4 m cell to ground observers within 200 m.
 *
 * Two layers per cell: GROUND (terrain surface) and ROOF (topmost prism top more than 3 m above the terrain).
 * For every standable cell, observers are sampled on a polar lattice around it (ground positions that are not
 * inside a building, eye 8 m above the terrain). A sample "sees" the cell under protocol §8 without the yaw wedge:
 * line of sight from the eye to the mech's centre or top; within 45 m only terrain/prisms block, beyond that
 * trunks and canopy block too. `expo` weights each sample by ring area x threat (how often a sighting at that
 * distance turned into damage in the recorded top-16 showdowns, data/intel/ghost.md), so 0 = no ground position
 * within 200 m can see a mech here, 1 = everything can.
 *
 * The map never changes, so the field is baked offline (bake.ts -> exposure.baked.ts, a gzip+base64 string that
 * survives bundling) and only decoded at startup (~5 ms). When the baked fingerprint does not match the loaded
 * world, a coarser field is computed in process (12 m lattice, 12 x 3 samples, ~0.1 s).
 *
 * Everything here is deterministic and allocation-free after construction.
 */
import { gunzipSync } from "node:zlib"
import type { World } from "../../contracts.ts"
import { BAKED } from "./exposure.baked.ts"

export const CELL = 4
export const NSECT = 16
export const F_STAND = 1
export const F_ROOF = 2
/** roof cell that no ground observer sample within 200 m can see */
export const F_SKY = 4
export const MECH_H = 9
export const EYE_H = 8
const ROOF_MIN_AGL = 3
const RADIUS = 2.5

/** threat weight of a sighting that starts at distance d (P(damage within 20 s), showdown data) */
export function threatAt(d: number): number {
  return d < 45 ? 0.9 : d < 100 ? 0.65 : d < 150 ? 0.45 : 0.3
}

export interface ExposureField {
  readonly cell: number
  readonly gnx: number
  readonly gny: number
  readonly minX: number
  readonly minY: number
  /** cells per layer (gnx * gny); arrays hold 2 layers: index = layer * n + j * gnx + i */
  readonly n: number
  readonly flags: Uint8Array
  /** threat-and-area weighted share of ground observers within 200 m with line of sight, 0..255 */
  readonly expo: Uint8Array
  /** share of ground observers within 45 m with line of sight (proximity leak), 0..255 */
  readonly near: Uint8Array
  /** share of observers standing on roofs within 200 m with line of sight, 0..255 */
  readonly roofSeen: Uint8Array
  /** per 22.5 deg sector (sector s covers bearings around s * 22.5 deg from the cell): share of samples that see, 0..255 */
  readonly sect: Uint8Array
  /** ground: metres to the nearest wall; roof: metres to the nearest roof edge (drop > 1.2 m); capped at 60 */
  readonly edge: Uint8Array
  /** feet height of the surface */
  readonly z: Float32Array
  readonly source: "baked" | "runtime"
  readonly buildMs: number
}

export interface ExposureSampling {
  dirs: number
  dists: number[]
  /** compute every stride-th cell in both axes and copy to the block (1 = every cell) */
  stride: number
}
export const BAKE_SAMPLING: ExposureSampling = { dirs: 48, dists: [14, 26, 38, 55, 75, 95, 115, 135, 155, 175, 195], stride: 1 }
export const RUNTIME_SAMPLING: ExposureSampling = { dirs: 12, dists: [30, 85, 150], stride: 3 }

export function gridDims(world: World): { gnx: number; gny: number } {
  return { gnx: Math.ceil(world.nx / CELL), gny: Math.ceil(world.ny / CELL) }
}

/** 32-bit fingerprint of the static geometry the field depends on */
export function worldFingerprint(world: World): number {
  let h = 2166136261 >>> 0
  const mix = (v: number) => {
    h ^= v >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  mix(world.nx)
  mix(world.ny)
  mix(Math.round(world.minX * 16))
  mix(Math.round(world.minY * 16))
  const tz = world.topZ
  for (let c = 0; c < tz.length; c += 61) mix(Math.round(tz[c]! * 8) | 0)
  mix(world.spanStart[world.spanStart.length - 1]!)
  return h >>> 0
}

function alloc(world: World, source: "baked" | "runtime"): ExposureField & { buildMs: number } {
  const { gnx, gny } = gridDims(world)
  const n = gnx * gny
  return {
    cell: CELL, gnx, gny, minX: world.minX, minY: world.minY, n,
    flags: new Uint8Array(2 * n), expo: new Uint8Array(2 * n), near: new Uint8Array(2 * n), roofSeen: new Uint8Array(2 * n),
    sect: new Uint8Array(2 * n * NSECT), edge: new Uint8Array(2 * n), z: new Float32Array(2 * n), source, buildMs: 0,
  }
}

/** Geometry-only part (cheap, always recomputed from the world): standable flags, surface z, edge distance. */
function fillSurfaces(world: World, f: ExposureField): void {
  const { gnx, gny, n } = f
  const wd = world.wallDist()
  const b = world.bounds
  for (let j = 0; j < gny; j++) {
    const y = f.minY + (j + 0.5) * CELL
    for (let i = 0; i < gnx; i++) {
      const x = f.minX + (i + 0.5) * CELL
      const c = j * gnx + i
      if (x < b.minX + RADIUS || x > b.maxX - RADIUS || y < b.minY + RADIUS || y > b.maxY - RADIUS) continue
      const rc = (Math.floor(y - world.minY) | 0) * world.nx + (Math.floor(x - world.minX) | 0)
      const g = world.groundZ(x, y)
      f.z[c] = g
      const w = wd[rc]!
      if (w >= RADIUS) {
        f.flags[c] = F_STAND
        f.edge[c] = Math.min(60, Math.round(w))
      }
      const top = world.surfaceZ(x, y)
      if (top > g + ROOF_MIN_AGL) {
        // no higher wall within the body radius
        let ok = true
        for (let k = 0; k < 8 && ok; k++) {
          const a = (k * Math.PI) / 4
          if (world.surfaceZ(x + Math.cos(a) * RADIUS, y + Math.sin(a) * RADIUS) > top + 1.2) ok = false
        }
        f.z[n + c] = top
        if (ok) {
          f.flags[n + c] = F_STAND | F_ROOF
          let e = 60
          for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4
            const ca = Math.cos(a)
            const sa = Math.sin(a)
            for (let d = 2; d < e; d += 2) {
              if (world.surfaceZ(x + ca * d, y + sa * d) < top - 1.2) {
                e = d
                break
              }
            }
          }
          f.edge[n + c] = e
        }
      }
    }
  }
}

/** Ray-sampled part. Used by the offline bake (BAKE_SAMPLING) and by the in-process fallback (RUNTIME_SAMPLING). */
export function computeExposure(world: World, s: ExposureSampling = RUNTIME_SAMPLING, source: "baked" | "runtime" = "runtime"): ExposureField {
  const t0 = performance.now()
  const f = alloc(world, source)
  fillSurfaces(world, f)
  const { gnx, gny, n } = f
  const wd = world.wallDist()
  const b = world.bounds
  const nd = s.dirs
  const cosT = new Float64Array(nd)
  const sinT = new Float64Array(nd)
  const sectOf = new Uint8Array(nd)
  for (let k = 0; k < nd; k++) {
    const a = ((k + 0.5) * 2 * Math.PI) / nd
    cosT[k] = Math.cos(a)
    sinT[k] = Math.sin(a)
    sectOf[k] = Math.round((a * NSECT) / (2 * Math.PI)) % NSECT
  }
  const sSeen = new Float64Array(NSECT)
  const sTot = new Float64Array(NSECT)
  const st = s.stride
  for (let layer = 0; layer < 2; layer++) {
    for (let j = 0; j < gny; j += st) {
      for (let i = 0; i < gnx; i += st) {
        // representative cell of the block: the first standable one
        let rep = -1
        for (let dj = 0; dj < st && rep < 0; dj++)
          for (let di = 0; di < st; di++) {
            const jj = j + dj
            const ii = i + di
            if (jj < gny && ii < gnx && f.flags[layer * n + jj * gnx + ii]! & F_STAND) {
              rep = jj * gnx + ii
              break
            }
          }
        if (rep < 0) continue
        const ri = rep % gnx
        const rj = (rep - ri) / gnx
        const x = f.minX + (ri + 0.5) * CELL
        const y = f.minY + (rj + 0.5) * CELL
        const tz = f.z[layer * n + rep]!
        const zc = tz + MECH_H * 0.5
        const zt = tz + MECH_H
        let wSeen = 0
        let wTot = 0
        let nSeen = 0
        let nTot = 0
        let rSeen = 0
        let rTot = 0
        sSeen.fill(0)
        sTot.fill(0)
        for (let k = 0; k < nd; k++) {
          const ca = cosT[k]!
          const sa = sinT[k]!
          const sec = sectOf[k]!
          for (let q = 0; q < s.dists.length; q++) {
            const d = s.dists[q]!
            const ox = x + ca * d
            const oy = y + sa * d
            if (ox < b.minX + 1 || ox > b.maxX - 1 || oy < b.minY + 1 || oy > b.maxY - 1) continue
            const rc = (Math.floor(oy - world.minY) | 0) * world.nx + (Math.floor(ox - world.minX) | 0)
            const og = world.groundZ(ox, oy)
            if (wd[rc]! < 1) {
              // inside / against a building: an observer could stand on its roof
              const top = world.surfaceZ(ox, oy)
              if (top > og + ROOF_MIN_AGL) {
                rTot++
                const ez = top + EYE_H
                if (world.sightClear(ox, oy, ez, x, y, zc) || world.sightClear(ox, oy, ez, x, y, zt)) rSeen++
              }
              continue
            }
            const ez = og + EYE_H
            const dz = zc - ez
            const d3 = Math.sqrt(d * d + dz * dz)
            let vis: boolean
            if (d3 <= 45) vis = world.segClear(ox, oy, ez, x, y, zc) || world.segClear(ox, oy, ez, x, y, zt)
            else if (d3 > 200) continue
            else vis = world.sightClear(ox, oy, ez, x, y, zc) || world.sightClear(ox, oy, ez, x, y, zt)
            const wgt = d * threatAt(d3)
            wTot += wgt
            sTot[sec]! += wgt
            if (d3 <= 45) nTot++
            if (vis) {
              wSeen += wgt
              sSeen[sec]! += wgt
              if (d3 <= 45) nSeen++
            }
          }
        }
        const e = wTot > 0 ? Math.min(255, Math.ceil((255 * wSeen) / wTot)) : 0
        const nr = nTot > 0 ? Math.min(255, Math.ceil((255 * nSeen) / nTot)) : 0
        const rs = rTot > 0 ? Math.min(255, Math.ceil((255 * rSeen) / rTot)) : 0
        for (let dj = 0; dj < st; dj++)
          for (let di = 0; di < st; di++) {
            const jj = j + dj
            const ii = i + di
            if (jj >= gny || ii >= gnx) continue
            const c = layer * n + jj * gnx + ii
            if (!(f.flags[c]! & F_STAND)) continue
            f.expo[c] = e
            f.near[c] = nr
            f.roofSeen[c] = rs
            for (let q = 0; q < NSECT; q++) f.sect[c * NSECT + q] = sTot[q]! > 0 ? Math.min(255, Math.ceil((255 * sSeen[q]!) / sTot[q]!)) : 0
            if (layer === 1 && wSeen === 0) f.flags[c] = f.flags[c]! | F_SKY
          }
      }
    }
  }
  ;(f as { buildMs: number }).buildMs = performance.now() - t0
  return f
}

// ------------------------------------------------------------------------------------------ baked
/** layout of the baked blob: u32 fingerprint, u32 n, then expo[2n], near[2n], roofSeen[2n], sky[2n] (0/1), sect[2n*16] */
export function encodeBaked(world: World, f: ExposureField): Uint8Array {
  const n2 = 2 * f.n
  const buf = new Uint8Array(8 + n2 * 4 + n2 * NSECT)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, worldFingerprint(world), true)
  dv.setUint32(4, f.n, true)
  let o = 8
  buf.set(f.expo, o); o += n2
  buf.set(f.near, o); o += n2
  buf.set(f.roofSeen, o); o += n2
  for (let c = 0; c < n2; c++) buf[o + c] = f.flags[c]! & F_SKY ? 1 : 0
  o += n2
  buf.set(f.sect, o)
  return buf
}

export function decodeBaked(world: World, b64gz: string): ExposureField | null {
  const t0 = performance.now()
  let raw: Uint8Array
  try {
    raw = gunzipSync(Buffer.from(b64gz, "base64"))
  } catch {
    return null
  }
  if (raw.length < 8) return null
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const f = alloc(world, "baked")
  const n2 = 2 * f.n
  if (dv.getUint32(0, true) !== worldFingerprint(world) || dv.getUint32(4, true) !== f.n || raw.length !== 8 + n2 * 4 + n2 * NSECT) return null
  fillSurfaces(world, f)
  let o = 8
  f.expo.set(raw.subarray(o, o + n2)); o += n2
  f.near.set(raw.subarray(o, o + n2)); o += n2
  f.roofSeen.set(raw.subarray(o, o + n2)); o += n2
  for (let c = 0; c < n2; c++) if (raw[o + c] && f.flags[c]! & F_STAND) f.flags[c] = f.flags[c]! | F_SKY
  o += n2
  f.sect.set(raw.subarray(o, o + n2 * NSECT))
  ;(f as { buildMs: number }).buildMs = performance.now() - t0
  return f
}

const cache = new WeakMap<World, ExposureField>()
let bakedBlob: string | null = BAKED || null

/** tests / tools: supply or clear the baked blob explicitly (null forces the runtime fallback) */
export function setBakedBlob(b: string | null): void {
  bakedBlob = b
}

/**
 * The field for this world: decoded from the baked blob when its fingerprint matches, else computed in process.
 * Cached per world (16 bots in the simulator share one).
 */
export function getExposure(world: World, baked?: string | null): ExposureField {
  let f = cache.get(world)
  if (f) return f
  const blob = baked !== undefined ? baked : bakedBlob
  f = (blob ? decodeBaked(world, blob) : null) ?? computeExposure(world, RUNTIME_SAMPLING, "runtime")
  cache.set(world, f)
  return f
}

// ------------------------------------------------------------------------------------------ queries
/** cell index within a layer (clamped) */
export function cellOf(f: ExposureField, x: number, y: number): number {
  let i = Math.floor((x - f.minX) / CELL)
  let j = Math.floor((y - f.minY) / CELL)
  if (i < 0) i = 0
  else if (i >= f.gnx) i = f.gnx - 1
  if (j < 0) j = 0
  else if (j >= f.gny) j = f.gny - 1
  return j * f.gnx + i
}

/** full index (layer included) of the surface a mech with feet at z stands on: the roof layer when z is within 2.5 m of it */
export function indexAt(f: ExposureField, x: number, y: number, z: number): number {
  const c = cellOf(f, x, y)
  if (f.flags[f.n + c]! & F_ROOF && Math.abs(z - f.z[f.n + c]!) < 2.5) return f.n + c
  return c
}

/** exposure 0..1 at a position; 1 for cells that are not standable (unknown = assume seen) */
export function exposureAt(f: ExposureField, x: number, y: number, z: number): number {
  const c = indexAt(f, x, y, z)
  return f.flags[c]! & F_STAND ? f.expo[c]! / 255 : 1
}

/** exposure 0..1 toward one bearing (yaw from the cell to where observers are expected), linear between the two nearest sectors */
export function exposureToward(f: ExposureField, x: number, y: number, z: number, bearing: number): number {
  const c = indexAt(f, x, y, z)
  if (!(f.flags[c]! & F_STAND)) return 1
  let u = (bearing * NSECT) / (2 * Math.PI)
  u -= Math.floor(u / NSECT) * NSECT
  const s0 = Math.floor(u) % NSECT
  const s1 = (s0 + 1) % NSECT
  const k = u - Math.floor(u)
  return (f.sect[c * NSECT + s0]! * (1 - k) + f.sect[c * NSECT + s1]! * k) / 255
}

export function isSkyOnly(f: ExposureField, x: number, y: number, z: number): boolean {
  return (f.flags[indexAt(f, x, y, z)]! & F_SKY) !== 0
}
