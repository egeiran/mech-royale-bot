/**
 * Test-only: drive one mech of the project simulator (src/sim physics: stepMech on a Collider) along a nav path.
 * Kept separate from _kinsim.ts so the nav tests still run when src/sim changes shape.
 */
import type { NavPath, NavQuery, Steer, World } from "../../contracts.ts"
import type { FollowResult } from "./_kinsim.ts"
import type { NavEx } from "./index.ts"

export interface SimKit {
  col: unknown
  cfg: any
  Mech: any
  recomputeMech: (cfg: any, m: any, init: boolean) => void
  stepMech: (col: any, m: any, dt: number, tick: number, first: boolean, speedMult: number) => void
}

export async function loadSimKit(world: World): Promise<SimKit | null> {
  try {
    const geom = await import("../../sim/geom.ts")
    const state = await import("../../sim/state.ts")
    const phys = await import("../../sim/physics.ts")
    const cfg = (await import("../../sim/defaultConfig.ts")).default
    if (!geom.Collider || !state.Mech || !state.recomputeMech || !phys.stepMech || !cfg) return null
    return { col: new geom.Collider(world), cfg, Mech: state.Mech, recomputeMech: state.recomputeMech, stepMech: phys.stepMech }
  } catch {
    return null
  }
}

export function simFollow(kit: SimKit, nav: NavEx, sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, cubes: number, allowJet: boolean, trace?: (t: number, m: any, out: Steer, path: NavPath) => void): FollowResult {
  const m = new kit.Mech(0, 1)
  m.cubes = cubes
  kit.recomputeMech(kit.cfg, m, true)
  m.x = sx
  m.y = sy
  m.z = sz
  const st = m.stats as Record<string, number>
  const q: NavQuery & { avoid: object } = { radius: m.radius, height: m.height, allowJet, energy: st.energy!, avoid: {} }
  const fol = nav.newFollower()
  q.avoid = fol
  let path: NavPath | null = nav.plan(m.x, m.y, m.z, gx, gy, gz, q)
  if (!path || !path.complete) return { ok: false, time: 0, cost: 0, replans: 0, x: sx, y: sy, z: sz }
  const cost = path.cost
  const out: Steer = { mx: 0, my: 0, jump: false, boost: false, stuck: false }
  const limit = cost * 3 + 20
  const dt = 0.05
  const regenDelayTicks = Math.round(st.energy_regen_delay! / dt) + 1
  let tick = 0
  let replans = 0
  while (tick * dt < limit) {
    nav.steer(fol, path, m.x, m.y, m.z, m.vx, m.vy, m.vz, m.grounded, m.energy, out)
    if (out.stuck) {
      if (++replans > 8) break
      const np = nav.plan(m.x, m.y, m.z, gx, gy, gz, q, path)
      if (!np) break
      path = np
      nav.steer(fol, path, m.x, m.y, m.z, m.vx, m.vy, m.vz, m.grounded, m.energy, out)
    }
    if (trace) trace(tick * dt, m, out, path)
    m.mx = out.mx
    m.my = out.my
    m.boost = out.boost
    m.jump = out.jump
    for (let k = 0; k < 2; k++) {
      kit.stepMech(kit.col, m, dt, tick, k === 0, 1)
      if (m.energy < st.energy! && tick - m.lastSpendTick > regenDelayTicks) m.energy = Math.min(st.energy!, m.energy + st.energy_regen! * dt)
      tick++
    }
    if (Math.hypot(m.x - gx, m.y - gy) < 1.5 && Math.abs(m.z - gz) < 2 && m.grounded) {
      nav.releasePath(path)
      return { ok: true, time: tick * dt, cost, replans, x: m.x, y: m.y, z: m.z }
    }
  }
  nav.releasePath(path)
  return { ok: false, time: tick * dt, cost, replans, x: m.x, y: m.y, z: m.z }
}
