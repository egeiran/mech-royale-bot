/**
 * mainBot: blackboard -> strategy (by mode) -> executor. One instance per mech; all state on the instance.
 */
import type { Bot, BotAction, BotContext, BotFactory, Observation } from "../../contracts.ts"
import { Blackboard, MODE_SQUAD } from "./blackboard.ts"
import { Executor } from "./execute.ts"
import { K_LOOT, KIND_NAMES, type Intent } from "./intent.ts"
import { Mover } from "./navx.ts"
import { resolveParams } from "./params.ts"
import { pickUpgrade } from "../strategies/common.ts"
import { decideFfa } from "../strategies/ffa.ts"
import { decideSquad, SquadScratch } from "../strategies/squad.ts"

export interface BrainBot extends Bot {
  readonly bb: Blackboard
  readonly exec: Executor
  readonly mover: Mover
  /** intent of the last decision (for timelines / debugging) */
  lastIntent(): Intent
}

export const BOT_NAME = "ai-caramba"

export function createBrain(ctx: BotContext): BrainBot {
  const bb = new Blackboard(ctx.hello, ctx.world, resolveParams(ctx.params), ctx.rng)
  bb.rt = ctx.rt ?? null // timing hint for the mode decision (modeGapMs)
  const mover = new Mover(ctx.world, ctx.hello.config.mech)
  const exec = new Executor(bb, mover)
  const sc = new SquadScratch()
  let last: Intent = bb.intent

  const act = (obs: Observation): BotAction => {
    bb.update(obs)
    let it: Intent
    if (bb.mode === MODE_SQUAD) it = decideSquad(bb, mover, sc)
    else it = decideFfa(bb, mover, sc) // FFA, and the UNKNOWN opening
    last = it
    const a = exec.run(it)
    // a loot goal the planner cannot reach is dropped for a while (roof without energy, sealed courtyard, ...)
    if (it.kind === K_LOOT && mover.unreachable && mover.dist > it.arrive + 3) {
      const item = bb.loot.get(bb.mem.lootId)
      if (item && Math.hypot(item.x - it.gx, item.y - it.gy) < 1) item.badUntil = obs.t + 25
    }
    if (obs.offer) a.pick = pickUpgrade(bb, obs.offer)
    return a
  }

  return { name: BOT_NAME, act, bb, exec, mover, lastIntent: () => last }
}

export const mainBot: BotFactory = (ctx: BotContext): Bot => createBrain(ctx)

export { KIND_NAMES }
