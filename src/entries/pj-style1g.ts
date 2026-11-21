import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Diagnostic probe: the laser-first bot of variant E, but fighting at 25 m instead of kiting at 75 m.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, rangeLaser: 25, rangeKite: 25, rangeVsLightning: 25, rangeLaserVsMortar: 25, rangeVsMortar: 25, kiteBoostGap: 999 } })
