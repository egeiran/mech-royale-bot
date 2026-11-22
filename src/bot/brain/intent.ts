/**
 * The vocabulary strategies emit. One Intent object per bot is reused every decision (reset, then filled by a
 * builder below), so strategies allocate nothing. The executor (execute.ts) turns it into an action.
 *
 * An intent has three independent parts:
 *   movement  - kind + goal/pace (goto, loot, capture, flee, hold) or kind = FIGHT (movement relative to target)
 *   shooting  - targetId (mech / NPC track id) and/or shootItem (crate id); the executor fires whenever its
 *               gates allow, whatever the movement is. fireAtMechs = false silences the guns (ghost).
 *   looking   - face: where the torso points when it is not needed for shooting
 */
export const K_IDLE = 0
export const K_GOTO = 1
export const K_FIGHT = 2
export const K_LOOT = 3
export const K_FLEE = 4
export const K_HOLD = 5
export const K_CAPTURE = 6
export const KIND_NAMES = ["idle", "goto", "fight", "loot", "flee", "hold", "capture"] as const

export const PACE_SILENT = 0
export const PACE_WALK = 1
export const PACE_BOOST = 2

export const STYLE_PUSH = 0
export const STYLE_HOLD = 1
export const STYLE_KITE = 2
export const STYLE_PEEK = 3
/** fight from the point (gx, gy, gz): walk there while shooting, then hover around it */
export const STYLE_SPOT = 4

/** torso policy when there is nothing to shoot */
export const FACE_SCAN = 0 // sweep around the travel direction / spin when standing
export const FACE_THREATS = 1 // keep recent attackers and known enemies inside the front arc
export const FACE_YAW = 2 // hold intent.faceYaw
export const FACE_TRAVEL = 3 // look where we go

export class Intent {
  kind = K_IDLE
  /** movement goal (feet) */
  gx = 0
  gy = 0
  gz = 0
  pace = PACE_WALK
  /** stop within this distance of the goal */
  arrive = 2
  /** may the path use jets */
  allowJet = true
  /** jet straight up (jump when grounded, jets in the air), no horizontal move: the opening jet scan */
  jetUp = false
  /** fight: pursue the target with boost (finish a fleeing, nearly dead target) */
  chase = false
  /** mech / NPC to shoot (track id), -1 = none */
  targetId = -1
  /** fight movement */
  style = STYLE_PUSH
  range = 25
  /** crate id to shoot, -1 = none */
  shootCrate = -1
  /** allowed to open fire on mechs / NPCs (false = stay silent) */
  weaponsFree = true
  /** allowed to fire the gun at all (false = lightning/laser only is not modelled; gun noise carries 320 m) */
  face = FACE_SCAN
  faceYaw = 0
  /** pickup to take when in reach, and the slot to drop for it (-1 = empty slot) */
  takeId = -1
  dropSlot = -1
  /** drop this slot without taking (-1 = no) */
  dropOnly = -1
  /** fight footwork: drift toward (driftX, driftY) with this weight (0 = none; the drop-drift variant) */
  driftW = 0
  driftX = 0
  driftY = 0
  /** short tag for debugging / the timeline */
  label = ""

  reset(): this {
    this.kind = K_IDLE
    this.gx = this.gy = this.gz = 0
    this.pace = PACE_WALK
    this.arrive = 2
    this.allowJet = true
    this.jetUp = false
    this.chase = false
    this.targetId = -1
    this.style = STYLE_PUSH
    this.range = 25
    this.shootCrate = -1
    this.weaponsFree = true
    this.face = FACE_SCAN
    this.faceYaw = 0
    this.takeId = -1
    this.dropSlot = -1
    this.dropOnly = -1
    this.driftW = 0
    this.label = ""
    return this
  }

  goto(x: number, y: number, z: number, pace: number, label: string): this {
    this.kind = K_GOTO
    this.gx = x
    this.gy = y
    this.gz = z
    this.pace = pace
    this.label = label
    return this
  }

  fight(targetId: number, style: number, range: number, label: string): this {
    this.kind = K_FIGHT
    this.targetId = targetId
    this.style = style
    this.range = range
    this.face = FACE_THREATS
    this.label = label
    return this
  }

  loot(x: number, y: number, z: number, pace: number, label: string): this {
    this.kind = K_LOOT
    this.gx = x
    this.gy = y
    this.gz = z
    this.pace = pace
    this.arrive = 0.8
    this.label = label
    return this
  }

  flee(x: number, y: number, z: number, pace: number, label: string): this {
    this.kind = K_FLEE
    this.gx = x
    this.gy = y
    this.gz = z
    this.pace = pace
    this.face = FACE_THREATS
    this.label = label
    return this
  }

  hold(x: number, y: number, z: number, label: string): this {
    this.kind = K_HOLD
    this.gx = x
    this.gy = y
    this.gz = z
    this.pace = PACE_SILENT
    this.arrive = 1.5
    this.label = label
    return this
  }

  capture(x: number, y: number, z: number, pace: number, label: string): this {
    this.kind = K_CAPTURE
    this.gx = x
    this.gy = y
    this.gz = z
    this.pace = pace
    this.arrive = 1.5
    this.label = label
    return this
  }
}
