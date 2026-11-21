# src/world — static map geometry

`loadWorld(dir)` (dir = `hello.map.dir`, the folder containing `v2/`) returns a `GridWorld`, which implements
`World` from `src/contracts.ts`. Import from `src/world/index.ts`. Units: metres, radians; x east, y north,
z up; yaw 0 = east, CCW. Synchronous, deterministic, no allocation per call (instance scratch only).

## Representation (`raster.ts`)
- Grid: `nx` 1070 x `ny` 724 cells of 1 m, origin (`minX` -513, `minY` -334); cell `c = j*nx + i` covers
  `[minX+i, minX+i+1) x [minY+j, minY+j+1)`. `maxX/maxY = min + n`. `bounds` = playable rectangle (world.json).
- `terrain` Float32, vertex grid (same nx, ny): height at `x = minX+i, y = minY+j`; `groundZ` is bilinear, clamped.
- Spans: prisms (ring minus holes, tested at the **cell centre**, scanline fill) give per-cell `[base, top]`
  intervals, sorted by base, overlaps merged: `k in [spanStart[c], spanStart[c+1])`, `spanData[2k]`, `spanData[2k+1]`.
- `topZ[c]` = max(4 terrain corners, highest span top): conservative "nothing solid above this" per cell.

## API
| call | meaning |
| --- | --- |
| `groundZ(x,y)` | terrain only |
| `surfaceZ(x,y)` | topmost surface from above: max(terrain, highest span top) |
| `floorZ(x,y,z,tol=0.05)` | highest surface (terrain unless buried in a span, or a span top) `<= z+tol`; lowest surface if none |
| `ceilZ(x,y,z)` | base of the first span whose top is `> z+0.05` (if `z` is inside a span: that span's base, `<= z`); `Infinity` = open sky |
| `solid(x,y,z)` | `z < groundZ` or strictly inside a span; `false` outside the grid |
| `raycast(o, d, maxDist)` | distance to the first solid, `maxDist` if none; `d` need not be unit; `lastHit` = `HIT_NONE/TERRAIN/PRISM` |
| `segClear(a, b)` | no terrain/prism on the segment (shots). Exactly symmetric. |
| `sightClear(a, b)` | `segClear` + no trunk + canopy path below the block length. Symmetric. |
| `treesBlock(a,b)`, `canopyPath(a,b)` | tree part only: blocked? / metres inside crowns (`Infinity` = trunk) |
| `canSee(eye, yaw, feet, h, range, fovDeg, nearRange)` | protocol §8: LOS to centre **or** top; near range: any direction, only terrain/prisms block; else range + yaw wedge with trunks and canopy. Distance = 3D eye to target centre. |
| `cellIndex(x,y)`, `inPrism(x,y)` | clamped cell index; does the cell have any span |
| `cellWalled(c, stepUp=1.2, height=9)` | a span overlaps `[ground+stepUp, ground+height]` at the cell centre |
| `wallDist()` | lazy Float32 per cell: distance (m) from the cell centre to the nearest walled cell (or outside `bounds`), minus 0.5 |
| fields | `terrain`, `trees` (struct of arrays), `rules`, `maxTopZ` |

Raycast: 2D DDA over cells with z interpolated. Spans: open z-interval overlap inside the cell (side entry, roof
from above, underside from below; a ray lying exactly on a roof is not blocked). Terrain: the bilinear ground
along the ray inside a cell is a quadratic, solved exactly from 3 samples (the stadium terrain has 40 m steps
between neighbouring vertices). Cells with `ray z > topZ` cost one comparison. A ray starting inside a solid
returns 0. Outside the grid nothing is solid (the ray ends there). Non-finite input returns "no hit".

## Trees and canopy (`world.ts`, block marked CANOPY MODEL)
Trunk = vertical cylinder `trunkR` from `z` to `z+height` (blocks sight only). Crown = ellipsoid centred
`(crownX, crownY)`, horizontal radius `crownR`, spanning `z+crownBase .. z+height` (crownBase is relative to the
tree base). `T = exp(-canopyDensity * metresInCrowns)`, blocked when `T < canopyBlockT` (0.35 / 0.25 => 3.96 m).
The recorded stream confirms this reading (see Accuracy); to recalibrate change only `canopyTransmittance` /
`canopyBlockLength`. Trees are in a 16 m bucket hash; `sightClear` walks only the buckets on the line.

## Accuracy
- Prism walls are quantised to cell centres: +-0.5 m perpendicular to a wall (more along a grazing ray). Against
  exact polygon intersection (3000 random 150 m rays): median error 0.00 m, p90 0.49 m, p97 1.0 m; about 1.5 %
  of rays differ by more than 2.5 m because they clip a building corner narrower than a cell (or miss one).
- Terrain: exact for the bilinear surface. Recorded stream (`mechfight-kit/check`): for all 239 grounded
  observations `floorZ(x, y, z+1) - z` is within +-0.006 m (the 0.01 m rounding of positions).
- Vision vs the same stream (is a known pickup/crate listed in an obs or not; crate height 2.4, pickup height
  0.8 fits best): `canSee` agrees on 652 of 654 samples; best-fit canopy block length 4.0 m (model: 3.96 m).
- Scenery (barriers, cars, water) is ignored, as the protocol says.

## Measured (bun 1.4.5, this machine, one thread)
- `loadWorld`: ~31 ms in a fresh process (259 prisms -> 169 860 span cells); `wallDist()` 21 ms once.
- `raycast`, 200 m rays from eye height in random directions: ~2.8 M rays/s; unobstructed at +60 m: ~2.6 M/s;
  `canSee` at 120 m: ~1.8 M calls/s.
Tests: `bun test src/world` (synthetic hand-computed world, real map, stream checks, benchmarks).
