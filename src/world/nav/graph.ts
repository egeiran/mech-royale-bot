/**
 * Nav graph over the World raster: a grid of columns (default 2 m), each with 1..n standable surfaces
 * (terrain, prism tops). See README.md for the design.
 */
import type { World } from "../../contracts.ts"

export interface MechNavParams {
  /** base (0 cubes) body; NavQuery carries the current one */
  radius: number
  height: number
  walkSpeed: number
  boostSpeed: number
  gravity: number
  jumpSpeed: number
  /** effective climb rate under jets (max_rise_speed minus one tick of gravity: 10 - 22*0.05) */
  maxRiseSpeed: number
  jetDrain: number
  maxEnergy: number
  stepUp: number
  maxSlopeDeg: number
  /** seconds between steer() calls (one decision = 2 sim ticks) */
  dt: number
  /** nav cell size in metres (integer, >= 1) */
  cell: number
  /** default A* expansion bound */
  maxExpansions: number
  /** weighted A* factor (1 = optimal, more = greedier/faster) */
  heuristicWeight: number
  /** a node is usable when its wall clearance >= radius - clearanceSlack */
  clearanceSlack: number
  /** jet energy model: jetEnergyBase + jetEnergyPerM * max(0, dz - jumpFree); perM = jet_drain / climb rate */
  jetEnergyBase: number
  jetEnergyPerM: number
  /** seconds of path cost charged per unit of jet energy */
  jetEnergyCost: number
  /** highest climb for which jet edges are built */
  maxClimb: number
}

export const DEFAULT_PARAMS: MechNavParams = {
  radius: 2.5,
  height: 9,
  walkSpeed: 11.7,
  boostSpeed: 19.5,
  gravity: 22,
  jumpSpeed: 11,
  maxRiseSpeed: 8.9,
  jetDrain: 15,
  maxEnergy: 100,
  stepUp: 1.2,
  maxSlopeDeg: 50,
  dt: 0.1,
  cell: 2,
  maxExpansions: 50000,
  heuristicWeight: 1.2,
  clearanceSlack: 0,
  jetEnergyBase: 8,
  jetEnergyPerM: 1.7,
  jetEnergyCost: 0.03,
  maxClimb: 64,
}

/** edge types (adjacent `nbrType` and long `xType`) */
export const E_NONE = 0
export const E_WALK = 1
export const E_DROP = 2
export const E_JET = 3

/** node kinds */
export const K_GROUND = 0
export const K_TOP = 1

/** body scale tiers (size = 1 + 0.05 * cubes); clearance is stored once per tier */
export const TIER_SCALE = [1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.6, 2.0]
export const NT = TIER_SCALE.length
/** clearance quantisation: stored value = metres * CLR_Q, 255 = nothing within the scan radius */
export const CLR_Q = 16
const SCAN_R = 7.5

export const DX = [1, 1, 0, -1, -1, -1, 0, 1]
export const DY = [0, 1, 1, 1, 0, -1, -1, -1]

export interface Graph {
  cs: number
  gnx: number
  gny: number
  minX: number
  minY: number
  n: number
  /** nodes of column c (= J*gnx + I) are colStart[c]..colStart[c+1]-1, ascending z */
  colStart: Int32Array
  nz: Float32Array
  nI: Int16Array
  nJ: Int16Array
  kind: Uint8Array
  /** 1 when a prism top is more than 3 m above the terrain under it (a "roof") */
  roof: Uint8Array
  /** free height above the surface at the node centre (Infinity under open sky) */
  head: Float32Array
  /** clearance per tier: clr[tier*n + node] */
  clr: Uint8Array
  /** 8 neighbours per node (-1 = none) and their edge type */
  nbr: Int32Array
  nbrType: Uint8Array
  /** long edges (jets onto / drops off prism rims), CSR by source node */
  xStart: Int32Array
  xTo: Int32Array
  xType: Uint8Array
  xLen: Float32Array
  /** corridor clearance of a long edge at rim height (same units as clr): side walls the body must pass between */
  xClr: Uint8Array
  buildMs: number
}

export function tierFor(scale: number): number {
  for (let t = 0; t < NT; t++) if (TIER_SCALE[t]! >= scale - 1e-3) return t
  return NT - 1
}

export function buildGraph(world: World, p: MechNavParams): Graph {
  const t0 = performance.now()
  const cs = Math.max(1, Math.round(p.cell))
  const nx = world.nx
  const ny = world.ny
  const gnx = Math.ceil(nx / cs)
  const gny = Math.ceil(ny / cs)
  const ncol = gnx * gny
  const spanStart = world.spanStart
  const spanData = world.spanData
  const stepUp = p.stepUp
  const minX = world.minX
  const minY = world.minY

  // ---- nodes
  let cap = ncol
  for (let J = 0; J < gny; J++) {
    const row = J * cs * nx
    for (let I = 0; I < gnx; I++) {
      const c = row + I * cs
      cap += spanStart[c + 1]! - spanStart[c]!
    }
  }
  const colStart = new Int32Array(ncol + 1)
  const nzA = new Float32Array(cap)
  const nIA = new Int16Array(cap)
  const nJA = new Int16Array(cap)
  const kindA = new Uint8Array(cap)
  const roofA = new Uint8Array(cap)
  const headA = new Float32Array(cap)
  let n = 0
  for (let J = 0; J < gny; J++) {
    const y = minY + J * cs + 0.5
    for (let I = 0; I < gnx; I++) {
      const c = J * cs * nx + I * cs
      colStart[J * gnx + I] = n
      const tz = world.groundZ(minX + I * cs + 0.5, y)
      const s0 = spanStart[c]!
      const s1 = spanStart[c + 1]!
      let inside = false
      let ceil = Infinity
      for (let k = s0; k < s1; k++) {
        const b = spanData[2 * k]!
        const t = spanData[2 * k + 1]!
        if (b <= tz && t > tz) inside = true
        else if (b > tz && b < ceil) ceil = b
      }
      if (!inside) {
        nzA[n] = tz
        nIA[n] = I
        nJA[n] = J
        kindA[n] = K_GROUND
        headA[n] = ceil - tz
        n++
      }
      for (let k = s0; k < s1; k++) {
        const t = spanData[2 * k + 1]!
        if (t <= tz) continue
        let h = Infinity
        for (let k2 = s0; k2 < s1; k2++) {
          const b2 = spanData[2 * k2]!
          if (b2 >= t && b2 - t < h) h = b2 - t
        }
        nzA[n] = t
        nIA[n] = I
        nJA[n] = J
        kindA[n] = K_TOP
        roofA[n] = t - tz > 3 ? 1 : 0
        headA[n] = h
        n++
      }
    }
  }
  colStart[ncol] = n
  const nz = nzA.slice(0, n)
  const nI = nIA.slice(0, n)
  const nJ = nJA.slice(0, n)
  const kind = kindA.slice(0, n)
  const roof = roofA.slice(0, n)
  const head = headA.slice(0, n)

  // ---- clearance per tier
  const tierH = new Float64Array(NT)
  for (let t = 0; t < NT; t++) tierH[t] = p.height * TIER_SCALE[t]!
  const R = Math.ceil(SCAN_R)
  const offs: { i: number; j: number; d: number }[] = []
  for (let j = -R; j <= R; j++)
    for (let i = -R; i <= R; i++) {
      const d = Math.hypot(i, j)
      if (d <= SCAN_R) offs.push({ i, j, d })
    }
  offs.sort((a, b) => a.d - b.d)
  const no = offs.length
  const offI = new Int32Array(no)
  const offJ = new Int32Array(no)
  const offQ = new Uint8Array(no)
  for (let o = 0; o < no; o++) {
    offI[o] = offs[o]!.i
    offJ[o] = offs[o]!.j
    // distance is centre-to-centre; the blocking cell extends ~0.5 m toward us
    offQ[o] = Math.max(0, Math.min(254, Math.floor((offs[o]!.d - 0.5) * CLR_Q)))
  }
  const b = world.bounds
  const iLo = Math.max(0, Math.ceil(b.minX - minX - 0.5))
  const iHi = Math.min(nx - 1, Math.floor(b.maxX - minX - 0.5))
  const jLo = Math.max(0, Math.ceil(b.minY - minY - 0.5))
  const jHi = Math.min(ny - 1, Math.floor(b.maxY - minY - 0.5))
  // coarse "anything within the scan radius" mask so open-field nodes skip the scan
  const busy = new Uint8Array(ncol)
  {
    const rc = Math.ceil((SCAN_R + 1) / cs) + 1
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        const out = i < iLo || i > iHi || j < jLo || j > jHi
        if (!out && spanStart[c] === spanStart[c + 1]) continue
        const I0 = Math.floor(i / cs)
        const J0 = Math.floor(j / cs)
        const centre = J0 * gnx + I0
        if (busy[centre] === 2) continue
        busy[centre] = 2
        const ja = Math.max(0, J0 - rc)
        const jb = Math.min(gny - 1, J0 + rc)
        const ia = Math.max(0, I0 - rc)
        const ib = Math.min(gnx - 1, I0 + rc)
        for (let J = ja; J <= jb; J++) {
          const row = J * gnx
          for (let I = ia; I <= ib; I++) if (busy[row + I] === 0) busy[row + I] = 1
        }
      }
    }
  }
  const clr = new Uint8Array(NT * n).fill(255)
  for (let u = 0; u < n; u++) {
    const I = nI[u]!
    const J = nJ[u]!
    if (busy[J * gnx + I] === 0) continue
    const ci = I * cs
    const cj = J * cs
    const z = nz[u]!
    const zs = z + stepUp
    let lowest = NT
    for (let o = 0; o < no; o++) {
      const i = ci + offI[o]!
      const j = cj + offJ[o]!
      let tmin = NT
      if (i < iLo || i > iHi || j < jLo || j > jHi) tmin = 0
      else {
        const c = j * nx + i
        const s0 = spanStart[c]!
        const s1 = spanStart[c + 1]!
        if (s0 === s1) continue
        for (let k = s0; k < s1; k++) {
          if (spanData[2 * k + 1]! <= zs) continue
          const hb = spanData[2 * k]! - z
          if (hb <= stepUp) tmin = 0
          else {
            tmin = 0
            while (tmin < NT && tierH[tmin]! <= hb) tmin++
          }
          break
        }
        if (tmin >= lowest) continue
      }
      const q = offQ[o]!
      for (let t = tmin; t < lowest; t++) clr[t * n + u] = q
      lowest = tmin
      if (lowest === 0) break
    }
  }

  // ---- adjacent edges
  const nbr = new Int32Array(8 * n).fill(-1)
  const nbrType = new Uint8Array(8 * n)
  const tanMax = Math.tan((p.maxSlopeDeg * Math.PI) / 180)
  for (let u = 0; u < n; u++) {
    const I = nI[u]!
    const J = nJ[u]!
    const za = nz[u]!
    const ka = kind[u]!
    const ax = minX + I * cs + 0.5
    const ay = minY + J * cs + 0.5
    for (let d = 0; d < 8; d++) {
      const I2 = I + DX[d]!
      const J2 = J + DY[d]!
      if (I2 < 0 || J2 < 0 || I2 >= gnx || J2 >= gny) continue
      const col2 = J2 * gnx + I2
      const s = colStart[col2]!
      const e = colStart[col2 + 1]!
      const L = (d & 1) === 1 ? cs * Math.SQRT2 : cs
      const allow = tanMax * L
      let target = -1
      let type = E_NONE
      for (let v = e - 1; v >= s; v--) {
        const dz = nz[v]! - za
        const bothGround = ka === K_GROUND && kind[v] === K_GROUND
        if (bothGround) {
          if (dz > allow + 0.05) continue
          // midpoint check: each half must respect the slope limit going up
          const mz = world.groundZ(ax + DX[d]! * cs * 0.5, ay + DY[d]! * cs * 0.5)
          const half = allow * 0.5 + 0.1
          const r1 = mz - za
          const r2 = nz[v]! - mz
          let upOk = r1 <= half && r2 <= half
          if (upOk && (r1 > half * 0.5 || r2 > half * 0.5)) {
            // moderately steep: the server tests the slope per tick (~0.6 m), so look at quarter steps too
            const q1 = world.groundZ(ax + DX[d]! * cs * 0.25, ay + DY[d]! * cs * 0.25)
            const q3 = world.groundZ(ax + DX[d]! * cs * 0.75, ay + DY[d]! * cs * 0.75)
            const quarter = allow * 0.25 + 0.05
            upOk = q1 - za <= quarter && mz - q1 <= quarter && q3 - mz <= quarter && nz[v]! - q3 <= quarter
          }
          if (dz >= 0) {
            if (!upOk) continue
            target = v
            type = E_WALK
          } else {
            target = v
            type = upOk && -dz <= allow + 0.05 ? E_WALK : E_DROP
          }
          break
        }
        if (dz > stepUp + 0.01) continue
        if (dz > 0.3 && kind[v] === K_GROUND) {
          // stepping up from a prism top onto terrain: the terrain part of the way obeys the slope limit
          // (terrain pokes through prism tops around the stadium rim)
          const mz = world.groundZ(ax + DX[d]! * cs * 0.5, ay + DY[d]! * cs * 0.5)
          const q3 = world.groundZ(ax + DX[d]! * cs * 0.75, ay + DY[d]! * cs * 0.75)
          const quarter = allow * 0.25 + 0.05
          if (nz[v]! - q3 > quarter || (mz > za && q3 - mz > quarter)) continue
        }
        target = v
        type = dz < -stepUp ? E_DROP : E_WALK
        break
      }
      if (target < 0 && ka === K_GROUND && s < e && kind[s] === K_GROUND) {
        // terrain cliff: jet/jump up
        const dz = nz[s]! - za
        if (dz > 0 && dz <= p.maxClimb) {
          target = s
          type = E_JET
        }
      }
      if (target >= 0) {
        nbr[u * 8 + d] = target
        nbrType[u * 8 + d] = type
      }
    }
  }

  // ---- long edges: prism rims. From rim node R march outward; every lower landing S (k >= 2 cells out) gets
  // drop R->S and jet S->R.
  let pcap = 1 << 16
  let pFrom = new Int32Array(pcap)
  let pTo = new Int32Array(pcap)
  let pType = new Uint8Array(pcap)
  let pLen = new Float32Array(pcap)
  let pClr = new Uint8Array(pcap)
  let np = 0
  const push = (from: number, to: number, type: number, len: number, cc: number) => {
    if (np === pcap) {
      pcap *= 2
      const a = new Int32Array(pcap)
      a.set(pFrom)
      pFrom = a
      const b2 = new Int32Array(pcap)
      b2.set(pTo)
      pTo = b2
      const c2 = new Uint8Array(pcap)
      c2.set(pType)
      pType = c2
      const d2 = new Float32Array(pcap)
      d2.set(pLen)
      pLen = d2
      const e2 = new Uint8Array(pcap)
      e2.set(pClr)
      pClr = e2
    }
    pFrom[np] = from
    pTo[np] = to
    pType[np] = type
    pLen[np] = len
    pClr[np] = cc
    np++
  }
  const H0 = p.height
  // nearest cell (quantised distance) around raster cell (ci, cj) with a span crossing the body range at feet height z
  const HC = p.height * 1.25
  const levelClear = (ci: number, cj: number, z: number): number => {
    for (let o = 0; o < no; o++) {
      const i = ci + offI[o]!
      const j = cj + offJ[o]!
      if (i < iLo || i > iHi || j < jLo || j > jHi) return offQ[o]!
      const c = j * nx + i
      for (let k = spanStart[c]!, e = spanStart[c + 1]!; k < e; k++) {
        if (spanData[2 * k + 1]! > z + 0.3 && spanData[2 * k]! < z + HC) return offQ[o]!
      }
    }
    return 255
  }
  for (let r = 0; r < n; r++) {
    if (kind[r] !== K_TOP) continue
    const I = nI[r]!
    const J = nJ[r]!
    const zr = nz[r]!
    for (let d = 0; d < 8; d++) {
      // rim in this direction: neighbour is a drop, or missing (e.g. the column below is solid at this height)
      const t1 = nbrType[r * 8 + d]!
      if (t1 === E_WALK || t1 === E_JET) continue
      const diag = (d & 1) === 1
      const K = diag ? 3 : 4
      let cc = 255
      for (let k = 1; k <= K; k++) {
        const I2 = I + DX[d]! * k
        const J2 = J + DY[d]! * k
        if (I2 < 0 || J2 < 0 || I2 >= gnx || J2 >= gny) break
        const c = J2 * cs * nx + I2 * cs
        let blocked = false
        for (let s = spanStart[c]!; s < spanStart[c + 1]!; s++) {
          if (spanData[2 * s + 1]! > zr + stepUp && spanData[2 * s]! < zr + H0) {
            blocked = true
            break
          }
        }
        if (blocked) break
        const col2 = J2 * gnx + I2
        let sNode = -1
        for (let v = colStart[col2 + 1]! - 1; v >= colStart[col2]!; v--) {
          if (nz[v]! <= zr + stepUp) {
            sNode = v
            break
          }
        }
        if (sNode < 0) break
        const dz = zr - nz[sNode]!
        if (dz <= stepUp) break
        const lc = levelClear(I2 * cs, J2 * cs, zr)
        if (lc < cc) cc = lc
        if (k < 2) continue
        const len = k * cs * (diag ? Math.SQRT2 : 1)
        push(r, sNode, E_DROP, len, cc)
        if (dz <= p.maxClimb) push(sNode, r, E_JET, len, cc)
      }
    }
  }
  const xStart = new Int32Array(n + 1)
  for (let e = 0; e < np; e++) xStart[pFrom[e]! + 1] = xStart[pFrom[e]! + 1]! + 1
  for (let u = 0; u < n; u++) xStart[u + 1] = xStart[u + 1]! + xStart[u]!
  const fill = xStart.slice(0, n)
  const xTo = new Int32Array(np)
  const xType = new Uint8Array(np)
  const xLen = new Float32Array(np)
  const xClr = new Uint8Array(np)
  for (let e = 0; e < np; e++) {
    const at = fill[pFrom[e]!]!
    fill[pFrom[e]!] = at + 1
    xTo[at] = pTo[e]!
    xType[at] = pType[e]!
    xLen[at] = pLen[e]!
    xClr[at] = pClr[e]!
  }

  return { cs, gnx, gny, minX, minY, n, colStart, nz, nI, nJ, kind, roof, head, clr, nbr, nbrType, xStart, xTo, xType, xLen, xClr, buildMs: performance.now() - t0 }
}

/** Map hello.config.mech (or self.stats) to nav params; missing fields keep the defaults. */
export function navParamsFromMech(m: Record<string, number | undefined> | undefined, tickDt = 0.05): Partial<MechNavParams> {
  const o: Partial<MechNavParams> = {}
  if (!m) return o
  const num = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v)
  if (num(m.radius)) o.radius = m.radius
  if (num(m.height)) o.height = m.height
  if (num(m.walk_speed)) o.walkSpeed = m.walk_speed
  if (num(m.boost_speed)) o.boostSpeed = m.boost_speed
  if (num(m.gravity)) o.gravity = m.gravity
  if (num(m.jump_speed)) o.jumpSpeed = m.jump_speed
  if (num(m.step_up)) o.stepUp = m.step_up
  if (num(m.max_slope_deg)) o.maxSlopeDeg = m.max_slope_deg
  if (num(m.energy)) o.maxEnergy = m.energy
  if (num(m.jet_drain)) o.jetDrain = m.jet_drain
  const g = o.gravity ?? DEFAULT_PARAMS.gravity
  if (num(m.max_rise_speed)) o.maxRiseSpeed = Math.max(1, m.max_rise_speed - g * tickDt)
  const rise = o.maxRiseSpeed ?? DEFAULT_PARAMS.maxRiseSpeed
  o.jetEnergyPerM = Math.round(((o.jetDrain ?? DEFAULT_PARAMS.jetDrain) / rise) * 100) / 100
  return o
}
