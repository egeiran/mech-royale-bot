/**
 * FFA evaluation fields: who sits in the 15 other seats. Lineups depend on (field, seed) only, never on the
 * candidate, so candidates run on the same seeds meet the same opponents in the same seats (paired tests).
 *
 * Bot specs: "fin:<preset>" (finalist.ts), "house:<preset>" (league house-bot imitation, no director),
 * "main" (our brain; params e.g. {forceMode: 1} = the squad duelist), "still" (naive camper), "idle".
 */
import type { BotFactory, Params } from "../../../contracts.ts"
import { makeRng } from "../../../util/rng.ts"
import { FINALIST_PRESETS, FINALIST_WEIGHTS, makeFinalist, standStillBot } from "./finalist.ts"

export interface Seat {
  bot: string
  params?: Params
  /** harness only (eval_ffa/run.ts, candidate seat): fake runner timing, ms between our answer and the next
   *  observation (ctx.rt.gaps), to test the modeGapMs hint; "rtGapMs=100" in a --cand spec */
  rtGapMs?: number
}

const RUNNERS = ["tigertown", "n2696", "abot", "scorpion", "benchmaster", "azing", "cocoa", "poteto"]
const DUEL: Seat = { bot: "main", params: { forceMode: 1 } }

function weightedDistinct(rng: ReturnType<typeof makeRng>, weights: Record<string, number>, n: number): string[] {
  const names = Object.keys(weights)
  const w = names.map((k) => weights[k]!)
  const out: string[] = []
  for (let k = 0; k < n && names.length > 0; k++) {
    let s = 0
    for (const v of w) s += v
    let u = rng.next() * s
    let i = 0
    while (i < w.length - 1 && u >= w[i]!) u -= w[i++]!
    out.push(names[i]!)
    names.splice(i, 1)
    w.splice(i, 1)
  }
  return out
}

export const FIELD_NAMES = ["finalists", "duelists", "house", "mixed", "hunters", "lobby"] as const

/**
 *   finalists  15 distinct team imitations drawn by their number of appearances in the recorded showdowns
 *   duelists   the aggressive end: 8 long-range laser runners, 3 "hunter" variants that chase and walk to
 *              gunfire, 4 copies of our own squad duelist (kites at 115 m, disengages, loots)
 *   house      10 expert house bots (the final fills empty seats with them) + 5 finalists
 *   mixed      5 finalists, 4 house (expert, hard, brawler, sniper), 3 squad duelists, 3 hunters
 *   hunters    stress test, not a measured field: 9 hunters + 6 finalists (everybody comes looking)
 *   lobby      calibration only: the public "Play now" lobby of data/intel/play.md (15 house bots: expert, two
 *              astra probes, two red probes) as 3 expert + 6 astra + 6 hard; standard zone (the lobby ran it at 2x)
 */
export function fieldLineup(field: string, seed: number): Seat[] {
  const rng = makeRng(((seed * 2654435761) ^ 0x0ffa17) >>> 0)
  let seats: Seat[]
  const fin = (n: number): Seat[] => weightedDistinct(rng, FINALIST_WEIGHTS, n).map((p) => ({ bot: `fin:${p}` }))
  const pick = (list: string[], n: number): Seat[] => Array.from({ length: n }, () => ({ bot: `fin:${list[rng.int(list.length)]!}` }))
  if (field === "finalists") seats = fin(15)
  else if (field === "duelists") seats = [...pick(RUNNERS, 8), ...pick(["hunter"], 3), DUEL, DUEL, DUEL, DUEL]
  else if (field === "house") seats = [...Array.from({ length: 10 }, () => ({ bot: "house:expert" })), ...fin(5)]
  else if (field === "mixed") seats = [...fin(5), { bot: "house:expert" }, { bot: "house:hard" }, { bot: "house:brawler" }, { bot: "house:sniper" }, DUEL, DUEL, DUEL, ...pick(["hunter"], 3)]
  else if (field === "hunters") seats = [...pick(["hunter"], 9), ...fin(6)]
  else if (field === "lobby") seats = [...Array.from({ length: 3 }, () => ({ bot: "house:expert" })), ...Array.from({ length: 6 }, () => ({ bot: "house:astra" })), ...Array.from({ length: 6 }, () => ({ bot: "house:hard" }))]
  else throw new Error(`unknown field "${field}" (have: ${FIELD_NAMES.join(", ")})`)
  for (let i = seats.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = seats[i]!
    seats[i] = seats[j]!
    seats[j] = t
  }
  return seats
}

export function seatOf(seed: number): number {
  return (((5 * seed + 3) % 16) + 16) % 16
}

const cache = new Map<string, BotFactory>()

export async function resolveSeat(bot: string): Promise<BotFactory> {
  const hit = cache.get(bot)
  if (hit) return hit
  let f: BotFactory
  if (bot.startsWith("fin:")) {
    const p = bot.slice(4)
    if (!FINALIST_PRESETS[p]) throw new Error(`unknown finalist "${p}"`)
    f = makeFinalist(p)
  } else if (bot.startsWith("house:")) {
    const { makeHouseBot } = await import("../../../league/housebots/bot.ts")
    f = makeHouseBot(bot.slice(6), null)
  } else if (bot === "main") f = (await import("../../brain/index.ts")).mainBot
  else if (bot === "still") f = standStillBot
  else if (bot === "simple") f = (await import("../../simple.ts")).simpleBot
  else if (bot === "idle") f = () => ({ name: "idle", act: () => ({}) })
  else throw new Error(`unknown bot spec "${bot}"`)
  cache.set(bot, f)
  return f
}

export function seatLabel(s: Seat): string {
  if (!s.params || Object.keys(s.params).length === 0) return s.bot
  return `${s.bot}{${Object.keys(s.params).sort().map((k) => `${k}:${s.params![k]}`).join(",")}}`
}
