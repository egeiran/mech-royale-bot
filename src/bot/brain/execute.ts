/**
 * Executor: Intent -> action. Owns everything that is the same whatever the strategy wants:
 * path following (navx.Mover), duel footwork, dodging, aim lead and fire gates (never through walls),
 * lightning / laser handling, reloads, weapon take/drop, torso facing and scanning.
 */
import type { BotAction } from "../../contracts.ts"
import type { Track } from "../perception/tracker.ts"
import {
  aimAt, aimError, GunAimer, hitProbGun, laserPlan, laserReleaseGate, LASER_CHARGE, leadGunObs, leadMortar, lightningTarget, newAimSolution,
  newGunIn, newMortarSolution, newShooterIn, slewStep, TICK, willHit, wrapPi, type Aim2,
} from "../tactics/aim.ts"
import { dodgeVector, faceThreatYaw, newDodgeOut, StrafeJitter, ThreatList, threatsFromProjectiles } from "../tactics/dodge.ts"
import { L_PICKUP, type Blackboard } from "./blackboard.ts"
import {
  FACE_SCAN, FACE_THREATS, FACE_TRAVEL, FACE_YAW, K_CAPTURE, K_FIGHT, K_HOLD, K_IDLE, PACE_BOOST, PACE_SILENT,
  STYLE_HOLD, STYLE_PEEK, STYLE_SPOT, type Intent,
} from "./intent.ts"
import type { Mover } from "./navx.ts"

export class ExecStats {
  decisions = 0
  /** decisions with a commanded move but (almost) no displacement */
  slow = 0
  /** runs of >= 1 s of such decisions */
  stuckEpisodes = 0
  shotsGun = 0
  shotsLightning = 0
  laserReleases = 0
}

export class Executor {
  readonly stats = new ExecStats()
  private readonly bb: Blackboard
  private readonly mv: Mover
  private readonly jitter: StrafeJitter
  private readonly threats = new ThreatList(48)
  private readonly dodge = newDodgeOut()
  private readonly sol = newAimSolution()
  /** gun/laser aim v1 (P.aimV 1): latency-aware lead + hit-probability gate, see tactics/aim.ts GunAimer */
  private readonly aimer = new GunAimer()
  private readonly shooterIn = newShooterIn()
  private readonly gunIn = newGunIn()
  private readonly msol = newMortarSolution()
  private morReadyT = -1
  private lasFullT = -1
  private morSkipUntil = -1
  private readonly a2: Aim2 = { yaw: 0, pitch: 0 }
  private readonly slew: Aim2 = { yaw: 0, pitch: 0 }
  private readonly bearings = new Float64Array(8)
  private readonly weights = new Float64Array(8)
  private readonly fire: [boolean, boolean] = [false, false]
  private readonly blockedFn: (dx: number, dy: number) => boolean
  private readonly groundFn: (x: number, y: number) => number
  private scanPhase: number
  private spinDir: number
  private noLosSince = -1
  private lastX = 0
  private lastY = 0
  private lastCmd = 0
  private slowRun = 0
  private unstickUntil = -1
  private unstickYaw = 0
  private unstickN = 0
  /** last hop-out spot / time and how many hops in a row happened there (nav watchdog) */
  private unstickX = 1e9
  private unstickY = 1e9
  private unstickT = -1e9
  private unstickRep = 0
  private mx = 0
  private my = 0
  private jump = false
  private boost = false
  /** intent.stayUp of the current decision (blockedFn also refuses drops) */
  private stayUp = false

  constructor(bb: Blackboard, mv: Mover) {
    this.bb = bb
    this.mv = mv
    this.jitter = new StrafeJitter(bb.P.strafeMin, bb.P.strafeMax)
    this.scanPhase = bb.rng.range(0, Math.PI * 2)
    this.spinDir = bb.rng.next() < 0.5 ? 1 : -1
    this.blockedFn = (dx: number, dy: number) => this.mv.blocked(this.bb, dx, dy, this.bb.P.probeDist) || (this.stayUp && this.dropAhead(dx, dy))
    this.groundFn = (x: number, y: number) => this.bb.world.groundZ(x, y)
  }

  run(it: Intent): BotAction {
    const bb = this.bb
    const P = bb.P
    const obs = bb.obs
    const me = bb.me
    const a: BotAction = {}
    this.mx = this.my = 0
    this.jump = this.boost = false
    this.stayUp = it.stayUp

    // ---- progress bookkeeping (for the eval)
    const st = this.stats
    st.decisions++
    const moved = Math.hypot(bb.x - this.lastX, bb.y - this.lastY)
    if (this.lastCmd > 0.5 && moved < 0.03 && bb.grounded) {
      st.slow++
      if (++this.slowRun === 10) st.stuckEpisodes++
    } else this.slowRun = 0
    this.lastX = bb.x
    this.lastY = bb.y

    const tgt = it.targetId >= 0 ? this.liveTarget(it.targetId) : null

    // ---- movement
    let speedScale = 1
    if (it.kind === K_FIGHT) {
      if (tgt) this.fightMove(it, tgt)
      else if (it.targetId >= 0) {
        const tr = bb.tracker.get(it.targetId)
        if (tr && tr.known) this.gotoMove(tr.x, tr.y, tr.z, true, 3)
      }
    } else if (it.kind !== K_IDLE) {
      this.mv.goto(bb, it.gx, it.gy, it.gz, it.allowJet && (it.forceJet || (bb.nThreats === 0 && bb.t - bb.tHurt > 3)), it.arrive)
      this.mx = this.mv.mx
      this.my = this.mv.my
      this.jump = this.mv.jump
      this.boost = this.mv.boost
      if (it.kind === K_CAPTURE && this.mv.dist < 6) this.ringMove(it, tgt)
      else if (it.kind === K_HOLD && this.mv.arrived) this.mx = this.my = 0
      if (it.pace === PACE_SILENT && !this.boost && bb.grounded) speedScale = Math.min(1, P.silentSpeed / bb.walk)
      else if (it.pace === PACE_BOOST && bb.grounded && !this.mv.noBoost && bb.energy > 12 && this.mv.dist > 10 && (this.mx !== 0 || this.my !== 0)) this.boost = true
    }
    // opening jet scan: straight up, no horizontal move (the strategy decides when to stop)
    if (it.jetUp) {
      this.mx = this.my = 0
      this.jump = bb.grounded
      this.boost = !bb.grounded
    }

    // ---- reflex: never stand still while being shot
    if (this.mx === 0 && this.my === 0 && bb.grounded && bb.t - bb.tHurt < 1.5 && it.kind !== K_CAPTURE) {
      const bx = Math.cos(bb.lastHurtBearing), by = Math.sin(bb.lastHurtBearing)
      const side = this.jitter.step(bb.t, bb.rng, bx, by, this.blockedFn)
      this.mx = -by * side
      this.my = bx * side
      speedScale = 1
    }

    // ---- dodge
    const hot = threatsFromProjectiles(obs.projectiles, me, this.threats, bb.cfg.weapons.mortar.gravity ?? 22, bb.cfg.weapons.mortar.splash_radius ?? 7, this.groundFn)
    const dg = this.dodge
    if (hot > 0 || bb.nEn > 0) {
      dodgeVector(me, obs.mechs, this.threats, bb.t, bb.rng, this.jitter, dg, this.blockedFn)
      if (dg.urgency >= P.dodgeOverride && bb.grounded) {
        this.mx = dg.mx
        this.my = dg.my
        speedScale = 1
      } else if (dg.urgency > 0.3 && it.kind !== K_FIGHT && it.kind !== K_HOLD && it.kind !== K_CAPTURE && bb.grounded && !this.boost && speedScale === 1 && (this.mx !== 0 || this.my !== 0)) {
        // travelling under aimed fire: weave
        const bx = this.mx + 0.6 * dg.mx, by = this.my + 0.6 * dg.my
        const l = Math.hypot(bx, by)
        if (l > 0.2 && !this.blockedFn(bx / l, by / l)) {
          this.mx = bx / l
          this.my = by / l
        }
      }
    }

    // ---- aim and fire
    const fire = this.fire
    fire[0] = fire[1] = false
    let wantYaw = bb.yaw
    let wantPitch = 0
    let aimed = false
    let shootingNow = false
    const pitchRate = me.stats.pitch_rate ?? 3
    const mOut = bb.radius + 0.5
    const aimV = P.aimV > 0
    if (aimV) {
      this.aimer.observe(bb.t, me.aim[0], me.aim[1], bb.turnRate, pitchRate, me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3)
      this.fillShooterIn(mOut, pitchRate)
    }

    if (tgt && (it.weaponsFree || tgt.npc)) {
      const hh = 0.5 * tgt.height
      const tz = tgt.z + hh
      const sol = this.sol
      let gunOk = false
      const v1 = aimV && !tgt.npc
      if (v1) this.aimer.updateTarget(tgt.id, bb.t, tgt.x, tgt.y, tgt.z, tgt.vx, tgt.vy, tgt.vz, tgt.radius, tgt.height, bb.world ? bb.world.floorZ(tgt.x, tgt.y, tgt.z, 0.5) : tgt.z)
      // gun
      if (v1 && bb.gun && bb.gunSlot >= 0) {
        // v1: lead with the capped-acceleration predictor for the fire time including the action latency; fire when
        // the estimated hit probability (actual aim, spread, prediction error, dodge) is >= aimPStar
        const g = bb.gun, gi = this.gunIn
        gi.cooldown = g.cooldown ?? 0
        gi.ammo = g.ammo ?? 1
        gi.reload = g.reload ?? 0
        gi.rate = g.stats.cooldown ?? 0.24
        gi.mag = g.stats.mag ?? 12
        gi.reloadS = g.stats.reload ?? 2.4
        gi.speed = g.stats.speed ?? 252
        gi.range = g.stats.range ?? 230
        gi.spreadDeg = g.stats.spread_deg ?? 0.6
        const ok = this.aimer.solve(this.shooterIn, gi, P.aimPStar, P.gunMaxDist)
        const s1 = this.aimer.sol
        wantYaw = s1.yaw
        wantPitch = s1.pitch
        aimed = true
        if (ok && this.muzzleClear(s1.yaw, mOut, s1.ix, s1.iy, s1.iz)) gunOk = true
      } else if (bb.gun && bb.gunSlot >= 0) {
        leadGunObs(me, bb.gunSlot, tgt.x, tgt.y, tz, tgt.vx, tgt.vy, tgt.vz, sol)
        wantYaw = sol.yaw
        wantPitch = sol.pitch
        aimed = true
        const g = bb.gun
        if ((g.reload ?? 0) <= 0 && (g.ammo ?? 1) > 0 && sol.inRange) {
          const spread = g.stats.spread_deg ?? 0.6
          const maxD = tgt.npc ? P.npcShootDist : P.gunMaxDist
          if (sol.dist <= maxD && willHit(me.aim, sol, sol.dist, tgt.radius, hh, spread, bb.turnRate, pitchRate, P.fireMarginSigma)) {
            const p = tgt.npc ? 1 : hitProbGun(sol.dist, tgt.radius, tgt.height, P.targetJink, spread, g.stats.speed ?? 252)
            if (p >= P.fireMinP && this.muzzleClear(sol.yaw, mOut, sol.ix, sol.iy, sol.iz)) gunOk = true
          }
        }
      } else {
        aimAt(bb.x, bb.y, bb.z, tgt.x, tgt.y, tz, this.a2, bb.muzzleH, mOut)
        wantYaw = this.a2.yaw
        wantPitch = this.a2.pitch
        aimed = true
      }
      // laser: hitscan, aims straight at where the target will be next tick
      if (bb.las && bb.lasSlot >= 0) {
        const las = bb.las
        const full = las.stats.charge ?? 0.75
        const charge = las.charge ?? 0
        let px = tgt.x + tgt.vx * 0.1, py = tgt.y + tgt.vy * 0.1, pz = tz + tgt.vz * 0.1
        let dist: number
        if (v1) {
          // v1: direct aim at where the target will be on the release tick (after the action latency)
          dist = this.aimer.laserAim(this.shooterIn, this.a2)
          px = this.aimer.lp.x
          py = this.aimer.lp.y
          pz = this.aimer.lp.z
        } else dist = aimAt(bb.x + bb.vx * 0.1, bb.y + bb.vy * 0.1, bb.z, px, py, pz, this.a2, bb.muzzleH, mOut)
        const los = bb.los[tgt.id] === 1 || tgt.npc
        const useLaser = dist <= Math.min(P.laserMaxDist, las.stats.range ?? 280) && !tgt.npc
        if (charge >= full - 1e-3) {
          if (this.lasFullT < 0) this.lasFullT = bb.t
        } else this.lasFullT = -1
        // laserKeepGun: keep the gun lead (and the gun firing) through the charge and release on it when the beam
        // would hit anyway; switch to the direct laser aim only after laserGunHoldS of full charge
        // v1 with action latency: the gun lead is then far from the beam line - go to the direct aim 0.25 s before full
        // charge (lab, lag 2: 79 -> 89 % hits, +14 % laser DPS; lockstep keeps laserKeepGun: 93 -> 98 %)
        const keepGun = P.laserKeepGun > 0 && !(v1 && this.aimer.lag > 0)
        const laserAim = keepGun ? !gunOk || (this.lasFullT >= 0 && bb.t - this.lasFullT >= P.laserGunHoldS) : charge >= full - 0.25 || !gunOk
        if (useLaser || charge > 0) {
          const cy = laserAim ? this.a2.yaw : wantYaw
          const cp = laserAim ? this.a2.pitch : wantPitch
          const on = v1
            ? los && this.aimer.laserGate(this.shooterIn, cy, cp, P.laserShrink, las.stats.range ?? 280) && this.beamClear()
            : los &&
              laserReleaseGate(bb.x, bb.y, bb.z, bb.vx, bb.vy, me.vel[2], me.aim[0], me.aim[1], cy, cp, tgt.x, tgt.y, tgt.z, tgt.vx, tgt.vy, tgt.vz, tgt.radius, tgt.height, las.stats.range ?? 280, bb.muzzleH, mOut, bb.turnRate, pitchRate, P.laserShrink) &&
              this.muzzleClear(cy, mOut, px, py, pz)
          const plan = laserPlan(charge, las.cooldown, on, los ? 0 : Infinity, Infinity, full, full, las.stats.min_charge ?? 0.15, las.stats.hold_s ?? 2)
          if (plan === LASER_CHARGE && (useLaser || charge > 0)) {
            fire[bb.lasSlot] = true
            if (laserAim && charge > 0) {
              wantYaw = this.a2.yaw
              wantPitch = this.a2.pitch
            }
          } else if (charge > 0) {
            // releasing: the beam leaves next tick along the aim slewed toward THIS command - command the aim the
            // gate validated (before: the gun lead stayed commanded and the beam missed by the lead angle)
            st.laserReleases++
            if (P.laserLegacyRelease <= 0) {
              wantYaw = cy
              wantPitch = cp
            }
          }
        }
      }
      // mortar: flat arc onto the target's feet when it is ready and the blast lands clear of us. The gun shares
      // the aim, so the torso dips for this one shot every ~2.6 s (the gun gate below uses the actual aim).
      if (bb.mor && bb.mor.cooldown > 0.2) this.morReadyT = -1
      if (bb.mor && bb.morSlot >= 0 && P.mortarFire > 0 && !tgt.npc && bb.mor.cooldown <= 0.2 && bb.t >= this.morSkipUntil && bb.los[tgt.id] === 1 && tgt.dist >= P.mortarMinDist && tgt.dist <= P.mortarMaxDist) {
        if (this.morReadyT < 0) this.morReadyT = bb.t
        // the aim never settles on the lob (fast-moving target, slewing between gun and mortar): give the gun 1 s
        if (bb.t - this.morReadyT > 0.6) {
          this.morSkipUntil = bb.t + 1
          this.morReadyT = -1
        }
        const mc = bb.cfg.weapons.mortar
        const ms = this.msol
        const minP = me.stats.min_pitch ?? -0.7, maxP = me.stats.max_pitch ?? 1.3
        if (
          leadMortar(bb.x, bb.y, bb.z, bb.vx, bb.vy, me.aim[0], me.aim[1], tgt.x, tgt.y, tgt.z, tgt.vx, tgt.vy, bb.mor.stats.speed ?? mc.speed ?? 72, mc.gravity ?? 22, false, bb.mor.cooldown, ms, bb.height + 0.5, mOut, bb.turnRate, pitchRate, minP, maxP) &&
          Math.hypot(ms.ix - bb.x - bb.vx * ms.tHit, ms.iy - bb.y - bb.vy * ms.tHit) > (bb.mor.stats.splash_radius ?? mc.splash_radius ?? 7) + bb.radius + 2
        ) {
          wantYaw = ms.yaw
          wantPitch = ms.pitch
          gunOk = false
          if (bb.mor.cooldown <= 0.05 && aimError(me.aim, ms.yaw, ms.pitch) < P.mortarAimTol) {
            fire[bb.morSlot] = true
            shootingNow = true
          }
        }
      }
      if (gunOk) {
        fire[bb.gunSlot] = true
        shootingNow = true
        st.shotsGun++
      }
      // lightning: auto-hit inside the cone
      if (bb.ltg && bb.ltgSlot >= 0 && bb.ltg.cooldown <= 0.1) {
        const lt = bb.ltg
        const cost = lt.stats.energy ?? 3
        const need = tgt.npc ? P.lightningFarmEnergy : cost + P.lightningReserve
        const range = (lt.stats.range ?? 45) * P.lightningRangeFrac
        if (bb.energy >= need && tgt.dist <= range + tgt.radius * 0.5) {
          slewStep(me.aim[0], me.aim[1], wantYaw, wantPitch, bb.turnRate, pitchRate, TICK, this.slew)
          const cone = lt.stats.cone_deg ?? 30
          const hit = lightningTarget(obs, this.slew.yaw, range, cone * P.lightningConeFrac, bb.world)
          if (hit === tgt.id || (hit >= 0 && hit < 100 && it.weaponsFree)) {
            fire[bb.ltgSlot] = true
            shootingNow = true
            st.shotsLightning++
          }
        }
      }
      if (bb.los[tgt.id] === 1 || tgt.npc) this.noLosSince = -1
      else if (this.noLosSince < 0) this.noLosSince = bb.t
    } else if (it.shootCrate >= 0) {
      const c = bb.loot.get(it.shootCrate)
      if (c && c.tSeen === bb.t) {
        const cz = c.z + 1.2
        const d = Math.hypot(c.x - bb.x, c.y - bb.y)
        if (d <= P.crateShootDist) {
          const sol = this.sol
          if (bb.gun && bb.gunSlot >= 0) {
            leadGunObs(me, bb.gunSlot, c.x, c.y, cz, 0, 0, 0, sol)
            wantYaw = sol.yaw
            wantPitch = sol.pitch
            aimed = true
            const g = bb.gun
            if ((g.reload ?? 0) <= 0 && (g.ammo ?? 1) > 0 && sol.inRange && willHit(me.aim, sol, sol.dist, 1.4, 1.2, g.stats.spread_deg ?? 0.6, bb.turnRate, pitchRate, 0.3) && this.muzzleClear(sol.yaw, mOut, c.x, c.y, cz)) {
              fire[bb.gunSlot] = true
              shootingNow = true
              st.shotsGun++
            }
          }
          if (bb.ltg && bb.ltgSlot >= 0 && bb.ltg.cooldown <= 0.1 && bb.energy >= P.lightningFarmEnergy && d <= (bb.ltg.stats.range ?? 45) * 0.95) {
            slewStep(me.aim[0], me.aim[1], wantYaw, wantPitch, bb.turnRate, pitchRate, TICK, this.slew)
            if (lightningTarget(obs, this.slew.yaw, (bb.ltg.stats.range ?? 45) * 0.95, (bb.ltg.stats.cone_deg ?? 30) * 0.85, bb.world) === c.id) {
              fire[bb.ltgSlot] = true
              shootingNow = true
            }
          }
        }
      }
      this.noLosSince = -1
    } else this.noLosSince = -1

    // a laser that is still charging keeps its trigger held until there is something to release at
    if (bb.las && bb.lasSlot >= 0 && (bb.las.charge ?? 0) > 0 && !tgt) fire[bb.lasSlot] = true

    if (!aimed) {
      wantPitch = 0
      wantYaw = this.faceYaw(it)
    }

    // ---- reload
    const g = bb.gun
    if (g && (g.reload ?? 0) <= 0) {
      const ammo = g.ammo ?? 0
      const mag = g.stats.mag ?? 12
      if (ammo <= 0) a.reload = true
      else if (ammo < mag && !shootingNow) {
        if (!tgt && it.shootCrate < 0 && bb.nThreats === 0 && ammo < mag * P.reloadIdleFrac) a.reload = true
        else if (tgt && this.noLosSince >= 0 && bb.t - this.noLosSince >= P.reloadNoLosS && ammo <= P.reloadLowAmmo) a.reload = true
        else if (!tgt && bb.nEn === 0 && ammo <= P.reloadLowAmmo) a.reload = true
      }
      // full magazine before contact: the approach is the cheapest moment to reload
      if (tgt && !tgt.npc && tgt.dist > P.reloadFarDist && ammo < mag * P.reloadIdleFrac && ammo > 0) {
        a.reload = true
        fire[bb.gunSlot] = false
      }
    }

    // ---- weapons on the ground
    if (it.takeId >= 0) {
      const p = bb.loot.get(it.takeId)
      const reach = (bb.cfg.loot.pickup_radius ?? 4) - 0.25
      if (p && p.type === L_PICKUP && Math.hypot(p.x - bb.x, p.y - bb.y) <= reach && Math.abs(p.z - bb.z) <= 3.8) {
        a.take = p.id
        if (it.dropSlot >= 0 && bb.freeSlot < 0) a.drop = it.dropSlot
      }
    } else if (it.dropOnly >= 0) a.drop = it.dropOnly

    // ---- last resort: wedged (commanded to move, no displacement for > 1.2 s) -> hop out, trying a new
    // direction each time (sideways, the other side, backwards), jetting while in the air
    if (this.slowRun >= 12 && bb.t >= this.unstickUntil) {
      this.unstickN++
      // watchdog: repeated hops at the same spot only jump (no jets): never burn energy in a hop loop
      if (Math.hypot(bb.x - this.unstickX, bb.y - this.unstickY) < 6 && bb.t - this.unstickT < 20) this.unstickRep++
      else this.unstickRep = 0
      this.unstickX = bb.x
      this.unstickY = bb.y
      this.unstickT = bb.t
      const base = Math.atan2(this.my, this.mx)
      const turn = this.unstickN % 4 === 1 ? 0 : this.unstickN % 4 === 2 ? 1.4 : this.unstickN % 4 === 3 ? -1.4 : Math.PI
      this.unstickYaw = base + turn
      // roof guard: never hop toward a drop
      for (let k = 0; k < 4 && this.stayUp && this.dropAhead(Math.cos(this.unstickYaw), Math.sin(this.unstickYaw)); k++) this.unstickYaw += Math.PI / 2
      this.unstickUntil = bb.t + 1.4
      this.slowRun = 0
    }
    if (bb.t < this.unstickUntil) {
      this.mx = Math.cos(this.unstickYaw)
      this.my = Math.sin(this.unstickYaw)
      speedScale = 1
      if (bb.grounded) this.jump = true
      else if (bb.energy > 8 && !(P.navWatchdogS > 0 && this.unstickRep >= 2)) this.boost = bb.t < this.unstickUntil - 0.4
    }

    // ---- output
    let mx = this.mx * speedScale, my = this.my * speedScale
    const l = Math.hypot(mx, my)
    if (l > 1) {
      mx /= l
      my /= l
    }
    this.lastCmd = Math.hypot(mx, my)
    a.move = [mx, my]
    if (this.boost) a.boost = true
    if (this.jump) a.jump = true
    const minP = me.stats.min_pitch ?? -0.7, maxP = me.stats.max_pitch ?? 1.3
    a.aim = [wrapPi(wantYaw), wantPitch < minP ? minP : wantPitch > maxP ? maxP : wantPitch]
    if (fire[0] || fire[1]) a.fire = [fire[0], fire[1]]
    if (aimV) this.aimer.commit(a.aim[0], a.aim[1], bb.gunSlot >= 0 && fire[bb.gunSlot])
    return a
  }

  /** aim v1: our state for GunAimer (feet, velocity, actual aim, muzzle, torso rates) */
  private fillShooterIn(mOut: number, pitchRate: number): void {
    const bb = this.bb, me = bb.me, s = this.shooterIn
    s.x = bb.x
    s.y = bb.y
    s.z = bb.z
    s.vx = bb.vx
    s.vy = bb.vy
    s.vz = me.vel[2]
    s.aimYaw = me.aim[0]
    s.aimPitch = me.aim[1]
    s.muzzleH = bb.muzzleH
    s.muzzleOut = mOut
    s.turnRate = bb.turnRate
    s.pitchRate = pitchRate
    s.minPitch = me.stats.min_pitch ?? -0.7
    s.maxPitch = me.stats.max_pitch ?? 1.3
  }

  /** aim v1: the beam GunAimer.laserGate just validated reaches the target without hitting a wall */
  private beamClear(): boolean {
    const w = this.bb.world
    if (!w) return true
    const m = this.aimer
    return w.segClear(m.bx, m.by, m.bz, m.ex, m.ey, m.ez)
  }

  /** roof guard (intent.stayUp): the floor probeDist + radius ahead is more than 2 m below our feet */
  private dropAhead(dx: number, dy: number): boolean {
    const bb = this.bb
    const l = Math.hypot(dx, dy)
    if (l < 1e-6) return false
    const r = bb.P.probeDist + bb.radius
    const w = bb.world
    for (let k = 1; k <= 2; k++) {
      const f = (k * r) / 2 / l
      if (w.floorZ(bb.x + dx * f, bb.y + dy * f, bb.z + 1.3, 0) < bb.z - 2) return true
    }
    return false
  }

  /** the track when it is alive and present in this observation */
  private liveTarget(id: number): Track | null {
    const tr = this.bb.tracker.get(id)
    if (!tr || tr.dead || !tr.visible) return null
    if (tr.npc && tr.hp === 0) return null
    return tr
  }

  /** shot line from the real muzzle (out along the yaw, at muzzle height) to a point */
  private muzzleClear(yaw: number, out: number, tx: number, ty: number, tz: number): boolean {
    const bb = this.bb
    const w = bb.world
    if (!w) return true
    const mx = bb.x + out * Math.cos(yaw), my = bb.y + out * Math.sin(yaw), mz = bb.z + bb.muzzleH
    // the barrel itself must not poke into a wall
    if (!w.segClear(bb.x, bb.y, mz, mx, my, mz)) return false
    return w.segClear(mx, my, mz, tx, ty, tz)
  }

  private gotoMove(x: number, y: number, z: number, jet: boolean, arrive: number): void {
    const mv = this.mv
    mv.goto(this.bb, x, y, z, jet, arrive)
    this.mx = mv.mx
    this.my = mv.my
    this.jump = mv.jump
    this.boost = mv.boost
  }

  /** duel footwork: hold the preferred range, strafe unpredictably, never into walls or out of the zone */
  private fightMove(it: Intent, e: Track): void {
    const bb = this.bb
    const P = bb.P
    const d = e.dist > 0.01 ? e.dist : 0.01
    const ux = (e.x - bb.x) / d, uy = (e.y - bb.y) / d
    const los = bb.los[e.id] === 1 || e.npc
    const R = it.range
    if (it.style === STYLE_SPOT && los) {
      // fight from a chosen point (peek spot): walk there while shooting, then hover around it
      if (Math.hypot(it.gx - bb.x, it.gy - bb.y) > 1.6) {
        this.gotoMove(it.gx, it.gy, it.gz, false, 0.8)
        return
      }
      const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn)
      this.mx = -uy * side * 0.6
      this.my = ux * side * 0.6
      if (this.blockedFn(this.mx * 2, this.my * 2)) this.mx = this.my = 0
      return
    }
    const hold = it.style === STYLE_HOLD || it.style === STYLE_PEEK
    if (!los) {
      // no shot line: reloading -> stay behind the wall; otherwise go and find the target
      const g = bb.gun
      const reloading = g !== null && (g.reload ?? 0) > 0.3
      if (reloading || hold) {
        const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn)
        this.mx = -uy * side * 0.5
        this.my = ux * side * 0.5
        if (this.blockedFn(this.mx * 2, this.my * 2)) this.mx = this.my = 0
        return
      }
      this.gotoMove(e.x, e.y, e.z, false, Math.min(R, 10))
      if (!e.npc && d > P.approachBoostDist && bb.grounded && !this.mv.noBoost && bb.energy > (bb.haveLightning ? P.lightningKeepEnergy : P.approachBoostEnergy)) this.boost = true
      if (it.chase && bb.grounded && !this.mv.noBoost && bb.energy > 15) this.boost = true
      return
    }
    if (it.chase && d > R + 3) {
      // finish a fleeing target: straight after it along the path, boosting
      this.gotoMove(e.x, e.y, e.z, false, R)
      if (bb.grounded && !this.mv.noBoost && bb.energy > 15 && (this.mx !== 0 || this.my !== 0)) this.boost = true
      return
    }
    if (!hold && d > R + 18) {
      // far: approach along the path, weaving when the enemy has a line on us
      this.gotoMove(e.x, e.y, e.z, false, R)
      if (!e.npc && d > P.approachBoostDist && bb.grounded && !this.mv.noBoost && bb.energy > (bb.haveLightning ? P.lightningKeepEnergy : P.approachBoostEnergy)) {
        this.boost = true
        return
      }
      const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn)
      const bx = this.mx - uy * side * 0.55, by = this.my + ux * side * 0.55
      const l = Math.hypot(bx, by)
      if (l > 0.1 && !this.blockedFn(bx / l, by / l)) {
        this.mx = bx / l
        this.my = by / l
      }
      return
    }
    let radial = 0
    if (!hold) radial = d > R + P.rangeBand ? 1 : d < R - P.rangeBand ? -1 : (0.5 * (d - R)) / P.rangeBand
    let side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn)
    // several enemies: orbit so that the target stands between us and the others (their shots hit it, not us)
    if (P.shieldOrbit > 0 && !e.npc && bb.nEn > 1 && d < 60) {
      let ox = 0, oy = 0, ow = 0
      for (let i = 0; i < bb.nEn; i++) {
        const o = bb.en[i]
        if (o === e || bb.los[o.id] !== 1 || o.dist > 150) continue
        const w = 1 / (o.dist + 10)
        ox += o.x * w
        oy += o.y * w
        ow += w
      }
      if (ow > 0) {
        ox /= ow
        oy /= ow
        const want = Math.atan2(e.y - oy, e.x - ox) // from the others through the target
        const have = Math.atan2(bb.y - e.y, bb.x - e.x)
        const diff = wrapPi(want - have)
        if (Math.abs(diff) > P.shieldOrbit) {
          const s2 = diff > 0 ? -1 : 1
          if (!this.blockedFn(-uy * s2, ux * s2)) {
            side = s2
            this.jitter.sign = s2
          }
        }
      }
    }
    const sw = P.strafeSpeed
    let mx = ux * radial - uy * side * sw
    let my = uy * radial + ux * side * sw
    // several mechs: drift away from the others (distance-weighted centroid) so they stay in front of us and
    // arrive one at a time instead of closing the ring
    if (P.kiteAwayW > 0 && !e.npc && bb.nEn > 1) {
      let ax = 0, ay = 0
      for (let i = 0; i < bb.nEn; i++) {
        const o = bb.en[i]
        if (o === e || o.dist > 160) continue
        const w = 1 / (o.dist + 15)
        ax -= ((o.x - bb.x) / Math.max(1, o.dist)) * w
        ay -= ((o.y - bb.y) / Math.max(1, o.dist)) * w
      }
      const al = Math.hypot(ax, ay)
      if (al > 1e-6) {
        mx += (ax / al) * P.kiteAwayW
        my += (ay / al) * P.kiteAwayW
      }
    }
    // drift toward a goal while fighting (drop-drift variant: the fight migrates to the supply drop)
    if (it.driftW > 0) {
      const gx = it.driftX - bb.x, gy = it.driftY - bb.y
      const gl = Math.hypot(gx, gy)
      if (gl > 6) {
        mx += (gx / gl) * it.driftW
        my += (gy / gl) * it.driftW
      }
    }
    // stay inside the circle
    const zm = bb.zone.margin(bb.x, bb.y)
    if (zm < P.zoneMargin) {
      const cx = bb.zone.ncx - bb.x, cy = bb.zone.ncy - bb.y
      const cl = Math.hypot(cx, cy) || 1
      const k = 1.5 * (1 - Math.max(0, zm) / P.zoneMargin)
      mx += (cx / cl) * k
      my += (cy / cl) * k
    }
    let l = Math.hypot(mx, my)
    if (l > 1e-6) {
      mx /= l
      my /= l
    }
    if (radial < 0 && d < R - P.kiteBoostGap && !e.npc) {
      // far inside the preferred range: open the distance. Best open direction away from the target
      // (a long free run that stays in the circle), boosting while the energy lasts.
      let bs = -1e9, bx = 0, by = 0
      for (let k = -3; k <= 3; k++) {
        const a = k * 0.42
        const c = Math.cos(a), sn = Math.sin(a)
        const rx = -ux * c + uy * sn, ry = -uy * c - ux * sn
        let free = 0
        if (this.mv.walkOk(bb, bb.x + rx * 6, bb.y + ry * 6)) free = this.mv.walkOk(bb, bb.x + rx * 16, bb.y + ry * 16) ? 16 : 6
        if (free === 0) continue
        const zm2 = bb.zone.marginNext(bb.x + rx * 30, bb.y + ry * 30)
        let sc = free * 1.5 - Math.abs(k) * 2 + (zm2 < 20 ? (zm2 - 20) * 0.5 : 0) + (k * side > 0 ? 1.5 : 0)
        if (it.driftW > 0) {
          const gl = Math.hypot(it.driftX - bb.x, it.driftY - bb.y)
          if (gl > 6) sc += (4 * it.driftW * (rx * (it.driftX - bb.x) + ry * (it.driftY - bb.y))) / gl
        }
        if (sc > bs) {
          bs = sc
          bx = rx
          by = ry
        }
      }
      if (bs > -1e8) {
        this.mx = bx
        this.my = by
        if (bb.energy > P.kiteBoostEnergy && bb.grounded && !(bb.haveLightning && d < 50)) this.boost = true
        return
      }
    }
    if (l > 1e-6 && this.blockedFn(mx, my)) {
      // alternatives: pure strafe, the other side, pure radial
      const sx = -uy * side, sy = ux * side
      if (!this.blockedFn(sx, sy)) {
        mx = sx
        my = sy
      } else if (!this.blockedFn(-sx, -sy)) {
        mx = -sx
        my = -sy
        this.jitter.sign = -side
      } else if (radial !== 0 && !this.blockedFn(ux * Math.sign(radial), uy * Math.sign(radial))) {
        mx = ux * Math.sign(radial)
        my = uy * Math.sign(radial)
      } else {
        mx = -ux
        my = -uy
      }
    }
    l = Math.hypot(mx, my)
    this.mx = mx
    this.my = my
    if (P.fightJumpRate > 0 && bb.grounded && bb.rng.next() < P.fightJumpRate * bb.dt) this.jump = true
  }

  /** inside a supply-drop ring: keep moving (strafe) but never leave it */
  private ringMove(it: Intent, e: Track | null): void {
    const bb = this.bb
    const cx = it.gx - bb.x, cy = it.gy - bb.y
    const d = Math.hypot(cx, cy)
    const ringR = (bb.cfg.drops?.radius ?? 8) - bb.radius * 0 - 2.5
    if (!e || d > ringR - 1.5) {
      if (d > 1.2) {
        this.mx = cx / d
        this.my = cy / d
      } else this.mx = this.my = 0
      return
    }
    const ed = e.dist > 0.01 ? e.dist : 0.01
    const ux = (e.x - bb.x) / ed, uy = (e.y - bb.y) / ed
    const side = this.jitter.step(bb.t, bb.rng, ux, uy)
    let mx = -uy * side, my = ux * side
    // would this step take us out of the ring: reverse
    const nx = bb.x + mx * 2.5 - it.gx, ny = bb.y + my * 2.5 - it.gy
    if (Math.hypot(nx, ny) > ringR) {
      mx = -mx
      my = -my
      this.jitter.sign = -side
      const n2x = bb.x + mx * 2.5 - it.gx, n2y = bb.y + my * 2.5 - it.gy
      if (Math.hypot(n2x, n2y) > ringR) {
        mx = d > 0.5 ? cx / d : 0
        my = d > 0.5 ? cy / d : 0
      }
    }
    this.mx = mx
    this.my = my
    this.jump = false
    this.boost = false
  }

  /** torso yaw when there is nothing to shoot */
  private faceYaw(it: Intent): number {
    const bb = this.bb
    const P = bb.P
    if (it.face === FACE_YAW) return it.faceYaw
    const moving = Math.hypot(this.mx, this.my) > 0.2
    if (it.face === FACE_TRAVEL && moving) return Math.atan2(this.my, this.mx)
    if (it.face === FACE_THREATS || bb.t - bb.tHurt < P.lookDamageS) {
      // attackers and aimers inside the front arc
      let n = 0
      const tr = bb.tracker.mechs
      for (let i = 0; i < tr.length && n < 8; i++) {
        const e = tr[i]
        if (!e.known || e.dead || e.id === bb.me.id) continue
        const recentHit = bb.t - e.tShotAtUs < 4
        const fresh = e.age(bb.t) < 6
        if (!(recentHit || (fresh && e.dist < 220))) continue
        this.bearings[n] = fresh ? e.bearing : e.lastHitBearing
        this.weights[n] = (recentHit ? 3 : 1) + (e.aimingAtUs ? 1 : 0) + 30 / (e.dist + 30)
        n++
      }
      if (n > 0) return faceThreatYaw(this.bearings, this.weights, n, bb.yaw, bb.cfg.mech.front_arc_deg ?? 180)
      if (bb.t - bb.tHurt < P.lookDamageS) return bb.lastHurtBearing
    }
    if (moving && it.face !== FACE_THREATS) {
      // sweep around the travel direction: finds loot and enemies on both sides
      return Math.atan2(this.my, this.mx) + Math.sin(bb.t * P.scanFreq + this.scanPhase) * P.scanAmp
    }
    // standing (or guarding with nobody known): spin
    return bb.yaw + this.spinDir * P.scanSpin * bb.dt * 1.5
  }
}
