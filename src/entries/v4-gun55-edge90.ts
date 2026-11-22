import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// gun55 best (5.80) + edge wait from 90 s: when idle, hold an open spot 45 m inside the next circle on the side away from the known mechs (loot only within 50 m meanwhile) - the opposite of centre hold (real 5.09)
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, salt: 210, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60, seekSoundS: 0, engageDist: 50, valNpc: 45, valCrate: 30, valCube: 20, npcMinHp: 0.35, valDrop: 0, rushNoScan: 150, rushBoostHi: 60, laserRushEnergy: 20, rushRoofFight: 25, rushForceJet: 1, rushZone1: 1, rangeGunOnly: 55, edgeHold: 1, centerHoldFrom: 90, centerHoldLoot: 50 } })
