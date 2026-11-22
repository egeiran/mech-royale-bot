import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"
import type { BotFactory } from "../contracts.ts"

// Timing probe on the gunmag base: plays exactly like v4-gun55-gunmag, but stands still for the rest of the match if the
// median wall-clock gap between our answer and the next observation (decisions 2..16) is at least 10 ms. A normal score
// (~5.7) means no practice match reaches 10 ms, so modeGapMs can drop from 40 to ~12 (the final's 16 container bots make
// the server wait for the slowest one; a lower threshold lets the FFA ghost opening start at t = 0 there).
const T = 10
const gate: BotFactory = (ctx) => {
  const bot = mainBot(ctx)
  let n = 0
  let idle = false
  return {
    name: bot.name,
    act(obs) {
      n++
      if (n === 17 && ctx.rt) {
        const g = ctx.rt.gaps.slice(1, 16).sort((a, b) => a - b)
        if (g.length >= 5 && g[g.length >> 1] >= T) idle = true
      }
      return idle ? {} : bot.act(obs)
    },
  }
}
runProcess({ name: BOT_NAME, factory: gate, loadWorld, warmup, salt: 210, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30, crateReflexDist: 60, crateScan: 1, crateLaserW: 1, crateReflexSafe: 100, kiteTrainN: 2, kiteTrainDist: 120, kiteTrainBoostDist: 130, kiteTrainBoostE: 30, kiteTrainFrom: 60, seekSoundS: 0, engageDist: 50, valNpc: 45, valCrate: 30, valCube: 20, npcMinHp: 0.35, valDrop: 0, rushNoScan: 150, rushBoostHi: 60, laserRushEnergy: 20, rushRoofFight: 25, rushForceJet: 1, rushZone1: 1, rangeGunOnly: 55, upGunMag: 105 } })
