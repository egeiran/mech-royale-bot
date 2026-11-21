/** Test fixture: the kit's recorded hello + 300 observations (mechfight-kit/check/stream.jsonl.gz). Tests only. */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { fileURLToPath } from "node:url"
import type { EndMsg, Hello, Observation } from "../../protocol/mechfight.ts"

export interface RecordedStream {
  hello: Hello
  obs: Observation[]
  end: EndMsg | null
}

let cached: RecordedStream | null = null

export function loadRecordedStream(): RecordedStream {
  if (cached) return cached
  const path = fileURLToPath(new URL("../../../mechfight-kit/check/stream.jsonl.gz", import.meta.url))
  const text = gunzipSync(readFileSync(path)).toString("utf8")
  let hello: Hello | null = null
  let end: EndMsg | null = null
  const obs: Observation[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.type === "hello") hello = m
    else if (m.type === "obs") obs.push(m)
    else if (m.type === "end") end = m
  }
  if (!hello) throw new Error("no hello in recorded stream")
  cached = { hello, obs, end }
  return cached
}
