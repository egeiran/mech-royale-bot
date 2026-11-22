/**
 * SQUAD strategy (we alone against cooperating hunters) - also the "duelist" core the FFA strategy falls back
 * to. Decision order per observation:
 *   1. zone urgent            -> rotate (boost when outside), keep shooting
 *   2. supply drop reachable  -> capture (full HP + 3 cubes), keep shooting from inside the ring
 *   3. enemy visible          -> duel at the preferred range; break line of sight to reload; disengage to
 *                                regenerate when the damage race is clearly lost and cover is close
 *   4. hurt, nobody visible   -> stay in cover until regenerated (only silent loot)
 *   5. loot                   -> weapons (lightning first), cubes, crates, NPC drones
 *   6. nothing                -> drift to a good spot in the next circle, scanning
 */
import { Track, W_LASER, W_LIGHTNING } from "../perception/tracker.ts"
import { S_BOOST, S_CRATE, S_GUN, S_JET, S_LASER, S_LASER_CHARGE, S_LIGHTNING, S_MORTAR, S_NPC_GUN, S_RELOAD, S_STEP } from "../perception/sounds.ts"
import { L_CRATE, L_CUBE, L_PICKUP, MODE_FFA, type Blackboard, type LootItem } from "../brain/blackboard.ts"
import { FACE_SCAN, FACE_THREATS, FACE_YAW, K_FIGHT, PACE_BOOST, PACE_WALK, STYLE_HOLD, STYLE_PUSH, STYLE_SPOT, type Intent } from "../brain/intent.ts"
import { newSpot, type Mover } from "../brain/navx.ts"
import { cellOf, F_STAND, getExposure } from "../cover/exposure.ts"
import { decideFfa } from "./ffa.ts"
import { FortState, fortEnabled, fortress } from "../brain/fortress.ts"
import {
  bestLoot, duelRange, fightRatio, healUntil, lootIntent, newLootChoice, newZoneGoal, ourDps, pickTarget, pickupValue, wantDrop, weaponReflex, zoneDuty, zoneIntent,
  zoneOutside,
} from "./common.ts"

export class SquadScratch {
  readonly zg = newZoneGoal()
  readonly lc = newLootChoice()
  readonly spot = newSpot()
  readonly spot2 = newSpot()
  readonly one: Track[] = []
  /** stand-in for an attacker we cannot see (placed along the damage bearing) */
  readonly phantom = new Track(50)
  /** sound lead (estimated source of the freshest armed-mech sound) */
  sndX = 0
  sndY = 0
  /** kills so far (kill events) and the latched "survivor" mode (play the ghost to outlast the squad) */
  kills = 0
  ghost = false
  /** laser hunt: seen map cells (50 m) and the current exploration goal */
  exSeen: Uint8Array | null = null
  exX = 0
  exY = 0
  exT = -1e9
  exOk = false
  wpn: LootItem | null = null
  ghostHeal = false
  /** peek spot (fight several mechs from a point only the target has a line to) */
  readonly peek = newSpot()
  peekT = -1e9
  peekOk = false
  /** opening jet scan: 0 not started, 1 climbing, 2 falling (still scanning), 3 done */
  js = 0
  /** UNKNOWN-phase restraint (openPassiveS) active this decision / a fight branch was taken */
  passive = false
  fought = false
  /** tempo variants: hunt lead (where to go), sniper post (where to stand, since when, last finished post) */
  hx = 0
  hy = 0
  hz = 0
  hAge = 0
  postX = 0
  postY = 0
  postZ = 0
  postOk = false
  postT = -1e9
  postArrT = -1
  postDoneX = 1e9
  postDoneY = 1e9
  postDoneT = -1e9
  /** crate stand-off variant (play-lab): crate loot goal watched for a stall (id, hp, time of the last progress) */
  cstId = -1
  cstHp = 0
  cstT = 0
  /** crate reflex: phase (0 none, 1 shooting crId, 2 collecting around crX/crY), start / break time, last seen hp */
  crPhase = 0
  crId = -1
  crT0 = 0
  crX = 0
  crY = 0
  crZ = 0
  crHp = 0
  crBrokeT = 0
  /** jet scan: torso yaw swept so far (rad) and the last yaw */
  jsSweep = 0
  jsYaw = NaN
  /** train kiting: last time the trigger held, run direction, waypoint, last plan time, boost burst on */
  trT = -1e9
  trDx = 0
  trDy = 0
  trGX = 0
  trGY = 0
  trGZ = 0
  trPlanT = -1e9
  trOk = false
  trBoost = false
  /** focus fire: primary mech id (-1 none), last time it had a shot line, time it became primary */
  fcId = -1
  fcLineT = -1e9
  fcT = -1e9
  /** two-phase play: the phaseT switch has been applied */
  phDone = false
  /** roof fortress variant (brain/fortress.ts) */
  readonly fort = new FortState()
  /** centre hold variant: spot near the next circle's centre, last search time, arrived there, nav query (on foot) */
  chX = 0
  chY = 0
  chZ = 0
  chOk = false
  chT = -1e9
  chArr = false
  readonly chQ = { radius: 2.5, height: 9, allowJet: false, energy: 0 }
}

/**
 * hunt lead: the freshest known mech (age <= 45 s, age + travel time) or else the freshest armed-mech sound within
 * soundS seconds, into sc.hx/hy/hz (sc.hAge = age of the lead); false when none
 */
function huntLead(bb: Blackboard, sc: SquadScratch, soundS: number): boolean {
  let lead: Track | null = null
  let ls = 1e9
  const trs = bb.tracker.mechs
  for (let i = 0; i < trs.length; i++) {
    const e = trs[i]
    if (!e.known || e.dead || e.id === bb.me.id) continue
    const age = e.age(bb.t)
    if (age > 45 || bb.zone.margin(e.x, e.y) < 10) continue
    if (e.dist < 12 && age > 3) continue // been there, nobody home
    const s = age + e.dist / 12
    if (s < ls) {
      ls = s
      lead = e
    }
  }
  if (lead) {
    sc.hx = lead.x
    sc.hy = lead.y
    sc.hz = lead.z
    sc.hAge = lead.age(bb.t)
    return true
  }
  if (!soundLead(bb, sc, soundS)) return false
  sc.hx = sc.sndX
  sc.hy = sc.sndY
  sc.hz = bb.world ? bb.world.groundZ(sc.sndX, sc.sndY) : bb.z
  sc.hAge = 99
  return true
}

/** drop drift: the nearest called, not yet taken supply drop within dropDriftDist that will be inside the zone */
function dropDriftGoal(bb: Blackboard, it: Intent): void {
  let bd = bb.P.dropDriftDist
  for (let i = 0; i < bb.drops.length; i++) {
    const d = bb.drops[i]
    if (d.holder !== null && d.holder !== bb.me.id) continue
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y)
    if (dist >= bd || bb.zone.marginAt(d.pos[0], d.pos[1], bb.t + d.lands_in + 6) < 6 || bb.isBadGoal(d.pos[0], d.pos[1])) continue
    bd = dist
    it.driftX = d.pos[0]
    it.driftY = d.pos[1]
    it.driftW = bb.P.dropDrift
  }
}

const POST_RINGS = [0, 0.2, 0.4, 0.6, 0.8, 1]
const POST_DIRS = 16
/**
 * sniper post: the ground spot within P.snipeR with the longest sightlines (static exposure field: share of the
 * ground within 200 m that has a line to it) inside the next circle, minus a travel cost; into sc.post*.
 * Re-searched every 2 s (keeps the current post unless a new one is clearly better).
 */
function snipeSpot(bb: Blackboard, sc: SquadScratch): boolean {
  const w = bb.world
  if (!w) return false
  if (bb.t - sc.postT < 2) return sc.postOk
  sc.postT = bb.t
  const f = getExposure(w)
  const R = bb.P.snipeR
  let bs = -1e9
  let bx = 0, by = 0
  const curOk = sc.postOk
  for (let ri = 0; ri < POST_RINGS.length; ri++) {
    const r = POST_RINGS[ri] * R
    const nd = r === 0 ? 1 : POST_DIRS
    for (let k = 0; k < nd; k++) {
      const a = (k * 2 * Math.PI) / nd
      const x = bb.x + r * Math.cos(a), y = bb.y + r * Math.sin(a)
      const c = cellOf(f, x, y)
      if (!(f.flags[c]! & F_STAND)) continue
      if (bb.zone.marginNext(x, y) < 20 || bb.zone.marginAt(x, y, bb.t + 20) < 10) continue
      if (Math.hypot(x - sc.postDoneX, y - sc.postDoneY) < 25 && bb.t - sc.postDoneT < 30) continue
      if (bb.isBadGoal(x, y)) continue
      const s = (100 * f.expo[c]!) / 255 - 0.3 * r
      if (s > bs) {
        bs = s
        bx = x
        by = y
      }
    }
  }
  if (curOk) {
    const c = cellOf(f, sc.postX, sc.postY)
    const cur = (100 * f.expo[c]!) / 255 - 0.3 * Math.hypot(sc.postX - bb.x, sc.postY - bb.y)
    if (cur + 8 >= bs && bb.zone.marginNext(sc.postX, sc.postY) >= 15) return true
  }
  sc.postOk = bs > -1e8
  if (sc.postOk) {
    sc.postX = bx
    sc.postY = by
    sc.postZ = w.groundZ(bx, by)
    sc.postArrT = -1
  }
  return sc.postOk
}

/**
 * centre hold spot: an open ground cell of the exposure field (standable ground layer = no building footprint, no
 * roof; >= 6 m from walls) within centerHoldR of the next circle's centre (zone model: re-searched when that centre
 * moves or the circle 45 s ahead leaves the spot), on our on-foot nav component when one matches; into sc.ch*.
 */
function centerSpot(bb: Blackboard, mv: Mover, sc: SquadScratch): boolean {
  const w = bb.world
  if (!w) return false
  const zn = bb.zone
  const R = Math.max(0, Math.min(bb.P.centerHoldR, zn.nr - bb.P.zoneMargin - 6))
  if (sc.chOk && Math.hypot(sc.chX - zn.ncx, sc.chY - zn.ncy) <= R + 4 && zn.marginAt(sc.chX, sc.chY, bb.t + 45) >= 6 && !bb.isBadGoal(sc.chX, sc.chY)) return true
  sc.chOk = false
  if (bb.t - sc.chT < 1) return false
  sc.chT = bb.t
  const f = getExposure(w)
  const nav = mv.nav
  const q = sc.chQ
  q.radius = bb.radius
  q.height = bb.height
  const myComp = nav ? nav.componentAt(bb.x, bb.y, bb.z, q) : -1
  let bs = -1e9, bsAny = -1e9
  let bx = 0, by = 0, bxAny = 0, byAny = 0
  for (let ri = 0; ri < POST_RINGS.length; ri++) {
    const r = POST_RINGS[ri] * R
    const nd = r === 0 ? 1 : POST_DIRS
    for (let k = 0; k < nd; k++) {
      const a = (k * 2 * Math.PI) / nd
      const x = zn.ncx + r * Math.cos(a), y = zn.ncy + r * Math.sin(a)
      const c = cellOf(f, x, y)
      if (!(f.flags[c]! & F_STAND) || f.edge[c]! < 6) continue
      if (zn.marginAt(x, y, bb.t + 45) < 6 || bb.isBadGoal(x, y)) continue
      const s = Math.min(15, f.edge[c]!) + (10 * f.expo[c]!) / 255 - 0.1 * r - 0.02 * Math.hypot(x - bb.x, y - bb.y)
      if (s > bsAny) {
        bsAny = s
        bxAny = x
        byAny = y
      }
      if (s > bs && (myComp < 0 || nav!.componentAt(x, y, f.z[c]!, q) === myComp)) {
        bs = s
        bx = x
        by = y
      }
    }
  }
  // no candidate on our component (we stand on a roof / in a pocket): the best one anyway (plans may drop down)
  if (bs <= -1e8 && bsAny > -1e8) {
    bs = bsAny
    bx = bxAny
    by = byAny
  }
  if (bs <= -1e8) return false
  sc.chOk = true
  sc.chArr = false
  sc.chX = bx
  sc.chY = by
  sc.chZ = w.groundZ(bx, by)
  return true
}

/** boost on long trips with nobody in sight (tempo) while energy is plentiful */
function travelPace(bb: Blackboard, x: number, y: number): number {
  if (bb.nEn > 0 || bb.energy < bb.P.boostMinEnergy) return PACE_WALK
  return Math.hypot(x - bb.x, y - bb.y) > bb.P.boostTravelDist ? PACE_BOOST : PACE_WALK
}

/** nearest known ground-level pickup of kind wk that we want (value > 0) within maxDist, into sc.wpn */
function bestWeapon(bb: Blackboard, maxDist: number, sc: SquadScratch, wk: number): boolean {
  const items = bb.loot.items
  let bd = maxDist
  sc.wpn = null
  for (let i = 0; i < items.length; i++) {
    const p = items[i]
    if (p.type !== L_PICKUP || p.badUntil > bb.t) continue
    if (p.wk !== wk) continue
    if (pickupValue(bb, p.wk) <= 0) continue
    if (p.z - bb.z > 3) continue // roofs: not in the middle of a fight
    const d = Math.hypot(p.x - bb.x, p.y - bb.y)
    if (d < bd && bb.zone.margin(p.x, p.y) > 6) {
      bd = d
      sc.wpn = p
    }
  }
  return sc.wpn !== null
}

/**
 * laser rush target: the nearest remembered laser pickup within maxDist (roof items only when `roof` and the climb
 * is < 40 m), inside the zone, with fewer than laserRushCrowd visible mechs (besides `target`) within 60 m of it;
 * into sc.wpn
 */
function rushLaser(bb: Blackboard, maxDist: number, sc: SquadScratch, roof: boolean, target: Track | null): boolean {
  const items = bb.loot.items
  let bd = maxDist
  sc.wpn = null
  if (pickupValue(bb, W_LASER) <= 0) return false
  for (let i = 0; i < items.length; i++) {
    const p = items[i]
    if (p.type !== L_PICKUP || p.wk !== W_LASER || p.badUntil > bb.t) continue
    const climb = p.z - bb.z
    if (climb > (roof ? 40 : 3)) continue
    const d = Math.hypot(p.x - bb.x, p.y - bb.y)
    if (d >= bd || bb.zone.marginAt(p.x, p.y, bb.t + d / 15 + 2) < 6) continue
    let crowd = 0
    for (let k = 0; k < bb.nEn; k++) {
      const e = bb.en[k]
      if (e !== target && !e.npc && Math.hypot(e.x - p.x, e.y - p.y) < 60) crowd++
    }
    if (crowd >= bb.P.laserRushCrowd) continue
    bd = d
    sc.wpn = p
  }
  return sc.wpn !== null
}

/** go and take sc.wpn (boost while energy allows), shooting `target` on the way */
function rushIntent(bb: Blackboard, sc: SquadScratch, it: Intent, target: Track | null): void {
  sc.lc.item = sc.wpn
  sc.lc.npc = null
  lootIntent(bb, sc.lc, it, bb.energy > bb.P.laserRushEnergy ? PACE_BOOST : PACE_WALK)
  if (target) {
    it.targetId = target.id
    it.face = FACE_THREATS
  }
  it.label = "rushL"
}

/** every visible mech is at least `clear` m from the item */
function lootIsClear(bb: Blackboard, item: LootItem, clear: number): boolean {
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (Math.hypot(e.x - item.x, e.y - item.y) < clear) return false
  }
  return true
}

/**
 * crate reflex safety: no visible mech within crateReflexSafe, nothing (mech or NPC) shooting at us, no mech fight
 * going on (target hit by us / shooting at us recently), not hurt, and no laser shot available at the target
 */
function crateCalm(bb: Blackboard, target: Track | null): boolean {
  const P = bb.P
  if (bb.nThreats > 0 || bb.npcAggressor !== null || bb.t - bb.tHurt < 2) return false
  if (bb.nearest !== null && bb.nearestD < P.crateReflexSafe) return false
  if (bb.hpFrac < healUntil(bb) && bb.t > 20) return false
  if (target) {
    if (bb.t - target.tHitByUs < 3 || bb.t - target.tShotAtUs < 4) return false
    if (bb.haveLaser && bb.los[target.id] === 1 && target.dist <= P.laserMaxDist) return false
  }
  return true
}

/** best visible crate within crateReflexDist with a clean shot line (near, little turning, current one kept) */
function pickCrate(bb: Blackboard, sc: SquadScratch): LootItem | null {
  const P = bb.P
  const w = bb.world
  const items = bb.loot.items
  const mz = bb.z + bb.muzzleH
  let best: LootItem | null = null
  let bs = 1e9
  for (let i = 0; i < items.length; i++) {
    const c = items[i]
    if (c.type !== L_CRATE || c.tSeen !== bb.t || c.badUntil > bb.t) continue
    const dx = c.x - bb.x, dy = c.y - bb.y
    const d = Math.hypot(dx, dy)
    if (d > P.crateReflexDist || d < 3) continue
    // its cube must be reachable on foot (no roof crates) and stay inside the zone
    if (w && c.z - w.groundZ(c.x, c.y) > 3) continue
    if (bb.zone.marginAt(c.x, c.y, bb.t + 12) < 8) continue
    if (w && !w.segClear(bb.x, bb.y, mz, c.x, c.y, c.z + 1.2)) continue
    const a = Math.atan2(dy, dx) - bb.yaw
    const s = d + 12 * Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) - (c.id === sc.crId ? 20 : 0)
    if (s < bs) {
      bs = s
      best = c
    }
  }
  return best
}

/** start shooting crate c (phase 1) */
function crateStart(bb: Blackboard, sc: SquadScratch, c: LootItem): void {
  if (sc.crPhase !== 1 || sc.crId !== c.id) sc.crT0 = bb.t
  sc.crPhase = 1
  sc.crId = c.id
  sc.crX = c.x
  sc.crY = c.y
  sc.crZ = c.z
  sc.crHp = c.hp
}

/**
 * Crate reflex (P.crateReflexDist > 0): stand still and shoot a nearby crate until it breaks, then collect its cube
 * and a dropped laser (lightning only while no laser is known; never a mortar). Aborts the moment anything engages
 * us or a mech comes within crateReflexSafe. Returns true when it filled the intent.
 */
function crateReflex(bb: Blackboard, sc: SquadScratch, it: Intent, target: Track | null): boolean {
  const P = bb.P
  if (!(P.crateReflexDist > 0)) return false
  if (!crateCalm(bb, target)) {
    sc.crPhase = 0
    return false
  }
  if (sc.crPhase === 1) {
    const c = bb.loot.get(sc.crId)
    if (!c) {
      // gone from memory (broken, or seen gone): collect whatever lies there
      sc.crPhase = 2
      sc.crBrokeT = bb.t
    } else if (bb.t - sc.crT0 > P.crateReflexMaxS || bb.t - c.tSeen > 1) {
      c.badUntil = bb.t + 30
      sc.crPhase = 0
    } else {
      sc.crHp = c.hp
      if (c.tSeen === bb.t) {
        it.hold(bb.x, bb.y, bb.z, "crateR")
        it.shootCrate = c.id
        it.targetId = -1
        return true
      }
      // out of view for a moment (miss count running): hold and keep aiming at it
      it.hold(bb.x, bb.y, bb.z, "crateR")
      it.face = FACE_YAW
      it.faceYaw = Math.atan2(c.y - bb.y, c.x - bb.x)
      return true
    }
  }
  if (sc.crPhase === 2) {
    if (bb.t - sc.crBrokeT > P.crateCollectS) sc.crPhase = 0
    else {
      // a wanted weapon dropped by the crate first (laser; lightning only while no laser is known), else its cube
      const items = bb.loot.items
      const noLaserKnown = !bb.haveLaser && bb.nearestLaserDist() > 1e8
      let best: LootItem | null = null
      let bs = 1e9
      for (let i = 0; i < items.length; i++) {
        const p = items[i]
        if (p.badUntil > bb.t) continue
        const dc = Math.hypot(p.x - sc.crX, p.y - sc.crY)
        if (dc > 8) continue
        let s = Math.hypot(p.x - bb.x, p.y - bb.y)
        if (p.type === L_PICKUP) {
          if (pickupValue(bb, p.wk) <= 0) continue
          if (p.wk === W_LASER) s -= 100
          else if (p.wk === W_LIGHTNING && noLaserKnown) s -= 50
          else continue
        } else if (p.type !== L_CUBE) continue
        if (s < bs) {
          bs = s
          best = p
        }
      }
      if (best) {
        sc.lc.item = best
        sc.lc.npc = null
        const d = Math.hypot(best.x - bb.x, best.y - bb.y)
        lootIntent(bb, sc.lc, it, d > 20 && bb.energy > 40 ? PACE_BOOST : PACE_WALK)
        it.face = FACE_SCAN
        if (target) it.targetId = target.id
        it.label = "crateC"
        return true
      }
      // nothing (left) near the crate: done once the drops had time to show up
      if (bb.t - sc.crBrokeT > 0.6) sc.crPhase = 0
      else {
        it.hold(bb.x, bb.y, bb.z, "crateW")
        it.face = FACE_YAW
        it.faceYaw = Math.atan2(sc.crY - bb.y, sc.crX - bb.x)
        return true
      }
    }
  }
  if (bb.t >= P.crateReflexUntil || !bb.gun || bb.gunSlot < 0) return false
  const c = pickCrate(bb, sc)
  if (!c) return false
  crateStart(bb, sc, c)
  it.hold(bb.x, bb.y, bb.z, "crateR")
  it.shootCrate = c.id
  it.targetId = -1
  return true
}

const hpFracOf = (e: Track): number => (e.hp >= 0 && e.maxHp > 0 ? e.hp / e.maxHp : 1)

/** focus fire: expected seconds to kill e from here (current HP incl. cube scaling / our DPS at its distance) */
function focusTtk(bb: Blackboard, e: Track): number {
  const hp = e.hp >= 0 ? e.hp : (bb.cfg.mech.hp ?? 1400)
  const d = ourDps(bb, e, e.dist)
  return d > 1 ? hp / d : 1e3
}

/** focus fire, kill confirmation: e is nearly dead (HP fraction below focusFinishHp, or our expected time to kill it
 *  at most focusFinishS s), we have a shot line, our own HP fraction is at least focusFinishSelf and at most
 *  focusFinishCrowd other mechs are on us (shot at us within 3 s or aiming at us with a line) */
function focusFinish(bb: Blackboard, e: Track): boolean {
  const P = bb.P
  if (e.npc || bb.los[e.id] !== 1 || bb.hpFrac < P.focusFinishSelf) return false
  if (!((P.focusFinishHp > 0 && hpFracOf(e) < P.focusFinishHp) || (P.focusFinishS > 0 && focusTtk(bb, e) <= P.focusFinishS))) return false
  if (P.focusFinishCrowd < 99) {
    let n = 0
    for (let i = 0; i < bb.nEn; i++) {
      const o = bb.en[i]
      if (o !== e && !o.npc && (bb.t - o.tShotAtUs < 3 || (o.aimingAtUs && bb.los[o.id] === 1))) n++
    }
    if (n > P.focusFinishCrowd) return false
  }
  return true
}

/** spare pacing (P.spareHp > 0): e is a mech below spareHp that we leave alive for now - we are still weak (cubes <
 *  spareCubes / no laser with spareLaser 1), before spareUntil, our HP fraction >= spareSelfHp and fewer than
 *  spareOnUs other mechs on us (shot at us within 3 s or aiming at us with a line) */
function spareNow(bb: Blackboard, e: Track): boolean {
  const P = bb.P
  if (e.npc || bb.t >= P.spareUntil || hpFracOf(e) >= P.spareHp || bb.hpFrac < P.spareSelfHp) return false
  if (!((P.spareCubes > 0 && bb.cubes < P.spareCubes) || (P.spareLaser > 0 && !bb.haveLaser))) return false
  let n = 0
  for (let i = 0; i < bb.nEn; i++) {
    const o = bb.en[i]
    if (o !== e && !o.npc && (bb.t - o.tShotAtUs < 3 || (o.aimingAtUs && bb.los[o.id] === 1))) n++
  }
  return n < P.spareOnUs
}

/**
 * Focus fire (P.focusFire): the sticky primary mech target. Kept while alive and with a shot line within
 * focusHoldS; a challenger with a line replaces it only when its time to kill is < focusSwitchK x the primary's
 * (never a full-HP one while the primary is wounded); with no primary the cheapest-to-kill mech with a line
 * (full-HP ones only when no mech with a line is below focusWound HP). While the primary has no line the best other
 * mech with a line is returned (focusAlt) without becoming the primary. `fb` (pickTarget) is returned when no mech
 * with a line qualifies, and NPC choices pass through unless the primary has a line.
 */
function focusTarget(bb: Blackboard, sc: SquadScratch, fb: Track | null): Track | null {
  const P = bb.P
  let prim: Track | null = null
  if (sc.fcId >= 0) {
    const tr = bb.tracker.get(sc.fcId)
    if (!tr || tr.dead || !tr.known || bb.t - sc.fcLineT > P.focusHoldS) sc.fcId = -1
    else if (tr.visible) prim = tr
  }
  const primLine = prim !== null && bb.los[prim.id] === 1
  if (primLine) sc.fcLineT = bb.t
  // candidates: visible mechs with a shot line within our weapons' reach
  let wounded = false
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (e.npc || bb.los[e.id] !== 1) continue
    if (hpFracOf(e) < P.focusWound) wounded = true
  }
  let best: Track | null = null
  let bs = 1e9
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (e.npc || bb.los[e.id] !== 1 || e === prim) continue
    if (wounded && hpFracOf(e) >= 0.98) continue
    const s = focusTtk(bb, e)
    if (s < bs) {
      bs = s
      best = e
    }
  }
  let out: Track | null
  if (primLine) {
    out = prim
    if (best && bs < P.focusSwitchK * focusTtk(bb, prim!) && !(hpFracOf(prim!) < P.focusWound && hpFracOf(best) >= 0.98)) {
      sc.fcId = best.id
      sc.fcT = bb.t
      out = best
    }
  } else if (sc.fcId >= 0) {
    // primary out of line (or out of sight) for less than focusHoldS: shoot someone else meanwhile, keep it primary
    out = P.focusAlt > 0 && best ? best : (prim ?? fb)
  } else if (best) {
    sc.fcId = best.id
    sc.fcT = bb.t
    sc.fcLineT = bb.t
    out = best
  } else out = fb
  if (out) {
    bb.mem.targetId = out.id
    bb.mem.targetT = bb.t
  }
  return out
}

/** train kiting: visible mechs within kiteTrainR, or with a line on us within 220 m that aim / shot at us */
function trainPursuers(bb: Blackboard): number {
  const R = bb.P.kiteTrainR
  let n = 0
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (e.dist < R || (bb.los[e.id] === 1 && e.dist < 220 && (e.aimingAtUs || bb.t - e.tShotAtUs < 3))) n++
  }
  return n
}

const TR_DIRS = 16
const TR_STEPS = [0.25, 0.5, 0.75, 1]
/**
 * train route: the run direction (16 candidates) that leads away from the pack's centroid along a long walkable
 * line that does not dead-end, stays inside the zone, keeps clear of every pursuer, prefers open ground and the
 * current direction; waypoint into sc.trG*
 */
function trainPlan(bb: Blackboard, mv: Mover, sc: SquadScratch): boolean {
  const P = bb.P
  const w = bb.world
  let cx = 0, cy = 0, cw = 0
  const trs = bb.tracker.mechs
  for (let i = 0; i < trs.length; i++) {
    const e = trs[i]
    if (!e.known || e.dead || e.id === bb.me.id) continue
    const age = e.age(bb.t)
    if (age > 8 || e.dist > 300) continue
    const wt = (e.visible ? 1 : 0.5) / (e.dist + 20)
    cx += e.x * wt
    cy += e.y * wt
    cw += wt
  }
  let ax = sc.trDx, ay = sc.trDy
  if (cw > 0) {
    ax = bb.x - cx / cw
    ay = bb.y - cy / cw
    const l = Math.hypot(ax, ay)
    if (l > 1e-3) {
      ax /= l
      ay /= l
    }
  }
  const L = P.kiteTrainLook
  const f = w ? getExposure(w) : null
  let bs = -1e9, bdx = 0, bdy = 0, bfree = 0
  for (let k = 0; k < TR_DIRS; k++) {
    const a = (k * 2 * Math.PI) / TR_DIRS
    const dx = Math.cos(a), dy = Math.sin(a)
    let free = 0
    for (let s = 0; s < TR_STEPS.length; s++) {
      if (!mv.walkOk(bb, bb.x + dx * L * TR_STEPS[s], bb.y + dy * L * TR_STEPS[s])) break
      free = L * TR_STEPS[s]
    }
    if (free <= 0) continue
    const ex = bb.x + dx * free, ey = bb.y + dy * free
    // dead end: no walkable continuation (straight or +-45 deg) from the end point
    let cont = 0
    if (w && free >= L * 0.5) {
      const ez = w.groundZ(ex, ey)
      for (let j = 0; j < 3 && cont === 0; j++) {
        const a2 = a + (j - 1) * 0.8
        if (mv.walkOkFrom(ex, ey, ez, ex + Math.cos(a2) * L * 0.5, ey + Math.sin(a2) * L * 0.5, bb.radius)) cont = 1
      }
    }
    const zm = Math.min(bb.zone.marginAt(ex, ey, bb.t + free / 12), bb.zone.marginNext(ex, ey))
    // pursuers near the route (distance from each visible mech to the segment us -> end point)
    let block = 0
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      const rx = e.x - bb.x, ry = e.y - bb.y
      const along = Math.max(0, Math.min(free, rx * dx + ry * dy))
      const dd = Math.hypot(rx - dx * along, ry - dy * along)
      if (dd < 40) block += (40 - dd) / 40
    }
    let s = 3 * (dx * ax + dy * ay) + (2 * free) / L + cont + (dx * sc.trDx + dy * sc.trDy) - 4 * block
    if (zm < 25) s += (zm - 25) * 0.15
    if (f) {
      const c = cellOf(f, ex, ey)
      if (f.flags[c]! & F_STAND) s += f.expo[c]! / 255
    }
    if (s > bs) {
      bs = s
      bdx = dx
      bdy = dy
      bfree = free
    }
  }
  if (bs < -1e8) return false
  sc.trDx = bdx
  sc.trDy = bdy
  const g = Math.max(10, bfree * 0.8)
  sc.trGX = bb.x + bdx * g
  sc.trGY = bb.y + bdy * g
  sc.trGZ = w ? w.groundZ(sc.trGX, sc.trGY) : bb.z
  return true
}

/**
 * Train kiting (P.kiteTrainN > 0, or from P.kiteTrainT with any pursuer): with several hunters on us keep RUNNING a
 * long open route ahead of the pack (boost bursts with energy hysteresis) while the torso shoots the nearest pursuer
 * with a clean line (nearly dead ones first). Cubes lying ahead on the route are picked up. Returns true when it
 * filled the intent.
 */
function trainKite(bb: Blackboard, mv: Mover, sc: SquadScratch, it: Intent, target: Track | null): boolean {
  const P = bb.P
  if (bb.t < P.kiteTrainFrom || (P.kiteTrainLaser > 0 && !bb.haveLaser)) return false
  if (bb.haveLightning && !bb.haveLaser) return false
  const n = trainPursuers(bb)
  if (n === 0) return false
  if (n >= P.kiteTrainN || bb.t >= P.kiteTrainT) sc.trT = bb.t
  if (bb.t - sc.trT > P.kiteTrainHoldS) {
    sc.trOk = false
    return false
  }
  // target: nearest pursuer with a clean line, nearly dead ones first (focus fire variant: the sticky primary)
  let tg: Track | null = null
  let ts = 1e9
  let near = 1e9
  const focus = P.focusFire > 0 && target !== null && !target.npc && bb.los[target.id] === 1
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (e.dist < near) near = e.dist
    if (focus || bb.los[e.id] !== 1) continue
    const hpF = e.hp >= 0 && e.maxHp > 0 ? e.hp / e.maxHp : 1
    const s = e.dist - (hpF < 0.3 ? 80 : 0) - (e.id === bb.mem.targetId ? 10 : 0)
    if (s < ts) {
      ts = s
      tg = e
    }
  }
  if (focus) tg = target
  if (!tg) tg = target
  if (tg) {
    bb.mem.targetId = tg.id
    bb.mem.targetT = bb.t
  }
  // focus fire: finish a nearly dead primary / stand and shoot while the damage race is clearly ours
  if (tg && !tg.npc && bb.los[tg.id] === 1 && bb.hpFrac >= P.focusFinishSelf) {
    const fin = focusFinish(bb, tg)
    if (fin || (P.focusStandRatio > 0 && fightRatio(bb, tg) >= P.focusStandRatio)) {
      sc.trBoost = false
      it.fight(tg.id, STYLE_HOLD, tg.dist, fin ? "fcFin" : "fcStand")
      it.face = FACE_THREATS
      return true
    }
  }
  // route: replan every 0.5 s or near the waypoint
  if (!sc.trOk || bb.t - sc.trPlanT > 0.5 || Math.hypot(sc.trGX - bb.x, sc.trGY - bb.y) < 8) {
    sc.trPlanT = bb.t
    sc.trOk = trainPlan(bb, mv, sc)
  }
  if (!sc.trOk) return false
  // boost bursts: on with energy >= kiteTrainBoostE while a pursuer is within kiteTrainBoostDist, off below 15
  if (sc.trBoost) {
    if (bb.energy < 15 || near > P.kiteTrainBoostDist) sc.trBoost = false
  } else if (bb.energy >= P.kiteTrainBoostE && near <= P.kiteTrainBoostDist) sc.trBoost = true
  const pace = sc.trBoost ? PACE_BOOST : PACE_WALK
  // range keeping: every pursuer beyond kiteTrainDist (their guns hit ~18 % there, our laser does not care) -> stand
  // and shoot (no charge slow-down, no route into the others)
  if (P.kiteTrainDist > 0 && near >= P.kiteTrainDist) {
    sc.trBoost = false
    it.hold(bb.x, bb.y, bb.z, "trHold")
    it.face = FACE_THREATS
    if (tg) it.targetId = tg.id
    return true
  }
  // a cube ahead on the route (within 30 m, inside +-40 deg of the run direction, nearer to us than to any pursuer)
  const items = bb.loot.items
  let cube: LootItem | null = null
  let cd = 30
  for (let i = 0; i < items.length; i++) {
    const c = items[i]
    if (c.type !== L_CUBE || c.badUntil > bb.t) continue
    const rx = c.x - bb.x, ry = c.y - bb.y
    const d = Math.hypot(rx, ry)
    if (d >= cd || d < 0.5 || (rx * sc.trDx + ry * sc.trDy) / d < 0.77) continue
    let ok = true
    for (let k = 0; k < bb.nEn && ok; k++) if (Math.hypot(bb.en[k].x - c.x, bb.en[k].y - c.y) < d + 10) ok = false
    if (ok) {
      cd = d
      cube = c
    }
  }
  if (cube) it.goto(cube.x, cube.y, cube.z, pace, "trCube").arrive = 0.6
  else {
    it.goto(sc.trGX, sc.trGY, sc.trGZ, pace, "train")
    it.arrive = 2
  }
  it.allowJet = false
  it.face = FACE_THREATS
  if (tg) it.targetId = tg.id
  return true
}

const EX_CELL = 50
/** mark the cells around us as seen; pick the nearest unseen cell centre inside the next circle (into sc.exX/Y) */
function exploreUnseen(bb: Blackboard, sc: SquadScratch): boolean {
  const w = bb.world
  if (!w) return false
  const b = w.bounds
  const nx = Math.ceil((b.maxX - b.minX) / EX_CELL), ny = Math.ceil((b.maxY - b.minY) / EX_CELL)
  if (!sc.exSeen || sc.exSeen.length !== nx * ny) sc.exSeen = new Uint8Array(nx * ny)
  const seen = sc.exSeen
  const r = bb.P.laserHuntSeenR
  const i0 = Math.max(0, Math.floor((bb.x - r - b.minX) / EX_CELL)), i1 = Math.min(nx - 1, Math.floor((bb.x + r - b.minX) / EX_CELL))
  const j0 = Math.max(0, Math.floor((bb.y - r - b.minY) / EX_CELL)), j1 = Math.min(ny - 1, Math.floor((bb.y + r - b.minY) / EX_CELL))
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const cx = b.minX + (i + 0.5) * EX_CELL, cy = b.minY + (j + 0.5) * EX_CELL
      if (Math.hypot(cx - bb.x, cy - bb.y) < r) seen[j * nx + i] = 1
    }
  // keep the current goal while it is unseen
  if (sc.exOk) {
    const ci = Math.floor((sc.exX - b.minX) / EX_CELL), cj = Math.floor((sc.exY - b.minY) / EX_CELL)
    if (seen[cj * nx + ci] === 0 && bb.t - sc.exT < 30) return true
  }
  let bd = 1e9
  sc.exOk = false
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (seen[j * nx + i]) continue
      const cx = b.minX + (i + 0.5) * EX_CELL, cy = b.minY + (j + 0.5) * EX_CELL
      if (bb.zone.marginNext(cx, cy) < 15) continue
      const d = Math.hypot(cx - bb.x, cy - bb.y)
      if (d < bd) {
        bd = d
        sc.exX = cx
        sc.exY = cy
        sc.exOk = true
      }
    }
  if (sc.exOk) sc.exT = bb.t
  return sc.exOk
}

/** sound kinds that mean "an armed mech is (or just was) there" */
const MECH_SOUND = new Uint8Array(16)
for (const k of [S_GUN, S_MORTAR, S_LASER, S_LASER_CHARGE, S_LIGHTNING, S_CRATE, S_NPC_GUN, S_STEP, S_BOOST, S_JET, S_RELOAD]) MECH_SOUND[k] = 1

/** freshest armed-mech sound inside the zone (age + travel time), into sc.sndX/Y; false when none */
function soundLead(bb: Blackboard, sc: SquadScratch, maxAge: number = bb.P.seekSoundS): boolean {
  const s = bb.sounds
  const cap = s.evKind.length
  let bs = 1e9
  for (let k = 0; k < s.evCount; k++) {
    const i = (s.evHead - 1 - k + cap) % cap
    const age = bb.t - s.evT[i]
    if (age > maxAge || age < -1) continue
    if (MECH_SOUND[s.evKind[i]] !== 1) continue
    const x = s.evX[i], y = s.evY[i]
    const d = Math.hypot(x - bb.x, y - bb.y)
    if (d < 20 || bb.zone.margin(x, y) < 10) continue
    if (zoneOutside(bb, x, y, d / bb.walk)) continue
    let sc2 = age + d / 12
    // without a laser, laser carriers are the best kills (they drop it)
    if (bb.P.seekLaserBonus > 0 && !bb.haveLaser && (s.evKind[i] === S_LASER || s.evKind[i] === S_LASER_CHARGE)) sc2 -= bb.P.seekLaserBonus
    if (sc2 < bs) {
      bs = sc2
      sc.sndX = x
      sc.sndY = y
    }
  }
  return bs < 1e9
}

/** fight sub-decision shared with the FFA strategy: fills the intent for a duel with `target` */
export function duelIntent(bb: Blackboard, mv: Mover, sc: SquadScratch, it: Intent, target: Track, allowDisengage: boolean): void {
  const P = bb.P
  const m = bb.mem
  const ratio = fightRatio(bb, target)
  const tHpFrac = target.hp >= 0 && target.maxHp > 0 ? target.hp / target.maxHp : 1
  const g = bb.gun
  const ltgUsable = bb.haveLightning && bb.energy > 12 && target.dist < 48

  // regenerating: stay behind cover while nobody has a line on us; fight when cornered
  if (allowDisengage) {
    if (!m.regen && ratio < P.squadDisengageRatio && bb.hpFrac < P.squadDisengageHp && tHpFrac > P.squadFinishHp) {
      if (bb.t - m.coverT > 0.5) {
        m.coverT = bb.t
        m.coverOk = mv.findCover(bb, bb.en, bb.nEn, P.coverMaxDist, sc.spot)
        if (m.coverOk) {
          m.coverX = sc.spot.x
          m.coverY = sc.spot.y
          m.coverZ = sc.spot.z
        }
      }
      if (m.coverOk) m.regen = true
    }
    if (m.regen) {
      if (bb.hpFrac >= healUntil(bb) || tHpFrac <= P.squadFinishHp) m.regen = false
      else {
        const seen = bb.los[target.id] === 1
        if (seen && bb.t - m.coverT > 0.5) {
          m.coverT = bb.t
          m.coverOk = mv.findCover(bb, bb.en, bb.nEn, P.coverMaxDist, sc.spot)
          if (m.coverOk) {
            m.coverX = sc.spot.x
            m.coverY = sc.spot.y
            m.coverZ = sc.spot.z
          }
        }
        if (m.coverOk && !(seen && target.dist < 14)) {
          it.flee(m.coverX, m.coverY, m.coverZ, bb.energy > 30 && seen ? PACE_BOOST : PACE_WALK, "regen")
          it.targetId = target.id
          it.arrive = 1
          return
        }
        m.regen = false
      }
    }
  }

  // reload behind cover when the gun is our only damage and the target is healthy
  if (P.reloadCoverHp > 0 && g && (g.reload ?? 0) > 0.7 && !ltgUsable && tHpFrac > P.reloadCoverHp && bb.los[target.id] === 1) {
    if (bb.t - m.coverT > 0.4) {
      m.coverT = bb.t
      sc.one[0] = target
      m.coverOk = mv.findCover(bb, sc.one, 1, P.reloadCoverDist, sc.spot)
      if (m.coverOk) {
        m.coverX = sc.spot.x
        m.coverY = sc.spot.y
        m.coverZ = sc.spot.z
      }
    }
    if (m.coverOk && Math.hypot(m.coverX - bb.x, m.coverY - bb.y) < P.reloadCoverDist + 4) {
      it.flee(m.coverX, m.coverY, m.coverZ, PACE_WALK, "reload")
      it.targetId = target.id
      it.arrive = 0.8
      return
    }
  }

  const range = duelRange(bb, target)
  // focus fire variant, kill confirmation: a nearly dead mech in line is finished from where we stand (no back-off)
  if ((P.focusFinishHp > 0 || P.focusFinishS > 0) && focusFinish(bb, target)) {
    it.fight(target.id, STYLE_HOLD, range, "fcFin")
    return
  }
  // sniper post variant: a laser target beyond the kite band with a clean line is fought from where we stand
  if (P.snipePost > 0 && bb.mode !== MODE_FFA && bb.haveLaser && !target.npc && bb.los[target.id] === 1 && target.dist > range + P.rangeBand && target.dist <= P.snipeMaxDist) {
    it.fight(target.id, STYLE_HOLD, range, "snipe")
    return
  }
  // finish kills: a nearly dead mech running away (or out of sight) is chased with boost, unless others guard it
  if (P.finishChaseHp > 0 && !target.npc && tHpFrac < P.finishChaseHp) {
    const d = Math.max(0.1, target.dist)
    const away = (target.vx * (target.x - bb.x) + target.vy * (target.y - bb.y)) / d
    if (away > 1 || bb.los[target.id] !== 1) {
      let crowd = 0
      for (let i = 0; i < bb.nEn; i++) {
        const e = bb.en[i]
        if (e !== target && !e.npc && Math.hypot(e.x - target.x, e.y - target.y) < 60) crowd++
      }
      if (crowd < P.finishChaseCrowd && bb.zone.margin(target.x, target.y) > 5) {
        it.fight(target.id, STYLE_PUSH, Math.min(range, P.finishChaseRange), "finish")
        it.chase = true
        return
      }
    }
  }
  // several mechs around: fight from the nearby point where only the target has a line on us
  if (P.peekMargin > 0 && !target.npc && bb.nEn > 1) {
    if (bb.t - sc.peekT > P.peekEvery) {
      sc.peekT = bb.t
      const here = mv.findPeek(bb, target, range, sc.peek)
      sc.peekOk = sc.peek.ok && sc.peek.score + P.peekMargin < here
    }
    if (sc.peekOk) {
      it.fight(target.id, STYLE_SPOT, range, "peek")
      it.gx = sc.peek.x
      it.gy = sc.peek.y
      it.gz = sc.peek.z
      return
    }
  } else sc.peekOk = false
  it.fight(target.id, STYLE_PUSH, range, "duel")
}

/**
 * Shot at with no mech to fight back at: kill an attacking NPC drone; against an unseen shooter face the
 * damage bearing and get behind something. Returns true when it filled the intent.
 */
export function underFire(bb: Blackboard, mv: Mover, sc: SquadScratch, it: Intent): boolean {
  const m = bb.mem
  const npc = bb.npcAggressor
  if (npc) {
    it.fight(npc.id, STYLE_PUSH, 26, "npc!")
    return true
  }
  if (bb.t - bb.tHurt > 2.5 || bb.lastHurtBy < 0 || bb.lastHurtBy >= 100) return false
  const ph = sc.phantom
  const d = 90
  ph.x = bb.x + d * Math.cos(bb.lastHurtBearing)
  ph.y = bb.y + d * Math.sin(bb.lastHurtBearing)
  ph.z = bb.world ? bb.world.groundZ(ph.x, ph.y) : bb.z
  ph.dist = d
  if (bb.t - m.coverT > 0.5) {
    m.coverT = bb.t
    sc.one[0] = ph
    m.coverOk = mv.findCover(bb, sc.one, 1, 35, sc.spot)
    if (m.coverOk) {
      m.coverX = sc.spot.x
      m.coverY = sc.spot.y
      m.coverZ = sc.spot.z
    }
  }
  if (m.coverOk) it.flee(m.coverX, m.coverY, m.coverZ, PACE_WALK, "sniped")
  else it.hold(bb.x, bb.y, bb.z, "sniped")
  it.face = FACE_THREATS
  return true
}

export function decideSquad(bb: Blackboard, mv: Mover, sc: SquadScratch): Intent {
  const P = bb.P
  // UNKNOWN-phase restraint (openPassiveS, off by default): until the mode is settled (FFA latch / squad lock) or
  // openPassiveS, start no fight beyond openEngageDist with a mech that is not on us, do not walk to enemies or
  // sounds, and hold fire on mechs that are not on us (in an FFA every early fight costs places; data/intel/final-plan.md)
  sc.passive = P.openPassiveS > 0 && bb.t < P.openPassiveS && !bb.squadLocked && bb.mode !== MODE_FFA
  sc.fought = false
  const it = decideSquadCore(bb, mv, sc)
  if (sc.passive && !sc.fought && it.weaponsFree && it.targetId >= 0 && it.targetId < 100) {
    let threat = false
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      if (e.id === it.targetId) threat = bb.t - e.tShotAtUs < 3 || (e.aimingAtUs && bb.los[e.id] === 1) || e.dist < P.openEngageDist
    }
    if (!threat) it.weaponsFree = false
  }
  // spare pacing variant: hold fire on a nearly dead mech we leave alive for now
  if (P.spareHp > 0 && it.weaponsFree && it.targetId >= 0 && it.targetId < 100) {
    const tr = bb.tracker.get(it.targetId)
    if (tr && tr.visible && spareNow(bb, tr)) it.weaponsFree = false
  }
  return it
}

function decideSquadCore(bb: Blackboard, mv: Mover, sc: SquadScratch): Intent {
  const P = bb.P
  const m = bb.mem
  const evs = bb.obs.events
  for (let i = 0; i < evs.length; i++) if (evs[i].type === "kill") sc.kills++
  // two-phase variant: from phaseT the ph* values replace their base params (bb.P is this bot's own copy)
  if (!sc.phDone && ((P.phaseT > 0 && bb.t >= P.phaseT) || (P.phaseCubes > 0 && bb.cubes >= P.phaseCubes) || (P.phaseKills > 0 && sc.kills >= P.phaseKills))) {
    sc.phDone = true
    if (P.phEngageDist >= 0) P.engageDist = P.phEngageDist
    if (P.phSeekSoundS >= 0) P.seekSoundS = P.phSeekSoundS
    if (P.phValNpc >= 0) P.valNpc = P.phValNpc
    if (P.phValCrate >= 0) P.valCrate = P.phValCrate
    if (P.phValCube >= 0) P.valCube = P.phValCube
  }

  // survivor mode: from a time / kill count / number of mechs on us, stop hunting and play the ghost (hide, break
  // line of sight, heal) to outlast the squad until the zone collapse (alive at the end = 1st place)
  if (!sc.ghost && (P.ghostT > 0 || P.ghostKills > 0 || P.ghostOnUs > 0)) {
    let onUs = 0
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      if (bb.t - e.tShotAtUs < 3 || (e.aimingAtUs && bb.los[e.id] === 1)) onUs++
    }
    if ((P.ghostT > 0 && bb.t >= P.ghostT) || (P.ghostKills > 0 && sc.kills >= P.ghostKills) || (P.ghostOnUs > 0 && onUs >= P.ghostOnUs && bb.t >= P.ghostOnUsAfter)) sc.ghost = true
  }
  if (sc.ghost) return decideFfa(bb, mv, sc)
  // evasive heal (not latched): below ghostHealHp break contact like the ghost, back to hunting at ghostHealUntil
  if (P.ghostHealHp > 0) {
    if (!sc.ghostHeal && bb.hpFrac < P.ghostHealHp) sc.ghostHeal = true
    else if (sc.ghostHeal && bb.hpFrac >= P.ghostHealUntil) sc.ghostHeal = false
    if (sc.ghostHeal) {
      const r = decideFfa(bb, mv, sc)
      if (r.label) r.label = "gh:" + r.label
      return r
    }
  }
  const it = bb.intent.reset()
  let target = pickTarget(bb)
  // focus fire variant: the sticky primary mech replaces pickTarget's mech choice (NPC choices pass through)
  if (P.focusFire > 0) {
    const fc = focusTarget(bb, sc, target)
    if (!(target && target.npc)) target = fc
    else {
      bb.mem.targetId = target.id
      bb.mem.targetT = bb.t
    }
  }
  const zl = zoneDuty(bb, sc.zg)

  // 0'. opening jet scan: straight up to jetScan m above the ground while spinning, then fall back scanning
  if (P.jetScan > 0 && sc.js < 3) {
    const w = bb.world
    const g = w ? w.groundZ(bb.x, bb.y) : bb.z
    const close = target !== null && target.dist < 100
    if (sc.js === 0) {
      const h = bb.me.stats.height ?? 9
      const open = !w || w.segClear(bb.x, bb.y, bb.z + h + 0.2, bb.x, bb.y, bb.z + h + P.jetScan + 2)
      sc.js = bb.t < 3 && bb.grounded && open && !close && zl < 2 && bb.energy >= P.jetScanMinE + 20 && bb.t - bb.tHurt > 2 ? 1 : 3
    }
    if (sc.js === 1 && (bb.z - g >= P.jetScan || bb.energy < P.jetScanMinE || bb.t - bb.tHurt < 0.5 || close || bb.t > 8 || (bb.t > 1 && bb.grounded))) sc.js = 2
    if (sc.js === 2 && (bb.grounded || close || bb.t > 12)) sc.js = 3
    if (sc.js < 3) {
      it.hold(bb.x, bb.y, bb.z, sc.js === 1 ? "jetscan" : "jsfall")
      it.jetUp = sc.js === 1
      it.face = FACE_SCAN
      if (target) it.targetId = target.id
      // crate reflex variant: once a full turn is done, lock onto a crate in line (shot from the air)
      if (P.crateScan > 0 && P.crateReflexDist > 0) {
        if (sc.jsYaw === sc.jsYaw) {
          const dy = bb.yaw - sc.jsYaw
          sc.jsSweep += Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)))
        }
        sc.jsYaw = bb.yaw
        if (sc.crPhase === 1 && bb.loot.get(sc.crId) === null) {
          sc.crPhase = 2 // broke while we were airborne: collect after landing
          sc.crBrokeT = bb.t
        }
        if (sc.jsSweep >= 2 * Math.PI && sc.crPhase !== 2 && crateCalm(bb, target) && bb.gun && bb.gunSlot >= 0) {
          const cur = sc.crPhase === 1 ? bb.loot.get(sc.crId) : null
          const c = cur && cur.tSeen === bb.t ? cur : pickCrate(bb, sc)
          if (c) {
            crateStart(bb, sc, c)
            it.shootCrate = c.id
            it.targetId = -1
            it.label = sc.js === 1 ? "jscrate" : "jfcrate"
          }
        }
      }
      weaponReflex(bb, it)
      return it
    }
  }

  // 0. opening: one full turn on the spot shows every pickup / crate / mech within 200 m before we commit
  if (bb.t < P.openScanS && !target && bb.t - bb.tHurt > 2 && zl < 2 && !(P.jetScan > 0)) {
    it.hold(bb.x, bb.y, bb.z, "scan")
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }

  // 1. zone
  if (zl >= 2) {
    zoneIntent(bb, sc.zg, it, target)
    weaponReflex(bb, it)
    return it
  }

  // 1'. roof fortress variant: from a trigger (pack on us / time / hurt / kills) hold the interior of a tall roof in
  // the next circle, out of the line of the ground, shooting whoever comes over the edge
  if (fortEnabled(bb)) {
    let ph: Track | null = null
    if (bb.t - bb.tHurt < 2.5 && bb.lastHurtBy >= 0 && bb.lastHurtBy < 100) {
      const tr = bb.tracker.get(bb.lastHurtBy)
      if (!tr || !tr.visible) {
        ph = sc.phantom
        ph.x = bb.x + 90 * Math.cos(bb.lastHurtBearing)
        ph.y = bb.y + 90 * Math.sin(bb.lastHurtBearing)
        ph.z = bb.world ? bb.world.groundZ(ph.x, ph.y) : bb.z
      }
    }
    if (fortress(bb, mv, sc.fort, it, target, sc.kills, ph)) {
      weaponReflex(bb, it)
      return it
    }
  }

  // 2. supply drop
  // safe-drop variant: hurt -> only an uncontested drop with nobody in sight
  const safeDrop = P.dropSafeHp > 0
  const lowHp = safeDrop && bb.hpFrac < P.dropSafeHp
  const di = lowHp && target ? -1 : wantDrop(bb, lowHp ? P.dropEnemyClear : 0)
  if (di >= 0) {
    const d = bb.drops[di]
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y)
    // in a duel only when it is close (walking away from a fight shows our side for too long)
    // with a mech on us only when it is (about to be) capturable: walking toward a drop that lands in 20 s
    // turns the duel into a long-range one we lose
    const soonEnough = !target || d.lands_in <= (dist / bb.walk) * 1.3 + P.dropFightLeadS
    // refuel variant: hurt -> go for it from far and through a fight (full HP + 3 cubes + energy), arriving as it lands
    const refuel = P.dropRefuelHp > 0 && bb.hpFrac < P.dropRefuelHp && dist <= P.dropRefuelDist && d.lands_in <= (dist / bb.walk) * 1.3 + 3
    if (refuel || (soonEnough && (!target || bb.nThreats === 0 || dist < 35 || (!safeDrop && bb.hpFrac < 0.75 && dist < 150)))) {
      it.capture(d.pos[0], d.pos[1], d.pos[2], target || dist < 40 ? PACE_WALK : PACE_BOOST, refuel ? "refuel" : "drop")
      it.face = FACE_THREATS
      if (target) it.targetId = target.id
      weaponReflex(bb, it)
      return it
    }
  }

  // 2''. train kiting variant: several hunters on us (or late) -> run a long open route ahead of the pack, shooting back
  if ((P.kiteTrainN > 0 || P.kiteTrainT < 999) && trainKite(bb, mv, sc, it, target)) {
    weaponReflex(bb, it)
    return it
  }

  // 2'. crate reflex variant (no mech near, nothing on us): stand and shoot a crate, then collect its cube / laser
  if (P.crateReflexDist > 0 && crateReflex(bb, sc, it, target)) {
    weaponReflex(bb, it)
    return it
  }

  // 3. fight: whoever engages us, or is close; a far mech that ignores us is only shot at in passing
  // hurt: leave mechs that have not noticed us alone unless they are close (time to regenerate first)
  const engD0 = bb.hpFrac < healUntil(bb) ? Math.min(P.engageDist, P.engageHurtDist) : P.engageDist
  const engD = sc.passive ? Math.min(engD0, P.openEngageDist) : engD0
  const engaged = target !== null && (bb.nThreats > 0 || target.dist < engD || bb.t - target.tShotAtUs < 4 || bb.t - target.tHitByUs < 2)
  // spare pacing variant: a nearly dead lone mech is left alive while we are weak (we farm / take cover instead)
  if (target && engaged && !(P.spareHp > 0 && spareNow(bb, target))) {
    sc.fought = true
    // no laser yet: go for a known one (boost), shooting on the way, unless this duel is nearly won
    const tHp = target.hp >= 0 && target.maxHp > 0 ? target.hp / target.maxHp : 1
    if (P.laserRush > 0 && !bb.haveLaser && !(tHp < P.laserRushFinish && target.dist < P.laserRushFinishDist) && rushLaser(bb, P.laserRush, sc, false, target)) {
      rushIntent(bb, sc, it, target)
      weaponReflex(bb, it)
      return it
    }
    // a known lightning (or, without one, a wanted weapon) further away: worth leaving the duel range for
    if ((P.duelLtgDist > 0 && bestWeapon(bb, P.duelLtgDist, sc, W_LIGHTNING)) || (P.duelLaserDist > 0 && !bb.haveLaser && bestWeapon(bb, P.duelLaserDist, sc, W_LASER))) {
      sc.lc.item = sc.wpn
      sc.lc.npc = null
      lootIntent(bb, sc.lc, it, PACE_WALK)
      it.targetId = target.id
      it.face = FACE_THREATS
      it.label = "grabW"
      weaponReflex(bb, it)
      return it
    }
    // kills drop cubes + 2 right where we fight: +4 % HP (healed) and damage each. Wanted weapons too.
    if (P.duelLootDist > 0 && bestLoot(bb, true, P.duelLootDist, sc.lc) && sc.lc.item) {
      lootIntent(bb, sc.lc, it, PACE_WALK)
      it.targetId = target.id
      it.face = FACE_THREATS
      it.label = "grab"
      weaponReflex(bb, it)
      return it
    }
    // kill cubes / weapons further away, collected while every visible mech stays clear of them (kite style)
    if (P.lootClearDist > 0 && bestLoot(bb, true, P.lootClearMax, sc.lc) && sc.lc.item && lootIsClear(bb, sc.lc.item, sc.lc.item.type === L_PICKUP && P.lootClearWpn > 0 ? P.lootClearWpn : P.lootClearDist)) {
      lootIntent(bb, sc.lc, it, PACE_WALK)
      it.targetId = target.id
      it.face = FACE_THREATS
      it.label = "grabC"
      weaponReflex(bb, it)
      return it
    }
    // an NPC drone shooting us during a duel: 350 HP, 2 cubes, 25 dps on us for the whole duel - kill it first
    const npc = bb.npcAggressor
    if (npc && P.npcFirstDist > 0 && npc.dist < P.npcFirstDist && (npc.dist < target.dist || target.dist > 30 || (npc.hp >= 0 && npc.hp < 150))) {
      it.fight(npc.id, STYLE_PUSH, Math.min(26, npc.dist), "npc1")
      weaponReflex(bb, it)
      return it
    }
    duelIntent(bb, mv, sc, it, target, true)
    if (P.dropDrift > 0 && it.kind === K_FIGHT) dropDriftGoal(bb, it)
    // no laser: do not empty the magazine at long range on a healthy mech (22 % hits beyond 120 m)
    if (P.gunFarDist > 0 && !bb.haveLaser && target.dist > P.gunFarDist && (target.hp < 0 || target.hp > P.gunFarHp * target.maxHp)) it.weaponsFree = false
    // a mech that has not noticed us: close in silently, open fire only from ambushDist (full magazine, it
    // is not facing us yet, no return fire at long range)
    if (P.ambushDist > 0 && it.label === "duel" && target.dist > P.ambushDist && bb.t - target.tShotAtUs > 4 && bb.t - target.tAimedAtUs > 1.5 && bb.t - target.tHitByUs > 4 && bb.t - bb.tHurt > 3) {
      it.weaponsFree = false
      it.label = "stalk"
    }
    weaponReflex(bb, it)
    return it
  }
  if (underFire(bb, mv, sc, it)) {
    sc.fought = true
    weaponReflex(bb, it)
    return it
  }

  // 4. regenerate in peace (only silent loot)
  const hurt = bb.hpFrac < healUntil(bb)
  if (!hurt) m.regen = false
  const recentEnemy = bb.t - bb.tEnemySeen < 6

  // 5'. no laser yet and one is known: straight there (roofs too), before any other loot
  if (P.laserRush > 0 && !bb.haveLaser && zl < (P.zoneGuard > 0 ? 2 : 1) && rushLaser(bb, P.laserRush, sc, true, target)) {
    rushIntent(bb, sc, it, target)
    if (!target) it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
    weaponReflex(bb, it)
    return it
  }

  // 5''. tempo variants (nobody engaged, HP >= seekHp, no zone duty): no NPC / crate farming and no far loot;
  // "hunt" goes for the next known / heard mech with boost, "sniper post" (laser) stands where it sees far
  const post = P.snipePost === 1 && bb.haveLaser
  if ((P.tempoHunt > 0 || post) && zl < 1 && !sc.passive && bb.hpFrac >= P.seekHp) {
    // cubes and wanted weapons close by first (silent; kills drop cubes + 2)
    if (bestLoot(bb, true, P.tempoHuntLoot, sc.lc) && sc.lc.item) {
      lootIntent(bb, sc.lc, it, PACE_WALK)
      it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
      if (target) it.targetId = target.id
      it.label = "tloot"
      weaponReflex(bb, it)
      return it
    }
    if (post) {
      // at the post: hold and scan; after 10 s there with nobody seen, mark it done (next post > 25 m away)
      if (snipeSpot(bb, sc)) {
        const d = Math.hypot(sc.postX - bb.x, sc.postY - bb.y)
        if (d < 3 && sc.postArrT < 0) sc.postArrT = bb.t
        const waited = sc.postArrT >= 0 ? bb.t - Math.max(sc.postArrT, bb.tEnemySeen) : 0
        if (waited > 10) {
          sc.postDoneX = sc.postX
          sc.postDoneY = sc.postY
          sc.postDoneT = bb.t
          sc.postOk = false
          sc.postT = -1e9
        } else {
          if (d >= 3) it.goto(sc.postX, sc.postY, sc.postZ, d > 30 && bb.energy > 70 ? PACE_BOOST : PACE_WALK, "post")
          else it.hold(sc.postX, sc.postY, sc.postZ, "overlook")
          it.arrive = 2
          it.allowJet = false
          it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
          if (target) it.targetId = target.id
          weaponReflex(bb, it)
          return it
        }
      }
    }
    if (P.tempoHunt > 0 && huntLead(bb, sc, P.tempoHuntSoundS)) {
      const d = Math.hypot(sc.hx - bb.x, sc.hy - bb.y)
      it.goto(sc.hx, sc.hy, sc.hz, d > 25 && bb.energy > P.tempoHuntEnergy ? PACE_BOOST : PACE_WALK, sc.hAge < 90 ? "hunt" : "hhear")
      it.arrive = 6
      it.allowJet = false
      it.face = sc.hAge < 6 ? FACE_THREATS : FACE_SCAN
      if (target) it.targetId = target.id
      weaponReflex(bb, it)
      return it
    }
  }

  // 5. loot
  if (zl >= 1 && !(bestLoot(bb, hurt, 60, sc.lc) && sc.lc.score > 6)) {
    zoneIntent(bb, sc.zg, it, target)
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  // centre hold variant with centerHoldLoot: only loot that close to us (the rest of the time is spent at the centre)
  const lootD = P.centerHold > 0 && P.centerHoldLoot > 0 && bb.t >= P.centerHoldFrom ? Math.min(P.lootMaxDist, P.centerHoldLoot) : P.lootMaxDist
  if (bestLoot(bb, hurt && bb.regenIn <= 0.01 ? true : hurt && bb.hpFrac < 0.6, lootD, sc.lc, P.zoneGuard > 0)) {
    lootIntent(bb, sc.lc, it, PACE_WALK)
    // crate stand-off variant: standing at a crate for 5 s without denting it (no line, out of the pitch range)
    // -> leave it for 30 s (play server: 33 s and 58 s parked on a crate)
    const ci = sc.lc.item
    if (P.crateStandOff > 0 && ci && ci.type === L_CRATE) {
      if (sc.cstId !== ci.id || ci.hp < sc.cstHp - 1 || Math.hypot(bb.vx, bb.vy) > 1.5) {
        sc.cstId = ci.id
        sc.cstHp = ci.hp
        sc.cstT = bb.t
      } else if (bb.t - sc.cstT > 5) {
        ci.badUntil = bb.t + 30
        sc.cstId = -1
      }
    }
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
    if (target && it.targetId < 0 && it.shootCrate < 0) it.targetId = target.id
    weaponReflex(bb, it)
    return it
  }

  if (hurt) {
    it.hold(bb.x, bb.y, bb.z, "heal")
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
    weaponReflex(bb, it)
    return it
  }

  // 6''. laser hunt: no laser yet -> walk to the nearest area we have not seen yet (pickups are only listed while
  // in sight), scanning; seen pickups / crates are then taken by the loot step above
  if (P.laserHunt > 0 && !bb.haveLaser && bb.t < P.laserHuntUntil && exploreUnseen(bb, sc)) {
    it.goto(sc.exX, sc.exY, bb.world ? bb.world.groundZ(sc.exX, sc.exY) : bb.z, PACE_WALK, "lhunt")
    it.arrive = 8
    it.allowJet = false
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  // 6'. camp: with nothing to loot, stand and scan (hunters walk into our laser range; top bots wait 35-52 %)
  if (P.idleHold > 0 && bb.zone.marginNext(bb.x, bb.y) > 15) {
    it.hold(bb.x, bb.y, bb.z, "camp")
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  // 6. healthy and alone: go and find the next mech (kill tempo) - the freshest known position
  if (bb.hpFrac >= P.seekHp && !sc.passive && bb.t >= P.seekFrom) {
    let lead: Track | null = null
    const trs = bb.tracker.mechs
    for (let i = 0; i < trs.length; i++) {
      const e = trs[i]
      if (!e.known || e.dead || e.id === bb.me.id) continue
      const age = e.age(bb.t)
      if (age > 45 || bb.zone.margin(e.x, e.y) < 10) continue
      if (e.dist < 12 && age > 3) continue // been there, nobody home
      if (zoneOutside(bb, e.x, e.y, e.dist / bb.walk)) continue
      if (!lead || age + e.dist / 12 < lead.age(bb.t) + lead.dist / 12) lead = e
    }
    if (lead) {
      it.goto(lead.x, lead.y, lead.z, travelPace(bb, lead.x, lead.y), "seek")
      it.arrive = 6
      it.allowJet = false
      weaponReflex(bb, it)
      return it
    }
    // nobody known: walk toward the freshest armed-mech sound (non-hunters farming crates / NPCs are noisy)
    if (P.seekSoundS > 0 && soundLead(bb, sc)) {
      it.goto(sc.sndX, sc.sndY, bb.world ? bb.world.groundZ(sc.sndX, sc.sndY) : bb.z, travelPace(bb, sc.sndX, sc.sndY), "hear")
      it.arrive = 10
      it.allowJet = false
      weaponReflex(bb, it)
      return it
    }
  }

  // 6'''. centre hold variant: instead of exploring, walk to an open ground spot near the next circle's centre and
  // hold there scanning (hunters released one after another have the shortest walk to the middle)
  if (P.centerHold > 0 && bb.t >= P.centerHoldFrom && centerSpot(bb, mv, sc)) {
    const d = Math.hypot(sc.chX - bb.x, sc.chY - bb.y)
    if (d > (sc.chArr ? 10 : 4)) {
      sc.chArr = false
      it.goto(sc.chX, sc.chY, sc.chZ, PACE_WALK, "center")
      it.arrive = 3
      it.allowJet = false
    } else {
      sc.chArr = true
      it.hold(bb.x, bb.y, bb.z, "chold")
    }
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }

  // 7. explore inside the next circle (finds loot; keeps us moving)
  if (bb.t >= m.n2 || Math.hypot(m.n0 - bb.x, m.n1 - bb.y) < 8 || bb.zone.marginNext(m.n0, m.n1) < (P.zoneGuard > 0 ? P.zoneMargin + P.zoneGuard : 10)) {
    const a = bb.rng.next() * Math.PI * 2
    const rMax = P.zoneGuard > 0 ? Math.max(0, Math.min(0.75 * bb.zone.nr, bb.zone.nr - P.zoneMargin - P.zoneGuard - 4)) : bb.zone.nr * 0.75
    const r = Math.sqrt(bb.rng.next()) * rMax
    m.n0 = bb.zone.ncx + r * Math.cos(a)
    m.n1 = bb.zone.ncy + r * Math.sin(a)
    m.n2 = bb.t + 25
  }
  it.goto(m.n0, m.n1, bb.world ? bb.world.groundZ(m.n0, m.n1) : bb.z, travelPace(bb, m.n0, m.n1), "explore")
  it.arrive = 6
  it.allowJet = false
  weaponReflex(bb, it)
  return it
}
