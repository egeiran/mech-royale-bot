import { runProcess } from "../runner/run.ts"
import { simpleBot } from "../bot/simple.ts"

runProcess({ name: "ai-caramba", factory: simpleBot })
