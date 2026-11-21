import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"
import type { BotFactory } from "../contracts.ts"

// Measurement probe: play variant E, then stand still from match time 100 s. The score is our kill count by that time.
const P = { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25 }
const trunc: BotFactory = (ctx) => {
  const bot = mainBot(ctx)
  return { name: bot.name, act: (obs) => (obs.t >= 100 ? {} : bot.act(obs)) }
}
runProcess({ name: BOT_NAME, factory: trunc, loadWorld, warmup, params: P })
