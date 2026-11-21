/**
 * FFA strategy v1 (frozen reference for paired tests; ffaVersion = 1): "ghost first, duelist as fallback". The field is aggressive duelists that find and kill each
 * other within ~200 s, and placement (not kills) is the score - so the plan is to not be found:
 *   1. zone urgent                      -> rotate (covered goal chosen by the hide-spot search when possible)
 *   2. end game (few alive / tiny zone) -> duelist core
 *   3. an enemy has found us            -> fight if cornered, clearly winning, or it is nearly dead;
 *                                          otherwise break line of sight (cover), returning fire while leaving
 *   4. we see an enemy that has not found us -> ambush only a nearly dead one; else get out of its possible
 *                                          sight lines and hold still, tracking it
 *   5. nobody around                    -> silent loot close by (weapons, cubes), then the best hide spot
 *                                          (low exposure, far from known enemies and noise, inside the next
 *                                          circle); walk silently when someone could hear
 * Also used for the UNKNOWN opening (the first seconds before the mode detector decides).
 */
import type { Track } from "../perception/tracker.ts"
import type { Blackboard } from "../brain/blackboard.ts"
import { FACE_SCAN, FACE_THREATS, FACE_YAW, K_GOTO, PACE_BOOST, PACE_SILENT, PACE_WALK, type Intent } from "../brain/intent.ts"
import type { Mover } from "../brain/navx.ts"
import { bestLoot, fightRatio, lootIntent, pickTarget, weaponReflex, zoneDuty, zoneIntent } from "./common.ts"
import { duelIntent, underFire, type SquadScratch } from "./squad.ts"

function hideSpot(bb: Blackboard, mv: Mover, sc: SquadScratch, force: boolean): boolean {
  const P = bb.P
  const m = bb.mem
  if (force || !m.hideOk || bb.t - m.hideT >= P.hideReplanS) {
    m.hideT = bb.t
    const cur = sc.spot
    cur.ok = m.hideOk
    cur.x = m.hideX
    cur.y = m.hideY
    cur.z = m.hideZ
    if (mv.findHide(bb, cur, force ? 28 : 14, sc.spot2)) {
      m.hideOk = true
      m.hideX = sc.spot2.x
      m.hideY = sc.spot2.y
      m.hideZ = sc.spot2.z
      m.hideScore = sc.spot2.score
    }
  }
  return m.hideOk
}

/** is a known (recent) enemy close enough to hear our steps */
function someoneNear(bb: Blackboard, dist: number, maxAge: number): boolean {
  const tr = bb.tracker.mechs
  for (let i = 0; i < tr.length; i++) {
    const e = tr[i]
    if (!e.known || e.dead || e.id === bb.me.id) continue
    if (e.age(bb.t) <= maxAge && Math.hypot(e.x - bb.x, e.y - bb.y) < dist) return true
  }
  return bb.sounds.movementNear(2.5)
}

export function decideFfaV1(bb: Blackboard, mv: Mover, sc: SquadScratch): Intent {
  const P = bb.P
  const m = bb.mem
  const it = bb.intent.reset()
  const target = pickTarget(bb)
  const zl = zoneDuty(bb, sc.zg)
  const quiet = someoneNear(bb, P.silentEnemyDist, 8)
  const pace = quiet ? PACE_SILENT : PACE_WALK

  // who has found us
  let found: Track | null = null
  let nFound = 0
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    const on = bb.t - e.tShotAtUs < 3 || (bb.los[e.id] === 1 && (e.aimingAtUs || (bb.sees[e.id] === 1 && e.aimErr < 0.5)))
    if (on) {
      nFound++
      if (!found || e.dist < found.dist) found = e
    }
  }
  if (!found) m.fleeSince = -1

  // 1. zone
  if (zl >= 2) {
    zoneIntent(bb, sc.zg, it, found ? (target ?? found) : null)
    it.weaponsFree = found !== null
    weaponReflex(bb, it)
    return it
  }

  // 2. end game: nowhere left to hide
  const endGame = bb.obs.alive <= P.ffaDuelAlive || bb.zone.r <= P.ffaDuelRadius
  if (endGame && target && (bb.zone.r <= P.ffaDuelRadius || found || fightRatio(bb, target) > 0.9)) {
    duelIntent(bb, mv, sc, it, target, true)
    weaponReflex(bb, it)
    return it
  }

  // 3. found
  if (found) {
    const tgt = target && (bb.t - target.tShotAtUs < 3 || target.aimingAtUs) ? target : found
    const tHp = tgt.hp >= 0 && tgt.maxHp > 0 ? tgt.hp / tgt.maxHp : 1
    if (m.fleeSince < 0) m.fleeSince = bb.t
    const ratio = fightRatio(bb, tgt)
    const cornered = found.dist < P.ffaCorneredDist || (bb.t - m.fleeSince > P.ffaFleePatience && bb.t - bb.tHurt < 1.5)
    const finishing = tHp < P.ffaFinishHp && bb.hpFrac > 0.45
    if ((cornered && nFound <= 2) || finishing || ratio > P.ffaFightRatio) {
      duelIntent(bb, mv, sc, it, tgt, true)
      it.label = cornered ? "cornered" : finishing ? "finish" : "adv"
      weaponReflex(bb, it)
      return it
    }
    if (bb.t - m.coverT > 0.4) {
      m.coverT = bb.t
      m.coverOk = mv.findCover(bb, bb.en, bb.nEn, 60, sc.spot)
      if (m.coverOk) {
        m.coverX = sc.spot.x
        m.coverY = sc.spot.y
        m.coverZ = sc.spot.z
      }
    }
    if (m.coverOk) {
      it.flee(m.coverX, m.coverY, m.coverZ, bb.energy > 25 ? PACE_BOOST : PACE_WALK, "break")
      it.arrive = 1
    } else if (hideSpot(bb, mv, sc, bb.t - m.hideT > 1.5)) it.flee(m.hideX, m.hideY, m.hideZ, bb.energy > 25 ? PACE_BOOST : PACE_WALK, "run")
    else {
      duelIntent(bb, mv, sc, it, tgt, false)
      weaponReflex(bb, it)
      return it
    }
    it.targetId = tgt.id
    it.weaponsFree = bb.t - bb.tHurt < 3 || tgt.dist < 60
    weaponReflex(bb, it)
    return it
  }

  // 4. we see someone who has not found us
  if (target) {
    const tHp = target.hp >= 0 && target.maxHp > 0 ? target.hp / target.maxHp : 1
    if (tHp < P.ffaFinishHp && bb.hpFrac > 0.6 && target.dist < 110 && bb.nEn <= 2) {
      duelIntent(bb, mv, sc, it, target, false)
      it.label = "ambush"
      weaponReflex(bb, it)
      return it
    }
    // any of them with a possible line to us: step out of it
    let exposed = false
    for (let i = 0; i < bb.nEn; i++) if (bb.los[bb.en[i].id] === 1) exposed = true
    if (exposed) {
      if (bb.t - m.coverT > 0.5) {
        m.coverT = bb.t
        m.coverOk = mv.findCover(bb, bb.en, bb.nEn, 50, sc.spot)
        if (m.coverOk) {
          m.coverX = sc.spot.x
          m.coverY = sc.spot.y
          m.coverZ = sc.spot.z
        }
      }
      if (m.coverOk) {
        it.flee(m.coverX, m.coverY, m.coverZ, bb.nearestD < 45 ? PACE_SILENT : PACE_WALK, "hide")
        it.arrive = 1
      } else if (hideSpot(bb, mv, sc, bb.t - m.hideT > 1.5)) it.goto(m.hideX, m.hideY, m.hideZ, pace, "away")
      else it.hold(bb.x, bb.y, bb.z, "freeze")
    } else {
      it.hold(bb.x, bb.y, bb.z, "lurk")
    }
    it.weaponsFree = false
    it.face = FACE_YAW
    it.faceYaw = (bb.nearest ?? target).bearing
    weaponReflex(bb, it)
    return it
  }

  // 5. nobody around
  if (underFire(bb, mv, sc, it)) {
    weaponReflex(bb, it)
    return it
  }
  it.weaponsFree = false
  const calm = !someoneNear(bb, P.ffaLootEnemyClear, 10)
  if (zl >= 1 && !(calm && bestLoot(bb, true, 40, sc.lc) && sc.lc.score > 6)) {
    if (hideSpot(bb, mv, sc, false) && bb.zone.marginNext(m.hideX, m.hideY) > 10) it.goto(m.hideX, m.hideY, m.hideZ, pace, "rotate")
    else {
      zoneIntent(bb, sc.zg, it, null)
      it.pace = pace
      // look for a hide spot around where we are going next time
      m.hideOk = false
    }
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  if (calm) {
    const noisy = bb.t >= P.ffaQuietUntil
    if (bestLoot(bb, !noisy, P.ffaLootDist, sc.lc)) {
      lootIntent(bb, sc.lc, it, pace)
      it.weaponsFree = false
      weaponReflex(bb, it)
      return it
    }
  }
  if (hideSpot(bb, mv, sc, false)) {
    it.hold(m.hideX, m.hideY, m.hideZ, "ghost")
    if (Math.hypot(m.hideX - bb.x, m.hideY - bb.y) > 2.5) it.kind = K_GOTO
    it.pace = pace
    it.arrive = 1.5
  } else it.hold(bb.x, bb.y, bb.z, "still")
  it.face = bb.t - bb.tEnemySeen < 8 ? FACE_THREATS : FACE_SCAN
  weaponReflex(bb, it)
  return it
}
