import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Probe: the style of the best teams' bots: prefer the laser and fight at 75 m.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { valLaser: 60, valLightning: 15, valSwapToLightning: 0, rangeGun: 75, rangeKite: 75, rangeVsLightning: 75, rangeLaserVsMortar: 75 } })
