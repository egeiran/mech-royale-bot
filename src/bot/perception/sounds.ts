/**
 * SoundMap: folds obs.sounds (kind, noisy world bearing, distance bucket, age) into
 *  - a coarse world-frame heat grid with exponential decay ("where is something going on"),
 *  - a ring buffer of recent sound events with an estimated position,
 *  - per-kind / per-bucket "last heard" times (which weapons are in use nearby).
 * One instance per bot. update() allocates nothing.
 */
import type { Observation } from "../../protocol/mechfight.ts"

export const SOUND_KINDS = ["step", "boost", "reload", "gun", "mortar", "explosion", "laser_charge", "laser", "lightning", "jet", "death", "crate", "npc_gun", "drop"] as const
export const S_STEP = 0
export const S_BOOST = 1
export const S_RELOAD = 2
export const S_GUN = 3
export const S_MORTAR = 4
export const S_EXPLOSION = 5
export const S_LASER_CHARGE = 6
export const S_LASER = 7
export const S_LIGHTNING = 8
export const S_JET = 9
export const S_DEATH = 10
export const S_CRATE = 11
export const S_NPC_GUN = 12
export const S_DROP = 13
const NK = SOUND_KINDS.length

export const D_NEAR = 0
export const D_MID = 1
export const D_FAR = 2

/** default carry ranges (m), protocol section 8; overridden by hello.config.sound.range */
const DEFAULT_RANGE = [40, 90, 60, 320, 420, 420, 140, 380, 160, 90, 600, 220, 200, 600]
/** heat weight per kind: how strongly it suggests "an armed mech is there" */
const HEAT_W = [0.5, 0.6, 0.6, 1, 1, 0.6, 1.2, 1.2, 1.2, 0.6, 0.3, 0.4, 0.3, 0]

export function soundKindIndex(kind: string): number {
  for (let i = 0; i < NK; i++) if (SOUND_KINDS[i] === kind) return i
  return -1
}

export interface SoundCfg {
  near: number
  mid: number
  bearing_noise_deg: number
  range: Record<string, number>
}

export interface Sector {
  /** cell centre (m) */
  x: number
  y: number
  heat: number
}

const EV_CAP = 64

export class SoundMap {
  readonly minX: number
  readonly minY: number
  readonly cell: number
  readonly nx: number
  readonly ny: number
  /** heat per cell, row-major (j * nx + i); decays with halfLife */
  readonly heat: Float32Array
  halfLife: number

  /** ring buffer of recent events */
  readonly evKind = new Int8Array(EV_CAP)
  readonly evDist = new Int8Array(EV_CAP)
  readonly evT = new Float32Array(EV_CAP)
  readonly evBearing = new Float32Array(EV_CAP)
  /** estimated source position (middle of the distance bucket along the bearing) */
  readonly evX = new Float32Array(EV_CAP)
  readonly evY = new Float32Array(EV_CAP)
  evHead = 0
  evCount = 0

  /** obs.t a kind was last heard in a bucket: lastHeard[kind * 3 + bucket], -1e9 = never */
  readonly lastHeard = new Float64Array(NK * 3).fill(-1e9)
  /** totals per kind since the start */
  readonly count = new Int32Array(NK)

  private near = 60
  private mid = 160
  private sigma = (7 * Math.PI) / 180
  private range = new Float32Array(DEFAULT_RANGE)
  private t = -1

  constructor(cfg?: SoundCfg | null, minX = -513, minY = -334, maxX = 557, maxY = 390, cell = 32, halfLife = 4) {
    this.minX = minX
    this.minY = minY
    this.cell = cell
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell))
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell))
    this.heat = new Float32Array(this.nx * this.ny)
    this.halfLife = halfLife
    if (cfg) {
      this.near = cfg.near
      this.mid = cfg.mid
      this.sigma = (cfg.bearing_noise_deg * Math.PI) / 180
      for (let i = 0; i < NK; i++) {
        const r = cfg.range[SOUND_KINDS[i]]
        if (typeof r === "number") this.range[i] = r
      }
    }
  }

  /** fold this observation's sounds in; call once per decision */
  update(obs: Observation): void {
    const t = obs.t
    if (this.t >= 0) {
      const dt = t - this.t
      if (dt > 0) {
        const k = Math.pow(0.5, dt / this.halfLife)
        const h = this.heat
        for (let i = 0; i < h.length; i++) h[i] *= k
      }
    }
    this.t = t
    const sx = obs.self.pos[0], sy = obs.self.pos[1]
    const hearing = obs.self.stats.hearing ?? 1
    const sounds = obs.sounds
    for (let i = 0; i < sounds.length; i++) {
      const s = sounds[i]
      const k = soundKindIndex(s.kind)
      if (k < 0) continue
      const b = s.dist === "near" ? D_NEAR : s.dist === "mid" ? D_MID : D_FAR
      const r0 = b === D_NEAR ? 0 : b === D_MID ? this.near : this.mid
      let r1 = b === D_NEAR ? this.near : b === D_MID ? this.mid : this.range[k] * hearing
      if (r1 < r0 + 10) r1 = r0 + 10
      const ts = t - s.age
      this.lastHeard[k * 3 + b] = ts
      this.count[k]++
      const rm = 0.5 * (r0 + r1)
      const e = this.evHead
      this.evKind[e] = k
      this.evDist[e] = b
      this.evT[e] = ts
      this.evBearing[e] = s.bearing
      this.evX[e] = sx + rm * Math.cos(s.bearing)
      this.evY[e] = sy + rm * Math.sin(s.bearing)
      this.evHead = (e + 1) % EV_CAP
      if (this.evCount < EV_CAP) this.evCount++
      const w = HEAT_W[k]
      if (w > 0) this.splat(sx, sy, s.bearing, r0, r1, w)
    }
  }

  /** spread weight w over the annular sector (bearing +- 2 sigma, r0..r1), Gaussian in bearing */
  private splat(sx: number, sy: number, bearing: number, r0: number, r1: number, w: number): void {
    const NA = 7
    const nr = Math.max(1, Math.round((r1 - r0) / this.cell))
    // weights of the 7 angular samples at -2..2 sigma: exp(-0.5 u^2), u = -2,-1.33,..,2 (sum 3.6943)
    const per = w / (nr * 3.6943)
    for (let a = 0; a < NA; a++) {
      const u = -2 + (4 * a) / (NA - 1)
      const g = Math.exp(-0.5 * u * u) * per
      const ang = bearing + u * this.sigma
      const c = Math.cos(ang), s = Math.sin(ang)
      for (let k = 0; k < nr; k++) {
        const r = r0 + ((k + 0.5) * (r1 - r0)) / nr
        const i = Math.floor((sx + r * c - this.minX) / this.cell)
        const j = Math.floor((sy + r * s - this.minY) / this.cell)
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
        this.heat[j * this.nx + i] += g
      }
    }
  }

  /** heat of the cell containing (x, y); 0 outside the grid */
  heatAt(x: number, y: number): number {
    const i = Math.floor((x - this.minX) / this.cell)
    const j = Math.floor((y - this.minY) / this.cell)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return 0
    return this.heat[j * this.nx + i]
  }

  /**
   * The `out.length` hottest cells in descending order (suspected enemy sectors). Returns how many have
   * heat >= minHeat; the rest of `out` is zeroed.
   */
  hottest(out: Sector[], minHeat = 0.05): number {
    const n = out.length
    for (let k = 0; k < n; k++) {
      out[k].heat = 0
      out[k].x = 0
      out[k].y = 0
    }
    const h = this.heat
    let found = 0
    for (let c = 0; c < h.length; c++) {
      const v = h[c]
      if (v < minHeat || (found === n && v <= out[n - 1].heat)) continue
      // insertion into the sorted prefix
      let p = found < n ? found : n - 1
      while (p > 0 && out[p - 1].heat < v) {
        out[p].heat = out[p - 1].heat
        out[p].x = out[p - 1].x
        out[p].y = out[p - 1].y
        p--
      }
      out[p].heat = v
      out[p].x = this.minX + ((c % this.nx) + 0.5) * this.cell
      out[p].y = this.minY + (Math.floor(c / this.nx) + 0.5) * this.cell
      if (found < n) found++
    }
    return found
  }

  /** seconds since `kind` (S_* index) was last heard at distance bucket <= maxBucket; Infinity if never */
  since(kind: number, maxBucket = D_FAR): number {
    let best = -1e9
    for (let b = 0; b <= maxBucket; b++) {
      const v = this.lastHeard[kind * 3 + b]
      if (v > best) best = v
    }
    return best < -1e8 ? Infinity : this.t - best
  }

  /**
   * W_* style bit mask (1 gun, 2 mortar, 4 laser, 8 lightning - same bits as tracker.ts) of the weapon kinds
   * heard within `window` seconds at distance bucket <= maxBucket (D_NEAR < 60 m, D_MID < 160 m).
   * laser_charge counts as laser; explosion counts as mortar.
   */
  weaponsHeard(maxBucket = D_NEAR, window = 3): number {
    let m = 0
    if (this.since(S_GUN, maxBucket) <= window) m |= 1
    if (this.since(S_MORTAR, maxBucket) <= window || this.since(S_EXPLOSION, maxBucket) <= window) m |= 2
    if (this.since(S_LASER, maxBucket) <= window || this.since(S_LASER_CHARGE, maxBucket) <= window) m |= 4
    if (this.since(S_LIGHTNING, maxBucket) <= window) m |= 8
    return m
  }

  /** true when a mech is moving close by (step / boost / jet / reload heard "near") within `window` s */
  movementNear(window = 1.5): boolean {
    return this.since(S_STEP, D_NEAR) <= window || this.since(S_BOOST, D_NEAR) <= window || this.since(S_JET, D_NEAR) <= window || this.since(S_RELOAD, D_NEAR) <= window
  }
}

export function newSectors(n: number): Sector[] {
  const out: Sector[] = []
  for (let i = 0; i < n; i++) out.push({ x: 0, y: 0, heat: 0 })
  return out
}
