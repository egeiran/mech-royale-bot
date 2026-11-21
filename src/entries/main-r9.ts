import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Probe: brain v2 with duel range 9 m.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { rangeGun: 9, rangeKite: 9, rangeVsLightning: 9, rangeLaserVsMortar: 9 } })
