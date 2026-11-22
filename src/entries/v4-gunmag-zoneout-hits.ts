import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// gunmag base + zone-out (hits; third session): as zoneout, but also stays out while it keeps hitting mechs from out there (hunters pinned at the edge >= 100 m away, where house guns hit ~18 %); modeGapMs 12
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, salt: 210, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60, seekSoundS: 0, engageDist: 50, valNpc: 45, valCrate: 30, valCube: 20, npcMinHp: 0.35, valDrop: 0, rushNoScan: 150, rushBoostHi: 60, laserRushEnergy: 20, rushRoofFight: 25, rushForceJet: 1, rushZone1: 1, rangeGunOnly: 55, upGunMag: 105, modeGapMs: 12, zoneOutT: 92, zoneOutHits: 1, zoneOutD: 115 } })
