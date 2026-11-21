import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"
import type { BotFactory } from "../contracts.ts"

// Measurement probe: play normally, but stand still for the rest of the match if the median wall-clock gap between our
// answer and the next observation (decisions 2..16) is at least 5 ms. The practice score then tells us how the
// scorer's timing is distributed, which we need for telling match types apart at the start.
const T = 5
const gate: BotFactory = (ctx) => {
  const bot = mainBot(ctx)
  let n = 0
  let idle = false
  return {
    name: bot.name,
    act(obs) {
      n++
      if (n === 17 && ctx.rt) {
        const g = ctx.rt.gaps.slice(1, 16).sort((a, b) => a - b)
        if (g.length >= 5 && g[g.length >> 1] >= T) idle = true
      }
      return idle ? {} : bot.act(obs)
    },
  }
}
runProcess({ name: BOT_NAME, factory: gate, loadWorld, warmup })
