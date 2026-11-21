import type { BotAction } from "../contracts.ts"

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Return a schema-valid copy of an action: anything malformed is dropped (a NaN would serialise as null and be rejected). */
export function sanitize(a: BotAction | null | undefined, tick: number): Record<string, unknown> {
  const o: Record<string, unknown> = { tick }
  if (!a || typeof a !== "object") return o
  const m = a.move
  if (Array.isArray(m) && fin(m[0]) && fin(m[1])) {
    let x = m[0]
    let y = m[1]
    const l = Math.hypot(x, y)
    if (l > 1) {
      x /= l
      y /= l
    }
    o.move = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]
  }
  const aim = a.aim
  if (Array.isArray(aim) && fin(aim[0]) && fin(aim[1])) o.aim = [Math.round(aim[0] * 1e4) / 1e4, Math.round(Math.max(-1.5, Math.min(1.5, aim[1])) * 1e4) / 1e4]
  if (a.boost === true) o.boost = true
  if (a.jump === true) o.jump = true
  if (a.reload === true) o.reload = true
  const f = a.fire
  if (Array.isArray(f) && (f[0] === true || f[1] === true)) o.fire = [f[0] === true, f[1] === true]
  if (fin(a.pick) && a.pick >= 0 && a.pick <= 2) o.pick = Math.floor(a.pick)
  if (fin(a.take)) o.take = Math.floor(a.take)
  if (a.drop === 0 || a.drop === 1) o.drop = a.drop
  if (a.debug && typeof a.debug === "object") o.debug = a.debug
  return o
}
