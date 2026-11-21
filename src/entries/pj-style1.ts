import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Laser-kite style: laser first, fight at ~75 m backing off, gun firing during the charge, break off to heal.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { style: 1 } })
