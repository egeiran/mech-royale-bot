import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import type { Bot, BotContext, BotFactory, Observation } from "../contracts.ts"
import { BOT_NAME, createBrain } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// GATE PROBE (measurement, not a contender): pj-final1 params, but the bot stands still and holds fire from the moment the
// FFA latch fires or the timing hint says "not practice". Practice score vs build F (5.38) = cost of false FFA flips:
// ~5.4 -> no false flips; every 1 % of matches flipped costs about 0.03-0.04 points.
const gated: BotFactory = (ctx: BotContext): Bot => {
  const b = createBrain(ctx)
  let gate = false
  const bot: Bot = {
    name: b.name,
    act(obs: Observation) {
      const a = b.act(obs)
      if (b.bb.ffaLatched || b.bb.gapHint === 1) gate = true
      return gate ? {} : a
    },
  }
  return Object.assign(bot, { bb: b.bb }) // warmup() borrows bb.world

}
runProcess({ name: BOT_NAME, factory: gated, loadWorld, warmup, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30 } })
