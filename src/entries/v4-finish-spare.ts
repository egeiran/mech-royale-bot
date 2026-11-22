import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Finishes weak targets once it holds a laser, and spares a nearly dead lone hunter before that
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, salt: 210, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 12, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60, seekSoundS: 0, engageDist: 50, valNpc: 45, valCrate: 30, valCube: 20, npcMinHp: 0.35, valDrop: 0, rangeGunOnly: 55, upGunMag: 105, focusFinishHp: 0.3, focusFinishCrowd: 1, rushNoScan: 150, rushBoostHi: 60, laserRushEnergy: 20, rushRoofFight: 25, rushForceJet: 1, rushZone1: 1, spareHp: 0.25, spareLaser: 1, spareUntil: 45, spareSelfHp: 0.6 } })
