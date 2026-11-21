/**
 * Aiming and fire-control solvers. Pure functions: scalars in, numbers out (or written into a caller-owned
 * out object). No allocation, no module state, no randomness.
 *
 * Server timing model (measured on the recorded stream, mech 10's beams and bullets):
 *   per sim tick (0.05 s): slew torso -> move -> fire. An action sent at obs tick N first fires at tick N+1,
 *   i.e. along the aim after ONE tick of slew (0.2 rad yaw, 0.15 rad pitch) from the position after one tick
 *   of movement. A bullet also advances one full step in the tick it is spawned, so at the end of the spawn
 *   tick it is already speed*0.05 m out: effectively it "leaves" one tick earlier than it is spawned.
 *   Shot origin = (x + out*cos(yaw), y + out*sin(yaw), z + muzzle_height): the 3 m offset is HORIZONTAL
 *   (beam/bullet origins sit at exactly pos.z + 7.00 for pitches of -0.04..-0.08).
 *   Gun cooldown counts down 0.05 per tick; a shot is possible on tick k = max(1, ceil(cooldown / 0.05)).
 */
import type { ActorObs, Observation, SelfObs } from "../../protocol/mechfight.ts"
import type { World } from "../../contracts.ts"

export const TICK = 0.05
export const DECISION_DT = 0.1
const PI = Math.PI
const TAU = 2 * Math.PI
const DEG = Math.PI / 180

// ---------------------------------------------------------------- angles
/** wrap an angle to [-pi, pi) */
export function wrapPi(a: number): number {
  a = (a + PI) % TAU
  if (a < 0) a += TAU
  return a - PI
}

/** signed shortest difference a - b in [-pi, pi) */
export function angDiff(a: number, b: number): number {
  return wrapPi(a - b)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export interface Aim2 {
  yaw: number
  pitch: number
}

/**
 * Exact torso slew model: yaw moves the shortest way round at turnRate, pitch at pitchRate, the commanded
 * pitch is clamped to [minPitch, maxPitch]. dt in seconds (any multiple of a tick gives the server's result).
 */
export function slewStep(curYaw: number, curPitch: number, wantYaw: number, wantPitch: number, turnRate: number, pitchRate: number, dt: number, out: Aim2, minPitch = -0.7, maxPitch = 1.3): void {
  const dy = wrapPi(wantYaw - curYaw)
  const my = turnRate * dt
  out.yaw = dy > my ? wrapPi(curYaw + my) : dy < -my ? wrapPi(curYaw - my) : wrapPi(wantYaw)
  const wp = clamp(wantPitch, minPitch, maxPitch)
  const dp = wp - curPitch
  const mp = pitchRate * dt
  out.pitch = dp > mp ? curPitch + mp : dp < -mp ? curPitch - mp : wp
}

/** seconds until the torso reaches the wanted aim */
export function slewTime(curYaw: number, curPitch: number, wantYaw: number, wantPitch: number, turnRate: number, pitchRate: number): number {
  const ty = Math.abs(wrapPi(wantYaw - curYaw)) / turnRate
  const tp = Math.abs(wantPitch - curPitch) / pitchRate
  return ty > tp ? ty : tp
}

/**
 * Angular distance (rad) between the actual aim [yaw, pitch] and a wanted direction. Yaw error is scaled by
 * cos(pitch) so the result is a true angle on the sphere (small-angle approximation).
 */
export function aimError(selfAim: ArrayLike<number>, wantYaw: number, wantPitch: number): number {
  const ey = wrapPi(wantYaw - selfAim[0]) * Math.cos(wantPitch)
  const ep = wantPitch - selfAim[1]
  return Math.sqrt(ey * ey + ep * ep)
}

// ---------------------------------------------------------------- gun lead
export interface AimSolution {
  /** aim to command (rad) */
  yaw: number
  pitch: number
  /** projectile flight time (s) from its effective launch to the intercept */
  tof: number
  /** seconds from now until the intercept */
  tHit: number
  /** seconds from now until the shot leaves (a multiple of TICK, >= TICK) */
  tFire: number
  /** distance the projectile travels from the muzzle (m) */
  dist: number
  /** intercept point */
  ix: number
  iy: number
  iz: number
  /** travel distance <= weapon range and pitch within the torso limits */
  inRange: boolean
}

export function newAimSolution(): AimSolution {
  return { yaw: 0, pitch: 0, tof: 0, tHit: 0, tFire: TICK, dist: 0, ix: 0, iy: 0, iz: 0, inRange: false }
}

/**
 * Intercept solution for a straight, constant-speed projectile against a constant-velocity target.
 *
 *   s*      shooter FEET position (m) and velocity (m/s; assumed constant until the shot leaves)
 *   aim*    shooter's ACTUAL torso aim now (obs.self.aim)
 *   t*      the point to hit (e.g. target feet + half its height) and its velocity
 *   cooldown  seconds until the weapon can fire (max of cooldown and reload left)
 *
 * The shot leaves on tick k = max(1, ceil(cooldown/TICK), ceil(slew time to the solution/TICK)); the muzzle is
 * muzzleOut m out horizontally along the solution yaw at height muzzleHeight above the feet.
 * spawnStepTicks = 1 is the real server (a bullet advances one step in the tick it is spawned; measured on the
 * recorded stream); pass 0 for a simulator that spawns shots after its projectile step.
 * Note: with a long cooldown (reload) the solution is where to point WHEN THE SHOT LEAVES; to keep tracking the
 * target meanwhile pass min(cooldown, ~0.3).
 * Returns out.inRange. Fixed-point iteration (3 inner x 2 outer), no allocation.
 */
export function leadGun(
  sx: number, sy: number, sz: number, svx: number, svy: number, svz: number,
  aimYaw: number, aimPitch: number,
  tx: number, ty: number, tz: number, tvx: number, tvy: number, tvz: number,
  projSpeed: number, range: number, cooldown: number,
  out: AimSolution,
  muzzleHeight = 7, muzzleOut = 3, turnRate = 4, pitchRate = 3, minPitch = -0.7, maxPitch = 1.3, spawnStepTicks = 1,
): boolean {
  let k = Math.ceil(cooldown / TICK - 1e-6)
  if (k < 1) k = 1
  let yaw = 0, pitch = 0, s = 0, ix = tx, iy = ty, iz = tz, tL = 0
  // initial flight-time guess from the present geometry
  {
    const dx = tx - sx, dy = ty - sy, dz = tz - (sz + muzzleHeight)
    s = Math.sqrt(dx * dx + dy * dy + dz * dz) / projSpeed
  }
  for (let outer = 0; outer < 5; outer++) {
    const tFire = k * TICK
    tL = tFire - spawnStepTicks * TICK // the bullet steps once in its spawn tick: effective launch one tick earlier
    const bx = sx + svx * tFire, by = sy + svy * tFire, bz = sz + svz * tFire + muzzleHeight
    let h = 0, dz = 0, hx = 0, hy = 0
    for (let i = 0; i < 3; i++) {
      const tt = tL + s
      ix = tx + tvx * tt
      iy = ty + tvy * tt
      iz = tz + tvz * tt
      hx = ix - bx
      hy = iy - by
      h = Math.sqrt(hx * hx + hy * hy) - muzzleOut
      if (h < 0.01) h = 0.01
      dz = iz - bz
      s = Math.sqrt(h * h + dz * dz) / projSpeed
    }
    yaw = Math.atan2(hy, hx)
    pitch = Math.atan2(dz, h)
    // the fire tick only ever moves later, so the loop cannot oscillate; a tick too many is harmless
    const ks = Math.ceil(slewTime(aimYaw, aimPitch, yaw, clamp(pitch, minPitch, maxPitch), turnRate, pitchRate) / TICK - 1e-6)
    if (ks <= k) break
    k = ks
  }
  out.yaw = yaw
  out.pitch = pitch
  out.tof = s
  out.tFire = k * TICK
  out.tHit = tL + s
  out.dist = s * projSpeed
  out.ix = ix
  out.iy = iy
  out.iz = iz
  out.inRange = out.dist <= range && pitch >= minPitch && pitch <= maxPitch
  return out.inRange
}

/**
 * leadGun with every number read from the observation: weapon stats of `slot` (speed, range, cooldown/reload
 * left), self.stats (muzzle_height, radius, turn/pitch rates and limits). (tx,ty,tz) is the point to hit.
 */
export function leadGunObs(self: SelfObs, slot: number, tx: number, ty: number, tz: number, tvx: number, tvy: number, tvz: number, out: AimSolution): boolean {
  const w = self.weapons[slot]
  if (!w) {
    out.inRange = false
    return false
  }
  const st = self.stats
  const cd = Math.max(w.cooldown, w.reload ?? 0)
  return leadGun(
    self.pos[0], self.pos[1], self.pos[2], self.vel[0], self.vel[1], self.vel[2],
    self.aim[0], self.aim[1],
    tx, ty, tz, tvx, tvy, tvz,
    w.stats.speed ?? 252, w.stats.range ?? 230, cd, out,
    st.muzzle_height ?? 7, (st.radius ?? 2.5) + 0.5, st.turn_rate ?? 4, st.pitch_rate ?? 3, st.min_pitch ?? -0.7, st.max_pitch ?? 1.3,
  )
}

/** convenience: lead the centre of a visible actor (size grown 5 % per cube) */
export function leadActor(self: SelfObs, slot: number, m: ActorObs, out: AimSolution, mechHeight = 9, sizePerCube = 0.05): boolean {
  const h = m.kind === "npc" ? 3.5 : mechHeight * (1 + sizePerCube * (m.cubes ?? 0))
  return leadGunObs(self, slot, m.pos[0], m.pos[1], m.pos[2] + 0.5 * h, m.vel[0], m.vel[1], m.vel[2], out)
}

/**
 * Direct (hitscan / no-lead) aim from the muzzle to a point: writes yaw, pitch into out, returns the distance
 * from the muzzle. sz is the shooter's feet height.
 */
export function aimAt(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, out: Aim2, muzzleHeight = 7, muzzleOut = 3): number {
  const hx = tx - sx, hy = ty - sy
  let h = Math.sqrt(hx * hx + hy * hy) - muzzleOut
  if (h < 0.01) h = 0.01
  const dz = tz - (sz + muzzleHeight)
  out.yaw = Math.atan2(hy, hx)
  out.pitch = Math.atan2(dz, h)
  return Math.sqrt(h * h + dz * dz)
}

// ---------------------------------------------------------------- hit probability
/** erf, Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7) */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return s * y
}

/**
 * How far (m) a mech can displace itself from its constant-velocity prediction in t seconds when it changes
 * its velocity by up to dv m/s at `accel` m/s^2 (ramp, then cruise at the new velocity).
 */
export function dodgeReach(t: number, dv: number, accel = 58.5): number {
  if (t <= 0 || dv <= 0) return 0
  const tr = dv / accel
  return t <= tr ? 0.5 * accel * t * t : dv * t - 0.5 * dv * tr
}

/**
 * Estimated probability that one gun shot at `dist` m hits a cylinder target.
 *   targetSpeedUncertainty  m/s of velocity change the target is expected to make during the flight
 *                           (0 = constant velocity / unaware; ~walk speed 11.7 = actively strafing;
 *                           up to 2 x speed for a full reversal)
 *   spreadDeg               gun spread sigma (deg)
 * Lateral error = spread (sigma = dist*spread) + dodge displacement (uniform in +-reach, sigma = reach/sqrt 3);
 * vertical error = spread only. Returns 0..1, monotonically falling with dist and with the uncertainty.
 */
export function hitProbGun(dist: number, targetRadius: number, targetHeight: number, targetSpeedUncertainty: number, spreadDeg: number, projSpeed = 252, accel = 58.5, projRadius = 0.3, extraDelay = 0): number {
  if (dist < 0.01) return 1
  const t = dist / projSpeed + extraDelay
  const ss = dist * spreadDeg * DEG
  const reach = dodgeReach(t, targetSpeedUncertainty, accel)
  const sd = reach * 0.5773502691896258
  const sl = Math.sqrt(ss * ss + sd * sd)
  const pl = sl < 1e-9 ? 1 : erf((targetRadius + projRadius) / (1.4142135623730951 * sl))
  const pv = ss < 1e-9 ? 1 : erf((0.5 * targetHeight + projRadius) / (1.4142135623730951 * ss))
  return pl * pv
}

// ---------------------------------------------------------------- fire gate
const _slew: Aim2 = { yaw: 0, pitch: 0 } // scratch, overwritten on every use

/**
 * Fire gate. True when the shot would leave within this decision (sol.tFire <= 0.1 s) AND the ACTUAL aim at
 * that moment (selfAim slewed toward the solution for sol.tFire) is within the target's angular size minus a
 * spread margin: yaw error <= atan(r/dist) - marginSigma*spread, pitch error <= atan(hh/dist) - marginSigma*spread
 * (each floored at 35 % of the angular size so long shots are still taken when dead on).
 */
export function willHit(selfAim: ArrayLike<number>, sol: AimSolution, dist: number, targetRadius: number, targetHalfHeight = 4.5, spreadDeg = 0.6, turnRate = 4, pitchRate = 3, marginSigma = 1): boolean {
  if (sol.tFire > DECISION_DT + 1e-6) return false
  slewStep(selfAim[0], selfAim[1], sol.yaw, sol.pitch, turnRate, pitchRate, sol.tFire, _slew)
  const ey = Math.abs(wrapPi(sol.yaw - _slew.yaw)) * Math.cos(sol.pitch)
  const ep = Math.abs(sol.pitch - _slew.pitch)
  const m = marginSigma * spreadDeg * DEG
  const ay = Math.atan2(targetRadius, dist)
  const ap = Math.atan2(targetHalfHeight, dist)
  const ly = Math.max(ay - m, 0.35 * ay)
  const lp = Math.max(ap - m, 0.35 * ap)
  return ey <= ly && ep <= lp
}

/** which decision tick the shot would leave on: 1 or 2 = fire this decision, larger = wait */
export function fireTick(cooldown: number): number {
  const k = Math.ceil(cooldown / TICK - 1e-6)
  return k < 1 ? 1 : k
}

// ---------------------------------------------------------------- ray vs cylinder
/**
 * Distance along a ray (origin o, UNIT direction d) to a vertical cylinder with feet at (cx,cy,cz), given
 * radius and height; -1 when it misses or the hit is beyond maxDist. 0 when the origin is inside.
 */
export function rayHitsCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, radius: number, height: number, maxDist: number): number {
  const rx = ox - cx, ry = oy - cy
  const a = dx * dx + dy * dy
  let t0 = 0, t1 = maxDist
  if (a < 1e-12) {
    if (rx * rx + ry * ry > radius * radius) return -1
  } else {
    const b = rx * dx + ry * dy
    const c = rx * rx + ry * ry - radius * radius
    const disc = b * b - a * c
    if (disc < 0) return -1
    const sq = Math.sqrt(disc)
    const ta = (-b - sq) / a, tb = (-b + sq) / a
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
  }
  if (Math.abs(dz) < 1e-12) {
    if (oz < cz || oz > cz + height) return -1
  } else {
    let za = (cz - oz) / dz, zb = (cz + height - oz) / dz
    if (za > zb) {
      const tmp = za
      za = zb
      zb = tmp
    }
    if (za > t0) t0 = za
    if (zb < t1) t1 = zb
  }
  return t0 <= t1 ? t0 : -1
}

/**
 * Would a shot along (yaw, pitch) from a shooter with feet at (sx,sy,sz) pass through the cylinder
 * (feet cx,cy,cz)? Returns the distance from the muzzle or -1. Used for "is that enemy's beam on me" too.
 */
export function aimHitsCylinder(sx: number, sy: number, sz: number, yaw: number, pitch: number, cx: number, cy: number, cz: number, radius: number, height: number, maxDist: number, muzzleHeight = 7, muzzleOut = 3): number {
  const cyaw = Math.cos(yaw), syaw = Math.sin(yaw), cp = Math.cos(pitch)
  return rayHitsCylinder(sx + muzzleOut * cyaw, sy + muzzleOut * syaw, sz + muzzleHeight, cp * cyaw, cp * syaw, Math.sin(pitch), cx, cy, cz, radius, height, maxDist)
}

// ---------------------------------------------------------------- mortar
export interface MortarSolution {
  yaw: number
  pitch: number
  /** shell flight time (s) */
  tof: number
  /** highest point of the arc above the launch point (m), 0 for a descending shot */
  apex: number
  /** seconds from now until the shell leaves / lands */
  tFire: number
  tHit: number
  /** predicted impact point */
  ix: number
  iy: number
  iz: number
  ok: boolean
}

export function newMortarSolution(): MortarSolution {
  return { yaw: 0, pitch: 0, tof: 0, apex: 0, tFire: TICK, tHit: 0, ix: 0, iy: 0, iz: 0, ok: false }
}

/**
 * Launch pitch (rad) for a ballistic shell to land dx m away horizontally and dz m above (+) / below (-) the
 * launch point. high=false: flat arc, high=true: lobbed arc. NaN when the point is out of reach or the pitch
 * is outside [minPitch, maxPitch]. Use mortarTof / mortarApex for the rest.
 */
export function mortarSolve(dx: number, dz: number, speed: number, gravity: number, high: boolean, minPitch = -0.7, maxPitch = 1.3): number {
  if (dx < 1e-6) return NaN
  const v2 = speed * speed
  const disc = v2 * v2 - gravity * (gravity * dx * dx + 2 * dz * v2)
  if (disc < 0) return NaN
  const sq = Math.sqrt(disc)
  const pitch = Math.atan2(high ? v2 + sq : v2 - sq, gravity * dx)
  if (pitch < minPitch - 1e-9 || pitch > maxPitch + 1e-9) return NaN
  return pitch
}

/** flight time (s) of a shell launched at `pitch` to a point dx m away horizontally */
export function mortarTof(dx: number, pitch: number, speed: number): number {
  return dx / (speed * Math.cos(pitch))
}

/** apex height (m) above the launch point; 0 when launched level or downward */
export function mortarApex(pitch: number, speed: number, gravity: number): number {
  const vz = speed * Math.sin(pitch)
  return vz > 0 ? (vz * vz) / (2 * gravity) : 0
}

/** horizontal distance (m) from the launch point at which the apex is reached */
export function mortarApexDist(pitch: number, speed: number, gravity: number): number {
  const vz = speed * Math.sin(pitch)
  return vz > 0 ? (speed * Math.cos(pitch) * vz) / gravity : 0
}

/** shell height (m) relative to the launch point after x m of horizontal travel */
export function mortarHeightAt(x: number, pitch: number, speed: number, gravity: number): number {
  const c = speed * Math.cos(pitch)
  const t = x / c
  return speed * Math.sin(pitch) * t - 0.5 * gravity * t * t
}

/** does the arc pass at least `margin` m above a wall top (height relative to the launch point) at wallDist m */
export function mortarClears(pitch: number, speed: number, gravity: number, wallDist: number, wallTopRel: number, margin = 1): boolean {
  return mortarHeightAt(wallDist, pitch, speed, gravity) >= wallTopRel + margin
}

/** horizontal range (m) at a pitch onto a plane dz m above the launch point; NaN if never reached */
export function mortarRange(pitch: number, dz: number, speed: number, gravity: number): number {
  const vz = speed * Math.sin(pitch)
  const disc = vz * vz - 2 * gravity * dz
  if (disc < 0) return NaN
  return (speed * Math.cos(pitch) * (vz + Math.sqrt(disc))) / gravity
}

/**
 * Mortar lead for a static or constant-velocity (horizontal) target point (tx,ty,tz = where the shell should
 * land, normally the target's feet). The tube is at feet + launchHeight (mech height + 0.5), muzzleOut m out
 * along the yaw (assumed like the gun). The shell leaves on tick max(1, cooldown, slew time).
 * Writes out; returns out.ok (false = out of reach / pitch limits for the requested arc).
 */
export function leadMortar(
  sx: number, sy: number, sz: number, svx: number, svy: number,
  aimYaw: number, aimPitch: number,
  tx: number, ty: number, tz: number, tvx: number, tvy: number,
  speed: number, gravity: number, high: boolean, cooldown: number,
  out: MortarSolution,
  launchHeight = 9.5, muzzleOut = 3, turnRate = 4, pitchRate = 3, minPitch = -0.7, maxPitch = 1.3,
): boolean {
  let k = Math.ceil(cooldown / TICK - 1e-6)
  if (k < 1) k = 1
  let yaw = 0, pitch = NaN, tof = 0, ix = tx, iy = ty, tL = 0
  const dz = tz - (sz + launchHeight)
  out.ok = false
  for (let outer = 0; outer < 5; outer++) {
    const tFire = k * TICK
    tL = tFire - TICK
    const bx = sx + svx * tFire, by = sy + svy * tFire
    // a lobbed shell is slow (horizontal speed can be < 20 m/s): the fixed point needs more rounds than the gun
    for (let i = 0; i < 10; i++) {
      const tt = tL + tof
      ix = tx + tvx * tt
      iy = ty + tvy * tt
      const hx = ix - bx, hy = iy - by
      const h = Math.sqrt(hx * hx + hy * hy) - muzzleOut
      yaw = Math.atan2(hy, hx)
      pitch = mortarSolve(h, dz, speed, gravity, high, minPitch, maxPitch)
      if (pitch !== pitch) return false
      tof = mortarTof(h, pitch, speed)
    }
    const ks = Math.ceil(slewTime(aimYaw, aimPitch, yaw, pitch, turnRate, pitchRate) / TICK - 1e-6)
    if (ks <= k) break
    k = ks
  }
  out.yaw = yaw
  out.pitch = pitch
  out.tof = tof
  out.apex = mortarApex(pitch, speed, gravity)
  out.tFire = k * TICK
  out.tHit = tL + tof
  out.ix = ix
  out.iy = iy
  out.iz = tz
  out.ok = true
  return true
}

// ---------------------------------------------------------------- laser
export const LASER_IDLE = 0
export const LASER_CHARGE = 1
export const LASER_RELEASE = 2

/** laser damage at a charge time (s): min_frac at 0 rising linearly to full at chargeFull */
export function laserDamage(charge: number, damage = 315, chargeFull = 0.75, minFrac = 0.35): number {
  const f = charge >= chargeFull ? 1 : charge <= 0 ? 0 : charge / chargeFull
  return damage * (minFrac + (1 - minFrac) * f)
}

/**
 * Laser trigger plan for this decision. Returns LASER_IDLE (trigger up, not charging), LASER_CHARGE (hold the
 * trigger) or LASER_RELEASE (let go now: the beam fires next tick along the aim after one tick of slew).
 *   charge     self.weapons[i].charge, seconds charged so far (0 = not charging)
 *   cooldown   seconds until the laser can start charging
 *   onTarget   laserReleaseGate(...) && line of sight, for a release this decision
 *   tLosIn     predicted seconds until we have a line to the target (0 = now, Infinity = unknown)
 *   tLosLeft   predicted seconds the line will last (Infinity = no known end)
 *   needCharge charge (s) that is enough (e.g. to kill); default = full charge
 * Start charging so the charge completes about when the line opens (the 2 s hold after full is slack);
 * release when on target and charged enough, or when the line is about to close and min_charge is in.
 */
export function laserPlan(charge: number, cooldown: number, onTarget: boolean, tLosIn: number, tLosLeft: number, needCharge = 0.75, chargeFull = 0.75, minCharge = 0.15, holdS = 2): number {
  if (needCharge > chargeFull) needCharge = chargeFull
  if (charge <= 0) {
    if (cooldown > DECISION_DT) return LASER_IDLE
    // charging halves our speed: do not start earlier than the hold window can cover
    return tLosIn <= needCharge + 0.5 * holdS ? LASER_CHARGE : LASER_IDLE
  }
  if (onTarget) {
    if (charge >= needCharge - 1e-6) return LASER_RELEASE
    // the window closes before the charge is in: take the partial shot rather than nothing
    if (tLosLeft < needCharge - charge + DECISION_DT && charge >= minCharge) return LASER_RELEASE
  }
  return LASER_CHARGE
}

const _rel: Aim2 = { yaw: 0, pitch: 0 }

/**
 * Laser release gate: if we let go this decision, the beam fires next tick from our position one tick ahead,
 * along the actual aim slewed one tick toward the commanded aim (cmdYaw, cmdPitch). True when that ray passes
 * through the target cylinder (feet tx,ty,tz predicted one tick ahead with its velocity, radius/height scaled
 * by `shrink` as a safety margin) within range. Line of sight is the caller's job (world.segClear).
 */
export function laserReleaseGate(
  sx: number, sy: number, sz: number, svx: number, svy: number, svz: number,
  aimYaw: number, aimPitch: number, cmdYaw: number, cmdPitch: number,
  tx: number, ty: number, tz: number, tvx: number, tvy: number, tvz: number,
  targetRadius: number, targetHeight: number,
  range = 280, muzzleHeight = 7, muzzleOut = 3, turnRate = 4, pitchRate = 3, shrink = 0.8,
): boolean {
  slewStep(aimYaw, aimPitch, cmdYaw, cmdPitch, turnRate, pitchRate, TICK, _rel)
  const r = targetRadius * shrink
  const h = targetHeight * shrink
  const zOff = 0.5 * (targetHeight - h)
  const d = aimHitsCylinder(
    sx + svx * TICK, sy + svy * TICK, sz + svz * TICK, _rel.yaw, _rel.pitch,
    tx + tvx * TICK, ty + tvy * TICK, tz + tvz * TICK + zOff, r, h, range, muzzleHeight, muzzleOut,
  )
  return d >= 0
}

// ---------------------------------------------------------------- lightning
/**
 * Which target the server would pick for a lightning shot fired with torso yaw `yaw`: the nearest mech, NPC
 * or crate within `range` m and within `coneDeg` degrees of the yaw (each side), with line of sight when a
 * world is given. Returns its id, or -1 (the arc would still fire and cost energy).
 */
export function lightningTarget(obs: Observation, yaw: number, range = 45, coneDeg = 30, world?: World): number {
  const s = obs.self
  const sx = s.pos[0], sy = s.pos[1], sz = s.pos[2] + (s.stats.muzzle_height ?? 7)
  const cone = coneDeg * DEG
  let best = -1, bestD = range
  const mechs = obs.mechs
  for (let i = 0; i < mechs.length; i++) {
    const m = mechs[i]
    const dx = m.pos[0] - sx, dy = m.pos[1] - sy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > bestD) continue
    if (d > 1e-6 && Math.abs(wrapPi(Math.atan2(dy, dx) - yaw)) > cone) continue
    const cz = m.pos[2] + (m.kind === "npc" ? 1.75 : 4.5 * (1 + 0.05 * (m.cubes ?? 0)))
    if (world && !world.segClear(sx, sy, sz, m.pos[0], m.pos[1], cz)) continue
    best = m.id
    bestD = d
  }
  const crates = obs.crates
  for (let i = 0; i < crates.length; i++) {
    const c = crates[i]
    const dx = c.pos[0] - sx, dy = c.pos[1] - sy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > bestD) continue
    if (d > 1e-6 && Math.abs(wrapPi(Math.atan2(dy, dx) - yaw)) > cone) continue
    if (world && !world.segClear(sx, sy, sz, c.pos[0], c.pos[1], c.pos[2] + 1)) continue
    best = c.id
    bestD = d
  }
  return best
}
