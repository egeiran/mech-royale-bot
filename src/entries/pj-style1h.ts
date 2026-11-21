import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Variant H: F plus chasing nearly dead targets, no gun fire beyond 120 m without a laser, gun-only duels at 55 m.
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, finishChaseHp: 0.2, gunFarDist: 120, rangeGunOnly: 55 } })
