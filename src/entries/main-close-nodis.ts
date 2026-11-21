import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Probe: close range and never disengage to regenerate (fight every duel to the end).
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { rangeGun: 14, rangeKite: 14, rangeVsLightning: 14, rangeLaserVsMortar: 14, squadDisengageHp: 0 } })
