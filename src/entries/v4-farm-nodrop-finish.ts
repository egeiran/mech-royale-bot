import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Farm-first laser-kite brain without supply drops that stands to finish nearly dead targets
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, salt: 210, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60, seekSoundS: 0, engageDist: 80, valNpc: 30, valCrate: 22, valCube: 16, valDrop: 0, focusFinishHp: 0.3, focusFinishCrowd: 1 } })
