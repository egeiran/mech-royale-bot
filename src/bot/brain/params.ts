/**
 * Every tunable number of the brain, flat and numeric, so `ctx.params` can override any key and a tuner can
 * search them. Units: metres, seconds, radians unless the name says otherwise. Fractions are 0..1.
 */
export const DEFAULTS = {
  /** play style preset applied under the explicit params: 0 = default (close-range duelist),
   *  1 = "laser kite" (STYLE_LASER_KITE below: laser first, fight at 65-85 m backing off, break off at 70 % HP
   *  to regenerate behind cover, fight from a point only the target sees, no mid-fight looting) */
  style: 0,
  // ---------------------------------------------------------------- mode
  /** 0 = auto (perception/mode.ts), 1 = force SQUAD, 2 = force FFA */
  forceMode: 0,
  /** no decisive FFA evidence (a death by another hand) by this time: play SQUAD; before it: ghost opening */
  unknownSquadAfter: 0,
  /** a death by another hand counts as "quiet" (FFA evidence) when we dealt/took no damage for this long */
  quietDeathS: 6,
  /** one quiet death before this time is enough for FFA (later: two) */
  ffaEarlyT: 45,
  /** this many deaths by another hand (quiet or not) also mean FFA */
  ffaOtherDeaths: 5,
  /** also latch FFA when the soft detector (perception/mode.ts log-odds) reaches this; 99 = off (its cues fire
   *  in squad matches too: hp drops, cross aim, far sounds reached +7.7 in a league squad match) */
  ffaSoftLatch: 99,
  // ---- final-integration mode knobs (data/intel/final-plan.md); all off by default
  /** this many deaths by another hand (quiet or not) before modeDeathsT latch FFA (0 = off). Real top-16
   *  showdowns: the 2nd death by 25/30/35 s in 57/89/95 % of matches; squad sim: 2 by 45 s in ~2 % */
  modeDeathsN: 0,
  modeDeathsT: 45,
  /** positive SQUAD evidence: nobody died by another hand by this time -> SQUAD for good (no FFA latch after it;
   *  0 = off). Real showdowns: the 1st death came before 30 s in 43 of 43 matches */
  modeSquadLockT: 0,
  /** timing hint (0 = off): the median gap between our answer and the next observation over the first 16
   *  decisions (runner ctx.rt.gaps) above this many ms means "not the practice scorer" (measured there: 1-5 ms).
   *  It never switches the squad brain off on its own unless modeGapUnknownS > 0; it only: */
  modeGapMs: 0,
  /** ... latches FFA on this many deaths by another hand (any, before 100 s) and skips the squad lock */
  modeGapDeaths: 1,
  /** ... plays the UNKNOWN (FFA ghost) opening until this time (0 = no: squad opening as without the hint) */
  modeGapUnknownS: 0,

  // ---------------------------------------------------------------- engagement range
  /** preferred duel distance with gun only */
  rangeGun: 14,
  /** preferred duel distance when we hold lightning (inside its 45 m range) */
  rangeLightning: 14,
  /** preferred duel distance while we hold a laser (0 = use the other range* keys) */
  rangeLaser: 0,
  /** preferred distance when the enemy holds lightning and we do not (stay outside its arc) */
  rangeVsLightning: 14,
  /** preferred distance with a laser against an enemy that holds a mortar (cook-off) */
  rangeLaserVsMortar: 14,
  /** preferred distance when the enemy holds a mortar and we have no laser (hug: its splash hurts it) */
  rangeVsMortar: 12,
  /** SQUAD: a visible mech that is not engaging us is only duelled inside this distance */
  engageDist: 250,
  /** ... and only inside this distance while HP is below squadRegenUntil */
  engageHurtDist: 999,
  /** boost away along the most open direction when the target is closer than the preferred range by more than
   *  this (needs kiteBoostEnergy). 999 = off: neutral-to-negative against the league squad (96 seeds). */
  kiteBoostGap: 999,
  /** duel footwork with several mechs in sight: weight of a drift away from the others (0 = off, 1 = as strong as
   *  the strafe) */
  kiteAwayW: 0,
  kiteBoostEnergy: 25,
  /** boost toward a target further than this (closing time is time under fire without dealing damage) */
  approachBoostDist: 999,
  /** ... while energy is above this (above lightningKeepEnergy when we hold lightning) */
  approachBoostEnergy: 35,
  lightningKeepEnergy: 75,
  /** in a duel, still pick up cubes / wanted weapons lying within this distance (kills drop cubes + 2) */
  duelLootDist: 32,
  /** in a duel, collect cubes / wanted weapons within lootClearMax m while every visible mech is at least
   *  lootClearDist m from the item (0 = off) */
  lootClearDist: 0,
  lootClearMax: 90,
  /** ... clearance used for weapon pickups instead (0 = lootClearDist) */
  lootClearWpn: 0,
  /** without a laser: seconds of sound-lead score credited to laser sounds (0 = off) */
  seekLaserBonus: 0,
  /** without a laser: seconds of time-to-kill credited to a target that holds a laser (0 = off) */
  targetLaserBonus: 0,
  /** in a duel, go for a known ground-level lightning pickup within this distance (0 = off) */
  duelLtgDist: 0,
  /** ... and for a laser (when we hold none) within this distance (0 = off) */
  duelLaserDist: 0,
  /** SQUAD: with at least this HP fraction and nobody in sight, go and look for the next mech */
  seekHp: 0.6,
  /** SQUAD laser hunt (1 = on): without a laser and before laserHuntUntil s, with nothing to fight or loot, walk to
   *  the nearest map area (50 m cells) not yet within laserHuntSeenR m of us, scanning (instead of seek / explore) */
  laserHunt: 0,
  laserHuntUntil: 150,
  laserHuntSeenR: 90,
  /** SQUAD: nothing to loot and nobody in sight -> hold position and scan instead of seeking / exploring (1) */
  idleHold: 0,
  /** SQUAD: nobody known -> walk toward armed-mech sounds heard within this many seconds (0 = off) */
  seekSoundS: 0,
  /** SQUAD: reload before contact when the target is further than this and the mag is below reloadIdleFrac
   *  (999 = off: -0.5 against the league squad, it kept interrupting the approach fire) */
  reloadFarDist: 999,
  /** with several enemies in sight, orbit the target until it stands between us and the others; this is the
   *  angular tolerance (rad) inside which we stop orbiting and strafe randomly. 0 = off */
  shieldOrbit: 0.3,
  /** several enemies in sight: fight from a nearby point (<= 14 m) where only the target has a line on us when
   *  it beats staying put by this score margin (one exposed other ~ 40-60). 0 = off */
  peekMargin: 0,
  /** re-evaluate the peek spot every this many seconds */
  peekEvery: 0.5,
  /** scale of the peek search rings (5 / 9 / 14 m at 1) */
  peekScale: 1,
  /** SQUAD: an NPC drone shooting us from within this distance during a mech duel is killed first (when it is
   *  closer than the mech, the mech is beyond 30 m, or the drone is nearly dead). 0 = off */
  npcFirstDist: 0,
  /** SQUAD: hold fire on a mech that has not noticed us (not aimed / shot at us, not hit by us, we are not
   *  hurt) until it is this close. 0 = off */
  ambushDist: 0,
  /** target choice: seconds of time-to-kill a mech's damage per second on us is worth, per 100 dps (0 = off) */
  targetDpsW: 0,
  /** SQUAD survivor mode (latched): play the FFA ghost (decideFfa) from this match time, after this many kills, or
   *  once at least ghostOnUs mechs shoot / aim at us at the same time (not before ghostOnUsAfter s). 0 = off */
  ghostT: 0,
  ghostKills: 0,
  ghostOnUs: 0,
  ghostOnUsAfter: 0,
  /** SQUAD evasive heal: below this HP fraction play the ghost (break contact, hide, regenerate) until
   *  ghostHealUntil, then hunt again. 0 = off */
  ghostHealHp: 0,
  ghostHealUntil: 0.9,
  /** SQUAD opening: spin on the spot for this long (one turn = 1.9 s) to see all loot around before moving */
  openScanS: 1.9,
  /** SQUAD opening "jet scan" (laser agent): at t < 3 s jump and jet straight up to this many m above the ground
   *  while spinning, so pickups behind buildings / on roofs within 200 m are seen and remembered (real layouts:
   *  spawns that see >= 1 laser 39 % from the ground, 62 % from +20 m). 0 = off */
  jetScan: 0,
  /** ... stop jetting below this energy */
  jetScanMinE: 45,
  /** without a laser, go for a known laser within this distance, also mid-duel (boost while energy >
   *  laserRushEnergy; ground-level items only while engaged). 0 = off */
  laserRush: 0,
  laserRushEnergy: 35,
  /** ... but finish the duel first when the target is below this HP fraction and within laserRushFinishDist */
  laserRushFinish: 0.35,
  laserRushFinishDist: 110,
  /** ... and not when this many other mechs (besides the target) are within 60 m of the laser */
  laserRushCrowd: 2,
  /** no lightning pickups while we hold no laser and a laser is known within this distance (0 = off) */
  ltgVetoLaser: 0,
  /** finish kills: a mech target below this HP fraction that runs away (or broke the line) is chased with boost
   *  to finishChaseRange, unless finishChaseCrowd other mechs are within 60 m of it (0 = off) */
  finishChaseHp: 0,
  finishChaseRange: 25,
  finishChaseCrowd: 2,
  /** gun only (no laser, no lightning): preferred duel distance against every mech, whatever it carries (0 = off;
   *  the range* keys apply). Real: <25 m 145/195 dealt/taken HP/s, 25-45 m 83/79, 45-65 m 88/64, 65-85 m 33/20 */
  rangeGunOnly: 0,
  /** without a laser: no gun fire at mechs beyond this distance unless the target is below gunFarHp (0 = off;
   *  real gun hit rate >= 120 m 22 %, and the magazine is then empty when the target comes close) */
  gunFarDist: 0,
  gunFarHp: 0.25,
  /** kite style: preferred distance */
  rangeKite: 14,
  /** width of the dead band around the preferred range in which we only strafe */
  rangeBand: 5,
  /** fraction of full speed used for strafing (1 = full) */
  strafeSpeed: 1,
  /** strafe side flip period bounds */
  strafeMin: 0.35,
  strafeMax: 1.0,
  /** probability per second of a jump while duelling (breaks linear lead in z; 0 = never) */
  fightJumpRate: 0.0,

  // ---------------------------------------------------------------- fire control
  /** gun + laser aim version: 0 = old (leadGunObs + willHit/hitProbGun gate, laserReleaseGate), 1 = v1 (tactics/aim.ts
   *  GunAimer: online action-latency estimate, capped-acceleration + ballistic lead for the real fire time, hit-
   *  probability gate, laser gate on the release tick with a beam wall check). Offline lab (src/tools/aimlab) on our
   *  real play trajectories: lockstep +1.4 DPS [0.2, 2.6] gun, laser 93 -> 98 %; play server (2-decision latency)
   *  +14.6 DPS [10.5, 19.1] (gun hit rate 47 -> 59 %) */
  aimV: 1,
  /** aim v1: minimum estimated gun hit probability to pull the trigger on a mech (lab optimum 0.1-0.3, flat) */
  aimPStar: 0.15,
  /** minimum estimated gun hit probability to pull the trigger on a mech */
  fireMinP: 0.12,
  /** never fire the gun at a mech beyond this */
  gunMaxDist: 210,
  /** fire-gate margin in spread sigmas (aim.ts willHit) */
  fireMarginSigma: 0.6,
  /** assumed velocity change (m/s) of a strafing target during the bullet flight (hit-probability model) */
  targetJink: 9,
  /** energy kept in reserve when firing lightning at mechs */
  lightningReserve: 4,
  /** energy needed before spending lightning on crates / NPCs */
  lightningFarmEnergy: 60,
  /** fraction of the lightning cone we require the aim to be inside */
  lightningConeFrac: 0.42,
  /** fraction of lightning range we require */
  lightningRangeFrac: 0.97,
  /** laser: maximum distance at which we bother charging */
  laserMaxDist: 230,
  /** laser: 1 = keep the gun lead aim (gun keeps firing) while charging and release on it when the beam hits;
   *  direct laser aim only after laserGunHoldS s at full charge. 0 = laser aim from 0.25 s before full charge */
  laserKeepGun: 0,
  laserGunHoldS: 0.6,
  /** 1 = the pre-fix release (aim command not set on the release decision: beams left on the gun lead). Only for
   *  calibration anchors that were scored with that code. */
  laserLegacyRelease: 0,
  /** laser: target cylinder shrink for the release gate */
  laserShrink: 0.75,
  /** fire a held mortar at mechs (1) or never (0); flat arc onto the feet, only between these distances */
  mortarFire: 0,
  mortarMinDist: 12,
  mortarMaxDist: 90,
  /** aim error (rad) under which the mortar trigger is pulled */
  mortarAimTol: 0.04,
  /** reload out of combat when the magazine is below this fraction */
  reloadIdleFrac: 0.7,
  /** reload in combat without a shot line for this long when ammo is at most reloadLowAmmo */
  reloadNoLosS: 0.6,
  reloadLowAmmo: 5,
  /** shoot crates within this distance */
  crateShootDist: 110,
  /** shoot NPC drones within this distance */
  npcShootDist: 70,

  // ---------------------------------------------------------------- fight or not (common.ts)
  /** assumed enemy gun accuracy against our strafing at point blank, and the distance where it halves */
  enemyHitP0: 0.75,
  enemyHitHalfDist: 85,
  /** SQUAD: keep fighting while time-to-die / time-to-kill is above this, else try to disengage */
  squadDisengageRatio: 0.55,
  /** SQUAD: only disengage below this HP fraction */
  squadDisengageHp: 0.45,
  /** SQUAD: do not disengage when the target is below this HP fraction (finish it) */
  squadFinishHp: 0.3,
  /** SQUAD: resume normal behaviour once HP is back above this fraction */
  squadRegenUntil: 0.9,
  /** SQUAD mode only: HP fraction that ends "hurt" (heal / regen exit); < 0 = use squadRegenUntil (FFA keeps that) */
  squadHealUntil: -1,
  /** SQUAD mode only: loot utility lost per second of travel; < 0 = use lootTimeCost */
  squadLootTimeCost: -1,
  /** SQUAD: maximum cover distance worth running to */
  coverMaxDist: 45,
  /** break line of sight while reloading when the target has more than this HP fraction (0 = never; 0.35 was
   *  score-neutral against the league squad and doubled the stuck seconds) */
  reloadCoverHp: 0,
  /** maximum distance to a reload cover point */
  reloadCoverDist: 14,
  /** FFA: fight a visible mech when time-to-die / time-to-kill exceeds this (opportunistic) */
  ffaFightRatio: 2.2,
  /** FFA: third-party a mech whose HP fraction is below this when we are healthy */
  ffaFinishHp: 0.3,
  /** FFA: an enemy inside this distance that sees us means we are cornered: fight */
  ffaCorneredDist: 38,
  /** FFA: seconds of being shot at without reaching cover before we turn and fight */
  ffaFleePatience: 4,
  /** FFA: number of mechs alive at or below which the ghost becomes a duelist */
  ffaDuelAlive: 2,
  /** FFA: zone radius at or below which hiding is over and we fight for the centre */
  ffaDuelRadius: 30,

  // ---------------------------------------------------------------- loot
  /** value of one cube (arbitrary utility unit) */
  valCube: 10,
  /** value of a crate (1 cube + 50 % weapon), before the time cost of killing it */
  valCrate: 9,
  /** weight of the laser drop chance in a crate's value (0 = only lightning counts, as before) */
  crateLaserW: 0,
  /** value of an NPC (2 cubes) */
  valNpc: 13,
  /** value of the weapons when the slot is empty */
  valLightning: 45,
  valLaser: 22,
  valMortar: 0,
  /** value of swapping laser -> lightning / mortar -> anything */
  valSwapToLightning: 28,
  /** value of swapping lightning -> laser (0 = never) */
  valSwapToLaser: 0,
  valSwapFromMortar: 20,
  /** utility lost per second of travel */
  lootTimeCost: 1.0,
  /** utility lost per metre the item lies outside the next circle */
  lootZoneCost: 0.5,
  /** ignore loot further than this */
  lootMaxDist: 260,
  /** multiply cube values by this once we hold stat_cap cubes (size keeps growing, stats do not) */
  cubeOverCapMult: 0.35,
  /** minimum HP fraction to pick a fight with an NPC */
  npcMinHp: 0.55,
  /** forget loot not seen for this long */
  lootForgetS: 150,
  /** hysteresis: keep the current loot goal unless another is better by this much utility */
  lootSwitchMargin: 4,
  /** supply drop: utility */
  valDrop: 60,
  /** supply drop: no known enemy closer to the ring than this (SQUAD) */
  dropEnemyClear: 60,
  /** SQUAD: with a mech in sight, go to a drop only when it lands within this many s more than our travel time */
  dropFightLeadS: 99,
  /** supply drop: go when it lands within this many seconds more than our travel time */
  dropLeadS: 12,

  // ---------------------------------------------------------------- zone
  /** metres we want to be inside the current circle */
  zoneMargin: 18,
  /** seconds of slack wanted before our position gets swallowed */
  zoneSlackS: 10,
  /** fraction of the next radius at which we aim when rotating (0 = centre, 1 = edge) */
  zoneAimFrac: 0.55,
  /** start drifting toward the next circle this long before its shrink starts */
  zoneEarlyS: 25,

  // ---------------------------------------------------------------- stealth (FFA ghost)
  /** speed (m/s) used for silent walking (below sound.step_speed) */
  silentSpeed: 4.7,
  /** walk silently when a known enemy is closer than this */
  silentEnemyDist: 75,
  /** radius (m) searched for hide spots */
  hideSearchR: 140,
  /** exposure rays: length (m) */
  exposureRay: 140,
  /** hide spot score: weight of exposure (0..1) */
  hideWExposure: 100,
  /** hide spot score: cost per metre of travel */
  hideWDist: 0.25,
  /** hide spot score: bonus per metre of distance from known enemies (capped at 150 m) */
  hideWEnemy: 0.25,
  /** hide spot score: weight of sound heat at the spot */
  hideWHeat: 10,
  /** keep the current hide spot unless a new one is better by this */
  hideSwitchMargin: 14,
  /** re-evaluate the hide spot every this many seconds */
  hideReplanS: 4,
  /** FFA: seconds before we allow noisy crate/NPC farming with the gun (also needs nobody around) */
  ffaQuietUntil: 9999,
  /** FFA: collect silent loot (pickups, cubes) within this distance of the hide route */
  ffaLootDist: 90,
  /** FFA: only loot when no enemy has been known within this distance in the last 10 s */
  ffaLootEnemyClear: 130,
  // ---- FFA v2 (src/bot/strategies/ffa_v2.ts, owned by the FFA agent; plan: data/intel/ffa-plan.md)
  /** FFA strategy version: 1 = ffa_v1.ts (ghost v1), 2 = ffa_v2.ts (phased ghost) */
  ffaVersion: 2,
  /** pocket search: max straight-line travel (m) and margin kept inside the next circle */
  ffaSpotMaxDist: 150,
  ffaSpotMargin: 12,
  /** pocket re-rank: the best K static spots get a nav path; cost = exposed s on the path + W * static score */
  ffaSpotTopK: 6,
  ffaSpotScoreW: 60,
  /** pocket choice: weight of travel time (s) in the re-rank */
  ffaSpotTimeW: 0.3,
  /** pace to the pocket: 0 silent, 1 walk, 2 boost */
  ffaTravelPace: 1,
  /** discovered: covered point search radius (m) of safeDirection */
  ffaBreakMaxDist: 52,
  /** discovered: fight when the finder is inside this distance and no covered point is within ffaCloseBreak m */
  ffaCloseDist: 45,
  ffaCloseBreak: 14,
  /** discovered: return fire while breaking LOS when the shooter is inside this distance */
  ffaReturnFireDist: 60,
  /** after breaking LOS: stay hidden (still, healing) this long */
  ffaHideS: 30,
  /** a sighting by a mech that is not aiming at us only counts within this distance */
  ffaSeenDist: 100,
  /** a visible mech with a line to us (could see us if it turned) inside this distance: step out of its line */
  ffaDuckDist: 160,
  /** third-party: a visible mech below this HP fraction inside ffaThirdDist while we are above ffaThirdHp */
  ffaThirdHp: 0.6,
  ffaThirdTargetHp: 0.35,
  ffaThirdDist: 120,
  /** opening/holding pickups: laser / lightning within this distance whose spot has exposure below ffaPickupExpo */
  ffaPickupDist: 35,
  ffaPickupExpo: 0.2,
  /** end-game: alive at or below this -> hunt / third-party when HP fraction >= ffaEndHp */
  ffaEndAlive: 2,
  ffaEndHp: 0.85,
  /** end-game: walk toward the freshest fight until this far from it */
  ffaEndApproach: 110,
  /** end-game master switch (0 = v1 behaviour: duel only at ffaDuelAlive) */
  ffaEndHunt: 1,
  /** after a hide: stay at the covered point when its static exposure is below this (0 = always re-pick a pocket) */
  ffaStayExpo: 0,
  /** nobody known near for 10 s: silent loot like v1 (bestLoot within ffaLootDist) - 0 off, 1 on */
  ffaCalmLoot: 1,
  /** break LOS to SOLID cover (segClear from eye and muzzle to knee/centre/top) with a committed point; 0 = cover.safeDirection (sight only) */
  ffaStrictCover: 0,
  /** keep a chosen break point this long while it stays covered */
  ffaBreakCommitS: 3,
  /** third-party / final duel fight style: 1 = hold position (STYLE_HOLD, shoot from where we are), 0 = duelIntent (push to range) */
  ffaThirdHold: 0,
  ffaFinalHold: 0,
  /** opening weapon rush: take a laser / lightning within ffaRushDist (any exposure) during the first ffaRushS s while a slot is free */
  ffaRushS: 0,
  ffaRushDist: 70,
  /** v2: seconds shot at without any covered point before we turn and fight (v1 uses ffaFleePatience) */
  ffaBreakPatience: 8,
  /** known-enemy memory horizon for avoidance */
  enemyMemoryS: 20,

  // ---------------------------------------------------------------- nav / movement
  /** replan when the goal moved by more than this */
  replanGoalDist: 6,
  /** replan at least every this many decisions */
  replanTicks: 40,
  /** A* expansion bound per plan */
  navMaxExp: 14000,
  /** arrive distance for goto */
  arriveDist: 2.0,
  /** allow jets in plans when energy is above this */
  jetMinEnergy: 45,
  /** plan with the grown body size (1 + size_per_cube * cubes, or the eye-height ratio) because the real server
   *  reports unscaled self.stats.radius / height (1 = on, bug fix; 0 = old behaviour) */
  navBodyFromCubes: 1,
  /** nav watchdog: no progress toward the same goal for this many s while commanding a move -> the goal / the
   *  blocked spot is blacklisted, replan on foot without jets (0 = off) */
  navWatchdogS: 0,
  /** boost when travelling further than this and energy is above boostMinEnergy (SQUAD only, no enemy near) */
  boostTravelDist: 9999,
  boostMinEnergy: 70,
  /** local wall probe length for strafing / dodging */
  probeDist: 4.5,
  /** dodge urgency above which the dodge vector overrides the movement */
  dodgeOverride: 0.75,

  // ---------------------------------------------------------------- scanning
  /** sweep amplitude (rad) around the travel direction while moving */
  scanAmp: 1.15,
  /** sweep angular frequency (rad/s) */
  scanFreq: 1.5,
  /** standing still: spin rate (rad/s) */
  scanSpin: 2.2,
  /** look toward the last damage bearing for this long */
  lookDamageS: 2.5,

  // ---------------------------------------------------------------- upgrades (bigger = preferred)
  upPlating: 100,
  upArmor: 92,
  upNanites: 70,
  upGunDamage: 88,
  upGunRate: 86,
  upLightningEfficiency: 90,
  upLightningRange: 60,
  upLightningChain: 30,
  upLaserDamage: 80,
  upLaserCharge: 72,
  upLaserPierce: 10,
  upGunMag: 55,
  upGunVelocity: 50,
  upGyros: 45,
  upServos: 58,
  upReactor: 40,
  upCapacitor: 42,
  upJets: 20,
  upSensors: 35,
  upMortar: 1,
}

export type BrainParams = typeof DEFAULTS

/**
 * style 1 = "laser kite" (data/intel/teams.md: top bots carry a laser, fight at 60-90 m backing off - house gun
 * aim falls to 32 % there, house lasers hit 20 % - break off fights at ~70 % HP to regenerate, avoid 2+ lines).
 * Every value is an ordinary param; explicit params override these.
 */
export const STYLE_LASER_KITE: Partial<Record<keyof BrainParams, number>> = {
  valLaser: 60,
  valLightning: 15,
  valSwapToLightning: 0,
  valSwapToLaser: 40,
  rangeLaser: 75,
  rangeGun: 75,
  rangeKite: 75,
  rangeVsLightning: 75,
  rangeLaserVsMortar: 75,
  rangeVsMortar: 75,
  rangeBand: 10,
  kiteBoostGap: 30,
  kiteBoostEnergy: 25,
  peekMargin: 10,
  squadDisengageRatio: 99,
  squadDisengageHp: 0.7,
  squadHealUntil: 0.95,
  squadFinishHp: 0.3,
  duelLootDist: 6,
  laserKeepGun: 1,
  lootClearDist: 55,
}

/** DEFAULTS, then the style preset (p.style), then any finite numeric key present in `p` (unknown keys ignored). */
export function resolveParams(p: Record<string, number> | undefined | null): BrainParams {
  const out: BrainParams = { ...DEFAULTS }
  if (p && p.style === 1) Object.assign(out, STYLE_LASER_KITE)
  if (p) {
    for (const k in p) {
      const v = p[k]
      if (k in out && typeof v === "number" && Number.isFinite(v)) (out as Record<string, number>)[k] = v
    }
  }
  return out
}
