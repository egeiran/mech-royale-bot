import { runProcess } from "../runner/run.ts"
import { loadWorld } from "../world/index.ts"
import { BOT_NAME, mainBot } from "../bot/brain/index.ts"
import { warmup } from "../bot/brain/warmup.ts"

// Final-integration build (data/intel/final-plan.md): build F + mode latch (2 deaths by another hand before 45 s -> FFA;
// nobody else dead at 30 s -> SQUAD for good) + timing hint (median answer->next-observation gap over the first 16
// decisions > 40 ms, i.e. not the practice scorer's 1-5 ms: FFA ghost opening until 30 s, FFA on the first death by another hand).
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup, params: { style: 1, seekSoundS: 8, npcFirstDist: 45, dropFightLeadS: 0, squadDisengageHp: 0, rangeGun: 25, jetScan: 20, laserRush: 220, ltgVetoLaser: 220, navWatchdogS: 5, modeDeathsN: 2, modeSquadLockT: 30, modeGapMs: 40, modeGapUnknownS: 30 } })
