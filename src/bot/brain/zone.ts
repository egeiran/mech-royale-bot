/**
 * Zone model: the current circle, the circle it shrinks to, and the schedule after that from config.zone.phases
 * (later centres are unknown: they are assumed to stay at next_center, which is the expected value).
 * One instance per bot, no allocation in queries.
 */
import type { Config, ZoneObs } from "../../protocol/mechfight.ts"

export interface XY {
  x: number
  y: number
}

export class ZoneModel {
  cx = 0
  cy = 0
  r = 1e6
  ncx = 0
  ncy = 0
  nr = 1e6
  /** current shrink window */
  t0 = 1e9
  t1 = 1e9
  dps = 0
  t = 0
  /** the server's current radius (r may be inflated by the zone-out variant) */
  trueR = 1e6
  trueCx = 0
  trueCy = 0
  trueNcx = 0
  trueNcy = 0
  trueNr = 1e6
  /** zone-out reference circle (set by inflate) */
  refX = 0
  refY = 0
  refR = 1e6
  /** index into phases of the shrink described by (next, t0, t1); phases.length when all are done */
  phase = 0
  readonly phases: { hold_s: number; shrink_s: number; radius: number; dps: number }[]
  private readonly _c: XY = { x: 0, y: 0 }

  constructor(cfg: Config["zone"] | null | undefined) {
    this.phases = cfg?.phases ?? []
    if (cfg) {
      this.cx = this.ncx = cfg.start_center[0]
      this.cy = this.ncy = cfg.start_center[1]
      this.r = this.nr = cfg.start_radius
    }
  }

  update(z: ZoneObs, t: number): void {
    this.t = t
    this.cx = z.center[0]
    this.cy = z.center[1]
    this.r = z.radius
    this.ncx = z.next_center[0]
    this.ncy = z.next_center[1]
    this.nr = z.next_radius
    this.t0 = z.shrink_start
    this.t1 = z.shrink_end
    this.dps = z.dps
    this.trueR = z.radius
    this.trueCx = z.center[0]
    this.trueCy = z.center[1]
    this.trueNcx = z.next_center[0]
    this.trueNcy = z.next_center[1]
    this.trueNr = z.next_radius
    // which phase: the one whose target radius matches next_radius (closest)
    let best = this.phases.length
    let bd = 1e9
    for (let i = 0; i < this.phases.length; i++) {
      const d = Math.abs(this.phases[i].radius - z.next_radius)
      if (d < bd - 1e-6) {
        bd = d
        best = i
      }
    }
    this.phase = best
  }

  /**
   * zone-out variant: the reference circle is the true one we will be left with (the next circle while a shrink is
   * running, else the current one); pretend the zone is that circle grown by d m, with no shrink pending.
   */
  inflate(d: number): void {
    this.setRef()
    this.cx = this.ncx = this.refX
    this.cy = this.ncy = this.refY
    this.r = this.nr = this.refR + d
  }

  /** zone-out reference circle from the server's circles (no change to the model's own circle) */
  setRef(): void {
    const next = this.t >= this.t0 && this.t < this.t1
    this.refX = next ? this.trueNcx : this.trueCx
    this.refY = next ? this.trueNcy : this.trueCy
    this.refR = next ? this.trueNr : this.trueR
  }

  /** metres inside the server's current circle (negative = outside), whatever inflate() did */
  trueMargin(x: number, y: number): number {
    return this.trueR - Math.hypot(x - this.trueCx, y - this.trueCy)
  }

  /** metres inside the zone-out reference circle (negative = outside) */
  refMargin(x: number, y: number): number {
    return this.refR - Math.hypot(x - this.refX, y - this.refY)
  }

  /** is the current shrink in progress */
  get shrinking(): boolean {
    return this.t >= this.t0 && this.t < this.t1
  }

  /**
   * Circle at time t >= now. Within the known window it is exact; afterwards the config schedule is followed
   * with the centre held at next_center. Writes the centre into out and returns the radius.
   */
  circleAt(t: number, out: XY): number {
    // The observation reports the circle as it is NOW (already partly shrunk when t0 <= now < t1).
    const from = this.t > this.t0 ? this.t : this.t0
    if (t <= from && t < this.t1) {
      out.x = this.cx
      out.y = this.cy
      return this.r
    }
    if (t < this.t1) {
      const f = (t - from) / (this.t1 - from)
      out.x = this.cx + (this.ncx - this.cx) * f
      out.y = this.cy + (this.ncy - this.cy) * f
      return this.r + (this.nr - this.r) * f
    }
    out.x = this.ncx
    out.y = this.ncy
    let r = this.nr
    let ts = this.t1
    for (let i = this.phase + 1; i < this.phases.length; i++) {
      const p = this.phases[i]
      const h = ts + p.hold_s
      if (t <= h) return r
      const e = h + p.shrink_s
      if (t < e) return r + (p.radius - r) * ((t - h) / p.shrink_s)
      r = p.radius
      ts = e
    }
    return r
  }

  radiusAt(t: number): number {
    return this.circleAt(t, this._c)
  }

  /** metres inside the current circle (negative = outside) */
  margin(x: number, y: number): number {
    return this.r - Math.hypot(x - this.cx, y - this.cy)
  }

  /** metres inside the next circle (negative = outside) */
  marginNext(x: number, y: number): number {
    return this.nr - Math.hypot(x - this.ncx, y - this.ncy)
  }

  /** metres inside the circle at time t */
  marginAt(x: number, y: number, t: number): number {
    const r = this.circleAt(t, this._c)
    return r - Math.hypot(x - this._c.x, y - this._c.y)
  }

  /**
   * Seconds from now until the point is outside the circle (0 = already outside, Infinity = safe for the whole
   * `horizon`). Only the known shrink is exact; later phases use the centre assumption above.
   */
  timeUntilOutside(x: number, y: number, horizon = 120): number {
    if (this.margin(x, y) < 0) return 0
    // inside the next circle: safe until the phase after it starts moving
    const step = 2
    let prevT = this.t
    let prevM = this.margin(x, y)
    for (let dt = step; dt <= horizon; dt += step) {
      const tt = this.t + dt
      const m = this.marginAt(x, y, tt)
      if (m < 0) {
        // linear interpolation inside the step
        const f = prevM / (prevM - m)
        return prevT + (tt - prevT) * f - this.t
      }
      prevT = tt
      prevM = m
    }
    return Infinity
  }

  /** damage per second outside the circle at time t (phase dps from config; the current one before t1) */
  dpsAt(t: number): number {
    if (t < this.t1 || this.phases.length === 0) return this.dps
    let ts = this.t1
    let d = this.dps
    for (let i = this.phase + 1; i < this.phases.length; i++) {
      const p = this.phases[i]
      d = p.dps
      ts += p.hold_s + p.shrink_s
      if (t < ts) return d
    }
    return d
  }
}
