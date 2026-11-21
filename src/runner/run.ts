/**
 * Process runner: speaks mechfight/1 on stdin/stdout around a BotFactory.
 * Guarantees: always answers with a schema-valid action, never crashes, falls back to SimpleBot when the
 * primary bot throws repeatedly or fails to construct, answers only the newest queued observation.
 */
import type { Bot, BotAction, BotContext, BotFactory, Hello, Observation, World } from "../contracts.ts"
import { makeRng } from "../util/rng.ts"
import { sanitize } from "./sanitize.ts"
import { simpleBot } from "../bot/simple.ts"

const log = (...a: unknown[]) => console.error(...a)
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n")

/** Wall-clock measurements the runner shares with the bot (realtime only). */
export interface RtStats {
  /** ms from writing our answer to the arrival of the next observation, for the first decisions (no backlog) */
  gaps: number[]
  /** ms from writing `ready` to the first observation */
  readyGapMs: number
}

export interface RunnerOptions {
  name: string
  factory: BotFactory
  /** builds the World from hello.map.dir; may throw (then the primary bot gets no world and we fall back) */
  loadWorld?: (dir: string) => World
  params?: Record<string, number>
  /** changes the bot's random stream (strafe timing etc.) without changing its logic */
  salt?: number
  /** observations to replay through the bot before `ready` to warm the JIT (synthetic, from the first hello) */
  warmup?: (bot: Bot, hello: Hello) => void
}

export function runProcess(opts: RunnerOptions) {
  let primary: Bot | null = null
  let fallback: Bot | null = null
  let primaryErrors = 0
  let consecutive = 0
  let disabled = false
  let last: BotAction = {}
  let buf = ""
  let queued = false
  let slow = 0
  const rt: RtStats = { gaps: [], readyGapMs: -1 }
  let tSent = -1
  let tReady = -1

  const onHello = (hello: Hello) => {
    const t0 = performance.now()
    const seed = (hello.seed ?? 1) >>> 0
    let world: World | null = null
    try {
      if (opts.loadWorld) world = opts.loadWorld(hello.map.dir)
    } catch (e) {
      log("world load failed:", e)
    }
    const mk = (salt: number): BotContext => ({
      hello,
      world: world as World,
      params: opts.params ?? {},
      rng: makeRng((seed ^ salt ^ Math.imul((opts.salt ?? 0) | 0, 0x9e3779b1)) >>> 0),
      realtime: true,
      log: (m: string) => log(m),
      rt,
    } as BotContext)
    try {
      fallback = simpleBot(mk(0x51ab))
    } catch (e) {
      log("fallback construct failed:", e)
    }
    try {
      if (world || !opts.loadWorld) primary = opts.factory(mk(0))
      if (primary && opts.warmup) opts.warmup(primary, hello)
    } catch (e) {
      log("primary construct failed:", e)
      primary = null
    }
    log(`ready in ${(performance.now() - t0).toFixed(0)} ms (world ${world ? "ok" : "none"}, primary ${primary ? "ok" : "none"})`)
    send({ type: "ready", name: opts.name.slice(0, 32) })
    tReady = performance.now()
  }

  const onObs = (obs: Observation) => {
    const t0 = performance.now()
    let action: BotAction | null = null
    if (primary && !disabled) {
      try {
        action = primary.act(obs)
        consecutive = 0
      } catch (e) {
        primaryErrors++
        consecutive++
        if (primaryErrors <= 5 || primaryErrors % 200 === 0) log(`act() failed at tick ${obs.tick} (${primaryErrors} so far):`, e)
        if (consecutive >= 30) {
          disabled = true
          log("primary disabled after 30 consecutive failures")
        }
      }
    }
    if (!action && fallback) {
      try {
        action = fallback.act(obs)
      } catch (e) {
        if (primaryErrors < 5) log("fallback failed:", e)
      }
    }
    if (!action) action = { move: last.move, aim: last.aim, boost: last.boost }
    last = action
    send(sanitize(action, obs.tick))
    tSent = performance.now()
    const ms = tSent - t0
    if (ms > 25 && ++slow <= 20) log(`slow decision ${ms.toFixed(1)} ms at tick ${obs.tick}`)
  }

  const handle = (lines: string[]) => {
    const tArr = performance.now()
    let nObs = 0
    let latest: Observation | null = null
    for (const line of lines) {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === "hello") onHello(msg)
      else if (msg.type === "obs") {
        latest = msg
        nObs++
      } else if (msg.type === "end") {
        try {
          primary?.end?.(msg)
        } catch {}
        process.exit(0)
      }
    }
    if (latest) {
      if (rt.readyGapMs < 0 && tReady >= 0) rt.readyGapMs = tArr - tReady
      else if (nObs === 1 && tSent >= 0 && rt.gaps.length < 64) rt.gaps.push(tArr - tSent)
      onObs(latest)
    }
  }

  const flush = () => {
    queued = false
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    handle(lines.filter((l) => l.trim()))
  }
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buf += chunk
    if (queued) return
    queued = true
    setImmediate(flush)
  })
  process.stdin.on("end", () => {
    buf += "\n"
    flush()
    process.exit(0)
  })
}
