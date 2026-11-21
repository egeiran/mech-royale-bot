/**
 * Every tunable number of the brain, flat and numeric, so `ctx.params` can override any key and a tuner can
 * search them. Units: metres, seconds, radians unless the name says otherwise. Fractions are 0..1.
 */
export const DEFAULTS = {
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

  // ---------------------------------------------------------------- engagement range
  /** preferred duel distance with gun only */
  rangeGun: 14,
  /** preferred duel distance when we hold lightning (inside its 45 m range) */
  rangeLightning: 14,
  /** preferred distance when the enemy holds lightning and we do not (stay outside its arc) */
  rangeVsLightning: 14,
  /** preferred distance with a laser against an enemy that holds a mortar (cook-off) */
  rangeLaserVsMortar: 14,
  /** preferred distance when the enemy holds a mortar and we have no laser (hug: its splash hurts it) */
  rangeVsMortar: 12,
  /** SQUAD: a visible mech that is not engaging us is only duelled inside this distance */
  engageDist: 250,
  /** boost away along the most open direction when the target is closer than the preferred range by more than
   *  this (needs kiteBoostEnergy). 999 = off: neutral-to-negative against the league squad (96 seeds). */
  kiteBoostGap: 999,
  kiteBoostEnergy: 25,
  /** boost toward a target further than this (closing time is time under fire without dealing damage) */
  approachBoostDist: 999,
  /** ... while energy is above this (above lightningKeepEnergy when we hold lightning) */
  approachBoostEnergy: 35,
  lightningKeepEnergy: 75,
  /** in a duel, still pick up cubes / wanted weapons lying within this distance (kills drop cubes + 2) */
  duelLootDist: 32,
  /** SQUAD: with at least this HP fraction and nobody in sight, go and look for the next mech */
  seekHp: 0.6,
  /** SQUAD: reload before contact when the target is further than this and the mag is below reloadIdleFrac
   *  (999 = off: -0.5 against the league squad, it kept interrupting the approach fire) */
  reloadFarDist: 999,
  /** with several enemies in sight, orbit the target until it stands between us and the others; this is the
   *  angular tolerance (rad) inside which we stop orbiting and strafe randomly. 0 = off */
  shieldOrbit: 0.3,
  /** SQUAD opening: spin on the spot for this long (one turn = 1.9 s) to see all loot around before moving */
  openScanS: 1.9,
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
  /** laser: target cylinder shrink for the release gate */
  laserShrink: 0.75,
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
  /** value of an NPC (2 cubes) */
  valNpc: 13,
  /** value of the weapons when the slot is empty */
  valLightning: 45,
  valLaser: 22,
  valMortar: 0,
  /** value of swapping laser -> lightning / mortar -> anything */
  valSwapToLightning: 28,
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
  ffaVersion: 1,
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
  ffaSeenDist: 230,
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
  ffaEndAlive: 4,
  ffaEndHp: 0.85,
  /** end-game: walk toward the freshest fight until this far from it */
  ffaEndApproach: 110,
  /** end-game master switch (0 = v1 behaviour: duel only at ffaDuelAlive) */
  ffaEndHunt: 1,
  /** after a hide: stay at the covered point when its static exposure is below this (0 = always re-pick a pocket) */
  ffaStayExpo: 0,
  /** nobody known near for 10 s: silent loot like v1 (bestLoot within ffaLootDist) - 0 off, 1 on */
  ffaCalmLoot: 0,
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

/** DEFAULTS overridden by any finite numeric key present in `p` (unknown keys are ignored). */
export function resolveParams(p: Record<string, number> | undefined | null): BrainParams {
  const out: BrainParams = { ...DEFAULTS }
  if (p) {
    for (const k in p) {
      const v = p[k]
      if (k in out && typeof v === "number" && Number.isFinite(v)) (out as Record<string, number>)[k] = v
    }
  }
  return out
}
