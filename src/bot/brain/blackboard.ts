/**
 * Blackboard: the per-bot world model, updated once per observation. Strategies read it, the executor reads it.
 * All persistent state of the brain lives on this object (and on the executor) - nothing at module level.
 */
import type { Config, DropObs, Hello, Observation, SelfObs, WeaponObs } from "../../protocol/mechfight.ts"
import type { Rng, World } from "../../contracts.ts"
import { EnemyTracker, weaponBit, W_LASER, W_LIGHTNING, W_MORTAR, type Track } from "../perception/tracker.ts"
import { SoundMap } from "../perception/sounds.ts"
import { ModeDetector, MODE_FFA, MODE_SQUAD, MODE_UNKNOWN } from "../perception/mode.ts"
import { seenBy } from "../perception/seenBy.ts"
import { ZoneModel } from "./zone.ts"
import { Intent } from "./intent.ts"
import type { BrainParams } from "./params.ts"

export { MODE_FFA, MODE_SQUAD, MODE_UNKNOWN }

export const L_CRATE = 0
export const L_CUBE = 1
export const L_PICKUP = 2

export class LootItem {
  id = -1
  type = L_CRATE
  /** weapon bit (tracker W_*) for pickups, 0 otherwise */
  wk = 0
  x = 0
  y = 0
  z = 0
  hp = 0
  tSeen = -1e9
  /** consecutive observations in which it should have been visible but was not listed */
  miss = 0
  /** no path to it was found: ignore it as a goal until this time */
  badUntil = -1
}

const ITEM_H = [2.4, 1.0, 1.0]

/** Remembered crates, cubes and weapon pickups. Items are removed when seen gone, taken, or forgotten. */
export class LootMemory {
  readonly items: LootItem[] = []
  private readonly byId = new Map<number, LootItem>()
  private readonly pool: LootItem[] = []

  get(id: number): LootItem | null {
    return this.byId.get(id) ?? null
  }

  private touch(id: number, type: number, x: number, y: number, z: number, t: number): LootItem {
    let it = this.byId.get(id)
    if (!it) {
      it = this.pool.pop() ?? new LootItem()
      it.id = id
      it.type = type
      it.wk = 0
      it.hp = 0
      it.badUntil = -1
      this.byId.set(id, it)
      this.items.push(it)
    }
    it.x = x
    it.y = y
    it.z = z
    it.tSeen = t
    it.miss = 0
    return it
  }

  remove(id: number): void {
    const it = this.byId.get(id)
    if (!it) return
    this.byId.delete(id)
    const i = this.items.indexOf(it)
    if (i >= 0) {
      const last = this.items.pop()!
      if (i < this.items.length) this.items[i] = last
    }
    this.pool.push(it)
  }

  /** remove the cube nearest to a point (within r), used when we get a `pickup` event */
  removeCubeNear(x: number, y: number, r: number): void {
    let best: LootItem | null = null
    let bd = r * r
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      if (it.type !== L_CUBE) continue
      const d = (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y)
      if (d < bd) {
        bd = d
        best = it
      }
    }
    if (best) this.remove(best.id)
  }

  update(obs: Observation, world: World | null, cfg: Config, forgetS: number): void {
    const t = obs.t
    for (let i = 0; i < obs.crates.length; i++) {
      const c = obs.crates[i]
      this.touch(c.id, L_CRATE, c.pos[0], c.pos[1], c.pos[2], t).hp = c.hp ?? 300
    }
    for (let i = 0; i < obs.cubes.length; i++) {
      const c = obs.cubes[i]
      this.touch(c.id, L_CUBE, c.pos[0], c.pos[1], c.pos[2], t)
    }
    for (let i = 0; i < obs.pickups.length; i++) {
      const p = obs.pickups[i]
      this.touch(p.id, L_PICKUP, p.pos[0], p.pos[1], p.pos[2], t).wk = weaponBit(p.kind)
    }
    for (let i = 0; i < obs.events.length; i++) {
      const e = obs.events[i]
      if (e.type === "took") this.remove(e.id)
      else if (e.type === "take_failed" && (e.reason === "gone" || e.reason === "have")) {
        if (e.reason === "gone") this.remove(e.id)
      } else if (e.type === "pickup") this.removeCubeNear(obs.self.pos[0], obs.self.pos[1], 7)
    }
    // seen gone / forgotten
    const s = obs.self
    const ex = s.pos[0], ey = s.pos[1], ez = s.pos[2] + (s.stats.eye_height ?? 8)
    const yaw = s.aim[0]
    const range = cfg.vision.range + (s.stats.vision_bonus ?? 0) - 10
    const near = cfg.vision.near_range + (s.stats.near_range_bonus ?? 0) - 4
    const fov = cfg.vision.fov_deg - 10
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.tSeen === t) continue
      if (t - it.tSeen > forgetS) {
        this.remove(it.id)
        continue
      }
      const dx = it.x - ex, dy = it.y - ey
      if (dx * dx + dy * dy > range * range) continue
      const vis = world ? world.canSee(ex, ey, ez, yaw, it.x, it.y, it.z, ITEM_H[it.type], range, fov, near) : dx * dx + dy * dy < near * near
      if (vis) {
        if (++it.miss >= 3) this.remove(it.id)
      }
    }
  }
}

/** free-form numeric memory for strategies (per bot) */
export class StratMemory {
  /** current committed plan tag and the time it expires */
  plan = 0
  planUntil = -1
  /** current loot goal */
  lootId = -1
  lootScore = 0
  /** hide spot */
  hideX = 0
  hideY = 0
  hideZ = 0
  hideOk = false
  hideT = -1e9
  hideScore = 0
  /** cover point while fleeing / reloading */
  coverX = 0
  coverY = 0
  coverZ = 0
  coverOk = false
  coverT = -1e9
  /** fight target with hysteresis */
  targetId = -1
  targetT = -1e9
  /** fleeing since (for patience), -1 = not fleeing */
  fleeSince = -1
  /** regenerating (disengaged) flag */
  regen = false
  /** time we first were alone (no enemy visible) */
  calmSince = 0
  /** drop being captured */
  dropId = -1
  /** generic scratch numbers */
  n0 = 0
  n1 = 0
  n2 = 0
}

export class Blackboard {
  readonly hello: Hello
  readonly cfg: Config
  readonly world: World
  readonly P: BrainParams
  readonly rng: Rng
  readonly tracker: EnemyTracker
  readonly sounds: SoundMap
  readonly modeDet: ModeDetector
  readonly zone: ZoneModel
  readonly loot = new LootMemory()
  readonly intent = new Intent()
  readonly mem = new StratMemory()

  obs!: Observation
  me!: SelfObs
  t = 0
  dt = 0.1
  tick = 0
  mode = MODE_UNKNOWN
  /** deaths not by our hand: all, and those that happened while we were not in any fight */
  otherDeaths = 0
  quietDeaths = 0
  ffaLatched = false
  /** positive SQUAD evidence latched (modeSquadLockT): no FFA latch any more */
  squadLocked = false
  /** runner wall-clock stats (realtime only; set by createBrain) and the timing hint: -1 not decided, 0 no, 1 yes */
  rt: { gaps: number[] } | null = null
  gapHint = -1
  private prevAlive = 16

  // ---- self
  x = 0
  y = 0
  z = 0
  vx = 0
  vy = 0
  speed = 0
  yaw = 0
  hp = 0
  maxHp = 1
  hpFrac = 1
  energy = 0
  maxEnergy = 100
  cubes = 0
  radius = 2.5
  height = 9
  eyeZ = 8
  muzzleH = 7
  walk = 11.7
  boostSpeed = 19.5
  turnRate = 4
  dmgMult = 1
  inZone = true
  grounded = true

  // ---- weapons
  gunSlot = -1
  ltgSlot = -1
  lasSlot = -1
  morSlot = -1
  gun: WeaponObs | null = null
  ltg: WeaponObs | null = null
  las: WeaponObs | null = null
  mor: WeaponObs | null = null
  /** slot index that holds no weapon (-1 = both full) */
  freeSlot = -1
  /** bit mask (tracker W_*) of what we hold */
  held = 0

  // ---- enemies (mech tracks present in this observation)
  readonly en: Track[] = []
  nEn = 0
  /** by mech id: we have a shot line (muzzle -> its centre) / it can see us (protocol vision from its side) */
  readonly los: Uint8Array
  readonly sees: Uint8Array
  /** visible mechs that aim at us or hit us in the last 3 s */
  nThreats = 0
  /** nearest visible mech and its distance */
  nearest: Track | null = null
  nearestD = Infinity
  /** number of visible mechs that can see us */
  nSeeing = 0
  /** time of the last damage from a mech / NPC, and of any combat (dealt or taken, resets the regen timer) */
  tHurt = -1e9
  tCombat = -1e9
  lastHurtBearing = 0
  /** id of the last mech / NPC that damaged us (-1 = none yet) */
  lastHurtBy = -1
  /** NPC drone that hit us in the last 3 s and is present in this observation (null = none) */
  npcAggressor: Track | null = null
  /** time of the last zone damage */
  tZoneHurt = -1e9
  /** seconds until HP regeneration starts (0 = regenerating or full) */
  regenIn = 0
  /** time any enemy mech was last present in an observation */
  tEnemySeen = -1e9
  /** time we last had a mech that could see us */
  tSeenByEnemy = -1e9
  drops: DropObs[] = []

  constructor(hello: Hello, world: World, P: BrainParams, rng: Rng) {
    this.hello = hello
    this.cfg = hello.config
    this.world = world
    this.P = P
    this.rng = rng
    this.tracker = new EnemyTracker(this.cfg, world)
    const n = this.cfg.match.mechs ?? 16
    this.los = new Uint8Array(n)
    this.sees = new Uint8Array(n)
    if (world) this.sounds = new SoundMap(this.cfg.sound, world.minX, world.minY, world.maxX, world.maxY)
    else this.sounds = new SoundMap(this.cfg.sound)
    this.modeDet = new ModeDetector(n, this.cfg.zone.start_radius)
    this.zone = new ZoneModel(this.cfg.zone)
    this.dt = (this.cfg.match.decide_every ?? 2) / (this.cfg.match.tick_hz ?? 20)
    this.prevAlive = n
  }

  update(obs: Observation): void {
    const me = obs.self
    this.obs = obs
    this.me = me
    this.t = obs.t
    this.tick = obs.tick
    const st = me.stats
    this.x = me.pos[0]
    this.y = me.pos[1]
    this.z = me.pos[2]
    this.vx = me.vel[0]
    this.vy = me.vel[1]
    this.speed = Math.hypot(this.vx, this.vy)
    this.yaw = me.aim[0]
    this.hp = me.hp
    this.maxHp = me.max_hp > 0 ? me.max_hp : 1
    this.hpFrac = this.hp / this.maxHp
    this.energy = me.energy
    this.maxEnergy = me.max_energy
    this.cubes = me.cubes
    this.radius = st.radius ?? 2.5
    this.height = st.height ?? 9
    // the real server keeps self.stats.radius / height at the base values while the body grows 5 % per cube
    // (eye / muzzle height do scale: 6 cubes -> eye 10.4 m, body 11.7 m). Planning for a 9 m body sent a grown
    // mech under an 11.5 m bridge again and again (41 s jet loop, zone death). Use the real size.
    if (this.P.navBodyFromCubes > 0) {
      const cm = this.cfg.mech
      const sc = Math.max(1 + ((this.cfg.cubes.size_per_cube as number) ?? 0.05) * me.cubes, (st.eye_height ?? 8) / (cm.eye_height ?? 8))
      this.radius = Math.max(this.radius, (cm.radius ?? 2.5) * sc)
      this.height = Math.max(this.height, (cm.height ?? 9) * sc)
    }
    this.eyeZ = st.eye_height ?? 8
    this.muzzleH = st.muzzle_height ?? 7
    this.walk = st.walk_speed ?? 11.7
    this.boostSpeed = st.boost_speed ?? 19.5
    this.turnRate = st.turn_rate ?? 4
    this.inZone = me.in_zone
    this.grounded = me.grounded
    const cc = this.cfg.cubes
    const cap = (cc.stat_cap as number) ?? 10
    this.dmgMult = 1 + ((cc.damage_per_cube as number) ?? 0.04) * Math.min(this.cubes, cap)

    // weapons
    this.gunSlot = this.ltgSlot = this.lasSlot = this.morSlot = -1
    this.gun = this.ltg = this.las = this.mor = null
    this.freeSlot = -1
    this.held = 0
    for (let i = 1; i >= 0; i--) {
      const w = me.weapons[i]
      if (!w) {
        this.freeSlot = i
        continue
      }
      this.held |= weaponBit(w.kind)
      if (w.kind === "gun") {
        this.gunSlot = i
        this.gun = w
      } else if (w.kind === "lightning") {
        this.ltgSlot = i
        this.ltg = w
      } else if (w.kind === "laser") {
        this.lasSlot = i
        this.las = w
      } else if (w.kind === "mortar") {
        this.morSlot = i
        this.mor = w
      }
    }

    // perception
    this.tracker.update(obs)
    this.sounds.update(obs)
    const det = this.modeDet.update(obs, this.tracker)
    // FFA needs deaths that our fight cannot explain. Stray bullets of hunters kill squad mates too, so a
    // death while we are in combat proves nothing; a death while nothing is going on around us does.
    // A ghost in a squad match is a disaster, so the softer cues of the detector are not used on their own.
    let died = this.prevAlive - obs.alive
    this.prevAlive = obs.alive
    if (died > 0) {
      for (let i = 0; i < obs.events.length; i++) if (obs.events[i].type === "kill") died--
      if (died > 0) {
        this.otherDeaths += died
        if (obs.t - this.tCombat > this.P.quietDeathS && this.nThreats === 0) this.quietDeaths += died
      }
    }
    const P = this.P
    // timing hint (final: 16 separate bots answer each tick; practice scorer: 1-5 ms) - decided once, after 16 gaps
    if (P.modeGapMs > 0 && this.gapHint < 0 && this.rt && this.rt.gaps.length >= 16) {
      const g = this.rt.gaps.slice(0, 16).sort((a, b) => a - b)
      this.gapHint = 0.5 * (g[7]! + g[8]!) > P.modeGapMs ? 1 : 0
    }
    const hint = this.gapHint === 1
    // positive SQUAD evidence: in an FFA somebody else has died by now (real showdowns: 43 of 43 by 30 s)
    if (!this.squadLocked && !this.ffaLatched && !hint && P.modeSquadLockT > 0 && obs.t >= P.modeSquadLockT && this.otherDeaths === 0) this.squadLocked = true
    if (!this.squadLocked) {
      if (this.quietDeaths >= 2 || (this.quietDeaths >= 1 && obs.t < P.ffaEarlyT) || this.otherDeaths >= P.ffaOtherDeaths) this.ffaLatched = true
      if (this.modeDet.logOdds >= P.ffaSoftLatch) this.ffaLatched = true
      if (P.modeDeathsN > 0 && this.otherDeaths >= P.modeDeathsN && obs.t < P.modeDeathsT) this.ffaLatched = true
      if (hint && this.otherDeaths >= P.modeGapDeaths && obs.t < 100) this.ffaLatched = true
    }
    const unknownUntil = hint && P.modeGapUnknownS > P.unknownSquadAfter ? P.modeGapUnknownS : P.unknownSquadAfter
    let mode = MODE_UNKNOWN
    if (this.ffaLatched) mode = MODE_FFA
    else if (this.squadLocked || det === MODE_SQUAD || obs.t >= unknownUntil) mode = MODE_SQUAD
    this.mode = this.P.forceMode === 1 ? MODE_SQUAD : this.P.forceMode === 2 ? MODE_FFA : mode
    this.zone.update(obs.zone, obs.t)
    this.loot.update(obs, this.world, this.cfg, this.P.lootForgetS)
    this.drops = obs.drops ?? []

    // events
    for (let i = 0; i < obs.events.length; i++) {
      const e = obs.events[i]
      if (e.type === "damaged") {
        this.tCombat = obs.t
        if (e.by === null || e.by === undefined) this.tZoneHurt = obs.t
        else {
          this.tHurt = obs.t
          this.lastHurtBy = e.by
          if (e.bearing !== null && e.bearing !== undefined) this.lastHurtBearing = e.bearing
        }
      } else if (e.type === "hit") this.tCombat = obs.t
    }
    const regenDelay = st.regen_delay ?? 5
    this.regenIn = this.hp >= this.maxHp ? 0 : Math.max(0, this.tCombat + regenDelay - obs.t)

    // enemies
    const tr = this.tracker
    let n = 0
    let nThreat = 0
    let nSee = 0
    let nearest: Track | null = null
    let nd = Infinity
    const mz = this.z + this.muzzleH
    const w = this.world
    for (let i = 0; i < tr.nVisible; i++) {
      const e = tr.visible[i]
      if (e.dead) continue
      if (n < this.en.length) this.en[n] = e
      else this.en.push(e)
      n++
      const cz = e.z + 0.5 * e.height
      const los = w ? w.segClear(this.x, this.y, mz, e.x, e.y, cz) || w.segClear(this.x, this.y, mz, e.x, e.y, e.z + 0.85 * e.height) : true
      this.los[e.id] = los ? 1 : 0
      const sees = seenBy(e, me, w, this.cfg.vision, 0, 0)
      this.sees[e.id] = sees ? 1 : 0
      if (sees) nSee++
      if ((e.aimingAtUs && los) || obs.t - e.tShotAtUs < 3) nThreat++
      if (e.dist < nd) {
        nd = e.dist
        nearest = e
      }
    }
    this.nEn = n
    this.nThreats = nThreat
    this.nSeeing = nSee
    this.nearest = nearest
    this.nearestD = nd
    this.npcAggressor = null
    const npcs = tr.npcs
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i]
      if (e.visible && e.hp !== 0 && obs.t - e.tShotAtUs < 3 && (!this.npcAggressor || e.dist < this.npcAggressor.dist)) this.npcAggressor = e
    }
    if (n > 0) this.tEnemySeen = obs.t
    if (nSee > 0) this.tSeenByEnemy = obs.t
  }

  /** does the mech hold this weapon (tracker bit) */
  enemyHas(e: Track, bit: number): boolean {
    return (e.weapons & bit) !== 0
  }

  get haveLightning(): boolean {
    return (this.held & W_LIGHTNING) !== 0
  }
  get haveLaser(): boolean {
    return (this.held & W_LASER) !== 0
  }
  get haveMortar(): boolean {
    return (this.held & W_MORTAR) !== 0
  }

  /** goals the nav watchdog gave up on (2 trips): x, y pairs, kept for the match */
  readonly badGoals = new Float64Array(32)
  nBadGoals = 0
  isBadGoal(x: number, y: number): boolean {
    for (let i = 0; i < this.nBadGoals; i++) if (Math.hypot(this.badGoals[2 * i] - x, this.badGoals[2 * i + 1] - y) < 10) return true
    return false
  }
  addBadGoal(x: number, y: number): void {
    if (this.isBadGoal(x, y)) return
    const i = this.nBadGoals < 16 ? this.nBadGoals++ : 15
    this.badGoals[2 * i] = x
    this.badGoals[2 * i + 1] = y
  }

  private lasDT = -1
  private lasD = 1e9
  /** horizontal distance to the nearest remembered laser pickup (1e9 = none known), cached per observation */
  nearestLaserDist(): number {
    if (this.lasDT === this.t) return this.lasD
    this.lasDT = this.t
    let bd = 1e9
    const items = this.loot.items
    for (let i = 0; i < items.length; i++) {
      const p = items[i]
      if (p.type !== L_PICKUP || p.wk !== W_LASER || p.badUntil > this.t) continue
      const d = Math.hypot(p.x - this.x, p.y - this.y)
      if (d < bd) bd = d
    }
    this.lasD = bd
    return bd
  }

  /** how many stacks of an upgrade we own */
  upgradeCount(id: string): number {
    let n = 0
    const u = this.me.upgrades
    for (let i = 0; i < u.length; i++) if (u[i] === id) n++
    return n
  }
}
