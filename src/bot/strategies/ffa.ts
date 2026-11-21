/**
 * FFA strategy entry (owned by the FFA agent). `ffaVersion` picks the implementation:
 *   1 = ffa_v1.ts  "ghost first, duelist as fallback" (frozen reference for paired tests)
 *   2 = ffa_v2.ts  phased ghost: pocket opening, still hold, break line of sight when seen, hide 30 s, end-game hunt
 * Also used for the UNKNOWN opening when the brain runs it (unknownSquadAfter > 0 or forceMode = 2).
 * Policy, evidence and results: data/intel/ffa-plan.md. Eval: src/bot/strategies/eval_ffa/run.ts.
 */
import type { Blackboard } from "../brain/blackboard.ts"
import type { Intent } from "../brain/intent.ts"
import type { Mover } from "../brain/navx.ts"
import { decideFfaV1 } from "./ffa_v1.ts"
import { decideFfaV2 } from "./ffa_v2.ts"
import type { SquadScratch } from "./squad.ts"

export function decideFfa(bb: Blackboard, mv: Mover, sc: SquadScratch): Intent {
  return bb.P.ffaVersion >= 2 ? decideFfaV2(bb, mv, sc) : decideFfaV1(bb, mv, sc)
}
