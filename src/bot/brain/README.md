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
