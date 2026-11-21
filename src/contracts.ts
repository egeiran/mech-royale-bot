/**
 * Shared contracts. Every module codes against these; change them only via the integrator (main session).
 *
 * Ownership (one owner per directory, nobody edits outside their own):
 *   src/protocol   wire types (copied from the kit: src/protocol/mechfight.ts)
 *   src/world      map: terrain, prism raster, raycast, vision      -> implements World
 *   src/world/nav  pathfinding / steering                            -> implements Nav
 *   src/sim        the game simulation                               -> implements runMatch
 *   src/bot        the bot (blackboard, tactics, strategies)         -> exports BotFactory values
 *   src/league     house-bot imitations, batch runner, tuning
 *   src/runner     stdin/stdout process entry
 *   src/tools      replay viewer, stream recorder, calibration, publish
 *
 * Conventions: meters, seconds, radians. x east, y north, z up. Yaw 0 = east, CCW. Pitch up-positive.
 * Hot paths take scalar arguments and allocate nothing. No Math.random / Date.now in decision logic:
 * use the seeded Rng. Module-level state is scratch only (16 bots share one process in the simulator).
 */
import type { Action, EndMsg, Hello, Observation } from "./protocol/mechfight.ts"

export type { Action, EndMsg, Hello, Observation }
export type BotAction = Omit<Action, "tick"> & { tick?: number }

// ---------------------------------------------------------------- rng
/** Deterministic PRNG (implementation: src/util/rng.ts, mulberry32). */
export interface Rng {
  /** uniform in [0, 1) */
  next(): number
  /** uniform in [a, b) */
  range(a: number, b: number): number
  /** standard normal */
  gauss(): number
  /** integer in [0, n) */
  int(n: number): number
  /** independent child stream */
  fork(salt: number): Rng
}

// ---------------------------------------------------------------- bot
export type Params = Record<string, number>

export interface BotContext {
  hello: Hello
  world: World
  /** tunable numbers; a bot must work with {} (its own defaults) */
  params: Params
  rng: Rng
  /** true in the real match process (wall-clock guards on), false in the simulator */
  realtime: boolean
  log(msg: string): void
}

export interface Bot {
  readonly name: string
  /** One decision. Must never throw in practice (the runner still guards). `tick` is filled in by the caller. */
  act(obs: Observation): BotAction
  end?(msg: EndMsg): void
}

export type BotFactory = (ctx: BotContext) => Bot

// ---------------------------------------------------------------- world
/**
 * Static map geometry. Built once from v2/world.json + v2/terrain.i16 (src/world/load.ts: loadWorld(dir)).
 *
 * Representation (src/world/raster.ts): a 1 m grid over the terrain extent
 * (nx = 1070, ny = 724, origin minX = -513, minY = -334; cell (i, j) covers [minX+i, minX+i+1) x [minY+j, minY+j+1)).
 * Each cell holds 0..n solid vertical spans [base, top] from prisms (buildings, stadium, bridges) whose
 * footprint (ring minus holes) contains the cell centre, sorted by base. Terrain is the bilinear height field.
 * "Solid" = below terrain, or inside a span.
 */
export interface World {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  /** raster dimensions (cells) */
  readonly nx: number
  readonly ny: number
  /** playable bounds from world.json (the map edge is a wall) */
  readonly bounds: { minX: number; maxX: number; minY: number; maxY: number }

  /** span storage: spans of cell c are spanData[2*k], spanData[2*k+1] for k in [spanStart[c], spanStart[c+1]) */
  readonly spanStart: Int32Array
  readonly spanData: Float32Array
  /** max solid height per cell (terrain or top of highest span), for ray skipping and "roof height" queries */
  readonly topZ: Float32Array

  /** terrain height (bilinear), ignoring prisms */
  groundZ(x: number, y: number): number
  /** highest standable surface with top <= z + tol (terrain or a prism top) under a point; the floor a body at z rests on */
  floorZ(x: number, y: number, z: number, tol?: number): number
  /** lowest prism underside above z (Infinity if open sky) */
  ceilZ(x: number, y: number, z: number): number
  /** is the point inside terrain or a prism */
  solid(x: number, y: number, z: number): boolean

  /**
   * Distance along the (not necessarily normalised: it is normalised internally) direction to the first solid
   * (terrain or prism), capped at maxDist. Returns maxDist when nothing is hit.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number
  /** shots: true when the segment hits no terrain/prism (trees never stop shots) */
  segClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean
  /** sight: segClear plus tree trunks (block) and canopy (blocks when the path through crowns is dense enough, protocol §8) */
  sightClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean
  /**
   * Full §8 visibility rule: eye at (ex,ey,ez) with torso yaw `yaw` sees a target whose feet are at (tx,ty,tz)
   * and whose height is th (line of sight to its centre or its top), within nearRange in any direction or
   * within range and inside the fovDeg yaw wedge.
   */
  canSee(ex: number, ey: number, ez: number, yaw: number, tx: number, ty: number, tz: number, th: number, range: number, fovDeg: number, nearRange: number): boolean
}

// ---------------------------------------------------------------- nav
export interface NavQuery {
  /** current mech radius and height (they grow 5% per cube) */
  radius: number
  height: number
  /** may the path use jets (boost in the air) to climb, and how much energy is available */
  allowJet: boolean
  energy: number
  /** max A* expansions for this call (deterministic time bound) */
  maxExpansions?: number
}

export interface NavPath {
  /** waypoints x,y,z flattened; first is near the start, last is the goal (or the closest reachable point) */
  pts: Float32Array
  n: number
  /** true when the goal itself was reached */
  complete: boolean
  /** estimated travel time in seconds at walk speed */
  cost: number
}

export interface Steer {
  /** desired horizontal direction, length <= 1 */
  mx: number
  my: number
  jump: boolean
  /** jet/boost needed to follow the path (climbing); callers may OR in their own boost */
  boost: boolean
  /** true when the follower thinks it is stuck and is running a recovery manoeuvre */
  stuck: boolean
}

export interface Nav {
  /** plan from a position to a goal; null when the start is not on the nav grid */
  plan(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, q: NavQuery): NavPath | null
  /**
   * Follow a path: called every decision with the current state, writes into `out`. Handles wall sliding,
   * ledges, jets onto roofs and stuck recovery. `state` is an opaque per-bot follower object from newFollower().
   */
  steer(state: object, path: NavPath, x: number, y: number, z: number, vx: number, vy: number, vz: number, grounded: boolean, energy: number, out: Steer): void
  newFollower(): object
  /** straight walkable line between two ground points for a mech of this radius (no wall, ledge > step_up or slope > max) */
  walkClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): boolean
}

// ---------------------------------------------------------------- simulator
export interface MatchEntry {
  name: string
  factory: BotFactory
  params?: Params
}

export interface MatchOptions {
  seed: number
  /** exactly config.match.mechs entries (16) */
  entries: MatchEntry[]
  world: World
  /** rule set; default = the config in the kit's recorded hello (src/sim/defaultConfig.ts) */
  config?: Hello["config"]
  /** write a mechreplay/1 JSONL replay (same format as the organisers' public replays) to this path */
  replayPath?: string
  /** stop as soon as entry `focus` is dead (speeds up evaluation of one candidate) */
  focus?: number
}

export interface MatchResult {
  seed: number
  /** per entry: final place (1 = winner), kills, time of death in seconds (duration if alive at the end) */
  place: number[]
  kills: number[]
  diedAt: number[]
  /** damage dealt to mechs / taken from mechs, per entry */
  dmgDealt: number[]
  dmgTaken: number[]
  cubes: number[]
  durationS: number
  /** exceptions thrown by each entry's act() (should be 0) */
  errors: number[]
}

export type RunMatch = (opts: MatchOptions) => MatchResult
