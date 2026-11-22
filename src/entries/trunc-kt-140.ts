import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"
import type { BotFactory } from "../contracts.ts"

// Measurement probe: play the crate + run-and-shoot variant, then stand still from match time 140 s.
const trunc: BotFactory = (ctx) => {
  const bot = mainBot(ctx)
  return { name: bot.name, act: (obs) => (obs.t >= 140 ? {} : bot.act(obs)) }
}
runProcess({ name: BOT_NAME, factory: trunc, loadWorld, warmup, salt: 200, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60 } })
