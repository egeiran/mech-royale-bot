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
stray bullets do kill squad mates, so one death proves nothing). Otherwise **SQUAD** once the detector says so or
`unknownSquadAfter` (12 s) has passed; before that UNKNOWN = ghost opening (break LOS, silent loot).
- **SQUAD** (`decideSquad`): 1 zone urgent → rotate (boost outside), keep shooting; 2 supply drop reachable → capture
  (strafe inside the ring, keep shooting); 3 mech engaging us or within `engageDist` → duel at `duelRange`
  (gun `rangeGun` = 115 m kite: the house bots' linear lead fails at range; lightning 22 m only against a single
  enemy; vs lightning 58 m), break LOS to reload, disengage to
  cover and regenerate when the race is lost (`squadDisengage*`); 4 shot by an NPC → kill it; by an unseen mech →
  face the bearing, take cover; 5 loot by value − time (lightning > laser > cubes > crates > NPCs; only silent
  loot while hurt); 6 explore inside the next circle, scanning.
- **FFA** (`decideFfa`, "ghost"): 1 zone; 2 end game (alive ≤ `ffaDuelAlive` or radius ≤ `ffaDuelRadius`) → duelist;
  3 found (shot / aimed at with a line) → fight only if cornered (< `ffaCorneredDist`, or fleeing failed for
  `ffaFleePatience`), clearly winning (`ffaFightRatio`) or the enemy is nearly dead; else break LOS (findCover),
  returning fire; 4 we see someone who has not found us → ambush only a nearly dead one, else step out of its
  sight lines and hold, tracking it; 5 nobody: silent loot nearby (weapons, cubes; no gunfire), then walk to the
  best hide spot (low exposure, far from known enemies/noise/NPCs, inside the next circle) and hold, scanning.

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
1. SQUAD: we die to the 2nd/3rd simultaneous hunter at ~100 s (zone closing = no room to kite). No corner play
   (one LOS at a time), kiting has no route planning (backs into walls: ~1 stuck second per 7 matches, then the
   hop-out reflex), kill cubes lie 115 m away and are rarely collected, drops are skipped under fire.
2. Loadout/economy timing is naive: no rush for lightning/laser before the first hunter, crates farmed only when
   calm, mortar never used, laser vs lightning preference untested on the real scorer.
3. FFA ghost: ~1/3 of sim matches still die before 60 s (found at spawn in the open, then a 50/50 duel); hide
   spots are ground-only (no roofs), no prediction of where hunters come from, no ambush logic for the last duel.
4. Regeneration: we rarely get 5 quiet seconds; no deliberate "break contact → heal → re-engage" loop that works.
5. Everything is tuned on our own sim (simpleBot / league imitations), not on the real scorer; `rangeGun`,
   `engageDist`, `unknownSquadAfter`, `val*` are the first params to probe with real submissions.
