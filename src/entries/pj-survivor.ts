import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Probe: after 4 kills switch to hiding (break line of sight, heal, tank upgrades) and try to outlast the squad.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { ghostKills: 4, upPlating: 130, upArmor: 128 } })
