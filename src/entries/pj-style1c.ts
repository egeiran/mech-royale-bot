import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Laser-kite style plus tempo params.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0 } })
