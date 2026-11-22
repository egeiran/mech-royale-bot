/**
 * JIT warm-up: replays synthetic observations (derived from the hello) through THROW-AWAY brain instances, so
 * the real bot's state stays untouched while every hot path (perception, nav, fight, loot, hide) gets compiled
 * before `ready`. Uses the real bot only to borrow its World.
 */
import type { Bot, BotContext, Hello, Observation, World } from "../../contracts.ts"
import type { ActorObs } from "../../protocol/mechfight.ts"
import { makeRng } from "../../util/rng.ts"
import { createBrain, type BrainBot } from "./index.ts"
import { getExposure } from "../cover/exposure.ts"
import { getRoofs } from "./fortress.ts"

function selfWeapons(cfg: Hello["config"], second: "lightning" | "laser" | null): Observation["self"]["weapons"] {
  const g = cfg.weapons.gun
  const w0 = { kind: "gun" as const, cooldown: 0, ammo: g.mag ?? 12, reload: 0, stats: { ...g } }
  if (!second) return [w0, null]
  const s = cfg.weapons[second]
  return [w0, { kind: second, cooldown: 0, charge: 0, stats: { ...s } }]
}

export function warmup(bot: Bot, hello: Hello, decisions = 240): void {
  const world = (bot as Partial<BrainBot>).bb?.world as World | undefined
  if (!world) return
  // static exposure field (~40 ms to decode the first time): fetch it before `ready` so no mid-match decision pays
  // for it (squad snipePost / kiteTrain use it; the FFA ghost builds its cover module from it)
  getExposure(world)
  // roof fortress catalogue (~2 ms on top of the field)
  const roofs = getRoofs(world)
  const cfg = hello.config
  const zc = cfg.zone.start_center
  // a 4th run standing on a roof when the real bot plays the roof fortress (its fort* params, triggered at once)
  const P = (bot as Partial<BrainBot>).bb?.P as Record<string, number> | undefined
  const fortOn = !!P && (P.fortOnUs! > 0 || P.fortT! < 999 || P.fortHp! > 0 || P.fortKills! > 0)
  let roofK = -1
  if (fortOn) {
    for (let k = 0; k < roofs.n; k++) {
      if (roofs.h[k]! < 15 || Math.hypot(roofs.x[k]! - zc[0], roofs.y[k]! - zc[1]) > 300) continue
      if (roofK < 0 || roofs.edge[k]! > roofs.edge[roofK]!) roofK = k
    }
  }
  for (let variant = 0; variant < (roofK >= 0 ? 4 : 3); variant++) {
    let params: Record<string, number> = { forceMode: variant === 0 ? 2 : variant === 1 ? 1 : 0 }
    if (variant === 3 && P) {
      params = {}
      for (const key in P) if (key.startsWith("fort")) params[key] = P[key]!
      Object.assign(params, { forceMode: 1, fortT: 1, fortFrom: 0, fortSafeR: 0, fortMaxDist: 1e4, fortZoneMargin: -1e4, fortMinH: 10, fortEdge: 6 })
    }
    const ctx: BotContext = {
      hello,
      world,
      params,
      rng: makeRng(1234 + variant),
      realtime: false,
      log: () => {},
    }
    const b = createBrain(ctx)
    let x = variant === 3 ? roofs.x[roofK]! : zc[0] + 60 * variant - 40
    let y = variant === 3 ? roofs.y[roofK]! : zc[1] + 35 * variant
    let z = world.floorZ(x, y, 1e3, 0)
    let yaw = 0
    const stats: Record<string, number> = { ...cfg.mech }
    const enemy: ActorObs = { id: (hello.slot + 1) % 16, kind: "mech", pos: [x + 40, y + 10, z], vel: [0, 6, 0], aim: [Math.PI, 0], hp: 900, max_hp: 1400, cubes: 2, weapons: ["gun", "laser"], charging: false }
    const npc: ActorObs = { id: 104, kind: "npc", pos: [x - 30, y - 20, z], vel: [1, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 }
    for (let k = 0; k < decisions; k++) {
      const t = k * 0.1
      const phase = Math.floor((k * 4) / decisions)
      const withEnemy = phase === 1 || phase === 3
      const withLoot = phase >= 2
      enemy.pos[0] = x + 45 * Math.cos(t * 0.3)
      enemy.pos[1] = y + 45 * Math.sin(t * 0.3)
      enemy.pos[2] = world.groundZ(enemy.pos[0], enemy.pos[1])
      enemy.aim[0] = Math.atan2(y - enemy.pos[1], x - enemy.pos[0])
      enemy.charging = k % 30 < 6
      const obs: Observation = {
        type: "obs",
        tick: k * 2,
        t,
        alive: 16,
        self: {
          id: hello.slot, pos: [x, y, z], vel: [0, 0, 0], aim: [yaw, 0], hp: phase === 3 ? 500 : 1400, max_hp: 1400, energy: 80, max_energy: 100,
          grounded: true, cubes: 0, upgrades: [], weapons: selfWeapons(cfg, phase === 0 ? null : variant === 1 ? "lightning" : "laser"), in_zone: true, stats,
        },
        mechs: withEnemy ? [enemy, npc] : withLoot ? [npc] : [],
        projectiles: withEnemy ? [{ id: 300 + k, kind: "gun", pos: [enemy.pos[0], enemy.pos[1], enemy.pos[2] + 7], vel: [(x - enemy.pos[0]) * 5, (y - enemy.pos[1]) * 5, 0] }] : [],
        crates: withLoot ? [{ id: 1001, pos: [x + 25, y - 30, world.groundZ(x + 25, y - 30)], hp: 300 }] : [],
        cubes: withLoot ? [{ id: 5001, pos: [x - 20, y + 30, world.groundZ(x - 20, y + 30)] }] : [],
        pickups: withLoot ? [{ id: 8001, kind: "lightning", pos: [x + 50, y + 40, world.groundZ(x + 50, y + 40)] }] : [],
        sounds: k % 7 === 0 ? [{ kind: "gun", bearing: 1, dist: "mid", age: 0.05 }] : [],
        beams: [],
        events: withEnemy && k % 5 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: enemy.aim[0] + Math.PI, by: enemy.id }] : [],
        zone: { center: [zc[0], zc[1]], radius: cfg.zone.start_radius, next_center: [zc[0], zc[1]], next_radius: cfg.zone.phases[0]?.radius ?? 380, shrink_start: 60, shrink_end: 110, dps: 20 },
        offer: k === 50 ? { id: 1, expires: t + 5, choices: [{ id: "plating", name: "", desc: "" }, { id: "armor", name: "", desc: "" }, { id: "gun_rate", name: "", desc: "" }] } : null,
        drops: [],
      }
      const a = b.act(obs)
      // crude kinematics so paths and steering make progress
      const m = a.move
      if (m) {
        const nx = x + m[0] * 1.1, ny = y + m[1] * 1.1
        const nz = world.floorZ(nx, ny, z + 1.2, 0)
        if (nz <= z + 1.25 && !world.solid(nx, ny, nz + 2)) {
          x = nx
          y = ny
          z = nz
        }
      }
      if (a.aim) yaw = a.aim[0]
    }
  }
}
