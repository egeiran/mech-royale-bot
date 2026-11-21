import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Probe: brain v1 fighting at close range (the real scorer rewards closing in: 12 m > 25 m > 55 m > 95 m with SimpleBot).
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { rangeGun: 14, rangeKite: 14, rangeVsLightning: 14, rangeLaserVsMortar: 14 } })
