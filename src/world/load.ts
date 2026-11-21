/**
 * loadWorld(dir): builds the World from <dir>/v2/world.json + <dir>/v2/terrain.i16 (synchronous).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildRaster, decodeTerrain, type PrismJson } from "./raster.ts"
import { GridWorld, type TreeSet, type WorldRules } from "./world.ts"

export interface WorldJson {
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  rules?: Partial<WorldRules>
  terrain: { file?: string; minX: number; minY: number; step: number; nx: number; ny: number; scale: number }
  prisms: PrismJson[]
  trees?: { fields: string[]; data: number[] }
}

export function buildTrees(t: { fields: string[]; data: number[] } | undefined): TreeSet {
  const fields = t?.fields ?? []
  const data = t?.data ?? []
  const stride = fields.length || 1
  const n = fields.length ? Math.floor(data.length / stride) : 0
  const col = (name: string): number => fields.indexOf(name)
  const fx = col("x")
  const fy = col("y")
  const fz = col("z")
  const fh = col("height")
  const fr = col("crownR")
  const fb = col("crownBase")
  const ft = col("trunkR")
  const fcx = col("crownX")
  const fcy = col("crownY")
  const ts: TreeSet = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    z0: new Float64Array(n),
    z1: new Float64Array(n),
    trunkR: new Float64Array(n),
    cx: new Float64Array(n),
    cy: new Float64Array(n),
    cz: new Float64Array(n),
    crownR: new Float64Array(n),
    crownV: new Float64Array(n),
  }
  for (let k = 0; k < n; k++) {
    const o = k * stride
    const x = data[o + fx]!
    const y = data[o + fy]!
    const z = data[o + fz]!
    const h = fh >= 0 ? data[o + fh]! : 0
    // crownBase is a height above the tree base (z), like `height`
    const cb = fb >= 0 ? data[o + fb]! : h
    ts.x[k] = x
    ts.y[k] = y
    ts.z0[k] = z
    ts.z1[k] = z + h
    ts.trunkR[k] = ft >= 0 ? data[o + ft]! : 0
    ts.cx[k] = fcx >= 0 ? data[o + fcx]! : x
    ts.cy[k] = fcy >= 0 ? data[o + fcy]! : y
    ts.cz[k] = z + (cb + h) * 0.5
    ts.crownR[k] = fr >= 0 ? data[o + fr]! : 0
    ts.crownV[k] = Math.max(0, (h - cb) * 0.5)
  }
  return ts
}

export function buildWorld(json: WorldJson, terrainBytes: Uint8Array): GridWorld {
  const t = json.terrain
  if (t.step !== 1) throw new Error(`terrain.step ${t.step} not supported (expected 1 m)`)
  const terrain = decodeTerrain(terrainBytes, t.nx, t.ny, t.scale ?? 0.01)
  const raster = buildRaster(terrain, t.nx, t.ny, t.minX, t.minY, json.prisms ?? [])
  const rules: WorldRules = {
    maxStep: json.rules?.maxStep ?? 1.5,
    maxSlopeDeg: json.rules?.maxSlopeDeg ?? 50,
    canopyDensity: json.rules?.canopyDensity ?? 0.35,
    canopyBlockT: json.rules?.canopyBlockT ?? 0.25,
  }
  return new GridWorld(raster, { ...json.bounds }, rules, buildTrees(json.trees))
}

/** dir is the folder that contains `v2/` (hello.map.dir, e.g. /arena). */
export function loadWorld(dir: string): GridWorld {
  const json = JSON.parse(readFileSync(join(dir, "v2", "world.json"), "utf8")) as WorldJson
  const bytes = readFileSync(join(dir, "v2", json.terrain.file ?? "terrain.i16"))
  return buildWorld(json, bytes)
}
