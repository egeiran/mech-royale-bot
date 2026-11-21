import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { seekSoundS: 8, npcFirstDist: 45, squadRegenUntil: 0.7, lootTimeCost: 0.5, dropFightLeadS: 0 } })
