/**
 * FFA v2 - phased ghost (ffaVersion = 2). Evidence: data/intel/ghost.md; plan + results: data/intel/ffa-plan.md.
 *   zone urgent                 -> zoneIntent (shooting back only when found)
 *   discovered (seen / shot)    -> break line of sight via cover.safeDirection (boost), return fire only when close or
 *                                  the shooter is nearly dead; fight when inside ffaCloseDist with no cover point near,
 *                                  when finishing, or when clearly winning; then hide ffaHideS (still, healing, facing
 *                                  the threat) and re-pick a pocket away from it
 *   attacked by an NPC drone    -> kill it (squad underFire)
 *   visible, not seeing us      -> third-party a nearly dead one; else step out of its line; else hold and watch
 *   nobody around               -> quiet pickups near us in low exposure; walk to the pocket (cover.bestHideSpots in the
 *                                  NEXT circle, <= ffaSpotMaxDist, re-ranked by nav-path exposure); hold still, scanning
 *   end-game (alive <= ffaEndAlive, HP >= ffaEndHp) -> third-party anything visible, else move near the freshest fight
 * Deterministic (bb.rng only through shared helpers), state per bot instance (WeakMap on the Blackboard).
 */
import type { NavPath } from "../../contracts.ts"
import type { NavEx, NavQueryEx } from "../../world/nav/index.ts"
import { L_CUBE, L_PICKUP, type Blackboard } from "../brain/blackboard.ts"
import { FACE_SCAN, FACE_THREATS, FACE_YAW, PACE_BOOST, PACE_SILENT, PACE_WALK, type Intent } from "../brain/intent.ts"
import type { Mover } from "../brain/navx.ts"
import { createCover, createHideSpots, createSafeStep, type Cover, type EnemyView, type HideOpts, type HideSpots, type SafeStep } from "../cover/index.ts"
import { S_DEATH, S_GUN, S_LASER, S_LIGHTNING } from "../perception/sounds.ts"
import { W_LASER, W_LIGHTNING, type Track } from "../perception/tracker.ts"
import { bestLoot, fightRatio, lootIntent, pickupValue, weaponReflex, zoneDuty, zoneIntent, type LootChoice } from "./common.ts"
import { duelIntent, underFire, type SquadScratch } from "./squad.ts"

const MAXV = 20
const MAXMAG = 160

class V2State {
  cover: Cover | null = null
  coverTried = false
  readonly spots: HideSpots = createHideSpots(16)
  readonly opts: HideOpts = {}
  readonly mags = new Float64Array(MAXMAG * 2)
  readonly enXYZ = new Float64Array(16 * 3)
  readonly views: EnemyView[] = Array.from({ length: MAXV }, () => ({ x: 0, y: 0, z: 0, yaw: 0, cubes: 0 }))
  nViews = 0
  readonly ss: SafeStep = createSafeStep()
  readonly q: NavQueryEx = { radius: 2.5, height: 9, allowJet: false, energy: 100, maxExpansions: 20000 }
  path: NavPath | null = null
  // pocket
  spotOk = false
  spotX = 0
  spotY = 0
  spotZ = 0
  spotExpo = 1
  spotT = -1e9
  spotNr = 0
  // break / hide
  brkOk = false
  brkX = 0
  brkY = 0
  brkZ = 0
  brkT = -1e9
  hideUntil = -1e9
  threatX = 0
  threatY = 0
  threatT = -1e9
  /** first time in the current discovery episode with no cover found (patience) */
  stuckSince = -1
  // end-game approach point
  endOk = false
  endX = 0
  endY = 0
  endZ = 0
  endT = -1e9
  readonly lc: LootChoice = { item: null, npc: null, score: 0 }
  readonly phantom: EnemyView = { x: 0, y: 0, z: 0, yaw: 0, cubes: 0 }
}

const STATES = new WeakMap<Blackboard, V2State>()

function stateOf(bb: Blackboard): V2State {
  let s = STATES.get(bb)
  if (!s) {
    s = new V2State()
    STATES.set(bb, s)
  }
  return s
}

function coverOf(bb: Blackboard, mv: Mover, st: V2State): Cover | null {
  if (st.cover || st.coverTried) return st.cover
  st.coverTried = true
  try {
    if (bb.world) st.cover = createCover(bb.world, mv.nav)
  } catch {
    st.cover = null
  }
  return st.cover
}

/** a known (recent) enemy within dist, or footsteps nearby */
function knownNear(bb: Blackboard, dist: number, maxAge: number): boolean {
  const tr = bb.tracker.mechs
  for (let i = 0; i < tr.length; i++) {
    const e = tr[i]
    if (!e.known || e.dead || e.id === bb.me.id) continue
    if (e.age(bb.t) <= maxAge && Math.hypot(e.x - bb.x, e.y - bb.y) < dist) return true
  }
  return bb.sounds.movementNear(2.5)
}

const hpOf = (e: Track): number => (e.hp >= 0 && e.maxHp > 0 ? e.hp / e.maxHp : 1)

function setView(v: EnemyView, e: Track): void {
  v.x = e.x
  v.y = e.y
  v.z = e.z
  v.yaw = e.aimYaw
  v.cubes = e.cubes
}

/** pick the pocket: best hide spots in the NEXT circle, re-ranked by the exposure of the nav path to them */
function pickPocket(bb: Blackboard, mv: Mover, st: V2State, avoidAge: number): boolean {
  const P = bb.P
  const cover = coverOf(bb, mv, st)
  if (!cover) return false
  const zn = bb.zone
  // magnets: crates, weapons on the floor, NPC homes (drones stay near them), supply drops
  const mg = st.mags
  let nm = 0
  const items = bb.loot.items
  for (let i = 0; i < items.length && nm < MAXMAG; i++) {
    const it = items[i]
    if (it.type === L_CUBE) continue
    mg[2 * nm] = it.x
    mg[2 * nm + 1] = it.y
    nm++
  }
  const npcs = bb.tracker.npcs
  for (let i = 0; i < npcs.length && nm < MAXMAG; i++) {
    const n = npcs[i]
    if (!n.known || n.dead) continue
    mg[2 * nm] = n.x
    mg[2 * nm + 1] = n.y
    nm++
  }
  for (let i = 0; i < bb.drops.length && nm < MAXMAG; i++) {
    mg[2 * nm] = bb.drops[i].pos[0]
    mg[2 * nm + 1] = bb.drops[i].pos[1]
    nm++
  }
  const ex = st.enXYZ
  let ne = 0
  const tr = bb.tracker.mechs
  for (let i = 0; i < tr.length && ne < 16; i++) {
    const e = tr[i]
    if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > avoidAge) continue
    ex[3 * ne] = e.x
    ex[3 * ne + 1] = e.y
    ex[3 * ne + 2] = e.z
    ne++
  }
  const o = st.opts
  o.magnets = mg
  o.nMagnets = nm
  o.enemies = ex
  o.nEnemies = ne
  o.fromZ = bb.z
  o.minMargin = P.ffaSpotMargin
  o.maxDist = P.ffaSpotMaxDist
  o.allowJet = false
  o.energy = bb.maxEnergy
  const out = st.spots
  let n = cover.bestHideSpots(zn.ncx, zn.ncy, zn.nr, bb.x, bb.y, o, out)
  if (n === 0) {
    o.maxDist = P.ffaSpotMaxDist * 3
    n = cover.bestHideSpots(zn.ncx, zn.ncy, zn.nr, bb.x, bb.y, o, out)
  }
  if (n === 0) return false
  let pick = 0
  const nav: NavEx | null = mv.nav
  const K = Math.min(n, P.ffaSpotTopK)
  if (nav && K > 1) {
    const q = st.q
    q.radius = bb.radius
    q.height = bb.height
    q.energy = bb.maxEnergy
    let bestC = Infinity
    for (let k = 0; k < K; k++) {
      const p = nav.plan(bb.x, bb.y, bb.z, out.x[k], out.y[k], out.z[k], q, st.path ?? undefined)
      if (!p) continue
      st.path = p
      if (!p.complete) continue
      const c = cover.pathExposure(p.pts, p.n) / bb.walk + P.ffaSpotScoreW * out.score[k] + P.ffaSpotTimeW * p.cost
      if (c < bestC) {
        bestC = c
        pick = k
      }
    }
  }
  st.spotOk = true
  st.spotX = out.x[pick]
  st.spotY = out.y[pick]
  st.spotZ = out.z[pick]
  st.spotExpo = out.expo[pick]
  st.spotT = bb.t
  st.spotNr = zn.nr
  return true
}

/** freshest fight we know of (enemy track or weapon sound) -> st.end*; false when nothing recent */
function freshestFight(bb: Blackboard, st: V2State): boolean {
  let bestT = -1e9
  let fx = 0, fy = 0
  const tr = bb.tracker.mechs
  for (let i = 0; i < tr.length; i++) {
    const e = tr[i]
    if (!e.known || e.dead || e.id === bb.me.id) continue
    const ts = bb.t - e.age(bb.t)
    if (ts > bestT) {
      bestT = ts
      fx = e.x
      fy = e.y
    }
  }
  const s = bb.sounds
  for (let k = 0; k < s.evCount; k++) {
    const i = (s.evHead - 1 - k + s.evKind.length) % s.evKind.length
    const kind = s.evKind[i]
    if (kind !== S_GUN && kind !== S_LASER && kind !== S_LIGHTNING && kind !== S_DEATH) continue
    if (s.evT[i] > bestT + 3) {
      bestT = s.evT[i]
      fx = s.evX[i]
      fy = s.evY[i]
    }
    break
  }
  if (bb.t - bestT > 25) return false
  st.endX = fx
  st.endY = fy
  return true
}

export function decideFfaV2(bb: Blackboard, mv: Mover, sc: SquadScratch): Intent {
  const P = bb.P
  const st = stateOf(bb)
  const it = bb.intent.reset()
  const zn = bb.zone
  const zl = zoneDuty(bb, sc.zg)
  const endGame = P.ffaEndHunt > 0 && bb.obs.alive <= P.ffaEndAlive
  const hunt = endGame && bb.hpFrac >= P.ffaEndHp

  // ---- who sees us / shoots us
  let found: Track | null = null // nearest mech that sees, aims at or shot us
  let shooter: Track | null = null // nearest that shot or aims at us
  let nFound = 0
  let nv = 0
  for (let i = 0; i < bb.nEn; i++) {
    const e = bb.en[i]
    const shot = bb.t - e.tShotAtUs < 3
    const aim = bb.los[e.id] === 1 && e.aimingAtUs
    const sees = bb.sees[e.id] === 1 && e.dist < P.ffaSeenDist
    if (!(shot || aim || sees)) continue
    nFound++
    if (!found || e.dist < found.dist) found = e
    if ((shot || aim) && (!shooter || e.dist < shooter.dist)) shooter = e
    if (nv < MAXV) setView(st.views[nv++], e)
  }
  // shot by a mech we cannot see: a phantom along the damage bearing
  const unseenHit = bb.t - bb.tHurt < 2 && bb.lastHurtBy >= 0 && bb.lastHurtBy < 100 && !shooter
  if (unseenHit && nv < MAXV) {
    const ph = st.phantom
    const lt = bb.tracker.mechs.find((e) => e.id === bb.lastHurtBy && e.known && e.age(bb.t) < 3)
    if (lt) {
      ph.x = lt.x
      ph.y = lt.y
      ph.z = lt.z
    } else {
      ph.x = bb.x + 90 * Math.cos(bb.lastHurtBearing)
      ph.y = bb.y + 90 * Math.sin(bb.lastHurtBearing)
      ph.z = bb.world ? bb.world.groundZ(ph.x, ph.y) : bb.z
    }
    const v = st.views[nv++]
    v.x = ph.x
    v.y = ph.y
    v.z = ph.z
    v.yaw = Math.atan2(bb.y - ph.y, bb.x - ph.x)
    v.cubes = 0
  }
  st.nViews = nv
  const discovered = nv > 0
  if (!discovered) st.stuckSince = -1

  // ---- 1. zone urgent
  if (zl >= 2) {
    zoneIntent(bb, sc.zg, it, shooter)
    it.weaponsFree = shooter !== null
    st.spotOk = false
    weaponReflex(bb, it)
    return it
  }

  // ---- 2. discovered: break line of sight (or fight when that is the better bet)
  if (discovered) {
    const cover = coverOf(bb, mv, st)
    const tgt = shooter ?? found
    const ss = st.ss
    if (cover) cover.safeDirection(bb.x, bb.y, bb.z, bb.height, st.views, nv, P.ffaBreakMaxDist, ss)
    else ss.found = false
    if (ss.found && zn.margin(ss.x, ss.y) < 4) ss.found = false
    if (!ss.found && st.stuckSince < 0) st.stuckSince = bb.t
    if (tgt) {
      const tHp = hpOf(tgt)
      const close = tgt.dist < P.ffaCloseDist && (!ss.found || ss.dist > P.ffaCloseBreak)
      const finishing = tHp < P.ffaFinishHp && bb.hpFrac > 0.45 && nFound <= 1
      const winning = fightRatio(bb, tgt) > P.ffaFightRatio
      const patience = !ss.found && st.stuckSince >= 0 && bb.t - st.stuckSince > P.ffaFleePatience && bb.t - bb.tHurt < 1.5
      const endFight = (hunt && nFound <= 1 && fightRatio(bb, tgt) > 0.8) || bb.obs.alive <= P.ffaDuelAlive
      if ((close && (shooter !== null || tgt.dist < 25)) || finishing || winning || (patience && tgt.dist < 110) || endFight) {
        duelIntent(bb, mv, sc, it, tgt, true)
        it.label = close ? "cornered" : finishing ? "finish" : winning ? "adv" : patience ? "stuck" : "endfight"
        weaponReflex(bb, it)
        return it
      }
    }
    st.threatT = bb.t
    st.threatX = st.views[0].x
    st.threatY = st.views[0].y
    st.hideUntil = bb.t + P.ffaHideS
    st.spotOk = false
    const danger = shooter !== null || unseenHit || (found !== null && found.dist < 100)
    const pace = danger && bb.energy > 20 ? PACE_BOOST : PACE_WALK
    if (ss.found) {
      st.brkOk = true
      st.brkX = ss.x
      st.brkY = ss.y
      st.brkZ = ss.z
      st.brkT = bb.t
      it.flee(ss.x, ss.y, ss.z, pace, "break")
      it.arrive = 1
    } else if (bb.nEn > 0 && mv.findCover(bb, bb.en, bb.nEn, 45, sc.spot)) {
      st.brkOk = true
      st.brkX = sc.spot.x
      st.brkY = sc.spot.y
      st.brkZ = sc.spot.z
      st.brkT = bb.t
      it.flee(sc.spot.x, sc.spot.y, sc.spot.z, pace, "cover")
      it.arrive = 1
    } else if (tgt && tgt.dist > 100 && bb.t > 60) {
      // far and no wall near: standing still draws far less fire than running (ghost.md c)
      it.hold(bb.x, bb.y, bb.z, "freeze")
    } else if (tgt) {
      duelIntent(bb, mv, sc, it, tgt, true)
      it.label = "noexit"
      weaponReflex(bb, it)
      return it
    } else {
      // unseen shooter, no covered point found: move away from the bearing
      const d = 30
      it.flee(bb.x - d * Math.cos(bb.lastHurtBearing), bb.y - d * Math.sin(bb.lastHurtBearing), bb.z, pace, "away")
    }
    if (tgt) {
      it.targetId = tgt.id
      it.weaponsFree = shooter !== null && (tgt.dist < P.ffaReturnFireDist || hpOf(tgt) < P.ffaThirdTargetHp)
    } else it.weaponsFree = false
    it.face = FACE_THREATS
    weaponReflex(bb, it)
    return it
  }

  // ---- 3. NPC drone attacking us
  if (bb.npcAggressor && underFire(bb, mv, sc, it)) {
    weaponReflex(bb, it)
    return it
  }

  // ---- 4. visible mechs that have not found us
  if (bb.nEn > 0) {
    // third-party: nearly dead (or, in the end-game, anyone) not aiming at us
    let best: Track | null = null
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      if (bb.los[e.id] !== 1) continue
      const ok = (hpOf(e) < P.ffaThirdTargetHp && e.dist < P.ffaThirdDist && bb.hpFrac > P.ffaThirdHp && bb.nEn <= 2) || (hunt && e.dist < 200 && bb.nEn <= 2) || (bb.obs.alive <= P.ffaDuelAlive && e.dist < 250)
      if (ok && (!best || hpOf(e) < hpOf(best))) best = e
    }
    if (best) {
      duelIntent(bb, mv, sc, it, best, true)
      it.label = hunt ? "hunt" : "third"
      weaponReflex(bb, it)
      return it
    }
    // nearest one with a line to us (could see us if it turned): step out of it
    let near: Track | null = null
    nv = 0
    for (let i = 0; i < bb.nEn; i++) {
      const e = bb.en[i]
      if (bb.los[e.id] === 1 && e.dist < P.ffaDuckDist) {
        if (!near || e.dist < near.dist) near = e
        if (nv < MAXV) setView(st.views[nv++], e)
      }
    }
    const look = near ?? bb.nearest ?? bb.en[0]
    if (near) {
      const cover = coverOf(bb, mv, st)
      const ss = st.ss
      if (cover && bb.t - st.brkT > 0.5) {
        cover.safeDirection(bb.x, bb.y, bb.z, bb.height, st.views, nv, P.ffaBreakMaxDist, ss)
        if (ss.found && zn.margin(ss.x, ss.y) >= 4) {
          st.brkOk = true
          st.brkX = ss.x
          st.brkY = ss.y
          st.brkZ = ss.z
          st.brkT = bb.t
        } else st.brkOk = false
      }
      st.spotOk = false
      st.hideUntil = Math.max(st.hideUntil, bb.t + 0.5 * P.ffaHideS)
      st.threatT = bb.t
      st.threatX = near.x
      st.threatY = near.y
      if (st.brkOk) {
        it.goto(st.brkX, st.brkY, st.brkZ, near.dist < 60 ? PACE_SILENT : PACE_WALK, "duck")
        it.arrive = 1
      } else it.hold(bb.x, bb.y, bb.z, "freeze")
    } else it.hold(bb.x, bb.y, bb.z, "lurk")
    it.weaponsFree = false
    it.face = FACE_YAW
    it.faceYaw = look.bearing
    weaponReflex(bb, it)
    return it
  }

  // ---- 5. hidden after a discovery: stay still, heal, watch where the threat was
  if (bb.t < st.hideUntil && !hunt) {
    if (st.brkOk && Math.hypot(st.brkX - bb.x, st.brkY - bb.y) > 2.5 && bb.t - st.brkT < 6) it.goto(st.brkX, st.brkY, st.brkZ, PACE_WALK, "tocover")
    else it.hold(bb.x, bb.y, bb.z, "hide")
    it.weaponsFree = false
    it.face = FACE_YAW
    it.faceYaw = Math.atan2(st.threatY - bb.y, st.threatX - bb.x)
    weaponReflex(bb, it)
    return it
  }

  // ---- 6. end-game hunt: move near the freshest fight (unseen), third-party when they show up
  if (hunt) {
    if (bb.t - st.endT > 3) {
      st.endT = bb.t
      st.endOk = false
      if (freshestFight(bb, st)) {
        const dx = bb.x - st.endX, dy = bb.y - st.endY
        const d = Math.hypot(dx, dy) || 1
        if (d > P.ffaEndApproach + 15) {
          const k = P.ffaEndApproach / d
          let gx = st.endX + dx * k, gy = st.endY + dy * k
          if (zn.marginNext(gx, gy) < 8) {
            // keep inside the next circle: pull toward its centre
            const cx = zn.ncx - gx, cy = zn.ncy - gy
            const cd = Math.hypot(cx, cy) || 1
            const pull = Math.min(cd, 8 - zn.marginNext(gx, gy))
            gx += (cx / cd) * pull
            gy += (cy / cd) * pull
          }
          const gz = mv.floor(gx, gy, bb.world ? bb.world.groundZ(gx, gy) : bb.z)
          st.endOk = true
          st.endX = gx
          st.endY = gy
          st.endZ = gz
        }
      }
    }
    if (st.endOk) {
      it.goto(st.endX, st.endY, st.endZ, PACE_WALK, "endgo")
      it.arrive = 4
      it.face = FACE_SCAN
      it.weaponsFree = false
      weaponReflex(bb, it)
      return it
    }
  }

  // ---- 7. nobody around: quiet pickups near us, then the pocket
  it.weaponsFree = false
  const cover = coverOf(bb, mv, st)
  if (cover && bb.t - bb.tEnemySeen > 3) {
    const items = bb.loot.items
    let bi = -1
    let bs = 0
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      if (p.type !== L_PICKUP && p.type !== L_CUBE) continue
      const d = Math.hypot(p.x - bb.x, p.y - bb.y)
      if (d > P.ffaPickupDist || Math.abs(p.z - bb.z) > 4) continue
      const v = p.type === L_CUBE ? P.valCube : p.wk === W_LASER || p.wk === W_LIGHTNING ? pickupValue(bb, p.wk) : 0
      if (v <= 0) continue
      if (cover.exposureAt(p.x, p.y, p.z) > P.ffaPickupExpo) continue
      if (zn.marginAt(p.x, p.y, bb.t + d / bb.walk + 3) < 8) continue
      const s = v - d * 0.2
      if (s > bs) {
        bs = s
        bi = i
      }
    }
    if (bi >= 0) {
      st.lc.item = items[bi]
      st.lc.npc = null
      lootIntent(bb, st.lc, it, PACE_WALK)
      it.weaponsFree = false
      it.face = FACE_SCAN
      weaponReflex(bb, it)
      return it
    }
  }
  // calm (nobody known near for 10 s): silent loot like v1 (cubes, wanted weapons) within ffaLootDist
  if (P.ffaCalmLoot > 0 && !knownNear(bb, P.ffaLootEnemyClear, 10) && bestLoot(bb, true, P.ffaLootDist, sc.lc)) {
    lootIntent(bb, sc.lc, it, PACE_WALK)
    it.weaponsFree = false
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  // after a hide: keep the covered point we broke to when it is quiet enough (moving again is what gets us seen)
  if (!st.spotOk && cover && P.ffaStayExpo > 0 && st.hideUntil > 0 && bb.t - st.hideUntil < 2 && zn.marginNext(bb.x, bb.y) > P.ffaSpotMargin && cover.exposureAt(bb.x, bb.y, bb.z) < P.ffaStayExpo) {
    st.spotOk = true
    st.spotX = bb.x
    st.spotY = bb.y
    st.spotZ = bb.z
    st.spotT = bb.t
    st.spotNr = zn.nr
    st.spotExpo = cover.exposureAt(bb.x, bb.y, bb.z)
  }
  // (re)pick the pocket: none yet, or the next circle no longer holds it
  if (!st.spotOk ||zn.marginNext(st.spotX, st.spotY) < 0.5 * P.ffaSpotMargin || (zn.nr !== st.spotNr && zn.marginNext(st.spotX, st.spotY) < P.ffaSpotMargin)) {
    if (bb.t - st.spotT > 1) pickPocket(bb, mv, st, bb.t < st.threatT + 60 ? P.enemyMemoryS * 3 : P.enemyMemoryS)
  }
  if (!st.spotOk) {
    zoneIntent(bb, sc.zg, it, null)
    it.face = FACE_SCAN
    weaponReflex(bb, it)
    return it
  }
  const dSpot = Math.hypot(st.spotX - bb.x, st.spotY - bb.y)
  if (dSpot > 2.5 || Math.abs(st.spotZ - bb.z) > 4) {
    const pace = P.ffaTravelPace >= 2 && bb.energy > 40 ? PACE_BOOST : P.ffaTravelPace >= 1 ? PACE_WALK : PACE_SILENT
    it.goto(st.spotX, st.spotY, st.spotZ, pace, zl >= 1 ? "rotate" : "pocket")
    it.arrive = 1.5
    it.allowJet = false
    it.face = FACE_SCAN
    // en route for too long (blocked / bad path): choose again
    if (bb.t - st.spotT > 8 + (1.6 * P.ffaSpotMaxDist) / bb.walk) st.spotOk = false
  } else {
    it.hold(st.spotX, st.spotY, st.spotZ, "ghost")
    it.face = bb.t - bb.tEnemySeen < 8 ? FACE_THREATS : FACE_SCAN
  }
  weaponReflex(bb, it)
  return it
}
