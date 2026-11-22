/**
 * Scoring shared by the strategies: damage-race estimates (time to kill vs time to die), target choice,
 * duel range, loot value vs time, zone duty, supply drops, weapon wishes and upgrade picks.
 * Pure functions of the blackboard (plus its StratMemory for hysteresis). No allocation.
 */
import type { Offer } from "../../protocol/mechfight.ts"
import type { Track } from "../perception/tracker.ts"
import { W_GUN, W_LASER, W_LIGHTNING, W_MORTAR } from "../perception/tracker.ts"
import { hitProbGun } from "../tactics/aim.ts"
import { L_CRATE, L_CUBE, L_PICKUP, MODE_SQUAD, type Blackboard, type LootItem } from "../brain/blackboard.ts"
import { FACE_THREATS, PACE_BOOST, PACE_WALK, type Intent } from "../brain/intent.ts"

// ---------------------------------------------------------------- damage race
/** our expected damage per second on a mech at `dist` (sustained over reloads) */
export function ourDps(bb: Blackboard, e: Track, dist: number): number {
  const P = bb.P
  let dps = 0
  const g = bb.gun
  if (g) {
    const cd = Math.max(0.25, g.stats.cooldown ?? 0.24)
    const mag = g.stats.mag ?? 12
    const rel = g.stats.reload ?? 2.4
    const p = dist > (g.stats.range ?? 230) ? 0 : hitProbGun(dist, e.radius, e.height, P.targetJink, g.stats.spread_deg ?? 0.6, g.stats.speed ?? 252)
    dps += (((g.stats.damage ?? 45) * p) / cd) * ((mag * cd) / (mag * cd + rel))
  }
  const lt = bb.ltg
  if (lt && dist <= (lt.stats.range ?? 45) * P.lightningRangeFrac) dps += (lt.stats.damage ?? 60) / 0.3
  const la = bb.las
  if (la && dist <= (la.stats.range ?? 280)) {
    let d = ((la.stats.damage ?? 315) * 0.6) / ((la.stats.charge ?? 0.75) + (la.stats.cooldown ?? 1.65))
    if (e.weapons & W_MORTAR) d *= 1 + (la.stats.cookoff ?? 0.6)
    dps += d
  }
  if (bb.mor && P.mortarFire > 0 && dist >= P.mortarMinDist && dist <= P.mortarMaxDist) dps += ((bb.mor.stats.damage ?? 200) * 0.6) / (bb.mor.stats.cooldown ?? 2.6)
  return dps * bb.dmgMult
}

/** expected damage per second a mech deals to us at `dist` */
export function theirDps(bb: Blackboard, e: Track, dist: number): number {
  const P = bb.P
  const w = e.weapons === 0 ? W_GUN : e.weapons | W_GUN
  const wc = bb.cfg.weapons
  let dps = 0
  if (w & W_GUN && dist < (wc.gun.range ?? 230)) {
    const p = P.enemyHitP0 / (1 + (dist / P.enemyHitHalfDist) * (dist / P.enemyHitHalfDist))
    const cd = 0.25
    const mag = wc.gun.mag ?? 12
    dps += (((wc.gun.damage ?? 45) * p) / cd) * ((mag * cd) / (mag * cd + (wc.gun.reload ?? 2.4)))
  }
  if (w & W_LIGHTNING && dist <= (wc.lightning.range ?? 45) + 3) dps += (wc.lightning.damage ?? 60) / 0.3
  if (w & W_LASER && dist <= (wc.laser.range ?? 280)) {
    let d = ((wc.laser.damage ?? 315) * 0.3) / ((wc.laser.charge ?? 0.75) + (wc.laser.cooldown ?? 1.65))
    if (bb.haveMortar) d *= 1 + (wc.laser.cookoff ?? 0.6)
    dps += d
  }
  if (w & W_MORTAR && dist > 12 && dist < 200) dps += 25
  const cap = (bb.cfg.cubes.stat_cap as number) ?? 10
  dps *= 1 + ((bb.cfg.cubes.damage_per_cube as number) ?? 0.04) * Math.min(e.cubes, cap)
  return dps * (1 - (bb.me.stats.armor ?? 0))
}

/** seconds for us to kill e from where it is */
export function timeToKill(bb: Blackboard, e: Track): number {
  const hp = e.hp >= 0 ? e.hp : (bb.cfg.mech.hp ?? 1400)
  const d = ourDps(bb, e, e.dist)
  return d > 1 ? hp / d : 1e3
}

/** seconds until the visible mechs with a line on us kill us */
export function timeToDie(bb: Blackboard): number {
  let dps = 0
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (bb.los[e.id] !== 1) continue
    const engaged = e.aimingAtUs || bb.t - e.tShotAtUs < 3 || e.aimErr < 0.6
    dps += theirDps(bb, e, e.dist) * (engaged ? 1 : 0.4)
  }
  return dps > 1 ? bb.hp / dps : 1e3
}

/** > 1: we win the race against `e` (and whoever else has a line on us) */
export function fightRatio(bb: Blackboard, e: Track): number {
  return timeToDie(bb) / Math.max(0.5, timeToKill(bb, e))
}

/** preferred duel distance against e */
export function duelRange(bb: Blackboard, e: Track): number {
  const P = bb.P
  if (e.npc) return 28
  if (bb.haveLaser && P.rangeLaser > 0) return P.rangeLaser
  const eLtg = (e.weapons & W_LIGHTNING) !== 0
  const eMor = (e.weapons & W_MORTAR) !== 0
  if (bb.haveLightning && bb.energy > 15 && bb.nThreats <= 1 && bb.nEn <= 1) return P.rangeLightning
  if (P.rangeGunOnly > 0 && !bb.haveLaser && !bb.haveLightning) return P.rangeGunOnly
  if (eLtg) return P.rangeVsLightning
  if (eMor) return bb.haveLaser ? P.rangeLaserVsMortar : P.rangeVsMortar
  return P.rangeGun
}

/**
 * The mech to shoot: cheapest to kill among the visible ones, preferring those with a shot line, those
 * engaging us and the current target (hysteresis).
 */
export function pickTarget(bb: Blackboard): Track | null {
  const m = bb.mem
  let best: Track | null = null
  let bs = 1e9
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    let s = Math.min(40, timeToKill(bb, e)) + e.dist / 30
    // kill order: the mechs that hurt us most go first (damage race against several)
    if (bb.P.targetDpsW > 0 && bb.los[e.id] === 1) s -= (bb.P.targetDpsW * theirDps(bb, e, e.dist)) / 100
    if (bb.los[e.id] !== 1) s += 6
    if (e.aimingAtUs) s -= 1.5
    // without a laser: a laser carrier drops it when it dies
    if (bb.P.targetLaserBonus > 0 && !bb.haveLaser && (e.weapons & W_LASER) !== 0) s -= bb.P.targetLaserBonus
    if (bb.t - e.tShotAtUs < 3) s -= 1.5
    if (e.id === m.targetId && bb.t - m.targetT < 1) s -= 2.5
    if (s < bs) {
      bs = s
      best = e
    }
  }
  if (best) {
    m.targetId = best.id
    m.targetT = bb.t
  }
  return best
}

// ---------------------------------------------------------------- zone
export interface ZoneGoal {
  x: number
  y: number
  /** 0 = no need, 1 = should start moving, 2 = urgent (outside or about to be) */
  level: number
}
export const newZoneGoal = (): ZoneGoal => ({ x: 0, y: 0, level: 0 })

/** where to stand for the next circle and how urgent it is to go there */
export function zoneDuty(bb: Blackboard, out: ZoneGoal): number {
  const P = bb.P
  const zn = bb.zone
  const dx = bb.x - zn.ncx, dy = bb.y - zn.ncy
  const dNext = Math.hypot(dx, dy)
  const aimFrac = zn.nr <= 30 ? 0.2 : P.zoneAimFrac
  const want = zn.nr * aimFrac
  if (dNext > want) {
    out.x = zn.ncx + (dx / dNext) * want
    out.y = zn.ncy + (dy / dNext) * want
  } else {
    out.x = bb.x
    out.y = bb.y
  }
  const need = Math.max(0, dNext - zn.nr + P.zoneMargin)
  const needT = (need / bb.walk) * 1.35
  const margin = zn.margin(bb.x, bb.y)
  const tOut = zn.timeUntilOutside(bb.x, bb.y, 90)
  let level = 0
  if (!bb.inZone || margin < 4 || tOut < needT + 2) level = 2
  else if (margin < P.zoneMargin || tOut < needT + P.zoneSlackS) level = 1
  else if (need > 0 && zn.t0 - bb.t < needT + P.zoneEarlyS) level = 1
  out.level = level
  return level
}

// ---------------------------------------------------------------- loot
export interface LootChoice {
  item: LootItem | null
  npc: Track | null
  score: number
}
export const newLootChoice = (): LootChoice => ({ item: null, npc: null, score: 0 })

/** utility of a weapon pickup for us right now (0 = do not want) and the slot it would replace (-1 = free slot) */
export function pickupValue(bb: Blackboard, wk: number): number {
  const P = bb.P
  if (bb.held & wk) return 0
  const free = bb.freeSlot >= 0
  // a laser is worth far more than lightning (which also pulls us into losing 14 m brawls): skip lightning
  // while a laser is known nearby and we hold none
  if (wk === W_LIGHTNING && P.ltgVetoLaser > 0 && !bb.haveLaser && bb.nearestLaserDist() < P.ltgVetoLaser) return 0
  if (wk === W_LIGHTNING) return free ? P.valLightning : bb.haveMortar ? P.valLightning : bb.haveLaser ? P.valSwapToLightning : 0
  if (wk === W_LASER) return free ? P.valLaser : bb.haveMortar ? P.valSwapFromMortar : bb.haveLightning ? P.valSwapToLaser : 0
  if (wk === W_MORTAR) return free ? P.valMortar : 0
  return 0
}

/** slot to drop when taking a pickup of kind wk with both slots full (-1 = none needed) */
export function swapSlot(bb: Blackboard, wk: number): number {
  if (bb.freeSlot >= 0) return -1
  if (bb.morSlot >= 0) return bb.morSlot
  if (wk === W_LIGHTNING && bb.lasSlot >= 0 && (bb.las?.charge ?? 0) <= 0) return bb.lasSlot
  if (wk === W_LASER && bb.ltgSlot >= 0 && bb.P.valSwapToLaser > 0) return bb.ltgSlot
  return -1
}

/** utility lost per second of travel to loot (SQUAD has its own value: kill tempo vs cubes) */
export function lootTc(bb: Blackboard): number {
  return bb.mode === MODE_SQUAD && bb.P.squadLootTimeCost >= 0 ? bb.P.squadLootTimeCost : bb.P.lootTimeCost
}

/** SQUAD mode: HP fraction below which we count as hurt (heal before seeking, regen exit) */
export function healUntil(bb: Blackboard): number {
  return bb.mode === MODE_SQUAD && bb.P.squadHealUntil >= 0 ? bb.P.squadHealUntil : bb.P.squadRegenUntil
}

/**
 * Zone guard (P.zoneGuard m, 0 = off -> always false): (x, y) lies where zoneDuty would ask for level 1 when we get
 * there in etaS s, widened by zoneGuard m (hysteresis). A goal like that, chosen at level 0, makes the decision
 * flip-flop: walk out, level 1, walk in, level 0, ... (play server: 50 s = 7 % of alive time, data/intel/play2.md L2)
 */
export function zoneOutside(bb: Blackboard, x: number, y: number, etaS: number): boolean {
  const P = bb.P
  if (P.zoneGuard <= 0) return false
  const zn = bb.zone
  const mn = zn.marginNext(x, y)
  if (mn >= P.zoneMargin + P.zoneGuard) return false
  const need = Math.max(0, P.zoneMargin - mn)
  return zn.t0 - (bb.t + etaS) < (need / bb.walk) * 1.35 + P.zoneEarlyS + 2
}

/**
 * Best loot goal by utility = value - time cost. `silentOnly` skips everything that needs shooting (crates,
 * NPCs); `maxDist` bounds the search. Hysteresis through mem.lootId. `zoneGuard`: skip goals zoneOutside().
 */
export function bestLoot(bb: Blackboard, silentOnly: boolean, maxDist: number, out: LootChoice, zoneGuard = false): boolean {
  const P = bb.P
  const zn = bb.zone
  const m = bb.mem
  out.item = null
  out.npc = null
  out.score = 0
  let best = 0
  const tc = lootTc(bb)
  const cap = (bb.cfg.cubes.stat_cap as number) ?? 10
  const cubeMult = bb.cubes >= cap ? P.cubeOverCapMult : 1
  const items = bb.loot.items
  const w = bb.world
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const d = Math.hypot(it.x - bb.x, it.y - bb.y)
    if (d > maxDist || it.badUntil > bb.t) continue
    let val = 0
    let extra = 0
    if (it.type === L_CUBE) val = P.valCube * cubeMult
    else if (it.type === L_CRATE) {
      if (silentOnly || !bb.gun) continue
      val = P.valCrate * cubeMult + 0.5 * Math.max(0, pickupValue(bb, W_LIGHTNING)) * 0.33 + P.crateLaserW * 0.5 * Math.max(0, pickupValue(bb, W_LASER)) * 0.33
      extra = 2
    } else if (it.type === L_PICKUP) val = pickupValue(bb, it.wk)
    if (val <= 0) continue
    // height: roofs cost jet time and energy; out of reach above ~45 m
    const dz = it.z - (w ? w.groundZ(it.x, it.y) : it.z)
    const climb = it.z - bb.z
    if (climb > 45) continue
    if (climb > 3) extra += climb / 8 + 4
    else if (dz > 3 && climb < -3) extra += 1
    const eta = (d / bb.walk) * 1.25 + extra
    const mz = zn.marginAt(it.x, it.y, bb.t + eta + 2)
    if (mz < 6) continue
    if (zoneGuard && zoneOutside(bb, it.x, it.y, eta)) continue
    let s = val - tc * eta
    const mNext = zn.marginNext(it.x, it.y)
    if (mNext < 0 && zn.t0 - bb.t < 40) s += P.lootZoneCost * Math.max(-60, mNext) * 0.2
    if (it.id === m.lootId) s += P.lootSwitchMargin
    if (s > best) {
      best = s
      out.item = it
      out.npc = null
    }
  }
  if (!silentOnly && bb.gun && bb.hpFrac >= P.npcMinHp) {
    const npcs = bb.tracker.npcs
    for (let i = 0; i < npcs.length; i++) {
      const n = npcs[i]
      if (!n.known || n.dead || n.hp === 0) continue
      if (!n.visible && bb.t - n.tSeen > 25) continue
      const d = n.dist
      if (d > maxDist) continue
      const eta = (Math.max(0, d - 30) / bb.walk) * 1.25 + 3.5
      if (zn.marginAt(n.x, n.y, bb.t + eta + 3) < 10) continue
      if (zoneGuard && zoneOutside(bb, n.x, n.y, eta)) continue
      let s = P.valNpc * cubeMult - tc * eta
      if (n.id === m.lootId) s += P.lootSwitchMargin
      if (s > best) {
        best = s
        out.item = null
        out.npc = n
      }
    }
  }
  out.score = best
  m.lootId = out.item ? out.item.id : out.npc ? out.npc.id : -1
  return best > 0
}

/** fill the intent for a loot choice */
export function lootIntent(bb: Blackboard, c: LootChoice, it: Intent, pace: number): void {
  if (c.npc) {
    it.fight(c.npc.id, 0, 28, "npc")
    return
  }
  const item = c.item!
  if (item.type === L_CRATE && bb.P.crateStandOff > 0) {
    // stand-off variant: the gun cannot point below min_pitch, so a crate at our feet is never hit (play server:
    // 33 s and 58 s standing on a crate, data/intel/play2.md). Stop where it is in the pitch range; step back if closer.
    const minPitch = Math.abs(bb.me.stats.min_pitch ?? -0.7)
    const so = Math.max(bb.P.crateStandOff, (bb.muzzleH - 0.5) / Math.tan(Math.max(0.2, minPitch)) + 2)
    const dx = bb.x - item.x, dy = bb.y - item.y
    const d = Math.hypot(dx, dy)
    if (d < so - 2) {
      const ux = d > 0.3 ? dx / d : 1, uy = d > 0.3 ? dy / d : 0
      it.loot(item.x + ux * so, item.y + uy * so, bb.z, pace, "crate")
      it.arrive = 1.5
    } else {
      it.loot(item.x, item.y, item.z, pace, "crate")
      it.arrive = so
    }
    it.shootCrate = item.id
  } else if (item.type === L_CRATE) {
    it.loot(item.x, item.y, item.z, pace, "crate")
    it.shootCrate = item.id
    it.arrive = 3
  } else if (item.type === L_CUBE) {
    it.loot(item.x, item.y, item.z, pace, "cube")
    it.arrive = 0.6
  } else {
    it.loot(item.x, item.y, item.z, pace, "weapon")
    it.arrive = 1.2
    it.takeId = item.id
    it.dropSlot = swapSlot(bb, item.wk)
  }
}

/**
 * Reflex: a wanted weapon lying within reach is taken whatever else we are doing (unless a strategy already
 * set a take).
 */
export function weaponReflex(bb: Blackboard, it: Intent): void {
  if (it.takeId >= 0) return
  const reach = (bb.cfg.loot.pickup_radius ?? 4) - 0.25
  const items = bb.loot.items
  let bv = 0
  for (let i = 0; i < items.length; i++) {
    const p = items[i]
    if (p.type !== L_PICKUP || p.tSeen !== bb.t) continue
    if (Math.hypot(p.x - bb.x, p.y - bb.y) > reach || Math.abs(p.z - bb.z) > 3.8) continue
    const v = pickupValue(bb, p.wk)
    if (v > bv) {
      const slot = swapSlot(bb, p.wk)
      if (bb.freeSlot < 0 && slot < 0) continue
      bv = v
      it.takeId = p.id
      it.dropSlot = slot
    }
  }
}

// ---------------------------------------------------------------- supply drops
/**
 * A supply drop worth going for now (index into bb.drops, -1 = none): inside the circle when we get there,
 * landing soon relative to our travel time, nobody else capturing far ahead of us and (enemyClear > 0) no
 * known enemy near the ring.
 */
export function wantDrop(bb: Blackboard, enemyClear: number): number {
  const P = bb.P
  let best = -1
  let bs = 0
  for (let i = 0; i < bb.drops.length; i++) {
    const d = bb.drops[i]
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y)
    const eta = (dist / bb.walk) * 1.3
    if (d.lands_in > eta + P.dropLeadS) continue
    // too far: we would arrive this long after it landed (others capture it first; play server: 300-380 m walks)
    if (P.dropMaxLateS > 0 && eta - d.lands_in > P.dropMaxLateS) continue
    if (bb.zone.marginAt(d.pos[0], d.pos[1], bb.t + Math.max(eta, d.lands_in) + d.capture_s + 2) < 4) continue
    if (d.holder !== null && d.holder !== bb.me.id && d.capture_s - d.progress < eta) continue
    if (bb.isBadGoal(d.pos[0], d.pos[1])) continue
    if (enemyClear > 0) {
      let near = false
      const tr = bb.tracker.mechs
      for (let k = 0; k < tr.length; k++) {
        const e = tr[k]
        if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > 8) continue
        if (Math.hypot(e.x - d.pos[0], e.y - d.pos[1]) < enemyClear) near = true
      }
      if (near) continue
    }
    const s = P.valDrop * (0.4 + 0.6 * (1 - bb.hpFrac) + 0.3) - lootTc(bb) * Math.max(eta, d.lands_in)
    if (s > bs) {
      bs = s
      best = i
    }
  }
  return best
}

// ---------------------------------------------------------------- upgrades
/** index of the best choice in an offer by the up* params (diminishing a little per stack owned) */
export function pickUpgrade(bb: Blackboard, offer: Offer): number {
  const P = bb.P as unknown as Record<string, number>
  let best = 0
  let bs = -1e9
  for (let i = 0; i < offer.choices.length; i++) {
    const id = offer.choices[i].id
    let key = "up" + id.replace(/(^|_)([a-z])/g, (_m, _a, c: string) => c.toUpperCase())
    if (id.startsWith("mortar")) key = "upMortar"
    let s = P[key] ?? 5
    s -= 4 * bb.upgradeCount(id)
    // weapon upgrades only pay while we hold the weapon
    if (id.startsWith("lightning") && !bb.haveLightning) s = 2
    if (id.startsWith("laser") && !bb.haveLaser) s = 2
    if (s > bs) {
      bs = s
      best = i
    }
  }
  return best
}

// ---------------------------------------------------------------- shared intents
/** zone rotation intent (keeps shooting the target if there is one) */
export function zoneIntent(bb: Blackboard, zg: ZoneGoal, it: Intent, target: Track | null): void {
  const z = bb.world ? bb.world.groundZ(zg.x, zg.y) : bb.z
  it.goto(zg.x, zg.y, z, zg.level >= 2 && (!bb.inZone || bb.zone.margin(bb.x, bb.y) < 0) ? PACE_BOOST : PACE_WALK, zg.level >= 2 ? "zone!" : "zone")
  it.arrive = 4
  it.face = FACE_THREATS
  if (target) it.targetId = target.id
}
