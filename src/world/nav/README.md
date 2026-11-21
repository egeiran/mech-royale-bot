# src/world/nav — pathfinding and steering

`createNav(world, mech?: Partial<MechNavParams>): NavEx` implements `Nav` (`src/contracts.ts`). Instances are cached per
(world, params): 16 bots in one process share one graph and search scratch. `navParamsFromMech(hello.config.mech)` maps
server config to params. Calls are synchronous and allocation-free (`releasePath(p)` / `plan(..., out)` recycle paths).

## API
- `plan(sx,sy,sz, gx,gy,gz, q, out?) -> NavPathEx | null` — A*; `null` only when no standable node within 8 m of the start.
  `complete:false` = path to the node closest to the goal (unreachable, or `maxExpansions` hit; default 50 000).
  Extra fields: `kinds[i]` (`WP_WALK|WP_DROP|WP_JET`: how waypoint i is reached), `radius`, `height`, `serial`, `expansions`.
  `cost` = plain travel time (s). `q.avoid = follower` skips jet edges that follower already failed on.
  Jets are used only when `q.allowJet` and `jetEnergy(dz) <= 0.9*q.energy` — pass max energy for far goals; steer waits for regen.
- `steer(state, path, x,y,z, vx,vy,vz, grounded, energy, out)` — call once per decision (0.1 s). `out.stuck` is set only
  after recovery failed (sidestep both ways, jump, short jet; ~3.5 s) or a jet edge failed: replan then (with `avoid`).
  `followerInfo(state)` -> `{idx, done, recovering, waiting}`. Do not OR your own `boost` in while the leg is a jet or
  while `waiting` (regenerating at the foot of a jet): it holds the mech in the air / drains the energy it waits for.
- `walkClear(a, b, radius)` — straight a->b over walk/step-down links with clearance >= radius (directional; start not checked).
- Extras: `nearestNode`, `nearestValidNode(x,y,z,q)`, `nodeSurfaceZ/nodeX/nodeY`, `clearanceAt(x,y,z)` (m, base body),
  `components(q)` / `componentAt(x,y,z,q)` (equal id = mutually reachable on foot, no jets), `reachableFrom(x,y,z,q)`
  (directed flood incl. drops, + jets if allowed; reused mask), `roofNodesNear(x,y,r,out)`, `jetEnergy(dz)`, `graph`.

## Design
- 2 m columns over the 1 m raster (node = raster cell (2I,2J), centre `minX+2I+0.5`); each column holds its standable
  surfaces: terrain (unless buried in a span) and every span top — so ground under a bridge and the deck are two nodes.
  2 m keeps the graph at 194 k nodes / 30 MB and A* under 10 ms worst case; walls are still measured on the 1 m raster.
- Per node: surface z, headroom, and **clearance per body-size tier** (9 tiers, scale 1..2): distance to the nearest
  raster cell whose span crosses [z+step_up, z+height·scale] (lower overhangs become walls for taller bodies) or that is
  outside the map bounds. A query maps radius/height to a tier and a threshold; nothing is baked for 2.5/9.
- Adjacent edges (8 dirs): walk (terrain slope <= 50° checked at half/quarter steps; ledges <= step_up), step-down/drop,
  terrain-cliff jet. Long edges from prism rims, 2–4 cells out: drop rim->landing and jet landing->rim, each with a
  corridor clearance at rim height (side walls) checked against the query radius.
- A*: weighted (1.2) octile heuristic, indexed typed-array heap, generation stamps, wall-proximity cost. Walk runs are
  string-pulled with a 0.5 m stricter clearance; jet/drop edges stay explicit waypoints.
- Steer: look-ahead when the line is clear, clearance-gradient nudge, jet sequence (wait for energy, jump+boost, hold
  above the rim, cut jets over the roof), drop speed control (land on the planned spot), air stall detection, watchdog.

## Measured (M-series laptop, bun 1.4.5; `bun test src/world/nav` prints them)
- Graph build ~225 ms, 194 231 nodes, 146 401 long edges, ~30 MB RSS. World load 31 ms.
- plan: ~300 m median 0.06 ms / p90 0.4 / max 2.5; any distance median 0.2 / max 4; with jets max 5 ms;
  unreachable goal at the 50 k cap ~6–7 ms (60 k: 8.4 ms). Complete paths need p99 20 k, max 43 k expansions.
- steer ~0.1 µs/call in the benchmark loop; walkClear is O(length). Follower on the final code, random pairs at 0/4/10/20 cubes. Project simulator physics (`src/sim` stepMech via
  `_simfollow.ts`): ground 600/600, ground->roof 600/600, roof->ground 800/800, roof->roof 799/800. Own kinematic
  cylinder (`_kinsim.ts`, 1 m raster): 800/800, 800/800, 799/800, 798/800. Time / path cost 0.94-1.02.

## Known gaps
- Static map only (mechs, NPCs, crates are not obstacles; watchdog + replan handle bumps). Polygon edges are known to
  ±0.5 m (raster): gaps under ~6 m for a 2.5 m body may be refused depending on grid phase.
- Stadium upper rim (terrain spikes through prism tops) holds the remaining follower failures. Scale > 2 uses tier 2.
  Roof nodes have no edge margin (a leg may clip a roof corner); no roof-to-roof gap jumps; jets start 4-8 m from a rim.
- Jet energy model (8 + 1.7 per m, climb 8.9 m/s) matches src/sim, not yet the real server.
