import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Laser-kite brain, zone-edge and crate stand-off fixes, random stream 121
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, salt: 121, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30, zoneGuard: 8, crateStandOff: 8 } })
