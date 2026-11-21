import type { Rng } from "../contracts.ts"

/** mulberry32-based deterministic PRNG. */
export class Mulberry implements Rng {
  private s: number
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next()
  }
  gauss(): number {
    let u = 0
    while (u < 1e-12) u = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next())
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  fork(salt: number): Rng {
    return new Mulberry((Math.imul(this.s ^ 0x85ebca6b, 0xc2b2ae35) ^ Math.imul(salt + 1, 0x27d4eb2f)) >>> 0)
  }
}

export const makeRng = (seed: number): Rng => new Mulberry(seed)
