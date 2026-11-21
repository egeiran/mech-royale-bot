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
import { Track, W_LIGHTNING } from "../perception/tracker.ts"
import { S_BOOST, S_CRATE, S_GUN, S_JET, S_LASER, S_LASER_CHARGE, S_LIGHTNING, S_MORTAR, S_NPC_GUN, S_RELOAD, S_STEP } from "../perception/sounds.ts"
import { L_PICKUP, type Blackboard, type LootItem } from "../brain/blackboard.ts"
import { FACE_SCAN, FACE_THREATS, PACE_BOOST, PACE_WALK, STYLE_PUSH, STYLE_SPOT, type Intent } from "../brain/intent.ts"
import { newSpot, type Mover } from "../brain/navx.ts"
import { decideFfa } from "./ffa.ts"
import {
  bestLoot, duelRange, fightRatio, healUntil, lootIntent, newLootChoice, newZoneGoal, pickTarget, pickupValue, wantDrop, weaponReflex, zoneDuty, zoneIntent,
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
  wpn: LootItem | null = null
  ghostHeal = false
  /** peek spot (fight several mechs from a point only the target has a line to) */
  readonly peek = newSpot()
  peekT = -1e9
  peekOk = false
}

/** boost on long trips with nobody in sight (tempo) while energy is plentiful */
function travelPace(bb: Blackboard, x: number, y: number): number {
  if (bb.nEn > 0 || bb.energy < bb.P.boostMinEnergy) return PACE_WALK
  return Math.hypot(x - bb.x, y - bb.y) > bb.P.boostTravelDist ? PACE_BOOST : PACE_WALK
}

/** nearest known ground-level lightning pickup we want (value > 0) within maxDist, into sc.wpn */
function bestWeapon(bb: Blackboard, maxDist: number, sc: SquadScratch): boolean {
  const items = bb.loot.items
  let bd = maxDist
  sc.wpn = null
  for (let i = 0; i < items.length; i++) {
    const p = items[i]
    if (p.type !== L_PICKUP || p.badUntil > bb.t) continue
    if (p.wk !== W_LIGHTNING) continue
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

/** every visible mech is at least `clear` m from the item */
function lootIsClear(bb: Blackboard, item: LootItem, clear: number): boolean {
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    if (Math.hypot(e.x - item.x, e.y - item.y) < clear) return false
  }
  return true
}

/** sound kinds that mean "an armed mech is (or just was) there" */
const MECH_SOUND = new Uint8Array(16)
for (const k of [S_GUN, S_MORTAR, S_LASER, S_LASER_CHARGE, S_LIGHTNING, S_CRATE, S_NPC_GUN, S_STEP, S_BOOST, S_JET, S_RELOAD]) MECH_SOUND[k] = 1

/** freshest armed-mech sound inside the zone (age + travel time), into sc.sndX/Y; false when none */
function soundLead(bb: Blackboard, sc: SquadScratch): boolean {
  const s = bb.sounds
  const cap = s.evKind.length
  let bs = 1e9
  for (let k = 0; k < s.evCount; k++) {
    const i = (s.evHead - 1 - k + cap) % cap
    const age = bb.t - s.evT[i]
    if (age > bb.P.seekSoundS || age < -1) continue
    if (MECH_SOUND[s.evKind[i]] !== 1) continue
    const x = s.evX[i], y = s.evY[i]
    const d = Math.hypot(x - bb.x, y - bb.y)
    if (d < 20 || bb.zone.margin(x, y) < 10) continue
    const sc2 = age + d / 12
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
  const m = bb.mem
  const evs = bb.obs.events
  for (let i = 0; i < evs.length; i++) if (evs[i].type === "kill") sc.kills++

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
  const target = pickTarget(bb)
  const zl = zoneDuty(bb, sc.zg)

  // 0. opening: one full turn on the spot shows every pickup / crate / mech within 200 m before we commit
  if (bb.t < P.openScanS && !target && bb.t - bb.tHurt > 2 && zl < 2) {
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

  // 2. supply drop
  const di = wantDrop(bb, 0)
  if (di >= 0) {
    const d = bb.drops[di]
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y)
    // in a duel only when it is close (walking away from a fight shows our side for too long)
    // with a mech on us only when it is (about to be) capturable: walking toward a drop that lands in 20 s
    // turns the duel into a long-range one we lose
    const soonEnough = !target || d.lands_in <= (dist / bb.walk) * 1.3 + P.dropFightLeadS
    if (soonEnough && (!target || bb.nThreats === 0 || dist < 35 || (bb.hpFrac < 0.75 && dist < 150))) {
      it.capture(d.pos[0], d.pos[1], d.pos[2], target || dist < 40 ? PACE_WALK : PACE_BOOST, "drop")
      it.face = FACE_THREATS
      if (target) it.targetId = target.id
      weaponReflex(bb, it)
      return it
    }
  }

  // 3. fight: whoever engages us, or is close; a far mech that ignores us is only shot at in passing
  // hurt: leave mechs that have not noticed us alone unless they are close (time to regenerate first)
  const engD = bb.hpFrac < healUntil(bb) ? Math.min(P.engageDist, P.engageHurtDist) : P.engageDist
  const engaged = target !== null && (bb.nThreats > 0 || target.dist < engD || bb.t - target.tShotAtUs < 4 || bb.t - target.tHitByUs < 2)
  if (target && engaged) {
    // a known lightning (or, without one, a wanted weapon) further away: worth leaving the duel range for
    if (P.duelLtgDist > 0 && bestWeapon(bb, P.duelLtgDist, sc)) {
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
    if (P.lootClearDist > 0 && bestLoot(bb, true, P.lootClearMax, sc.lc) && sc.lc.item && lootIsClear(bb, sc.lc.item, P.lootClearDist)) {
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
    weaponReflex(bb, it)
    return it
  }

  // 4. regenerate in peace (only silent loot)
  const hurt = bb.hpFrac < healUntil(bb)
  if (!hurt) m.regen = false
  const recentEnemy = bb.t - bb.tEnemySeen < 6

  // 5. loot
  if (zl >= 1 && !(bestLoot(bb, hurt, 60, sc.lc) && sc.lc.score > 6)) {
    zoneIntent(bb, sc.zg, it, target)
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  if (bestLoot(bb, hurt && bb.regenIn <= 0.01 ? true : hurt && bb.hpFrac < 0.6, P.lootMaxDist, sc.lc)) {
    lootIntent(bb, sc.lc, it, PACE_WALK)
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

  // 6. healthy and alone: go and find the next mech (kill tempo) - the freshest known position
  if (bb.hpFrac >= P.seekHp) {
    let lead: Track | null = null
    const trs = bb.tracker.mechs
    for (let i = 0; i < trs.length; i++) {
      const e = trs[i]
      if (!e.known || e.dead || e.id === bb.me.id) continue
      const age = e.age(bb.t)
      if (age > 45 || bb.zone.margin(e.x, e.y) < 10) continue
      if (e.dist < 12 && age > 3) continue // been there, nobody home
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

  // 7. explore inside the next circle (finds loot; keeps us moving)
  if (bb.t >= m.n2 || Math.hypot(m.n0 - bb.x, m.n1 - bb.y) < 8 || bb.zone.marginNext(m.n0, m.n1) < 10) {
    const a = bb.rng.next() * Math.PI * 2
    const r = Math.sqrt(bb.rng.next()) * bb.zone.nr * 0.75
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
