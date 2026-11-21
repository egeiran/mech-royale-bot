/**
 * "Can that enemy see me?" - protocol section 8 applied from the enemy's point of view.
 * Pure functions, no allocation.
 */
import type { Config, SelfObs } from "../../protocol/mechfight.ts"
import type { World } from "../../contracts.ts"
import type { Track } from "./tracker.ts"

export type VisionCfg = Pick<Config["vision"], "range" | "fov_deg" | "near_range">

const PI = Math.PI
const TAU = 2 * Math.PI
function wrapPi(a: number): number {
  a = (a + PI) % TAU
  if (a < 0) a += TAU
  return a - PI
}

/**
 * Geometry only (no walls): is the point (x,y) inside the vision of an observer at (ox,oy) with torso yaw
 * `yaw` - within nearRange in any direction, or within range and inside the fovDeg wedge.
 */
export function inVisionWedge(ox: number, oy: number, yaw: number, x: number, y: number, range: number, fovDeg: number, nearRange: number): boolean {
  const dx = x - ox, dy = y - oy
  const d2 = dx * dx + dy * dy
  if (d2 <= nearRange * nearRange) return true
  if (d2 > range * range) return false
  return Math.abs(wrapPi(Math.atan2(dy, dx) - yaw)) <= (0.5 * fovDeg * PI) / 180
}

/**
 * Radians by which we are outside the enemy's vision wedge (negative = inside it by that much). Only
 * meaningful beyond near_range and within range. Use it to judge how much the enemy must turn to spot us.
 */
export function wedgeMargin(track: Track, self: SelfObs, fovDeg: number): number {
  const dx = self.pos[0] - track.x, dy = self.pos[1] - track.y
  return Math.abs(wrapPi(Math.atan2(dy, dx) - track.aimYaw)) - (0.5 * fovDeg * PI) / 180
}

/**
 * Is our mech inside that enemy's vision right now (its last known position and torso yaw): the 120 deg
 * wedge on ITS aim yaw within 200 m, or within 45 m any direction, with line of sight from its eye
 * (z + eye_height, scaled by its cubes) to our centre or top via world.canSee. With world = null only the
 * geometry is tested (conservative: walls ignored). The enemy's sensor upgrades are unknown: pass
 * rangeBonus / nearBonus (m) to be pessimistic (a "sensors" upgrade gives +25 / +15).
 */
export function seenBy(track: Track, self: SelfObs, world: World | null, visionCfg: VisionCfg, rangeBonus = 0, nearBonus = 0): boolean {
  if (!track.known || track.dead) return false
  const range = visionCfg.range + rangeBonus
  const near = visionCfg.near_range + nearBonus
  const ourH = self.stats.height ?? 9
  if (world) {
    const eye = track.z + (track.npc ? 0.9 * track.height : (8 / 9) * track.height)
    return world.canSee(track.x, track.y, eye, track.aimYaw, self.pos[0], self.pos[1], self.pos[2], ourH, range, visionCfg.fov_deg, near)
  }
  return inVisionWedge(track.x, track.y, track.aimYaw, self.pos[0], self.pos[1], range, visionCfg.fov_deg, near)
}

/**
 * Are we in the enemy's REAR arc (a hit from us now would deal x1.5): the bearing from it to us is outside
 * its 180 deg front arc centred on its aim yaw.
 */
export function inRearArcOf(track: Track, self: SelfObs, frontArcDeg = 180): boolean {
  const dx = self.pos[0] - track.x, dy = self.pos[1] - track.y
  return Math.abs(wrapPi(Math.atan2(dy, dx) - track.aimYaw)) > (0.5 * frontArcDeg * PI) / 180
}
