/**
 * EnemyTracker: per-id memory of every mech (0..15) and NPC drone (100+) across observations.
 * One instance per bot; no module state. update(obs) allocates nothing after construction
 * (NPC tracks are created lazily, once per drone id).
 */
import type { Config, Observation } from "../../protocol/mechfight.ts"
import type { World } from "../../contracts.ts"

export const W_GUN = 1
export const W_MORTAR = 2
export const W_LASER = 4
export const W_LIGHTNING = 8

export function weaponBit(kind: string): number {
  return kind === "gun" ? W_GUN : kind === "mortar" ? W_MORTAR : kind === "laser" ? W_LASER : kind === "lightning" ? W_LIGHTNING : 0
}

const PI = Math.PI
const TAU = 2 * Math.PI
function wrapPi(a: number): number {
  a = (a + PI) % TAU
  if (a < 0) a += TAU
  return a - PI
}

export class Track {
  id = -1
  npc = false
  /** has a position fix (seen at least once, or located by a beam origin) */
  known = false
  /** present in obs.mechs this update: the position is the server's truth (also during the 5 s memory) */
  visible = false
  /** present AND geometrically inside our vision (wedge/near range; with a world: canSee) */
  inView = false
  dead = false
  tDead = -1

  x = 0
  y = 0
  z = 0
  vx = 0
  vy = 0
  vz = 0
  /** smoothed acceleration estimate (m/s^2) from consecutive velocities */
  ax = 0
  ay = 0
  az = 0
  /** velocity smoothed over ~0.6 s (a strafing target's mean drift) */
  vxAvg = 0
  vyAvg = 0
  /** RMS (m/s, smoothed over ~1.5 s) of the horizontal velocity around vxAvg/vyAvg: 0 = steady mover,
   *  ~10 = hard strafe jitter. Feed it to hitProbGun as targetSpeedUncertainty. */
  velJitter = 0
  aimYaw = 0
  aimPitch = 0
  /** rad/s, from consecutive observations */
  aimYawRate = 0
  /** -1 = unknown */
  hp = -1
  maxHp = -1
  cubes = 0
  /** W_* bit mask of weapons it is known to hold (seen, or used on us / in a beam) */
  weapons = 0
  charging = false
  /** obs.t when the current laser charge was first seen (-1 = not charging) */
  tChargeStart = -1
  radius = 2.5
  height = 9

  /** obs.t of the last position fix from obs.mechs, of the first one, of the last time it was inView */
  tSeen = -1e9
  tFirstSeen = -1e9
  tInView = -1e9
  /** obs.t of a position fix from a beam origin (only used while not visible) */
  tBeamFix = -1e9

  // --- relation to us, refreshed every update from the last known state
  /** horizontal distance (m) and world bearing (rad) from us to it */
  dist = Infinity
  bearing = 0
  /** yaw error (rad) between its aim and the bearing from it to us */
  aimErr = PI
  aimingAtUs = false
  tAimedAtUs = -1e9

  // --- damage bookkeeping
  dmgToUs = 0
  /** exponentially decayed (tau 5 s) damage it dealt to us */
  dmgToUsRecent = 0
  hitsOnUs = 0
  rearHitsOnUs = 0
  tShotAtUs = -1e9
  /** world bearing of its last hit on us (from the damaged event) */
  lastHitBearing = 0
  weaponsUsedOnUs = 0
  dmgFromUs = 0
  tHitByUs = -1e9
  /** hp it lost this update that our own hits do not explain (0 if none / unknown) */
  hpDropUnexplained = 0
  tHpDropUnexplained = -1e9

  threat = 0

  // internal
  _present = false
  _hitNow = 0

  constructor(id: number) {
    this.id = id
    this.npc = id >= 100
    if (this.npc) {
      this.radius = 1.8
      this.height = 3.5
    }
  }

  /** seconds since the last position fix */
  age(t: number): number {
    const a = t - this.tSeen
    const b = t - this.tBeamFix
    return a < b ? a : b
  }
}

export interface Vec3Out {
  x: number
  y: number
  z: number
}

export class EnemyTracker {
  /** mech tracks by id 0..n-1 (our own slot stays unused) */
  readonly mechs: Track[] = []
  /** NPC tracks in order of first sighting */
  readonly npcs: Track[] = []
  /** mechs present in the last obs (prefix of length nVisible), sorted by nothing in particular */
  readonly visible: Track[] = []
  nVisible = 0
  selfId = -1
  t = 0
  dt = 0.1
  /** obs.alive of the last update, and the count before it */
  alive = 16
  ourKills = 0
  /** deaths (alive-count drops) not explained by our kill events */
  otherDeaths = 0
  tLastOtherDeath = -1e9
  /** total / recent (tau 5 s) damage we took from mechs and NPCs; time of the last such hit */
  dmgTaken = 0
  dmgTakenRecent = 0
  tDamaged = -1e9

  private world: World | null
  private visRange = 200
  private visFov = 120
  private visNear = 45
  private memoryS = 5
  private mechRadius = 2.5
  private mechHeight = 9
  private sizePerCube = 0.05
  private nMechs = 16
  private started = false

  constructor(config?: Config | null, world?: World | null) {
    this.world = world ?? null
    if (config) {
      this.visRange = config.vision.range
      this.visFov = config.vision.fov_deg
      this.visNear = config.vision.near_range
      this.memoryS = config.vision.memory_s ?? 5
      this.mechRadius = config.mech.radius ?? 2.5
      this.mechHeight = config.mech.height ?? 9
      this.sizePerCube = (config.cubes.size_per_cube as number) ?? 0.05
      this.nMechs = config.match.mechs ?? 16
    }
    for (let i = 0; i < this.nMechs; i++) {
      this.mechs.push(new Track(i))
      this.visible.push(this.mechs[i])
    }
    this.alive = this.nMechs
  }

  /** track by id (mech or NPC), or null when never heard of */
  get(id: number): Track | null {
    if (id >= 0 && id < this.mechs.length) return this.mechs[id]
    for (let i = 0; i < this.npcs.length; i++) if (this.npcs[i].id === id) return this.npcs[i]
    return null
  }

  private getOrCreate(id: number): Track | null {
    if (id < 0) return null
    if (id < this.mechs.length) return this.mechs[id]
    if (id < 100) return null
    for (let i = 0; i < this.npcs.length; i++) if (this.npcs[i].id === id) return this.npcs[i]
    const tr = new Track(id)
    this.npcs.push(tr)
    return tr
  }

  update(obs: Observation): void {
    const self = obs.self
    const t = obs.t
    let dt = this.started ? t - this.t : 0.1
    if (dt <= 0) dt = 0.1
    const contiguous = this.started && dt < 0.16
    this.dt = dt
    this.t = t
    this.selfId = self.id
    this.started = true
    const sx = self.pos[0], sy = self.pos[1], sz = self.pos[2]
    const selfR = self.stats.radius ?? 2.5
    const eyeZ = sz + (self.stats.eye_height ?? 8)
    const decay = Math.exp(-dt / 5)
    this.dmgTakenRecent *= decay

    const mechs = this.mechs
    const npcs = this.npcs
    for (let i = 0; i < mechs.length; i++) {
      const tr = mechs[i]
      tr._present = false
      tr._hitNow = 0
      tr.hpDropUnexplained = 0
      tr.dmgToUsRecent *= decay
    }
    for (let i = 0; i < npcs.length; i++) {
      const tr = npcs[i]
      tr._present = false
      tr._hitNow = 0
      tr.hpDropUnexplained = 0
      tr.dmgToUsRecent *= decay
    }

    // --- events first (our hits explain hp drops)
    let killsNow = 0
    const events = obs.events
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e.type === "damaged") {
        if (e.by === null || e.by === undefined) continue
        this.dmgTaken += e.amount
        this.dmgTakenRecent += e.amount
        this.tDamaged = t
        const tr = this.getOrCreate(e.by)
        if (!tr) continue
        tr.dmgToUs += e.amount
        tr.dmgToUsRecent += e.amount
        tr.hitsOnUs++
        if (e.rear) tr.rearHitsOnUs++
        tr.tShotAtUs = t
        if (e.bearing !== null && e.bearing !== undefined) tr.lastHitBearing = e.bearing
        const b = weaponBit(e.weapon)
        tr.weaponsUsedOnUs |= b
        tr.weapons |= b
      } else if (e.type === "hit") {
        const tr = this.getOrCreate(e.target)
        if (!tr) continue
        tr.dmgFromUs += e.amount
        tr.tHitByUs = t
        tr._hitNow += e.amount
      } else if (e.type === "kill") {
        killsNow++
        this.ourKills++
        const tr = this.getOrCreate(e.target)
        if (tr) {
          tr.dead = true
          tr.tDead = t
        }
      }
    }

    // --- visible actors
    let nv = 0
    const list = obs.mechs
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const tr = this.getOrCreate(m.id)
      if (!tr || m.id === self.id) continue
      const wasFresh = contiguous && tr.visible
      const px = m.pos[0], py = m.pos[1], pz = m.pos[2]
      const vx = m.vel[0], vy = m.vel[1], vz = m.vel[2]
      if (wasFresh) {
        const k = 0.5
        tr.ax += k * ((vx - tr.vx) / dt - tr.ax)
        tr.ay += k * ((vy - tr.vy) / dt - tr.ay)
        tr.az += k * ((vz - tr.vz) / dt - tr.az)
        tr.aimYawRate = wrapPi(m.aim[0] - tr.aimYaw) / dt
        const ka = 1 - Math.exp(-dt / 0.6)
        tr.vxAvg += ka * (vx - tr.vxAvg)
        tr.vyAvg += ka * (vy - tr.vyAvg)
        const ex = vx - tr.vxAvg, ey = vy - tr.vyAvg
        const kj = 1 - Math.exp(-dt / 1.5)
        tr.velJitter = Math.sqrt(tr.velJitter * tr.velJitter + kj * (ex * ex + ey * ey - tr.velJitter * tr.velJitter))
      } else {
        tr.ax = 0
        tr.ay = 0
        tr.az = 0
        tr.aimYawRate = 0
        tr.vxAvg = vx
        tr.vyAvg = vy
        // unknown mover: assume a moderately evasive one until we have watched it
        tr.velJitter = tr.npc ? 2 : 6
      }
      if (m.hp !== undefined) {
        if (wasFresh && tr.hp >= 0) {
          const drop = tr.hp - m.hp - tr._hitNow
          if (drop > 0.5) {
            tr.hpDropUnexplained = drop
            tr.tHpDropUnexplained = t
          }
        }
        tr.hp = m.hp
      }
      if (m.max_hp !== undefined) tr.maxHp = m.max_hp
      tr.x = px
      tr.y = py
      tr.z = pz
      tr.vx = vx
      tr.vy = vy
      tr.vz = vz
      tr.aimYaw = m.aim[0]
      tr.aimPitch = m.aim[1]
      if (!tr.npc) {
        tr.cubes = m.cubes ?? 0
        const s = 1 + this.sizePerCube * tr.cubes
        tr.radius = this.mechRadius * s
        tr.height = this.mechHeight * s
        if (m.weapons) {
          // what we see replaces what we inferred (a weapon can be dropped or swapped)
          let mask = 0
          for (let j = 0; j < m.weapons.length; j++) mask |= weaponBit(m.weapons[j])
          tr.weapons = mask
        }
        const ch = m.charging === true
        if (ch && !tr.charging) tr.tChargeStart = t
        if (!ch) tr.tChargeStart = -1
        tr.charging = ch
      }
      if (!tr.known) tr.tFirstSeen = t
      tr.known = true
      tr.tSeen = t
      tr._present = true
      if (tr.dead) {
        // we were wrong
        tr.dead = false
        tr.tDead = -1
      }
      // geometric visibility
      const dx = px - sx, dy = py - sy
      const d = Math.sqrt(dx * dx + dy * dy)
      let inView: boolean
      if (this.world) {
        inView = this.world.canSee(sx, sy, eyeZ, self.aim[0], px, py, pz, tr.height, this.visRange + (self.stats.vision_bonus ?? 0), this.visFov, this.visNear + (self.stats.near_range_bonus ?? 0))
      } else {
        inView = d <= this.visNear + (self.stats.near_range_bonus ?? 0) || (d <= this.visRange + (self.stats.vision_bonus ?? 0) && Math.abs(wrapPi(Math.atan2(dy, dx) - self.aim[0])) <= (0.5 * this.visFov * PI) / 180)
      }
      tr.inView = inView
      if (inView) tr.tInView = t
      if (!tr.npc) this.visible[nv++] = tr
    }
    this.nVisible = nv

    // --- beams: weapon knowledge and a position fix for shooters we cannot see
    const beams = obs.beams
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i]
      const tr = this.getOrCreate(b.by)
      if (!tr || b.by === self.id) continue
      tr.weapons |= weaponBit(b.kind)
      if (!tr._present && b.path.length > 0) {
        const p = b.path[0]
        tr.x = p[0]
        tr.y = p[1]
        tr.z = p[2] - 7 * (tr.height / this.mechHeight)
        tr.vx = 0
        tr.vy = 0
        tr.vz = 0
        if (b.path.length > 1) {
          const q = b.path[1]
          tr.aimYaw = Math.atan2(q[1] - p[1], q[0] - p[0])
        }
        tr.known = true
        tr.tBeamFix = t - b.age
      }
    }

    // --- deaths: alive-count drops we did not cause
    const drop = this.alive - obs.alive
    if (drop > 0) {
      let unexplained = drop - killsNow
      if (unexplained > 0) {
        this.otherDeaths += unexplained
        this.tLastOtherDeath = t
        // a mech we were watching that vanished before its 5 s memory ran out, on the very obs the count
        // dropped, is the one that died (lowest hp first)
        while (unexplained > 0) {
          let best: Track | null = null
          for (let i = 0; i < mechs.length; i++) {
            const tr = mechs[i]
            if (tr.dead || tr._present || !tr.visible || !contiguous) continue
            if (t - tr.tInView > this.memoryS - 0.5) continue
            if (!best || tr.hp < best.hp) best = tr
          }
          if (!best) break
          best.dead = true
          best.tDead = t
          unexplained--
        }
      }
    }
    this.alive = obs.alive

    // --- relations and threat
    for (let i = 0; i < mechs.length; i++) this.relate(mechs[i], sx, sy, selfR, t)
    for (let i = 0; i < npcs.length; i++) this.relate(npcs[i], sx, sy, selfR, t)
  }

  private relate(tr: Track, sx: number, sy: number, selfR: number, t: number): void {
    tr.visible = tr._present
    if (!tr._present) {
      tr.inView = false
      tr.charging = false
      tr.tChargeStart = -1
      tr.aimYawRate = 0
    }
    if (!tr.known || tr.id === this.selfId) {
      tr.threat = 0
      tr.aimingAtUs = false
      return
    }
    const dx = tr.x - sx, dy = tr.y - sy
    const d = Math.sqrt(dx * dx + dy * dy)
    tr.dist = d
    tr.bearing = Math.atan2(dy, dx)
    tr.aimErr = Math.abs(wrapPi(tr.aimYaw - Math.atan2(-dy, -dx)))
    tr.aimingAtUs = tr.visible && !tr.dead && tr.aimErr < Math.atan2(selfR + 1.5, d) + 0.05
    if (tr.aimingAtUs) tr.tAimedAtUs = t
    if (tr.dead) {
      tr.threat = 0
      return
    }
    // threat: what it can do to us from there, scaled by whether it is pointing at us and how fresh it is
    let th = 0
    if (tr.npc) {
      th = d < 90 ? 0.25 : 0
    } else {
      const w = tr.weapons === 0 ? W_GUN : tr.weapons
      if (w & W_GUN && d < 240) th += d < 80 ? 1.2 : d < 160 ? 0.9 : 0.5
      if (w & W_LASER && d < 290) th += 1.6
      if (w & W_LIGHTNING) th += d < 50 ? 2 : d < 80 ? 0.6 : 0
      if (w & W_MORTAR && d < 240) th += 0.7
      th *= 1 + 0.04 * (tr.cubes < 10 ? tr.cubes : 10)
    }
    th *= tr.aimingAtUs ? 1.5 : tr.aimErr < 1.05 ? 1 : 0.6
    if (tr.charging && tr.aimErr < 0.5) th += 2
    th += tr.dmgToUsRecent / 150
    if (!tr.visible) th *= Math.exp(-tr.age(t) / 4)
    tr.threat = th
  }

  /** visible mech with the highest threat, or null */
  mostThreatening(): Track | null {
    let best: Track | null = null
    for (let i = 0; i < this.nVisible; i++) {
      const tr = this.visible[i]
      if (!best || tr.threat > best.threat) best = tr
    }
    return best
  }

  /** nearest visible mech, or null */
  nearestVisible(): Track | null {
    let best: Track | null = null
    for (let i = 0; i < this.nVisible; i++) {
      const tr = this.visible[i]
      if (!best || tr.dist < best.dist) best = tr
    }
    return best
  }

  /** number of mechs known dead (kill events + inferred) */
  knownDead(): number {
    let n = 0
    for (let i = 0; i < this.mechs.length; i++) if (this.mechs[i].dead) n++
    return n
  }

  /**
   * Velocity to lead with for a projectile flight of `tof` seconds: the instantaneous velocity for short
   * flights, blending to the ~0.6 s average for long ones (a jittering target's velocity now says little
   * about where it is half a second later). Writes out.x/y/z (m/s).
   */
  leadVelocity(tr: Track, tof: number, out: Vec3Out): void {
    let w = (tof - 0.15) / 0.45
    w = w < 0 ? 0 : w > 1 ? 1 : w
    out.x = tr.vx + w * (tr.vxAvg - tr.vx)
    out.y = tr.vy + w * (tr.vyAvg - tr.vy)
    out.z = tr.vz * (1 - w)
  }

  /**
   * Predicted feet position `dt` seconds after the track's last fix: constant velocity plus the estimated
   * acceleration for at most accelHorizon seconds (speed is not clamped). Writes out.
   */
  predict(tr: Track, dt: number, out: Vec3Out, accelHorizon = 0): void {
    const ta = dt < accelHorizon ? dt : accelHorizon
    out.x = tr.x + tr.vx * dt + tr.ax * ta * (dt - 0.5 * ta)
    out.y = tr.y + tr.vy * dt + tr.ay * ta * (dt - 0.5 * ta)
    out.z = tr.z + tr.vz * dt
  }
}
