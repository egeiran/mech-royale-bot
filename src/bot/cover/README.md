# src/bot/cover — where nobody sees us, and how to get out of sight

`createCover(world, nav?) -> Cover` (index.ts; cached per world, deterministic, no allocation in queries except one
closure per `bestHideSpots` call). Import from `src/bot/cover/index.ts`. Study behind the numbers: `data/intel/ghost.md`.

## API
| call | meaning | cost |
| --- | --- | --- |
| `cover.field` (`ExposureField`) | 4 m grid, 2 layers (ground, roof = prism top > 3 m above terrain). Per cell: `expo` 0..255 (threat x area weighted share of ground observers within 200 m that see a 9 m mech there, centre or top, §8 without the yaw wedge), `near` (same within 45 m), `roofSeen` (observers standing on roofs), `sect[16]` (per 22.5° bearing), `edge` (m to wall / roof edge), `z`, `flags` (`F_STAND`, `F_ROOF`, `F_SKY` = roof cell no ground sample sees) | - |
| `cover.exposureAt(x,y,z)`, `exposureToward(field,x,y,z,bearing)`, `isSkyOnly(field,x,y,z)` | 0..1 lookups (1 = not standable) | < 0.1 us |
| `cover.bestHideSpots(zoneCx, zoneCy, zoneR, fromX, fromY, opts, out)` | ranked spots inside a circle (pass the circle the zone is closing TO) into a `createHideSpots(cap)` buffer: `x,y,z,score,expo,near,dist,edge,magnetDist,exits,lowNbrs,roof,needJet,jetEnergy,seenNow`. `opts`: `magnets` (x,y pairs: crates, NPC homes, pickups, drops), `enemies` (x,y,z triples), `navQuery`, `allowJet`, `energy`, `allowRoof`, `maxDist`, `maxExpo`, `minMargin`, `weights`, `nav` | 35-120 us |
| `cover.visibleToAny(x,y,z,h, enemies, n, anyYaw?)` | index of the first `EnemyView {x,y,z,yaw,cubes?,sensors?}` that sees us (exact `world.canSee`), -1 if none; `anyYaw` ignores the wedge | 0.5 us / enemy |
| `cover.safeDirection(x,y,z,h, enemies, n, maxDist, out)` | nearest straight-walkable point (rings 4..52 m x 16 directions) hidden from ALL given enemies: `out.found, dx, dy, dist, x, y, z` | 20-60 us |
| `cover.segmentExposure(a, b)`, `cover.pathExposure(pts, n)` | static "exposed metres" of a segment / NavPath (integral of `expo`): the cover-path cost hook, nav-independent | 0.3 us / 250 m |
| `cover.segmentSeenFrac(a, b, h, enemies, n)` | share of the segment visible to known enemies (wedge ignored) | ~1 us / sample / enemy |

Score of a spot (lower = safer; `DEFAULT_WEIGHTS` in hide.ts): `expo + 0.03 near + 0.03 roofSeen + 0.12 (1 - magnetDist/80) + 0.4 dist/300
+ 0.06 roof + 0.08 jet + 0.03 dead-end + 0.04 centre pull + 0.3 enemy within 60 m + 0.6 enemy has line of sight` (the last one
by rays, for the best 12 only). Candidates are the 1215 local exposure minima (5x5 cells); circles of r <= 100 m are scanned
cell by cell (`id < 0`). Reachability: same nav component = on foot; otherwise `needJet` (roof: `nav.jetEnergy(height)`;
walled yard: a guess) and the spot is dropped unless `allowJet` and `jetEnergy <= 0.9 energy`. Verify the top picks with `nav.plan`.

## Build
- The map never changes, so the field is **baked**: `bun src/bot/cover/bake.ts` (14 s, 48 directions x 11 distances per cell)
  writes `exposure.baked.ts` (gzip+base64 string, 0.94 MB, survives bundling). Startup = decode + surfaces:
  **~18-35 ms**, hide index 3-7 ms, **+8-9 MB RSS** (typed arrays 2.4 MB).
- If `worldFingerprint(world)` does not match the blob (different map), a coarse field is computed in process
  (`RUNTIME_SAMPLING`: 12 m lattice, 12 x 3 samples): ~0.1-0.2 s, Pearson r = 0.90 against the bake. Re-bake when the map changes.
- Tests: `bun test src/bot/cover` (11 tests; prints build time, memory, per-query times; numbers above are from an idle core, about 2x under load).

## Validation against the real showdowns (ghost.md section b; `data/tmp/cover/{cf,cfstat,auc}.ts`)
Counterfactual: for 7 recorded top-16 matches, every standable cell was tested at 5 Hz against all real eye positions and
aim yaws ("would a mech standing here have been seen?").
- Ground cells still inside the zone, never seen until 120 s, by baked exposure: < 0.02: 100 % (n=9), 0.02-0.05: 85 %,
  0.05-0.10: 36 %, 0.10-0.20: 17 %, 0.20-0.35: 3 %, all cells: 5 %. Until 180 s: 100 / 83 / 26 / 7 / 1 %, all: 2 %.
- AUC of exposure for "never seen until t": 0.61 (60 s), 0.73 (120 s), 0.87 (180 s); full static score (exposure + magnets
  + centre + roof): 0.65 / 0.75 / 0.88. Best 0.1 % of cells by exposure: 97 / 94 / 90 % never seen.
- Rank correlation over ALL cells is weak (Spearman 0.21 with seen-seconds, 0.38 with time of first sighting; per match
  -0.11..0.51): in the mid range, where the bots happen to walk decides. The field is reliable in its low tail only.
- Policy replay (16 spawns x 7 matches, HP-budget model): `bestHideSpots` top pick + walk there = alive at 120 s in 67-70 %
  of runs (real bots: 44 %), mean place 7.2-7.5 (field 8.5); + `pathExposure` route choice + `safeDirection` when seen: 6.7-6.8.
  Seeking the lowest exposure at any distance was far worse (10.4), hence the travel weight 0.4 and `maxDist` ~150.

## Caveats
- Exposure counts ground observers only (bots were on roofs 3 % of the time); `roofSeen` covers the rest. Observer cubes
  (taller eyes) and sensor upgrades (+25 m) are not in the static field: use `visibleToAny` for known enemies.
- Roofs are NOT hiding places: one sky-only cell on the whole map; a mech on a roof shows its top to ground eyes far away.
  Roof interiors >= 30 m up are safe from the 45 m proximity ring only.
- `expo` is the body's centre-or-top rule at the cell centre; walls are known to +-0.5 m, so check `visibleToAny` after arriving
  and shift 1-2 m. Pockets (expo < 0.05) are rare: 22 ground + 20 roof clusters; a 240 m circle holds 2-6.
- `safeDirection` walks straight lines on the 1 m raster (no nav): it can miss covered points around a corner.
- `exits` / `lowNbrs` come from the 4 m grid (12 m straight runs), not from nav; `jetEnergy` for walled yards is a guess.
