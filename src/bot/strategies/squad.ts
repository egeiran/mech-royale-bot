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
import { Track } from "../perception/tracker.ts"
import type { Blackboard } from "../brain/blackboard.ts"
import { FACE_SCAN, FACE_THREATS, PACE_BOOST, PACE_WALK, STYLE_PUSH, type Intent } from "../brain/intent.ts"
import { newSpot, type Mover } from "../brain/navx.ts"
import {
  bestLoot, duelRange, fightRatio, lootIntent, newLootChoice, newZoneGoal, pickTarget, wantDrop, weaponReflex, zoneDuty, zoneIntent,
} from "./common.ts"

export class SquadScratch {
  readonly zg = newZoneGoal()
  readonly lc = newLootChoice()
  readonly spot = newSpot()
  readonly spot2 = newSpot()
  readonly one: Track[] = []
  /** stand-in for an attacker we cannot see (placed along the damage bearing) */
  readonly phantom = new Track(50)
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
      if (bb.hpFrac >= P.squadRegenUntil || tHpFrac <= P.squadFinishHp) m.regen = false
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

  it.fight(target.id, STYLE_PUSH, duelRange(bb, target), "duel")
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
    if (!target || bb.nThreats === 0 || dist < 35 || (bb.hpFrac < 0.75 && dist < 150)) {
      it.capture(d.pos[0], d.pos[1], d.pos[2], target || dist < 40 ? PACE_WALK : PACE_BOOST, "drop")
      it.face = FACE_THREATS
      if (target) it.targetId = target.id
      weaponReflex(bb, it)
      return it
    }
  }

  // 3. fight: whoever engages us, or is close; a far mech that ignores us is only shot at in passing
  const engaged = target !== null && (bb.nThreats > 0 || target.dist < P.engageDist || bb.t - target.tShotAtUs < 4 || bb.t - target.tHitByUs < 2)
  if (target && engaged) {
    // kills drop cubes + 2 right where we fight: +4 % HP (healed) and damage each. Wanted weapons too.
    if (P.duelLootDist > 0 && bestLoot(bb, true, P.duelLootDist, sc.lc) && sc.lc.item) {
      lootIntent(bb, sc.lc, it, PACE_WALK)
      it.targetId = target.id
      it.face = FACE_THREATS
      it.label = "grab"
      weaponReflex(bb, it)
      return it
    }
    duelIntent(bb, mv, sc, it, target, true)
    weaponReflex(bb, it)
    return it
  }
  if (underFire(bb, mv, sc, it)) {
    weaponReflex(bb, it)
    return it
  }

  // 4. regenerate in peace (only silent loot)
  const hurt = bb.hpFrac < P.squadRegenUntil
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
      it.goto(lead.x, lead.y, lead.z, PACE_WALK, "seek")
      it.arrive = 6
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
  it.goto(m.n0, m.n1, bb.world ? bb.world.groundZ(m.n0, m.n1) : bb.z, PACE_WALK, "explore")
  it.arrive = 6
  it.allowJet = false
  weaponReflex(bb, it)
  return it
}
