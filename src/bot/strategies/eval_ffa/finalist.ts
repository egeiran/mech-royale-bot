/**
 * "Finalist" imitation bots for FFA evaluation: one parameterised bot whose presets follow the per-team
 * numbers of the recorded top-16 showdowns (fieldstats.ts --real --teams; data/intel/ghost.md a, c).
 *
 * What the real finalists do, and what this bot therefore does:
 *   - shoot on sight, near-perfect linear lead; whether a sighting beyond 45 / 100 m is engaged at all is a
 *     per-team probability (engageMidP / engageFarP: "damage within 20 s of a >= 100 m sighting" 14-81 %)
 *   - do NOT hunt: after the line of sight breaks only chaseP (6 %) walk to the last seen position
 *   - idle: legs of legMin..legMax metres pulled toward the next zone centre, then stand still (restFrac of
 *     the idle time; teams differ from 5 % to 55 %), torso sweeping all the time
 *   - loadout: nearest wanted weapon early (laser / lightning weights), cubes from kills, some crate farming
 *   - almost never in the air (2 % of the time), boost ~9 %
 * Deterministic (ctx.rng only), no module-level state. Not part of the shipped bot.
 */
import type { Bot, BotAction, BotContext, BotFactory, NavPath, Observation, Steer } from "../../../contracts.ts"
import { createNav } from "../../../world/nav/index.ts"

const TAU = Math.PI * 2
const DEG = Math.PI / 180
const wrap = (a: number) => {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

export interface FinalistKnobs {
  aimSigmaDeg: number
  aimTau: number
  reactionS: number
  lead: number
  fireTolDeg: number
  fireRad: number
  gunMaxDist: number
  /** probability to engage a mech first seen at 45-100 m / beyond 100 m (inside 45 m: always) */
  engageMidP: number
  engageFarP: number
  strafeSpeed: number
  strafeMin: number
  strafeMax: number
  /** share of combat time standing still */
  combatStill: number
  prefDist: number
  band: number
  radial: number
  /** jump period in combat (s, 0 = never) */
  jumpCombat: number
  boostDuty: number
  wLaser: number
  wLightning: number
  wMortar: number
  /** walks to wanted weapon pickups within this distance while the second slot is empty */
  lootRange: number
  cubeRange: number
  /** share of idle time spent shooting crates / NPCs */
  farm: number
  farmNpc: number
  /** share of idle time standing still */
  restFrac: number
  legMin: number
  legMax: number
  idleSpeed: number
  /** probability that an idle leg heads for the next zone centre (else a random direction) */
  zonePull: number
  /** torso sweep rate when idle (rad/s) */
  scanRate: number
  /** probability to walk to the last seen position after losing a target */
  chaseP: number
  /** probability that an idle leg heads for recent gunfire */
  soundP: number
  retreatHp: number
  laserCharge: number
  dropRange: number
  /** probability (per acquired target) to stop and duel (strafe at prefDist); otherwise keep walking the idle
   *  leg / resting while shooting, which lets the line of sight break by itself */
  duelP: number
  /** below this HP fraction and under fire: break the line of sight behind the nearest wall with probability
   *  duckP (per damage episode) and stay there until regenerated */
  duckHp: number
  duckP: number
  /** calibration handles applied to every preset: multipliers on engageMidP / engageFarP and on aimSigmaDeg */
  engageMul: number
  sigmaMul: number
  /** zone rotation: starts this long before the shrink, to this fraction of the next radius */
  zoneLeadS: number
  zoneIn: number
}

export const FINALIST_BASE: FinalistKnobs = {
  aimSigmaDeg: 1.2, aimTau: 0.35, reactionS: 0.3, lead: 1, fireTolDeg: 1.5, fireRad: 0.5, gunMaxDist: 200,
  engageMidP: 0.75, engageFarP: 0.4, strafeSpeed: 0.6, strafeMin: 1.0, strafeMax: 2.2, combatStill: 0.2,
  prefDist: 60, band: 25, radial: 0.15, jumpCombat: 0, boostDuty: 0.1, wLaser: 1, wLightning: 1, wMortar: 0,
  lootRange: 170, cubeRange: 90, farm: 0.6, farmNpc: 1, restFrac: 0.35, legMin: 40, legMax: 120, idleSpeed: 1,
  zonePull: 0.22, scanRate: 1.4, chaseP: 0.06, soundP: 0.1, retreatHp: 0, laserCharge: 1, dropRange: 0,
  duelP: 0.15, duckHp: 0.8, duckP: 1, engageMul: 0.75, sigmaMul: 0.85, zoneLeadS: 25, zoneIn: 0.85,
}

/**
 * Per-team presets. Columns used (real showdowns, n = bot-matches): share of time > 5 m/s / standing still,
 * median hit distance, share of damage beyond 100 m, damage split by weapon, long-range engagement rate,
 * damage dealt per alive second (skill).
 */
export const FINALIST_PRESETS: Record<string, Partial<FinalistKnobs>> = {
  // ---- runners with a laser that shoot far (TigerTown27, 2696, A-bot LLC, scorpion, benchmaster)
  tigertown: { restFrac: 0.04, legMin: 80, legMax: 220, prefDist: 80, band: 30, engageFarP: 0.5, engageMidP: 0.9, wLaser: 4, wLightning: 0.3, aimSigmaDeg: 0.8, reactionS: 0.2, boostDuty: 0.25, farm: 0.8, farmNpc: 1, cubeRange: 110, lootRange: 170, combatStill: 0.02, chaseP: 0.15 },
  n2696: { restFrac: 0.15, legMin: 70, legMax: 200, prefDist: 100, band: 35, engageFarP: 0.85, engageMidP: 0.95, wLaser: 4, wLightning: 0.8, aimSigmaDeg: 0.8, reactionS: 0.2, boostDuty: 0.13, combatStill: 0.1 },
  abot: { restFrac: 0.15, legMin: 70, legMax: 200, prefDist: 100, band: 35, engageFarP: 0.55, engageMidP: 0.85, wLaser: 3, wLightning: 0.8, aimSigmaDeg: 1.1, boostDuty: 0.1, combatStill: 0.1 },
  scorpion: { restFrac: 0.1, legMin: 80, legMax: 220, prefDist: 85, band: 30, engageFarP: 0.4, engageMidP: 0.8, wLaser: 4, wLightning: 0.5, aimSigmaDeg: 1.3, boostDuty: 0.17, combatStill: 0.05 },
  benchmaster: { restFrac: 0.28, legMin: 60, legMax: 160, prefDist: 105, band: 35, engageFarP: 0.7, engageMidP: 0.9, wLaser: 3, wLightning: 2, aimSigmaDeg: 0.9, reactionS: 0.2, soundP: 0.35, combatStill: 0.2 },
  azing: { restFrac: 0.3, legMin: 60, legMax: 160, prefDist: 105, band: 35, engageFarP: 0.56, engageMidP: 0.8, wLaser: 1.5, wLightning: 1.5, aimSigmaDeg: 1.4, soundP: 0.25, combatStill: 0.2 },
  // ---- snipers that mostly stand (uploadcocoa, poteto)
  cocoa: { restFrac: 0.5, legMin: 40, legMax: 120, prefDist: 115, band: 40, engageFarP: 0.75, engageMidP: 0.9, wLaser: 4, wLightning: 1, aimSigmaDeg: 0.9, boostDuty: 0.2, combatStill: 0.4, farm: 0.8, farmNpc: 1, cubeRange: 100 },
  poteto: { restFrac: 0.38, legMin: 40, legMax: 130, prefDist: 95, band: 35, engageFarP: 0.6, engageMidP: 0.85, wLaser: 5, wLightning: 0.2, aimSigmaDeg: 1.0, soundP: 0.3, combatStill: 0.3 },
  // ---- slow gun + lightning holders that fight at ~50 m and rarely shoot far
  giddy: { idleSpeed: 0.42, restFrac: 0.6, legMin: 30, legMax: 90, prefDist: 46, band: 14, gunMaxDist: 130, engageFarP: 0.2, engageMidP: 0.7, wLaser: 1.5, wLightning: 1.5, aimSigmaDeg: 1.3, boostDuty: 0.03, zonePull: 0.4, combatStill: 0.35 },
  backwards: { idleSpeed: 0.42, restFrac: 0.62, legMin: 30, legMax: 90, prefDist: 44, band: 12, gunMaxDist: 110, engageFarP: 0.14, engageMidP: 0.7, wLaser: 0.1, wLightning: 3, aimSigmaDeg: 1.3, boostDuty: 0.06, zonePull: 0.4, combatStill: 0.4 },
  whatever: { idleSpeed: 0.42, restFrac: 0.58, legMin: 30, legMax: 90, prefDist: 46, band: 14, gunMaxDist: 130, engageFarP: 0.22, engageMidP: 0.7, wLaser: 0.6, wLightning: 2.5, aimSigmaDeg: 1.5, boostDuty: 0.05, zonePull: 0.4, combatStill: 0.35 },
  kanyaraasi: { idleSpeed: 0.42, restFrac: 0.7, legMin: 30, legMax: 110, prefDist: 50, band: 15, gunMaxDist: 120, engageFarP: 0.15, engageMidP: 0.6, wLaser: 0.3, wLightning: 3, aimSigmaDeg: 1.5, boostDuty: 0.05, soundP: 0.3, combatStill: 0.5, lootRange: 120 },
  r1ver: { idleSpeed: 0.42, restFrac: 0.5, legMin: 30, legMax: 100, prefDist: 48, band: 14, gunMaxDist: 150, engageFarP: 0.25, engageMidP: 0.75, wLaser: 0.4, wLightning: 3, aimSigmaDeg: 1.1, boostDuty: 0.06, combatStill: 0.3, farm: 0.8, cubeRange: 100 },
  wsquad: { idleSpeed: 0.42, restFrac: 0.6, legMin: 30, legMax: 90, prefDist: 56, band: 16, gunMaxDist: 150, engageFarP: 0.24, engageMidP: 0.7, wLaser: 3, wLightning: 0.1, aimSigmaDeg: 1.4, boostDuty: 0.05, zonePull: 0.4, soundP: 0.3, combatStill: 0.35 },
  notevenclose: { idleSpeed: 0.42, restFrac: 0.7, legMin: 30, legMax: 110, prefDist: 60, band: 18, gunMaxDist: 150, engageFarP: 0.14, engageMidP: 0.65, wLaser: 3, wLightning: 0.1, aimSigmaDeg: 1.3, boostDuty: 0.03, combatStill: 0.5 },
  // ---- in between
  mahalas: { duckP: 1, duckHp: 0.85, duelP: 0.1, restFrac: 0.42, legMin: 50, legMax: 140, prefDist: 85, band: 30, engageFarP: 0.4, engageMidP: 0.75, wLaser: 1.5, wLightning: 1.5, aimSigmaDeg: 1.8, boostDuty: 0.12, zonePull: 0.4, combatStill: 0.3, lootRange: 120 },
  antalos: { restFrac: 0.45, legMin: 40, legMax: 120, prefDist: 44, band: 14, gunMaxDist: 150, engageFarP: 0.3, engageMidP: 0.8, wLaser: 2, wLightning: 1.2, aimSigmaDeg: 1.2, boostDuty: 0.07, combatStill: 0.25 },
  p23: { restFrac: 0.12, legMin: 80, legMax: 220, prefDist: 60, band: 20, engageFarP: 0.48, engageMidP: 0.8, wLaser: 1.2, wLightning: 1, aimSigmaDeg: 1.7, boostDuty: 0.2, soundP: 0.3, combatStill: 0.05, lootRange: 120 },
  kyoto: { restFrac: 0.35, legMin: 50, legMax: 140, prefDist: 52, band: 16, gunMaxDist: 150, engageFarP: 0.25, engageMidP: 0.8, wLaser: 0.3, wLightning: 2, aimSigmaDeg: 1.0, boostDuty: 0.12, combatStill: 0.2 },
  // ---- stress variants (not measured): the same shooter that DOES hunt, and one that shoots everything it sees
  hunter: { restFrac: 0.08, legMin: 80, legMax: 220, prefDist: 60, band: 20, engageFarP: 1, engageMidP: 1, wLaser: 3, wLightning: 2, aimSigmaDeg: 1.0, reactionS: 0.2, boostDuty: 0.2, chaseP: 1, soundP: 0.8, combatStill: 0.02, farm: 0.2, cubeRange: 100 },
}

/** the 9 recorded showdowns: bot-matches per team (weights of the "finalists" field) */
export const FINALIST_WEIGHTS: Record<string, number> = {
  tigertown: 7, n2696: 9, abot: 9, scorpion: 9, benchmaster: 9, azing: 9, cocoa: 2, poteto: 2, giddy: 9, backwards: 9, whatever: 9,
  kanyaraasi: 9, r1ver: 7, wsquad: 9, notevenclose: 7, mahalas: 9, antalos: 9, p23: 9, kyoto: 2,
}

export function resolveFinalist(preset: string, overrides?: Record<string, number> | null): FinalistKnobs {
  const p = FINALIST_PRESETS[preset]
  if (!p) throw new Error(`unknown finalist preset "${preset}"`)
  const k: FinalistKnobs = { ...FINALIST_BASE, ...p }
  if (overrides) for (const key of Object.keys(k) as (keyof FinalistKnobs)[]) if (typeof overrides[key] === "number") k[key] = overrides[key]!
  return k
}

type Actor = Observation["mechs"][number]

const UPGRADE_RANK = [
  "plating", "armor", "nanites", "gun_damage", "gun_rate", "laser_damage", "laser_charge", "lightning_efficiency", "gun_mag",
  "gyros", "servos", "reactor", "lightning_chain", "lightning_range", "gun_velocity", "capacitor", "jets", "laser_pierce", "sensors",
]

export function makeFinalist(preset: string): BotFactory {
  return (ctx: BotContext): Bot => {
    const K = resolveFinalist(preset, ctx.params)
    const cfg = ctx.hello.config
    const rng = ctx.rng
    const world = ctx.world
    const dt = (cfg.match.decide_every ?? 2) / (cfg.match.tick_hz ?? 20)
    const nMech = cfg.match.mechs ?? 16
    let nav: ReturnType<typeof createNav> | null = null
    if (world) {
      try {
        nav = createNav(world)
      } catch {
        nav = null
      }
    }
    const follower = nav ? nav.newFollower() : null
    const steer: Steer = { mx: 0, my: 0, jump: false, boost: false, stuck: false }

    // ---- state
    let strafeSign = rng.next() < 0.5 ? 1 : -1
    let strafeUntil = 0
    let stillUntil = -1
    let noiseYaw = 0
    let noisePitch = 0
    let targetId = -1
    let acquiredT = -1
    let lastSeenT = -100
    let lastX = 0, lastY = 0, lastZ = 0
    let chasing = false
    let lookYaw = 0
    let lookUntil = -1
    let attackerId = -1
    let attackedT = -100
    let nextJump = rng.range(2, 8)
    let boostUntil = -1
    let nextBoost = rng.range(1, 6)
    let stuckT = 0
    let detourUntil = -1
    let detourSign = 1
    let px = 0, py = 0
    let path: NavPath | null = null
    let pathGX = 1e9, pathGY = 1e9, pathT = -100
    let legX = 0, legY = 0
    let legUntil = -1
    let restUntil = rng.range(0, 3) * K.restFrac
    let legStart = 0
    let soundX = 0, soundY = 0, soundT = -100
    const spin = rng.next() < 0.5 ? 1 : -1
    const scanPhase = rng.range(0, TAU)
    let farmUntil = -1
    let farming = false
    let duel = false
    let push = false
    let duckUntil = -1
    let duckX = 0, duckY = 0, duckZ = 0
    let duckDecidedT = -100
    /** per mech: time last seen, engagement decision (0 undecided, 1 engage, 2 ignore), distance at the decision */
    const seenT = new Float64Array(nMech).fill(-100)
    const decision = new Uint8Array(nMech)
    const decDist = new Float64Array(nMech)
    const decT = new Float64Array(nMech)

    let mx = 0, my = 0
    let jump = false, boost = false
    let aimYaw = 0, aimPitch = 0, aimDist = 0

    const act = (obs: Observation): BotAction => {
      const me = obs.self
      const x = me.pos[0], y = me.pos[1], z = me.pos[2]
      const t = obs.t
      const a: BotAction = {}
      const stats = me.stats
      const scaleMe = 1 + ((cfg.cubes.size_per_cube as number) ?? 0.05) * me.cubes
      const radius = (cfg.mech.radius ?? 2.5) * scaleMe
      const height = (cfg.mech.height ?? 9) * scaleMe
      const muzzleZ = z + (stats.muzzle_height ?? 7)
      mx = my = 0
      jump = boost = false

      if (obs.offer) {
        let pick = 0, bestRank = 1e9
        for (let i = 0; i < obs.offer.choices.length; i++) {
          const r = UPGRADE_RANK.indexOf(obs.offer.choices[i]!.id)
          const rr = r < 0 ? 500 : r
          if (rr < bestRank) {
            bestRank = rr
            pick = i
          }
        }
        a.pick = pick
      }

      for (const e of obs.events) {
        if (e.type === "damaged" && e.bearing != null) {
          lookYaw = e.bearing
          lookUntil = t + 2.5
          if (e.by != null && e.by < 100) {
            attackerId = e.by
            attackedT = t
          }
        }
      }
      for (const s of obs.sounds) {
        if (s.kind !== "gun" && s.kind !== "laser" && s.kind !== "lightning") continue
        const d = s.dist === "near" ? 45 : s.dist === "mid" ? 110 : 220
        soundX = x + Math.cos(s.bearing) * d
        soundY = y + Math.sin(s.bearing) * d
        soundT = t
      }

      // ---- perception: engagement decision per sighting episode
      let enemy: Actor | null = null
      let enemyScore = Infinity
      let npc: Actor | null = null
      let npcD = Infinity
      for (const m of obs.mechs) {
        const d = Math.hypot(m.pos[0] - x, m.pos[1] - y)
        if (m.kind === "npc") {
          if (d < npcD) {
            npcD = d
            npc = m
          }
          continue
        }
        if (m.id < 0 || m.id >= nMech) continue
        if (t - seenT[m.id]! > 5) decision[m.id] = 0
        seenT[m.id] = t
        const hitUs = m.id === attackerId && t - attackedT < 6
        if (decision[m.id] === 2 && (d < 0.7 * decDist[m.id]! || t - decT[m.id]! > 10)) decision[m.id] = 0
        if (decision[m.id] === 0) {
          const p = d < 45 ? 1 : d < 100 ? K.engageMidP * K.engageMul * 0.6 : d < 150 ? K.engageFarP * K.engageMul : K.engageFarP * K.engageMul * 0.85
          decision[m.id] = rng.next() < p ? 1 : 2
          decDist[m.id] = d
          decT[m.id] = t
        }
        if (hitUs || d < 45) decision[m.id] = 1
        if (decision[m.id] !== 1) continue
        let score = d
        if (m.id === targetId) score -= 15
        if (hitUs) score -= 25
        if (score < enemyScore) {
          enemyScore = score
          enemy = m
        }
      }
      const enemyD = enemy ? Math.hypot(enemy.pos[0] - x, enemy.pos[1] - y) : Infinity
      if (enemy) {
        if (enemy.id !== targetId || t - lastSeenT > 1.0) {
          acquiredT = t
          duel = rng.next() < K.duelP
          push = duel && rng.next() < 3 * K.chaseP
        }
        targetId = enemy.id
        lastSeenT = t
        lastX = enemy.pos[0]
        lastY = enemy.pos[1]
        lastZ = enemy.pos[2]
        chasing = false
      } else if (targetId >= 0 && !chasing && t - lastSeenT > 0.15 && t - lastSeenT < 0.4) {
        // just lost the target: decide once whether to go after it
        chasing = rng.next() < K.chaseP
        if (!chasing) targetId = -1
      }

      // ---- zone
      const zn = obs.zone
      const dNext = Math.hypot(zn.next_center[0] - x, zn.next_center[1] - y)
      const dCur = Math.hypot(zn.center[0] - x, zn.center[1] - y)
      const outsideNext = dNext > zn.next_radius * K.zoneIn + 8
      const mustRotate = !me.in_zone || dCur > zn.radius - 20 || (outsideNext && t >= zn.shrink_start - K.zoneLeadS)

      const w0 = me.weapons[0]
      const w1 = me.weapons[1]
      const fire: [boolean, boolean] = [false, false]
      let haveAim = false

      const aimAt = (tx: number, ty: number, tz: number, vx: number, vy: number, vz: number, speed: number, fromZ: number) => {
        const dx = tx - x, dy = ty - y, dz = tz - fromZ
        let tt = 0
        if (speed > 0) {
          const A = vx * vx + vy * vy + vz * vz - speed * speed
          const B = 2 * (dx * vx + dy * vy + dz * vz)
          const C = dx * dx + dy * dy + dz * dz
          const disc = B * B - 4 * A * C
          if (disc >= 0 && Math.abs(A) > 1e-6) {
            const t1 = (-B - Math.sqrt(disc)) / (2 * A)
            const t2 = (-B + Math.sqrt(disc)) / (2 * A)
            tt = t1 > 0 && (t1 < t2 || t2 <= 0) ? t1 : t2 > 0 ? t2 : 0
          }
          tt += dt * 0.5
        } else tt = dt * 0.5
        tt *= K.lead
        const ax = dx + vx * tt, ay = dy + vy * tt, az = dz + vz * tt * 0.5
        aimDist = Math.hypot(ax, ay)
        aimYaw = Math.atan2(ay, ax)
        aimPitch = Math.atan2(az, aimDist)
        haveAim = true
      }
      const onTarget = (r: number, halfH: number) => {
        const ey = Math.abs(wrap(aimYaw - me.aim[0]))
        const ep = Math.abs(aimPitch - me.aim[1])
        const d = Math.max(aimDist, 1)
        return ey < K.fireTolDeg * DEG + Math.atan2(r * K.fireRad, d) && ep < K.fireTolDeg * DEG + Math.atan2(halfH * K.fireRad, d)
      }
      const goTo = (gx: number, gy: number, gz: number, speed: number) => {
        const d = Math.hypot(gx - x, gy - y)
        if (d < 1.5) return
        let done = false
        if (nav && follower) {
          if (d < 60 && nav.walkClear(x, y, z, gx, gy, gz, radius)) {
            mx = ((gx - x) / d) * speed
            my = ((gy - y) / d) * speed
            done = true
          } else {
            const moved = Math.hypot(gx - pathGX, gy - pathGY)
            if (!path || t - pathT > 3 || moved > Math.max(8, d * 0.15)) {
              path = nav.plan(x, y, z, gx, gy, gz, { radius, height, allowJet: false, energy: me.energy, maxExpansions: 12000 }, path ?? undefined)
              pathGX = gx
              pathGY = gy
              pathT = t
            }
            if (path && path.n > 0) {
              nav.steer(follower, path, x, y, z, me.vel[0], me.vel[1], me.vel[2], me.grounded, me.energy, steer)
              if (steer.mx !== 0 || steer.my !== 0 || steer.boost || steer.jump) {
                mx = steer.mx * speed
                my = steer.my * speed
                if (steer.jump) jump = true
                if (steer.boost) boost = true
                done = true
              }
            }
          }
        }
        if (!done) {
          mx = ((gx - x) / d) * speed
          my = ((gy - y) / d) * speed
        }
      }

      /** a point close by that no visible mech has a line to (its eye to our centre and top), reachable in a straight line */
      const findDuck = (o: Observation): boolean => {
        if (!world) return false
        for (const r of [8, 15, 24, 36]) {
          const base = rng.range(0, TAU)
          for (let k = 0; k < 16; k++) {
            const ang = base + (k * TAU) / 16
            const qx = x + r * Math.cos(ang), qy = y + r * Math.sin(ang)
            const qz = world.groundZ(qx, qy)
            if (Math.abs(qz - z) > 3 || world.solid(qx, qy, qz + 2) || world.solid(qx, qy, qz + height - 0.5)) continue
            if (nav && !nav.walkClear(x, y, z, qx, qy, qz, radius)) continue
            let hidden = true
            for (const m of o.mechs) {
              if (m.kind !== "mech") continue
              const ez = m.pos[2] + 8 * (1 + 0.05 * (m.cubes ?? 0))
              if (world.segClear(m.pos[0], m.pos[1], ez, qx, qy, qz + 0.5 * height) || world.segClear(m.pos[0], m.pos[1], ez, qx, qy, qz + height)) {
                hidden = false
                break
              }
            }
            if (!hidden) continue
            duckX = qx
            duckY = qy
            duckZ = qz
            return true
          }
        }
        return false
      }

      const idleMove = (combat: boolean): void => {
        // ---------------------------------------------------------------- idle
        let gx = 0, gy = 0, gz = z
        let haveGoal = false
        let speed = K.idleSpeed
        let urgent = false
        if (t < duckUntil && !(mustRotate && !me.in_zone)) {
          // hiding behind the wall we ducked to until regenerated
          if (me.hp > me.max_hp * 0.9) duckUntil = t
          gx = duckX
          gy = duckY
          gz = duckZ
          if (Math.hypot(gx - x, gy - y) > 2) goTo(gx, gy, gz, 1)
          if (me.energy > 20 && Math.hypot(gx - x, gy - y) > 8 && t - attackedT < 3) boost = true
          if (!haveAim) {
            aimYaw = t < lookUntil ? lookYaw : me.aim[0] + spin * K.scanRate * dt * 1.5
            aimPitch = 0
          }
          return
        }
        if (mustRotate && !me.in_zone) {
          gx = zn.next_center[0]
          gy = zn.next_center[1]
          haveGoal = true
          urgent = true
          speed = 1
        } else if (chasing && t - lastSeenT < 8) {
          gx = lastX
          gy = lastY
          gz = lastZ
          haveGoal = Math.hypot(gx - x, gy - y) > 8
          speed = 1
          if (!haveGoal) chasing = false
        } else if (mustRotate) {
          const want = zn.next_radius * K.zoneIn
          gx = zn.next_center[0] + ((x - zn.next_center[0]) / (dNext || 1)) * want
          gy = zn.next_center[1] + ((y - zn.next_center[1]) / (dNext || 1)) * want
          haveGoal = true
          speed = 1
        } else chasing = false
        // loot: cubes, and a second weapon while the slot is empty
        if (!urgent) {
          let bd = K.cubeRange
          for (const c of obs.cubes) {
            const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
            if (d < bd && Math.abs(c.pos[2] - z) < 6) {
              bd = d
              gx = c.pos[0]
              gy = c.pos[1]
              gz = c.pos[2]
              haveGoal = true
              speed = 1
            }
          }
          if (!w1) {
            let bw = K.lootRange
            for (const p of obs.pickups) {
              const wgt = p.kind === "laser" ? K.wLaser : p.kind === "lightning" ? K.wLightning : p.kind === "mortar" ? K.wMortar : 0
              if (wgt <= 0) continue
              const d = Math.hypot(p.pos[0] - x, p.pos[1] - y) / Math.min(1.6, Math.max(0.3, wgt))
              if (d < bw && Math.abs(p.pos[2] - z) < 5) {
                bw = d
                gx = p.pos[0]
                gy = p.pos[1]
                gz = p.pos[2]
                haveGoal = true
                speed = 1
              }
            }
          }
        }
        // farm crates / NPCs
        let shot = false
        if (!combat && !urgent && K.farm > 0 && w0?.kind === "gun" && (w0.reload ?? 0) <= 0 && me.hp > me.max_hp * 0.5) {
          if (t >= farmUntil) {
            farming = rng.next() < K.farm
            farmUntil = t + rng.range(4, 9)
          }
          if (farming) {
            let tp: number[] | null = null
            let tv: number[] | null = null
            let th = 1.2, tr = 1.4, td = 75
            for (const c of obs.crates) {
              const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
              if (d < td) {
                td = d
                tp = c.pos
              }
            }
            if (K.farmNpc > 0 && npc && npcD < 60 && npcD < td + 10) {
              td = npcD
              tp = npc.pos
              tv = npc.vel
              th = 1.75
              tr = 1.8
            }
            if (tp && (!world || world.segClear(x, y, muzzleZ, tp[0]!, tp[1]!, tp[2]! + th))) {
              aimAt(tp[0]!, tp[1]!, tp[2]! + th, tv ? tv[0]! : 0, tv ? tv[1]! : 0, 0, w0.stats.speed ?? 252, muzzleZ)
              if (onTarget(tr, th)) fire[0] = true
              shot = true
              if (!haveGoal && td > 30) {
                gx = tp[0]!
                gy = tp[1]!
                gz = tp[2]!
                haveGoal = true
              }
            }
          }
        }
        // legs and rests
        if (!haveGoal && !shot) {
          if (t >= restUntil && (t >= legUntil || Math.hypot(legX - x, legY - y) < 6)) {
            if (legUntil > 0 && K.restFrac > 0 && t >= restUntil) {
              // the leg just ended: rest in proportion to the time it took
              const walked = Math.max(2, t - legStart)
              restUntil = t + ((walked * K.restFrac) / Math.max(0.05, 1 - K.restFrac)) * rng.range(0.5, 1.5)
              legUntil = -1
            }
            if (t >= restUntil) {
              let ang: number
              const u = rng.next()
              if (u < K.soundP && t - soundT < 10) ang = Math.atan2(soundY - y, soundX - x) + rng.range(-0.3, 0.3)
              else if (u < K.soundP + K.zonePull) ang = Math.atan2(zn.next_center[1] - y, zn.next_center[0] - x) + rng.range(-0.7, 0.7)
              else ang = rng.range(0, TAU)
              const len = rng.range(K.legMin, K.legMax)
              legX = x + Math.cos(ang) * len
              legY = y + Math.sin(ang) * len
              const dc = Math.hypot(legX - zn.next_center[0], legY - zn.next_center[1])
              const lim = zn.next_radius * 0.85
              if (dc > lim && dc > dNext) {
                // never walk further out of the next circle
                legX = zn.next_center[0] + ((legX - zn.next_center[0]) / dc) * Math.min(lim, dNext)
                legY = zn.next_center[1] + ((legY - zn.next_center[1]) / dc) * Math.min(lim, dNext)
              }
              legStart = t
              legUntil = t + len / 9 + 6
            }
          }
          if (t >= restUntil && legUntil > 0) {
            gx = legX
            gy = legY
            gz = world ? world.groundZ(gx, gy) : z
            haveGoal = true
          }
        }
        if (haveGoal) goTo(gx, gy, gz, speed)
        if (urgent && me.energy > 15 && (mx !== 0 || my !== 0)) boost = true
        if (!haveAim) {
          if (t < lookUntil) aimYaw = lookYaw
          else if (mx || my) aimYaw = Math.atan2(my, mx) + Math.sin(t * K.scanRate + scanPhase) * 1.2
          else aimYaw = me.aim[0] + spin * K.scanRate * dt * 1.5
          aimPitch = 0
        }
        if (!combat && w0?.kind === "gun" && !fire[0] && (w0.ammo ?? 12) < (w0.stats.mag ?? 12) * 0.5 && (w0.reload ?? 0) <= 0) a.reload = true
      }

      let inCombat = false
      if (enemy) {
        // ---------------------------------------------------------------- combat
        inCombat = true
        const scale = 1 + 0.05 * (enemy.cubes ?? 0)
        const er = 2.5 * scale
        const eh = 4.5 * scale
        const ecx = enemy.pos[0], ecy = enemy.pos[1]
        const ecz = enemy.pos[2] + eh
        const clear = world ? world.segClear(x, y, muzzleZ, ecx, ecy, ecz) : true
        const reacted = t - acquiredT >= K.reactionS
        const k = Math.exp(-dt / Math.max(0.05, K.aimTau))
        const sd = K.aimSigmaDeg * K.sigmaMul * DEG * Math.sqrt(1 - k * k)
        noiseYaw = noiseYaw * k + rng.gauss() * sd
        noisePitch = noisePitch * k + rng.gauss() * sd * 0.5
        const second = w1 && w1.kind !== "gun" ? w1.kind : null
        const gunSpeed = w0?.kind === "gun" ? (w0.stats.speed ?? 252) : 252
        const laserCharging = second === "laser" && (w1!.charge ?? 0) > 0
        const laserReady = second === "laser" && w1!.cooldown <= 0.05 && enemyD < (w1!.stats.range ?? 280) && clear
        aimAt(ecx, ecy, ecz, enemy.vel[0], enemy.vel[1], enemy.vel[2], laserCharging ? 0 : gunSpeed, muzzleZ)
        aimYaw += noiseYaw
        aimPitch += noisePitch
        const on = onTarget(er, eh)
        if (reacted) {
          if (w0?.kind === "gun" && clear && on && enemyD < Math.min(w0.stats.range ?? 230, K.gunMaxDist) && (w0.reload ?? 0) <= 0) fire[0] = true
          if (second === "lightning") {
            const cone = (w1!.stats.cone_deg ?? 30) * DEG * 0.4
            if (clear && enemyD < (w1!.stats.range ?? 45) && Math.abs(wrap(aimYaw - me.aim[0])) < cone && me.energy > 6) fire[1] = true
          } else if (second === "laser") {
            const full = (w1!.stats.charge ?? 0.75) * K.laserCharge
            const ch = w1!.charge ?? 0
            if (laserReady || laserCharging) fire[1] = !(ch >= full * 0.97 && on)
          }
        }
        if (t >= strafeUntil) {
          strafeSign = -strafeSign
          strafeUntil = t + rng.range(K.strafeMin, K.strafeMax)
          if (K.combatStill > 0 && rng.next() < K.combatStill * 1.3) stillUntil = t + rng.range(1.0, 2.6)
        }
        const ex = (ecx - x) / (enemyD || 1)
        const ey = (ecy - y) / (enemyD || 1)
        let want = K.prefDist
        if (second === "lightning") want = Math.min(want, (w1!.stats.range ?? 45) * 0.8)
        const low = K.retreatHp > 0 && me.hp < me.max_hp * K.retreatHp
        const hpF = me.hp / Math.max(1, me.max_hp)
        const underFire = t - attackedT < 2.5
        if (t >= duckUntil && K.duckP > 0 && hpF < K.duckHp && t - attackedT < 1 && t - duckDecidedT > 12) {
          duckDecidedT = t
          if (rng.next() < K.duckP && findDuck(obs)) duckUntil = t + 25
        }
        if (t < duckUntil && !(clear && enemyD < 40)) idleMove(true)
        else if (!clear) {
          if (push && enemyD < 120) goTo(ecx, ecy, enemy.pos[2], 1)
          else idleMove(true)
        } else if (!duel && !underFire) idleMove(true)
        else if (t < stillUntil && !underFire) mx = my = 0
        else {
          let rad = enemyD > want + K.band ? 1 : enemyD < want - K.band ? -1 : 0
          let radSpeed = K.radial
          if (enemyD > K.gunMaxDist * 0.95 && duel) radSpeed = 1
          if (low) {
            rad = -1
            radSpeed = 1
          }
          const tang = K.strafeSpeed * strafeSign
          mx = ex * rad * radSpeed - ey * tang
          my = ey * rad * radSpeed + ex * tang
          if (low) boost = me.energy > 20
        }
        if (mustRotate) {
          const zx = (zn.next_center[0] - x) / (dNext || 1)
          const zy = (zn.next_center[1] - y) / (dNext || 1)
          mx = mx * 0.5 + zx
          my = my * 0.5 + zy
          if (!me.in_zone) boost = me.energy > 5
        }
        if (K.jumpCombat > 0 && t >= nextJump && me.grounded) {
          jump = true
          nextJump = t + rng.range(K.jumpCombat * 0.6, K.jumpCombat * 1.4)
        }
      } else idleMove(false)

      // ---- boost bursts
      if (K.boostDuty > 0 && (mx !== 0 || my !== 0)) {
        if (t >= nextBoost && me.energy > 45) {
          boostUntil = t + 1.5
          nextBoost = t + (1.5 / K.boostDuty) * rng.range(0.7, 1.3)
        }
        if (t < boostUntil && me.energy > 12 && me.grounded) boost = true
      }

      // ---- pickups in reach
      if (!w1) {
        const reach = cfg.loot.pickup_radius
        for (const p of obs.pickups) {
          const wgt = p.kind === "laser" ? K.wLaser : p.kind === "lightning" ? K.wLightning : p.kind === "mortar" ? K.wMortar : 0
          if (wgt <= 0) continue
          if (Math.hypot(p.pos[0] - x, p.pos[1] - y) < reach && Math.abs(p.pos[2] - z) < 4) {
            a.take = p.id
            break
          }
        }
      }

      // ---- stuck handling
      const moved = Math.hypot(x - px, y - py)
      px = x
      py = y
      const cmd = Math.hypot(mx, my)
      if (cmd > 0.3 && moved < 0.2 && !inCombat) stuckT += dt
      else stuckT = Math.max(0, stuckT - dt * 2)
      if (stuckT > 0.8 && t > detourUntil) {
        detourUntil = t + 1.6
        detourSign = rng.next() < 0.5 ? 1 : -1
        stuckT = 0
        path = null
        legUntil = Math.min(legUntil, t + 3)
      }
      if (t < detourUntil && cmd > 0) {
        const c = Math.cos(0.9 * detourSign), s = Math.sin(0.9 * detourSign)
        const nx = mx * c - my * s, ny = mx * s + my * c
        mx = nx
        my = ny
        if (me.grounded) jump = true
      }

      const len = Math.hypot(mx, my)
      if (len > 1) {
        mx /= len
        my /= len
      }
      a.move = [mx, my]
      a.boost = boost
      a.jump = jump
      a.aim = [wrap(aimYaw), Math.max(-0.7, Math.min(1.3, aimPitch))]
      a.fire = fire
      return a
    }
    return { name: `fin-${preset}`, act }
  }
}

/** a naive camper for reference: never moves except for the zone, shoots back at whoever is within 45 m or hits it */
export const standStillBot: BotFactory = (ctx) => makeFinalist("kanyaraasi")({ ...ctx, params: { restFrac: 0.999, legMin: 1, legMax: 2, lootRange: 0, cubeRange: 0, farm: 0, engageFarP: 0, engageMidP: 0.3, soundP: 0, zonePull: 0, ...ctx.params } })
