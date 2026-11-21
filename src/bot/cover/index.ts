/**
 * src/bot/cover - where to stand so nobody sees us, and how to get out of sight. See README.md.
 */
import type { World } from "../../contracts.ts"
import { getExposure, type ExposureField } from "./exposure.ts"
import { bestHideSpots, buildHideIndex, createHideSpots, type HideIndex, type HideNav, type HideOpts, type HideSpots } from "./hide.ts"
import { pathExposure, safeDirection, segmentExposure, segmentSeenFrac, visibleToAny, DEFAULT_VISION, type EnemyView, type SafeStep, type VisionCfg } from "./threat.ts"

export * from "./exposure.ts"
export * from "./hide.ts"
export * from "./threat.ts"

export interface Cover {
  readonly field: ExposureField
  readonly index: HideIndex
  readonly buildMs: number
  /** ranked hide spots inside a circle (pass the circle the zone is closing to); returns the count written to out */
  bestHideSpots(zoneCx: number, zoneCy: number, zoneR: number, fromX: number, fromY: number, opts: HideOpts | null, out: HideSpots): number
  /** index of the first enemy that sees a mech at (x, y, z), or -1 */
  visibleToAny(x: number, y: number, z: number, height: number, enemies: ArrayLike<EnemyView>, n: number, anyYaw?: boolean): number
  /** nearest walkable point hidden from all the given enemies */
  safeDirection(x: number, y: number, z: number, height: number, enemies: ArrayLike<EnemyView>, n: number, maxDist: number, out: SafeStep): SafeStep
  /** static exposure integral of a segment in "exposed metres" */
  segmentExposure(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number
  /** exposed metres of a polyline (NavPath pts, n) */
  pathExposure(pts: ArrayLike<number>, n: number): number
  /** share of the segment visible to known enemies */
  segmentSeenFrac(ax: number, ay: number, az: number, bx: number, by: number, bz: number, height: number, enemies: ArrayLike<EnemyView>, n: number): number
  /** static exposure 0..1 at a position (1 = unknown / not standable) */
  exposureAt(x: number, y: number, z: number): number
}

const cache = new WeakMap<World, { cover: Cover; hasNav: boolean }>()

/**
 * Build (or fetch the cached) cover module for a world. `nav` (src/world/nav createNav) is optional: with it,
 * hide spots know their nav node, so bestHideSpots can tell "on foot" from "needs jets" when opts.nav is passed.
 */
export function createCover(world: World, nav?: HideNav | null, vision: VisionCfg = DEFAULT_VISION): Cover {
  const hit = cache.get(world)
  // a cover built without nav is rebuilt once nav is supplied (the exposure field itself stays cached)
  if (hit && (hit.hasNav || !nav)) return hit.cover
  const t0 = performance.now()
  const field = getExposure(world)
  const index = buildHideIndex(world, field, nav ?? null)
  const cover: Cover = {
    field,
    index,
    buildMs: performance.now() - t0,
    bestHideSpots: (cx, cy, r, fx, fy, opts, out) => bestHideSpots(index, world, cx, cy, r, fx, fy, opts && nav && opts.nav === undefined ? withNav(opts, nav) : opts, out),
    visibleToAny: (x, y, z, h, en, n, anyYaw = false) => visibleToAny(world, x, y, z, h, en, n, vision, anyYaw),
    safeDirection: (x, y, z, h, en, n, maxDist, out) => safeDirection(world, x, y, z, h, en, n, maxDist, out),
    segmentExposure: (ax, ay, az, bx, by, bz) => segmentExposure(field, ax, ay, az, bx, by, bz),
    pathExposure: (pts, n) => pathExposure(field, pts, n),
    segmentSeenFrac: (ax, ay, az, bx, by, bz, h, en, n) => segmentSeenFrac(world, ax, ay, az, bx, by, bz, h, en, n),
    exposureAt: (x, y, z) => {
      let i = Math.floor((x - field.minX) / field.cell)
      let j = Math.floor((y - field.minY) / field.cell)
      if (i < 0) i = 0
      else if (i >= field.gnx) i = field.gnx - 1
      if (j < 0) j = 0
      else if (j >= field.gny) j = field.gny - 1
      let c = j * field.gnx + i
      if (field.flags[field.n + c]! & 2 && Math.abs(z - field.z[field.n + c]!) < 2.5) c += field.n
      return field.flags[c]! & 1 ? field.expo[c]! / 255 : 1
    },
  }
  cache.set(world, { cover, hasNav: !!nav })
  return cover
}

/** opts object is caller-owned and reused: attach the nav once instead of allocating a copy per call */
function withNav(opts: HideOpts, nav: HideNav): HideOpts {
  opts.nav = nav
  return opts
}

export { createHideSpots }
