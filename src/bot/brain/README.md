# src/bot/brain — decision core ("ai-caramba")

`mainBot: BotFactory` (index.ts). Per observation: **Blackboard.update → strategy.decide → Executor.run**.
All state lives on the instance (16 bots share the process in the sim); only static per-World caches are module level.

## Files
- `params.ts` — `DEFAULTS`: every tunable number, flat and numeric; `ctx.params` overrides any key.
- `blackboard.ts` — world model: self/weapons summary, `tracker` (EnemyTracker), `sounds`, `modeDet`, `zone`
  (ZoneModel), `loot` (LootMemory: crates/cubes/pickups, removed when seen gone / taken / forgotten), per-enemy
  `los[id]` (we have a shot line) and `sees[id]` (it can see us), threats, `npcAggressor`, damage/regen timers,
  `mem` (StratMemory: hysteresis for strategies), `intent` (reused).
- `zone.ts` — circle at time t (exact inside the known shrink, config schedule after it with the centre held at
  next_center), `margin`, `marginNext`, `marginAt`, `timeUntilOutside`, `dpsAt`.
- `intent.ts` — vocabulary: `goto / fight / loot / flee / hold / capture` + pace (silent|walk|boost), target id,
  crate to shoot, fight style/range, `weaponsFree`, face policy (scan|threats|yaw|travel), take/drop wishes.
- `navx.ts` — `Mover`: adapter over `src/world/nav` (one plan per decision; replan when the goal moved, the plan is
  old, following was interrupted, or the follower reports stuck; straight-line "bug" steering if plan() is null),
  `walkOk/blocked` probes, `findCover` (nearest point no threat has a line to), `findHide` + `exposureAt`
  (static open-ness field, lazily cached per World).
- `execute.ts` — Intent → action: path following, duel footwork (range band + random strafe, wall/zone aware),
  dodge (tactics/dodge), gun lead + fire gate + muzzle line-of-fire check (never shoots walls), lightning
  (server target prediction, energy reserve), laser charge/release, reload policy, take/drop, facing/scanning,
  "never stand still under fire" reflex. `stats` counts slow decisions / stuck episodes.
- `warmup.ts` — JIT warm-up on throw-away instances (the real bot's state is not touched).
- `eval.ts` — sim harness (below). `brain.test.ts` — zone, loot memory, blackboard on the recorded stream, determinism.
- `../strategies/common.ts` — damage race (`ourDps/theirDps/fightRatio`), `pickTarget`, `duelRange`, `bestLoot`
  (value − time), `zoneDuty`, `wantDrop`, `weaponReflex`, `pickUpgrade`.
- `../strategies/squad.ts`, `../strategies/ffa.ts` — the two strategies.

## Decision flow
Mode (blackboard.ts): **FFA** latches on deaths our own fight cannot explain: 2 "quiet" deaths (by another hand
while we dealt/took no damage for `quietDeathS`), 1 before `ffaEarlyT`, or `ffaOtherDeaths` in total (hunters'
stray bullets do kill squad mates, so one death proves nothing). Otherwise **SQUAD** from `unknownSquadAfter`
(default 0 = from the first tick; a positive value plays `decideFfa` as the opening until then).
- **SQUAD** (`decideSquad`, kill tempo at close range - real scorer: 14 m 4.48 vs 115 m 4.02):
  1 zone urgent -> rotate (boost outside), keep shooting; 2 supply drop reachable -> capture (strafe inside the
  ring, keep shooting); 3 any visible mech (`engageDist` 250) -> if a cube / wanted weapon lies within
  `duelLootDist` grab it while shooting (kills drop cubes + 2), else duel at `duelRange` (14 m; gun + lightning);
  with several enemies orbit so the target shields us (`shieldOrbit`); disengage to cover when the race is lost
  (`squadDisengage*`, no measurable effect on the real scorer); 4 shot by an NPC -> kill it; by an unseen mech ->
  face the bearing, take cover; 5 loot by value - time (lightning > laser > cubes > crates > NPCs; silent loot
  only while hurt); 6 healthy (`seekHp`) and alone -> walk to the freshest known enemy position; 7 explore.
- **FFA** (`decideFfa`, owned by the FFA agent - see ffa.ts): ghost first, duelist (`duelIntent`) as fallback.

## Style 1 "laser kite" (`style: 1`, squad agent, 2026-11-21 evening)
`params.ts STYLE_LASER_KITE` is applied under the explicit params when `style` is 1 (data/intel/teams.md: top bots
carry a laser and fight at 60-90 m backing off; house guns hit 32 % there, house lasers ~20 %): laser first
(`valLaser`, `valSwapToLaser` swaps lightning out), `rangeLaser`/`rangeGun` 75 m with `rangeBand` 10 and a boost to
re-open inside 45 m, `laserKeepGun` (gun keeps firing during the charge), `peekMargin` (fight from a point only the
target sees), break-off at 70 % HP (`squadDisengage*`, `squadHealUntil`), no mid-fight looting within 6 m but kill
cubes / weapons collected while every visible mech is >= `lootClearDist` from them. Lightning without a laser keeps
the 14 m duel. Sim log: data/tmp/squad/log.md.

**Laser release fix (default):** on the release decision the aim command now is the aim the release gate checked.
Before, the gun lead stayed commanded and beams left 2-5 deg off (our laser hit ~33 %, now ~90-100 %).
`laserLegacyRelease: 1` restores the bug (calibration anchors only).

Other squad params added (default off unless noted): `seekSoundS` (walk to the freshest armed-mech sound),
`npcFirstDist` (kill an NPC that shoots us mid-duel first), `dropFightLeadS`, `peekMargin`/`peekEvery`,
`mortarFire` (flat-arc mortar use), `ghostT`/`ghostKills`/`ghostOnUs`/`ghostHealHp` (play the FFA ghost; all lost in
sim and the real ghostKills 4 probe), `ambushDist` (bad), `targetDpsW`, `engageHurtDist`, `duelLtgDist`,
`squadHealUntil`/`squadLootTimeCost` (squad-mode-only overrides), `idleHold`, `crateLaserW`, `boostTravelDist`
(now wired). `eval.ts --trace <dir>` writes per-decision JSONL for data/tmp/squad/trace_an.py.

## Laser / nav / finish params (laser agent, 2026-11-21 night; all off unless noted)
Harness on REAL layouts (live replay headers via `src/sim/loot.ts layoutHook`): `bun data/tmp/laser/harness.ts
--opp none|squad --seats 3 --files 70 --T 60 --params k=v`. Real layouts = sim generator statistically (lasers/match
12.8 vs 13.6, spawn->laser p50 108/107 m, spawns seeing a laser 39 %/39 %).
- `jetScan` m (opening: jet straight up while spinning; +25 m: spawns seeing a laser 39 -> 64 %), `laserRush` m (go
  for a known laser with boost, also out of a duel; `laserRushFinish/Crowd/Energy`), `ltgVetoLaser` m (no lightning
  while a laser is known). Squad hunters, real layouts: laser by 30/60 s 52/62 % -> 61/75 %.
- `navBodyFromCubes` (default ON): the real server reports unscaled self.stats.radius/height; plan with the grown
  body (6-cube loop under the 11.5 m bridge at (-108,-33)). `navWatchdogS` s: no progress near one spot -> replan
  1.15x bigger, on foot for 12 s; 2nd trip blacklists the goal (`bb.addBadGoal`, wantDrop skips it); repeated
  hop-outs do not jet. Test: navloop.test.ts.
- `finishChaseHp` (+`finishChaseRange/Crowd`: boost after a fleeing nearly dead mech), `rangeGunOnly` (gun-only duel
  range vs every mech), `gunFarDist`/`gunFarHp` (no gun at healthy mechs beyond it without a laser).

## Tempo variants (tempo agent, 2026-11-21 late; all off by default; data/tmp/tempo)
Sim, final config + params, 384 seeds (two 192-seed halves) vs the league squad, base 6.90 / 6.76:
- `tempoHunt: 1` (+`tempoHuntLoot/SoundS/Energy`): no fight -> boost to the freshest known (45 s) / heard (20 s)
  mech, no NPC / crate farming or far loot (cubes / weapons within 40 m first). +0.15 / +0.23, kills by 60 s
  2.91 -> 3.30 / 2.95 -> 3.22. The laser is otherwise ready with nobody in sight 32 % of its held time.
- `snipePost: 1` (laser): nobody in sight -> stand on the most open ground spot (cover exposure field) within
  `snipeR`, 10 s per post; `snipePost: 2` = only the duel part: a laser target beyond the kite band with a line and
  within `snipeMaxDist` is fought from where we stand. 1: +0.01; 2: -0.22; `tempoHunt 1 + snipePost 2`: +0.46 / +0.20.
- `dropRefuelHp` (+`dropRefuelDist`): go for a reachable drop through fights when hurt: -0.18 (captures 14 -> 20
  of 192, but alive at 95 s 81 -> 74). `dropDrift` (+`dropDriftDist`; intent `driftW/X/Y` in fightMove): duel
  footwork drifts toward a called drop: -0.09, captures 14 -> 16.
Laser cycle (no change needed): in duels the laser is idle-ready only ~3 % of the time, median hold at full
charge before release 0.1 s (mean 0.32, 9 % auto-fire after LOS loss). Tools: `data/tmp/tempo/run.sh`,
`tempo_an.py` (kills by 60/100 s, first-100 s shares), `paired.py`, `laser_cyc.py`, `drop_an.py`.

## Squad-dev variants (squad-dev agent, 2026-11-22 night; all off by default; data/tmp/squaddev)
Harness: `data/tmp/squaddev/h.sh <name> squad|none <T> <seats> <params> [squad overrides]` (real layouts, final
config; prints crates broken by 15/30/60 s, first cube, kills by 60/100 s, SCORE = 16 - place, kills / survival after 72 s,
damage taken per intent label after 72 s).
- **Crate reflex** `crateReflexDist` m (+`crateReflexSafe/Until/MaxS`, `crateCollectS`, `crateScan`; squad.ts
  `crateReflex`, step 2' before the fight branch): no mech within crateReflexSafe and nothing on us -> stand and shoot
  the best visible ground crate with a clean line, then collect its cube / dropped laser; crateScan 1 also locks onto
  one from the air after a full jet-scan turn. `60 / scan 1 / crateLaserW 1 / safe 100` vs final (230 runs, --opp
  squad): crates by 30 s 0.10 -> 0.54 (no opponents 0.31 -> 1.08), finished 44 -> 79 %, first cube 25.0 -> 21.4 s,
  laser by 60 s 70 -> 75 %, kills 5.60 -> 6.22.
- **Train kiting** `kiteTrainN` (+`kiteTrainR/T/HoldS/Look/BoostE/BoostDist/Laser/Dist/From`; squad.ts `trainKite`,
  step 2'' before the crate reflex and the fight branch): with >= N pursuers (laser held) run a 16-direction route away
  from the pack centroid (walkable 90 m ray, no dead end, zone margin, clear of pursuers, open ground) with boost bursts,
  shooting the nearest pursuer with a line; `kiteTrainDist` stands and shoots while every mech is beyond it. Sim (345
  runs) `N 2 / Dist 120 / BoostDist 130 / BoostE 30 / From 60`: swarm 6.59 -> 6.86 (survival after 72 s 21.9 -> 24.3 s),
  slow pursuit (`all.huntRadial=0.15,all.boostDuty=0,all.gunMaxDist=240`) 6.65 -> 7.02, allAt 999 10.10 -> 10.15 (kills
  by 60 s unchanged). The sim swarm closes at ~7 m/s with boost from all sides (real 0-3 m/s): under-rates it.
- warmup.ts now fetches the exposure field before `ready` (first fetch ~37 ms; the eval harness has no warm-up, so
  its decision max shows it once per process).

## Play-lab variants (play-lab agent, 2026-11-22 night; all off by default; data/intel/play2.md, data/tmp/play)
Measured on the public play server (`src/tools/play-client.ts --src <frozen tree> --params forceMode=1 --ab k=v`,
analysis `data/tmp/play/an2.py`, `ab.py`; the client records the live intent per decision).
- `dropSafeHp` (HP fraction; no "hurt -> drop through a fight", below it only uncontested drops with nobody in sight)
  + `dropMaxLateS` (s; skip drops we reach that long after they land; common.ts wantDrop). Play A/B 8 v 8: drop
  deaths 3/8 -> 0 but kills 3.5 -> 2.1, dealt 56 -> 41 HP/s, first-minute damage -40 % (p 0.02), placement equal:
  not worth it (the drop brawl is where the FFA kills are; freed time went into idling).
- `zoneGuard` m (common.ts `zoneOutside`, bestLoot `zoneGuard` arg, squad.ts seek/hear/explore/laser rush): no goal
  at zone level 0 where zoneDuty would switch to level 1 on arrival (the +-4 m zone/seek flip-flop, 31 s in one match).
- `crateStandOff` m (common.ts lootIntent, squad.ts step 5): stop outside the gun's min-pitch cone from a crate, step
  back when closer, give a crate up for 30 s after 5 s standing at it without denting it (parked 0.6 m from a crate
  for 58 s). Sim 96 seeds `zoneGuard 8 + crateStandOff 8`: 6.91 -> 6.92, flip-flop 114 -> 42 s, crate stall 365 -> 71 s.

## Roof fortress (fortress agent, 2026-11-22 morning; all off by default; fortress.ts)
`fortress.ts` + squad.ts step 1' (right after the urgent zone step). Triggers (any): `fortOnUs` (>= N visible mechs
shooting / aiming with a line / within `fortNearR`), `fortT` (match time; after a quiet release again only with a
pursuer in sight), `fortHp` (+ >= 2 pursuers), `fortKills`; `fortFrom`, `fortLaser`. Roof catalogue (static per World,
~2 ms, warmup.ts prefetches it and, when fort* is on, warms the code on a roof): exposure-field roof cells, >= 6 m from
every edge, grouped by surface, stadium excluded. Pick: `fortMinH` / `fortEdge` / safe radius `fortSafeR` (edge + edge
(h - 7) / (body h / 2): no ground muzzle closer than that has a line to our centre) / climbable with 85 % energy /
`fortMaxDist` / next circle by `fortZoneMargin` and inside at arrival + `fortStayS`; score travel x (1 + 0.25 onUs) +
exposure - safe radius / 12 + pursuers closer to it than us. Travel with jets even under fire (`intent.forceJet`); give a
roof up on no path / watchdog bad goal / late (3 failures -> release 30 s). On the roof (`intent.stayUp`: footwork, dodge,
strafe and hop-out never step toward a drop): hold the deepest cell (body must fit) on the far side from the pursuers,
moving out of the line of known shooters (0.5 s re-check, hysteresis, frozen while fighting an arrival < 45 m), shoot
mechs with a line first, collect cubes on the roof (`fortCubeDist`), optional peek-snipe (`fortPeek`), relocate when
the circle leaves the spot within `fortRelocS` (60 % requirements; loop guard), release after `fortQuietS` with no
pursuer seen / heard near / damage. Sim (48 seeds, final-s0 + params, vs league squad; base 7.40): `fortOnUs 2 /
fortFrom 45` 6.67, `fortT 90` 7.29, `fortOnUs 3 / fortFrom 60` 7.10: sim hunters climb (~1 per match) but also
jet-jump-shoot from 8-16 m within 80 m and shoot from 80-130 m ground; on the roof we deal 81-112 HP/s vs take 29-47
(off roof 130-180 vs 40-70): same ratio, half the tempo. Harness: scratch fh.ts (not kept).

## Focus fire / kill confirmation / phases (focus agent, 2026-11-22 morning; all off by default)
squad.ts `focusTarget` / `focusFinish`, params `focus*`, `phaseT` + `ph*`, `seekFrom` (see params.ts). Sim, KT params,
384 seeds per squad model (A2 = calib3 best fit, C2, B1, R1 = +1 hunter per kill, v2 default), late = after 72 s:
regen undoes only 3.5-5 % of our late mech damage, abandoned damage 5-8 %, damage left on live mechs at our death
14-27 %, recent damage on other mechs at each late kill 250-400 HP; late output 150-195 HP/s, 2150-2300 HP per kill
(target max HP ~1830): conversion is fine, survival limits. `focusFire 1`: A2 -0.02, v2 -0.15 (no gain).
`focusFinishHp 0.3 + focusFinishCrowd 1`: KT A2 +0.21 +- 0.14, v2 -0.20; FARM C2 +0.38, A2/B1/R1 -0.05..-0.11.
FARM vs KT: -0.4..-0.9 in every time-scheduled model (fewer cubes: kills are the cube source), +0.07 (+8 s alive) in R1.

## Pacing / drops (r1-opt agent, 2026-11-22 morning; all off by default)
New params: `phaseCubes` / `phaseKills` (the `ph*` switch also fires at N cubes / N kills), `spare*` (squad.ts
`spareNow`: a mech below `spareHp` is not finished and the fight branch is skipped while cubes < `spareCubes` or
no laser with `spareLaser`, before `spareUntil`, own HP >= `spareSelfHp`, < `spareOnUs` others on us),
`dropUntil` / `dropFrom` (common.ts wantDrop time window). Squad model "M1" (fits the real kill curve and the
KT/FARM/base/fortress levels, NOT the real FARM > KT order): R1 + `all.cubeStart 3, cubeRate 4, cubeMax 16,
huntSpeed 0.5, huntBoost 0, strafeMul 1.3, allAt 140`; cross-checks MA (huntSpeed 0.75) and R1. Paired vs FARM, 576
seeds each, M1 / MA / R1: `valDrop 0` +0.30 / +0.25 / +0.28 (the 95 s drop walk is the loss; `dropFrom 120` same);
+ `phaseCubes 8` to KT hunting +0.43 / +0.20 / +0.32; KT + `engageDist 80` + `valDrop 0` + `upNanites 120` +0.47 /
+0.38 / +0.13; spare variants -0.35..-2.1 in M1 (kill tempo is the cube source); `engageDist 30` -0.19, upgrade
orders +-0.1. Scripts (scratch, not kept): r1/rr.sh, mb.sh, scan.sh, sana.py.

## Laser-2 variants (laser-2 agent, 2026-11-22 morning; all off by default; data/tmp/laser2)
Harness `data/tmp/laser2/h.ts --base farm|farm2 --seats 2 --v --params k=v` (real layouts of every distinct live
header, FARM / FARM2-nodrop params, sim squad, no replays; prints laser held by 15/30/45/60/90 s, kills, and a reason
table for no laser at 45 s); `run.sh`, paired stats `pair.py`. FARM2 base: laser @45 s 70 %; of the rest 62 % never
saw one (hidden ground lasers, median 152 m), 16 % got it after 45 s, 7 % fighting, 7 % died.
- `rushRoofFight` m (squad.ts rushLaser: roof lasers up to this climb also mid-fight) + `rushForceJet` (rush travel
  jets under fire): together +4.7 pp laser @45 s (alone +2.8 / 0). `rushZone1` (step 5' rush also at zone level 1)
  +0.6. `rushNoScan` m (no jet scan when a ground laser is in sight at spawn) and `rushBoostHi` (rush boost with
  hysteresis down to laserRushEnergy): ~0 at 45 s, laser ~2 s sooner. All six (150/60/20/25/1/1): +5.5 +- 1.3 pp.
- No gain on FARM2: `crateNoLasDist/Safe` (crate reflex while no laser), `jetPeekS` (+`jetPeekE/Safe/From/Until`:
  repeat the jet scan when calm and no laser known), `ltgNoLasVal/T` (lightning fallback, common.ts pickupValue),
  `laserHuntFirst` (+`laserHuntLoot/Centre`: explore unseen cells before farming), jetScan 30 (-2.8).

## Centre hold (2026-11-22; off by default)
`centerHold: 1` (squad.ts step 6''', replaces explore, after seek): walk (no boost, no jets) to an open ground cell
(exposure field ground layer, >= 6 m from walls, same on-foot nav component) within `centerHoldR` (60) of the next
circle's centre, re-picked when that centre moves, and hold there scanning; from `centerHoldFrom` s. FARM explores only
0.4 % of decisions (loot reaches 260 m), so alone it is inert: batch 3001..3048 vs FARM 6.85 / 6.83 (45 ties).
`centerHoldLoot` m (0 = off) bounds loot step 5 meanwhile: 40 -> 7.02 / 6.83 (n.s.), distance from the next centre at
30 / 60 s 279 / 264 -> 256 / 210 m (spawns ~285 m out; the circle is ~380 m for the first ~100 s). REAL: + loot 40
5.09 vs FARM 5.5. `edgeHold: 1` (precedence; `edgeHoldMargin` 45, same From / Loot params): the spot is edgeHoldMargin
inside the next circle on the side away from the recency-weighted centroid of known mechs (none: our side), re-picked
on a new next circle or (after 8 s) a > 1 rad side change; holds sweeping toward the centre. + loot 40: batch 6.56 /
6.83 (n.s.), cubes 5.7 / 7.1; edge walks p50 41 m (FARM already idles near the edge).

## Params (see comments in params.ts)
Ranges `range*`, `engageDist`, `kiteBoost*`; fire control `fireMinP`, `gunMaxDist`, `fireMarginSigma`, `targetJink`,
`lightning*`, `laser*`, `reload*`; fight evaluation `enemyHitP0/HalfDist`, `squadDisengage*`, `squadRegenUntil`,
`cover*`, `reloadCover*`, `ffa*`, mode `quietDeathS/ffaEarlyT/ffaOtherDeaths`; loot values `val*`, `loot*`, `npcMinHp`, `drop*`; zone `zone*`; stealth `silent*`,
`hide*`, `exposureRay`, `enemyMemoryS`; nav `replan*`, `navMaxExp`, `probeDist`, `dodgeOverride`; scan `scan*`;
upgrades `up*` (score per upgrade id); `forceMode` (1 squad, 2 ffa), `unknownSquadAfter`.

## Eval
```
bun src/bot/brain/eval.ts --seeds 48 --opp squad            # vs the league's 15 house imitations + director
bun src/bot/brain/eval.ts --seeds 30 --mode ffa --baseline  # ghost vs 15 simpleBots, + simpleBot in our seat
bun src/bot/brain/eval.ts --mode squad --opp mix --params rangeGun=90,fireMinP=0.2
bun src/bot/brain/eval.ts --opp squad --timeline 7 --tlEvery 10   # per-decision timeline of one match
```
Prints per match: place, score, kills, death time and cause (attackers × weapon in the last 6 s), last intent, mode;
summary: mean ± se, exceptions, stuck episodes, decision ms. Also: `bun src/league/batch.ts --candidate main ...`.

## Known weaknesses (ranked by expected score impact)
1. SQUAD: every close duel is a damage race we only win through loadout (lightning in ~50 % of sim matches,
   mean t = 24 s) and cubes; nothing yet makes the hunters miss or lets only one of them shoot (no corner play,
   `shieldOrbit` is a first step). Death is by 2-3 simultaneous hunters at ~60-100 s.
2. The league squad sim has the WRONG SIGN for engagement distance (it prefers 115 m, reality prefers 14 m);
   only loadout/loot/tempo/robustness conclusions from it are trusted. Each such change still needs a real probe.
3. No working heal loop (needs 5 s without dealing or taking damage; hunters walk straight at us), drops are
   taken only when calm, hurt (< 75 % HP within 150 m) or within 35 m.
4. Opening: no deliberate lightning rush beyond loot value - a 360 deg scan and a known-roof/jet plan are missing.
5. Fight footwork is still built for dodging (random strafe) although nothing dodges at 14 m; duel movement
   blocked by mechs/crates (not in the nav map) costs ~1 stuck second per 10-30 matches (then the hop-out reflex).
