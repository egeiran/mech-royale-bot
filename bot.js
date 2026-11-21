// @bun
// src/util/rng.ts
class Mulberry {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    let t = this.s += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  gauss() {
    let u = 0;
    while (u < 0.000000000001)
      u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  int(n) {
    return Math.floor(this.next() * n);
  }
  fork(salt) {
    return new Mulberry((Math.imul(this.s ^ 2246822507, 3266489909) ^ Math.imul(salt + 1, 668265263)) >>> 0);
  }
}
var makeRng = (seed) => new Mulberry(seed);

// src/runner/sanitize.ts
var fin = (v) => typeof v === "number" && Number.isFinite(v);
function sanitize(a, tick) {
  const o = { tick };
  if (!a || typeof a !== "object")
    return o;
  const m = a.move;
  if (Array.isArray(m) && fin(m[0]) && fin(m[1])) {
    let x = m[0];
    let y = m[1];
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    o.move = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  }
  const aim = a.aim;
  if (Array.isArray(aim) && fin(aim[0]) && fin(aim[1]))
    o.aim = [Math.round(aim[0] * 1e4) / 1e4, Math.round(Math.max(-1.5, Math.min(1.5, aim[1])) * 1e4) / 1e4];
  if (a.boost === true)
    o.boost = true;
  if (a.jump === true)
    o.jump = true;
  if (a.reload === true)
    o.reload = true;
  const f = a.fire;
  if (Array.isArray(f) && (f[0] === true || f[1] === true))
    o.fire = [f[0] === true, f[1] === true];
  if (fin(a.pick) && a.pick >= 0 && a.pick <= 2)
    o.pick = Math.floor(a.pick);
  if (fin(a.take))
    o.take = Math.floor(a.take);
  if (a.drop === 0 || a.drop === 1)
    o.drop = a.drop;
  if (a.debug && typeof a.debug === "object")
    o.debug = a.debug;
  return o;
}

// src/bot/simple.ts
var TAU = Math.PI * 2;
var wrap = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0)
    a += TAU;
  return a - Math.PI;
};
var UPGRADE_RANK = [
  "plating",
  "nanites",
  "armor",
  "gun_damage",
  "gun_rate",
  "lightning_efficiency",
  "laser_damage",
  "laser_charge",
  "servos",
  "gun_mag",
  "lightning_range",
  "gyros",
  "gun_velocity",
  "reactor",
  "capacitor",
  "jets",
  "lightning_chain",
  "laser_pierce",
  "sensors",
  "mortar_reload",
  "mortar_splash",
  "mortar_velocity"
];
var simpleBot = (ctx) => {
  const cfg = ctx.hello.config;
  const rng = ctx.rng;
  const P = ctx.params;
  const prefDist = P.prefDist ?? 55;
  const retreatHp = P.retreatHp ?? 0.3;
  const seekLightning = (P.seekLightning ?? 0) > 0;
  const farm = (P.farm ?? 1) > 0;
  const dt = cfg.match.decide_every / cfg.match.tick_hz;
  let strafeSign = rng.next() < 0.5 ? 1 : -1;
  let strafeUntil = 0;
  let lookYaw = 0;
  let lookUntil = -1;
  let stuckT = 0;
  let detourUntil = -1;
  let detourSign = 1;
  let lastX = 0;
  let lastY = 0;
  let scanPhase = rng.range(0, TAU);
  const act = (obs) => {
    const me = obs.self;
    const [x, y, z] = me.pos;
    const t = obs.t;
    const a = {};
    const stats = me.stats;
    const muzzleZ = z + (stats.muzzle_height ?? 7);
    const turn = stats.turn_rate ?? 4;
    if (obs.offer) {
      let best = 0;
      let bestRank = 1e9;
      obs.offer.choices.forEach((c, i) => {
        const r = UPGRADE_RANK.indexOf(c.id);
        const rr = r < 0 ? 500 : r;
        if (rr < bestRank) {
          bestRank = rr;
          best = i;
        }
      });
      a.pick = best;
    }
    for (const e of obs.events) {
      if (e.type === "damaged" && e.bearing != null) {
        lookYaw = e.bearing;
        lookUntil = t + 2.5;
      }
    }
    let enemy = null;
    let enemyD = Infinity;
    let npc = null;
    let npcD = Infinity;
    for (const m of obs.mechs) {
      const d = Math.hypot(m.pos[0] - x, m.pos[1] - y);
      if (m.kind === "mech") {
        if (d < enemyD) {
          enemyD = d;
          enemy = m;
        }
      } else if (d < npcD) {
        npcD = d;
        npc = m;
      }
    }
    const zn = obs.zone;
    const dNext = Math.hypot(zn.next_center[0] - x, zn.next_center[1] - y);
    const dCur = Math.hypot(zn.center[0] - x, zn.center[1] - y);
    const shrinking = t >= zn.shrink_start;
    const timeToShrink = zn.shrink_start - t;
    const needTravel = dNext - zn.next_radius * 0.7;
    const mustRotate = !me.in_zone || dCur > zn.radius - 25 || needTravel > 0 && (shrinking || needTravel / 10 > timeToShrink - 8);
    const w0 = me.weapons[0];
    const w1 = me.weapons[1];
    const fire = [false, false];
    let wantYaw = me.aim[0];
    let wantPitch = 0;
    let mx = 0;
    let my = 0;
    let boost = false;
    let haveAim = false;
    const aimAt = (tx, ty, tz, vx, vy, vz, speed) => {
      const dx = tx - x;
      const dy = ty - y;
      const dz = tz - muzzleZ;
      let tt = 0;
      if (speed > 0) {
        const A = vx * vx + vy * vy + vz * vz - speed * speed;
        const B = 2 * (dx * vx + dy * vy + dz * vz);
        const C = dx * dx + dy * dy + dz * dz;
        const disc = B * B - 4 * A * C;
        if (disc >= 0 && Math.abs(A) > 0.000001) {
          const t1 = (-B - Math.sqrt(disc)) / (2 * A);
          const t2 = (-B + Math.sqrt(disc)) / (2 * A);
          tt = t1 > 0 && (t1 < t2 || t2 <= 0) ? t1 : t2 > 0 ? t2 : 0;
        }
        tt += dt * 0.5;
      }
      const ax = dx + vx * tt;
      const ay = dy + vy * tt;
      const az = dz + vz * tt;
      wantYaw = Math.atan2(ay, ax);
      wantPitch = Math.atan2(az, Math.hypot(ax, ay));
      haveAim = true;
      return Math.hypot(ax, ay);
    };
    const aimedWithin = (dist, radius, halfH) => {
      const ey = Math.max(0, Math.abs(wrap(wantYaw - me.aim[0])) - turn * dt * 0.5);
      const ep = Math.abs(wantPitch - me.aim[1]);
      return ey < Math.atan2(radius * 0.8, dist) + 0.004 && ep < Math.atan2(halfH * 0.8, dist) + 0.01;
    };
    if (enemy) {
      const scale = 1 + 0.05 * (enemy.cubes ?? 0);
      const gunSpeed = w0?.kind === "gun" ? w0.stats.speed ?? 252 : 252;
      const useLaser = w1?.kind === "laser" && w1.cooldown <= 0.05;
      const d = aimAt(enemy.pos[0], enemy.pos[1], enemy.pos[2] + 4.5 * scale, enemy.vel[0], enemy.vel[1], enemy.vel[2], useLaser && (w1.charge ?? 0) > 0 ? 0 : gunSpeed);
      const on = aimedWithin(d, 2.5 * scale, 4.5 * scale);
      if (w0?.kind === "gun") {
        const range = w0.stats.range ?? 230;
        if (on && d < Math.min(range, P.gunMaxDist ?? 140) && (w0.reload ?? 0) <= 0)
          fire[0] = true;
      }
      if (w1) {
        if (w1.kind === "lightning") {
          if (d < (w1.stats.range ?? 45) && Math.abs(wrap(wantYaw - me.aim[0])) < (w1.stats.cone_deg ?? 30) * Math.PI / 180 * 0.8 && me.energy > 6)
            fire[1] = true;
        } else if (w1.kind === "laser") {
          const full = w1.stats.charge ?? 0.75;
          const ch = w1.charge ?? 0;
          if (w1.cooldown <= 0.05 && d < (w1.stats.range ?? 280))
            fire[1] = !(ch >= full * 0.95 && on);
        }
      }
      if (t >= strafeUntil) {
        strafeSign = -strafeSign;
        strafeUntil = t + rng.range(0.4, 1.1);
      }
      const ex = (enemy.pos[0] - x) / (enemyD || 1);
      const ey = (enemy.pos[1] - y) / (enemyD || 1);
      const want = w1?.kind === "lightning" ? Math.min(prefDist, 30) : prefDist;
      const low = me.hp < me.max_hp * retreatHp && (enemy.hp ?? 1e9) > me.hp * 0.6;
      let radial = enemyD > want + 10 ? 0.7 : enemyD < want - 10 ? -0.7 : 0;
      if (low)
        radial = -1;
      mx = ex * radial - ey * strafeSign;
      my = ey * radial + ex * strafeSign;
      boost = low && me.energy > 20;
      if (mustRotate) {
        const zx = (zn.next_center[0] - x) / (dNext || 1);
        const zy = (zn.next_center[1] - y) / (dNext || 1);
        mx = mx * 0.5 + zx;
        my = my * 0.5 + zy;
        boost = !me.in_zone;
      }
    } else {
      let gx = zn.next_center[0];
      let gy = zn.next_center[1];
      let goalD = dNext;
      let haveGoal = mustRotate;
      if (!mustRotate) {
        let bd = 90;
        for (const c of obs.cubes) {
          const d = Math.hypot(c.pos[0] - x, c.pos[1] - y);
          if (d < bd && Math.abs(c.pos[2] - z) < 6) {
            bd = d;
            gx = c.pos[0];
            gy = c.pos[1];
            haveGoal = true;
            goalD = d;
          }
        }
        if (!w1 || seekLightning && w1.kind === "laser") {
          for (const p of obs.pickups) {
            if (p.kind === "mortar" || p.kind === "gun")
              continue;
            if (w1 && p.kind !== "lightning")
              continue;
            const d = Math.hypot(p.pos[0] - x, p.pos[1] - y);
            const bonus = seekLightning && p.kind === "lightning" ? 60 : 20;
            if (d < bd + bonus && Math.abs(p.pos[2] - z) < 6) {
              bd = d - bonus;
              gx = p.pos[0];
              gy = p.pos[1];
              haveGoal = true;
              goalD = d;
            }
          }
        }
      }
      let shot = false;
      if (farm && w0?.kind === "gun" && (w0.reload ?? 0) <= 0 && me.hp > me.max_hp * 0.5) {
        let tgt = null;
        let td = 70;
        for (const c of obs.crates) {
          const d = Math.hypot(c.pos[0] - x, c.pos[1] - y);
          if (d < td) {
            td = d;
            tgt = { pos: c.pos, h: 1.2, r: 1.4 };
          }
        }
        if (npc && npcD < 60 && npcD < td + 15) {
          td = npcD;
          tgt = { pos: npc.pos, h: 1.75, r: 1.8, vel: npc.vel };
        }
        if (tgt) {
          const v = tgt.vel ?? [0, 0, 0];
          const d = aimAt(tgt.pos[0], tgt.pos[1], tgt.pos[2] + tgt.h, v[0], v[1], v[2], w0.stats.speed ?? 252);
          if (aimedWithin(d, tgt.r, tgt.h))
            fire[0] = true;
          shot = true;
          if (!haveGoal) {
            gx = tgt.pos[0];
            gy = tgt.pos[1];
            goalD = td;
            haveGoal = td > 25;
          }
        }
      }
      if (haveGoal && goalD > 1.5) {
        mx = (gx - x) / goalD;
        my = (gy - y) / goalD;
        boost = !me.in_zone && me.energy > 10;
      } else if (!shot) {
        if (dNext > zn.next_radius * 0.5) {
          mx = (zn.next_center[0] - x) / (dNext || 1) * 0.4;
          my = (zn.next_center[1] - y) / (dNext || 1) * 0.4;
        }
      }
      if (!haveAim) {
        if (t < lookUntil)
          wantYaw = lookYaw;
        else if (mx || my)
          wantYaw = Math.atan2(my, mx) + Math.sin(t * 1.3 + scanPhase) * 1.2;
        else
          wantYaw = me.aim[0] + 0.25;
        wantPitch = 0;
      }
      if (w0?.kind === "gun" && !fire[0] && (w0.ammo ?? 12) < (w0.stats.mag ?? 12) * 0.5 && (w0.reload ?? 0) <= 0)
        a.reload = true;
    }
    if (!w1 || seekLightning && w1.kind === "laser" && (w1.charge ?? 0) === 0) {
      const reach = cfg.loot.pickup_radius;
      for (const p of obs.pickups) {
        if (p.kind === "mortar" || p.kind === "gun")
          continue;
        if (w1 && p.kind !== "lightning")
          continue;
        if (Math.hypot(p.pos[0] - x, p.pos[1] - y) < reach && Math.abs(p.pos[2] - z) < 4) {
          a.take = p.id;
          if (w1)
            a.drop = 1;
          break;
        }
      }
    }
    const moved = Math.hypot(x - lastX, y - lastY);
    lastX = x;
    lastY = y;
    const cmd = Math.hypot(mx, my);
    if (cmd > 0.3 && moved < 0.25)
      stuckT += dt;
    else
      stuckT = Math.max(0, stuckT - dt * 2);
    if (stuckT > 0.5 && t > detourUntil) {
      detourUntil = t + 1.6;
      detourSign = rng.next() < 0.5 ? 1 : -1;
      stuckT = 0;
    }
    if (t < detourUntil && cmd > 0) {
      const c = Math.cos(0.9 * detourSign);
      const s = Math.sin(0.9 * detourSign);
      const nx = mx * c - my * s;
      const ny = mx * s + my * c;
      mx = nx;
      my = ny;
      if (me.grounded)
        a.jump = true;
      else if (me.energy > 15)
        boost = true;
    }
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    a.move = [mx, my];
    a.boost = boost;
    a.aim = [wrap(wantYaw), Math.max(-0.7, Math.min(1.3, wantPitch))];
    a.fire = fire;
    return a;
  };
  return { name: "simple", act };
};

// src/runner/run.ts
var log = (...a) => console.error(...a);
var send = (o) => process.stdout.write(JSON.stringify(o) + `
`);
function runProcess(opts) {
  let primary = null;
  let fallback = null;
  let primaryErrors = 0;
  let consecutive = 0;
  let disabled = false;
  let last = {};
  let buf = "";
  let queued = false;
  let slow = 0;
  const onHello = (hello) => {
    const t0 = performance.now();
    const seed = (hello.seed ?? 1) >>> 0;
    let world = null;
    try {
      if (opts.loadWorld)
        world = opts.loadWorld(hello.map.dir);
    } catch (e) {
      log("world load failed:", e);
    }
    const mk = (salt) => ({
      hello,
      world,
      params: opts.params ?? {},
      rng: makeRng(seed ^ salt),
      realtime: true,
      log: (m) => log(m)
    });
    try {
      fallback = simpleBot(mk(20907));
    } catch (e) {
      log("fallback construct failed:", e);
    }
    try {
      if (world || !opts.loadWorld)
        primary = opts.factory(mk(0));
      if (primary && opts.warmup)
        opts.warmup(primary, hello);
    } catch (e) {
      log("primary construct failed:", e);
      primary = null;
    }
    log(`ready in ${(performance.now() - t0).toFixed(0)} ms (world ${world ? "ok" : "none"}, primary ${primary ? "ok" : "none"})`);
    send({ type: "ready", name: opts.name.slice(0, 32) });
  };
  const onObs = (obs) => {
    const t0 = performance.now();
    let action = null;
    if (primary && !disabled) {
      try {
        action = primary.act(obs);
        consecutive = 0;
      } catch (e) {
        primaryErrors++;
        consecutive++;
        if (primaryErrors <= 5 || primaryErrors % 200 === 0)
          log(`act() failed at tick ${obs.tick} (${primaryErrors} so far):`, e);
        if (consecutive >= 30) {
          disabled = true;
          log("primary disabled after 30 consecutive failures");
        }
      }
    }
    if (!action && fallback) {
      try {
        action = fallback.act(obs);
      } catch (e) {
        if (primaryErrors < 5)
          log("fallback failed:", e);
      }
    }
    if (!action)
      action = { move: last.move, aim: last.aim, boost: last.boost };
    last = action;
    send(sanitize(action, obs.tick));
    const ms = performance.now() - t0;
    if (ms > 25 && ++slow <= 20)
      log(`slow decision ${ms.toFixed(1)} ms at tick ${obs.tick}`);
  };
  const handle = (lines) => {
    let latest = null;
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "hello")
        onHello(msg);
      else if (msg.type === "obs")
        latest = msg;
      else if (msg.type === "end") {
        try {
          primary?.end?.(msg);
        } catch {}
        process.exit(0);
      }
    }
    if (latest)
      onObs(latest);
  };
  const flush = () => {
    queued = false;
    const lines = buf.split(`
`);
    buf = lines.pop() ?? "";
    handle(lines.filter((l) => l.trim()));
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    if (queued)
      return;
    queued = true;
    setImmediate(flush);
  });
  process.stdin.on("end", () => {
    buf += `
`;
    flush();
    process.exit(0);
  });
}

// src/world/load.ts
import { readFileSync } from "fs";
import { join } from "path";

// src/world/raster.ts
function decodeTerrain(buf, nx, ny, scale) {
  const n = nx * ny;
  if (buf.byteLength < n * 2)
    throw new Error(`terrain.i16 too small: ${buf.byteLength} < ${n * 2}`);
  const out = new Float32Array(n);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let k = 0;k < n; k++)
    out[k] = dv.getInt16(k * 2, true) * scale;
  return out;
}
function bilinear(h, nx, ny, lx, ly) {
  if (lx < 0)
    lx = 0;
  else if (lx > nx - 1)
    lx = nx - 1;
  if (ly < 0)
    ly = 0;
  else if (ly > ny - 1)
    ly = ny - 1;
  let i = lx | 0;
  let j = ly | 0;
  if (i > nx - 2)
    i = nx - 2;
  if (j > ny - 2)
    j = ny - 2;
  const fx = lx - i;
  const fy = ly - j;
  const k = j * nx + i;
  const a = h[k];
  const b = h[k + 1];
  const c = h[k + nx];
  const d = h[k + nx + 1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}
function ringCrossings(ring, yc, xs, n) {
  const m = ring.length >> 1;
  if (m < 3)
    return n;
  let x0 = ring[2 * (m - 1)];
  let y0 = ring[2 * (m - 1) + 1];
  for (let v = 0;v < m; v++) {
    const x1 = ring[2 * v];
    const y1 = ring[2 * v + 1];
    if (y0 <= yc !== y1 <= yc) {
      xs[n++] = x0 + (yc - y0) * (x1 - x0) / (y1 - y0);
    }
    x0 = x1;
    y0 = y1;
  }
  return n;
}
function sortPrefix(xs, n) {
  for (let a = 1;a < n; a++) {
    const v = xs[a];
    let b = a - 1;
    while (b >= 0 && xs[b] > v) {
      xs[b + 1] = xs[b];
      b--;
    }
    xs[b + 1] = v;
  }
}
function fillPairs(xs, n, minX, nx, mask, val) {
  for (let p = 0;p + 1 < n; p += 2) {
    let i0 = Math.ceil(xs[p] - minX - 0.5);
    let i1 = Math.ceil(xs[p + 1] - minX - 0.5) - 1;
    if (i0 < 0)
      i0 = 0;
    if (i1 > nx - 1)
      i1 = nx - 1;
    for (let i = i0;i <= i1; i++)
      mask[i] = val;
  }
}
function buildRaster(terrain, nx, ny, minX, minY, prisms) {
  const ncell = nx * ny;
  const counts = new Int32Array(ncell + 1);
  let cap = 1 << 18;
  let eCell = new Int32Array(cap);
  let ePrism = new Int32Array(cap);
  let ne = 0;
  let maxVerts = 8;
  for (const p of prisms) {
    let v = p.ring.length >> 1;
    if (p.holes)
      for (const h of p.holes)
        v = Math.max(v, h.length >> 1);
    if (v > maxVerts)
      maxVerts = v;
  }
  const xs = new Float64Array(maxVerts + 4);
  const mask = new Uint8Array(nx);
  for (let pi = 0;pi < prisms.length; pi++) {
    const p = prisms[pi];
    const ring = p.ring;
    if (!(p.top > p.base) || ring.length < 6)
      continue;
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;
    for (let v = 0;v < ring.length; v += 2) {
      const x = ring[v];
      const y = ring[v + 1];
      if (x < bx0)
        bx0 = x;
      if (x > bx1)
        bx1 = x;
      if (y < by0)
        by0 = y;
      if (y > by1)
        by1 = y;
    }
    let j0 = Math.ceil(by0 - minY - 0.5);
    let j1 = Math.ceil(by1 - minY - 0.5) - 1;
    if (j0 < 0)
      j0 = 0;
    if (j1 > ny - 1)
      j1 = ny - 1;
    let i0 = Math.floor(bx0 - minX) - 1;
    let i1 = Math.ceil(bx1 - minX) + 1;
    if (i0 < 0)
      i0 = 0;
    if (i1 > nx - 1)
      i1 = nx - 1;
    const holes = p.holes;
    for (let j = j0;j <= j1; j++) {
      const yc = minY + j + 0.5;
      let n = ringCrossings(ring, yc, xs, 0);
      if (n < 2)
        continue;
      sortPrefix(xs, n);
      fillPairs(xs, n, minX, nx, mask, 1);
      if (holes) {
        for (let h = 0;h < holes.length; h++) {
          n = ringCrossings(holes[h], yc, xs, 0);
          if (n < 2)
            continue;
          sortPrefix(xs, n);
          fillPairs(xs, n, minX, nx, mask, 0);
        }
      }
      const row = j * nx;
      for (let i = i0;i <= i1; i++) {
        if (mask[i]) {
          mask[i] = 0;
          if (ne === cap) {
            cap *= 2;
            const a = new Int32Array(cap);
            a.set(eCell);
            eCell = a;
            const b = new Int32Array(cap);
            b.set(ePrism);
            ePrism = b;
          }
          eCell[ne] = row + i;
          ePrism[ne] = pi;
          ne++;
          counts[row + i + 1]++;
        }
      }
    }
  }
  for (let c = 0;c < ncell; c++)
    counts[c + 1] += counts[c];
  const slotBase = new Float32Array(ne);
  const slotTop = new Float32Array(ne);
  const fill = new Int32Array(ncell);
  for (let e = 0;e < ne; e++) {
    const c = eCell[e];
    const s = counts[c] + fill[c]++;
    const p = prisms[ePrism[e]];
    slotBase[s] = p.base;
    slotTop[s] = p.top;
  }
  const spanStart = new Int32Array(ncell + 1);
  const data = new Float32Array(ne * 2);
  const topZ = new Float32Array(ncell);
  let ns = 0;
  for (let j = 0;j < ny; j++) {
    const jn = j < ny - 1 ? j + 1 : j;
    for (let i = 0;i < nx; i++) {
      const c = j * nx + i;
      const inx = i < nx - 1 ? i + 1 : i;
      let tz = terrain[c];
      const t1 = terrain[j * nx + inx];
      const t2 = terrain[jn * nx + i];
      const t3 = terrain[jn * nx + inx];
      if (t1 > tz)
        tz = t1;
      if (t2 > tz)
        tz = t2;
      if (t3 > tz)
        tz = t3;
      spanStart[c] = ns;
      const s0 = counts[c];
      const s1 = counts[c + 1];
      if (s1 > s0) {
        for (let a = s0 + 1;a < s1; a++) {
          const vb = slotBase[a];
          const vt = slotTop[a];
          let b = a - 1;
          while (b >= s0 && slotBase[b] > vb) {
            slotBase[b + 1] = slotBase[b];
            slotTop[b + 1] = slotTop[b];
            b--;
          }
          slotBase[b + 1] = vb;
          slotTop[b + 1] = vt;
        }
        let cb = slotBase[s0];
        let ct = slotTop[s0];
        for (let a = s0 + 1;a < s1; a++) {
          if (slotBase[a] <= ct) {
            if (slotTop[a] > ct)
              ct = slotTop[a];
          } else {
            data[2 * ns] = cb;
            data[2 * ns + 1] = ct;
            ns++;
            cb = slotBase[a];
            ct = slotTop[a];
          }
        }
        data[2 * ns] = cb;
        data[2 * ns + 1] = ct;
        ns++;
        if (ct > tz)
          tz = ct;
      }
      topZ[c] = tz;
    }
  }
  spanStart[ncell] = ns;
  return { minX, minY, nx, ny, terrain, spanStart, spanData: data.slice(0, ns * 2), topZ };
}

// src/world/world.ts
var HIT_NONE = 0;
var HIT_TERRAIN = 1;
var HIT_PRISM = 2;
var TREE_BUCKET = 16;
function canopyBlockLength(density, blockT) {
  if (!(density > 0) || !(blockT > 0))
    return Infinity;
  return -Math.log(blockT) / density;
}

class GridWorld {
  minX;
  minY;
  maxX;
  maxY;
  nx;
  ny;
  bounds;
  spanStart;
  spanData;
  topZ;
  terrain;
  rules;
  trees;
  maxTopZ;
  lastHit = 0;
  canopyMaxPath;
  bnx;
  bny;
  bucketStart;
  bucketItems;
  treeStamp;
  stamp = 0;
  wallDistField = null;
  constructor(r, bounds, rules, trees) {
    this.minX = r.minX;
    this.minY = r.minY;
    this.nx = r.nx;
    this.ny = r.ny;
    this.maxX = r.minX + r.nx;
    this.maxY = r.minY + r.ny;
    this.bounds = bounds;
    this.spanStart = r.spanStart;
    this.spanData = r.spanData;
    this.topZ = r.topZ;
    this.terrain = r.terrain;
    this.rules = rules;
    this.trees = trees;
    let m = -Infinity;
    for (let c = 0;c < r.topZ.length; c++)
      if (r.topZ[c] > m)
        m = r.topZ[c];
    this.maxTopZ = m;
    this.canopyMaxPath = canopyBlockLength(rules.canopyDensity, rules.canopyBlockT);
    const B = TREE_BUCKET;
    const bnx = this.bnx = Math.ceil(r.nx / B);
    const bny = this.bny = Math.ceil(r.ny / B);
    const start = new Int32Array(bnx * bny + 1);
    const n = trees.n;
    const range = new Int32Array(n * 4);
    for (let k = 0;k < n; k++) {
      const x0 = Math.min(trees.x[k] - trees.trunkR[k], trees.cx[k] - trees.crownR[k]);
      const x1 = Math.max(trees.x[k] + trees.trunkR[k], trees.cx[k] + trees.crownR[k]);
      const y0 = Math.min(trees.y[k] - trees.trunkR[k], trees.cy[k] - trees.crownR[k]);
      const y1 = Math.max(trees.y[k] + trees.trunkR[k], trees.cy[k] + trees.crownR[k]);
      const i0 = clampInt(Math.floor((x0 - r.minX) / B), 0, bnx - 1);
      const i1 = clampInt(Math.floor((x1 - r.minX) / B), 0, bnx - 1);
      const j0 = clampInt(Math.floor((y0 - r.minY) / B), 0, bny - 1);
      const j1 = clampInt(Math.floor((y1 - r.minY) / B), 0, bny - 1);
      range[4 * k] = i0;
      range[4 * k + 1] = i1;
      range[4 * k + 2] = j0;
      range[4 * k + 3] = j1;
      for (let j = j0;j <= j1; j++)
        for (let i = i0;i <= i1; i++)
          start[j * bnx + i + 1]++;
    }
    for (let b = 0;b < bnx * bny; b++)
      start[b + 1] += start[b];
    const items = new Int32Array(start[bnx * bny]);
    const fill = new Int32Array(bnx * bny);
    for (let k = 0;k < n; k++) {
      for (let j = range[4 * k + 2];j <= range[4 * k + 3]; j++)
        for (let i = range[4 * k];i <= range[4 * k + 1]; i++) {
          const b = j * bnx + i;
          items[start[b] + fill[b]++] = k;
        }
    }
    this.bucketStart = start;
    this.bucketItems = items;
    this.treeStamp = new Int32Array(n);
  }
  cellIndex(x, y) {
    let i = Math.floor(x - this.minX);
    let j = Math.floor(y - this.minY);
    if (i < 0)
      i = 0;
    else if (i >= this.nx)
      i = this.nx - 1;
    if (j < 0)
      j = 0;
    else if (j >= this.ny)
      j = this.ny - 1;
    return j * this.nx + i;
  }
  inPrism(x, y) {
    const c = this.cellIndex(x, y);
    return this.spanStart[c + 1] > this.spanStart[c];
  }
  groundZ(x, y) {
    return bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY);
  }
  surfaceZ(x, y) {
    const g = bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY);
    const c = this.cellIndex(x, y);
    const e = this.spanStart[c + 1];
    if (e > this.spanStart[c]) {
      const t = this.spanData[2 * e - 1];
      if (t > g)
        return t;
    }
    return g;
  }
  floorZ(x, y, z, tol = 0.05) {
    const g = bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY);
    const c = this.cellIndex(x, y);
    const s = this.spanStart[c];
    const e = this.spanStart[c + 1];
    if (e === s)
      return g;
    const sd = this.spanData;
    const lim = z + tol;
    let best = -Infinity;
    let lowest = Infinity;
    let buried = false;
    for (let k = s;k < e; k++) {
      const b = sd[2 * k];
      const t = sd[2 * k + 1];
      if (b <= g && g < t)
        buried = true;
      if (t >= g) {
        if (t < lowest)
          lowest = t;
        if (t <= lim && t > best)
          best = t;
      }
    }
    if (!buried) {
      if (g < lowest)
        lowest = g;
      if (g <= lim && g > best)
        best = g;
    }
    return best > -Infinity ? best : lowest < Infinity ? lowest : g;
  }
  ceilZ(x, y, z) {
    const c = this.cellIndex(x, y);
    const e = this.spanStart[c + 1];
    const sd = this.spanData;
    for (let k = this.spanStart[c];k < e; k++) {
      if (sd[2 * k + 1] > z + 0.05)
        return sd[2 * k];
    }
    return Infinity;
  }
  solid(x, y, z) {
    if (x < this.minX || x >= this.maxX || y < this.minY || y >= this.maxY)
      return false;
    if (z < bilinear(this.terrain, this.nx, this.ny, x - this.minX, y - this.minY))
      return true;
    const c = this.cellIndex(x, y);
    const e = this.spanStart[c + 1];
    const sd = this.spanData;
    for (let k = this.spanStart[c];k < e; k++) {
      if (z > sd[2 * k] && z < sd[2 * k + 1])
        return true;
    }
    return false;
  }
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    this.lastHit = HIT_NONE;
    if (!(maxDist > 0))
      return 0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0) || !(len < Infinity) || !(ox - ox === 0) || !(oy - oy === 0) || !(oz - oz === 0))
      return maxDist;
    const missDist = maxDist;
    if (maxDist > 1e6)
      maxDist = 1e6;
    const inv = 1 / len;
    dx *= inv;
    dy *= inv;
    dz *= inv;
    const nx = this.nx;
    const ny = this.ny;
    const px = ox - this.minX;
    const py = oy - this.minY;
    let t = 0;
    if (px < 0 || px >= nx || py < 0 || py >= ny) {
      let t0 = 0;
      let t1 = maxDist;
      if (dx !== 0) {
        const a = -px / dx;
        const b = (nx - px) / dx;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      } else if (px < 0 || px >= nx)
        return missDist;
      if (dy !== 0) {
        const a = -py / dy;
        const b = (ny - py) / dy;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
      } else if (py < 0 || py >= ny)
        return missDist;
      if (t0 >= t1)
        return missDist;
      t = t0;
    }
    if (dz >= 0 && oz + dz * t > this.maxTopZ)
      return missDist;
    let i = Math.floor(px + dx * t);
    let j = Math.floor(py + dy * t);
    if (i < 0)
      i = 0;
    else if (i >= nx)
      i = nx - 1;
    if (j < 0)
      j = 0;
    else if (j >= ny)
      j = ny - 1;
    const stepI = dx > 0 ? 1 : -1;
    const stepJ = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tMaxX = dx > 0 ? (i + 1 - px) / dx : dx < 0 ? (i - px) / dx : Infinity;
    let tMaxY = dy > 0 ? (j + 1 - py) / dy : dy < 0 ? (j - py) / dy : Infinity;
    const topZ = this.topZ;
    const spanStart = this.spanStart;
    const sd = this.spanData;
    const h = this.terrain;
    let zIn = oz + dz * t;
    for (;; ) {
      const c = j * nx + i;
      let tOut = tMaxX < tMaxY ? tMaxX : tMaxY;
      let last = false;
      if (tOut >= maxDist) {
        tOut = maxDist;
        last = true;
      }
      const zOut = oz + dz * tOut;
      const zlo = zIn < zOut ? zIn : zOut;
      if (zlo <= topZ[c]) {
        const zhi = zIn < zOut ? zOut : zIn;
        let best = Infinity;
        let kind = HIT_NONE;
        const e = spanStart[c + 1];
        for (let k = spanStart[c];k < e; k++) {
          const b = sd[2 * k];
          const tp = sd[2 * k + 1];
          if (zlo < tp && zhi > b) {
            const th = zIn > b && zIn < tp ? t : zIn >= tp ? (tp - oz) / dz : (b - oz) / dz;
            if (th < best) {
              best = th;
              kind = HIT_PRISM;
            }
          }
        }
        const fIn = zIn - bilinear(h, nx, ny, px + dx * t, py + dy * t);
        if (fIn < 0) {
          if (t <= best) {
            best = t;
            kind = HIT_TERRAIN;
          }
        } else {
          const fOut = zOut - bilinear(h, nx, ny, px + dx * tOut, py + dy * tOut);
          const tm = 0.5 * (t + tOut);
          const fMid = oz + dz * tm - bilinear(h, nx, ny, px + dx * tm, py + dy * tm);
          const c2 = 2 * (fIn + fOut - 2 * fMid);
          const c1 = fOut - fIn - c2;
          let u = 2;
          if (Math.abs(c2) < 0.000000001) {
            if (fOut < 0)
              u = fIn / (fIn - fOut);
          } else {
            const disc = c1 * c1 - 4 * c2 * fIn;
            if (disc >= 0) {
              const q = -0.5 * (c1 + (c1 < 0 ? -1 : 1) * Math.sqrt(disc));
              const r1 = q / c2;
              const r2 = q !== 0 ? fIn / q : 2;
              if (r1 >= 0 && r1 <= 1)
                u = r1;
              if (r2 >= 0 && r2 <= 1 && r2 < u)
                u = r2;
            }
            if (u > 1 && fOut < 0)
              u = fIn / (fIn - fOut);
          }
          if (u <= 1) {
            const th = t + (tOut - t) * u;
            if (th < best) {
              best = th;
              kind = HIT_TERRAIN;
            }
          }
        }
        if (kind !== HIT_NONE) {
          this.lastHit = kind;
          return best < t ? t : best > maxDist ? missDist : best;
        }
      }
      if (last)
        return missDist;
      if (tMaxX < tMaxY) {
        i += stepI;
        if (i < 0 || i >= nx)
          return missDist;
        tMaxX += tDeltaX;
      } else {
        j += stepJ;
        if (j < 0 || j >= ny)
          return missDist;
        tMaxY += tDeltaY;
      }
      t = tOut;
      zIn = zOut;
    }
  }
  segClear(ax, ay, az, bx, by, bz) {
    if (ax > bx || ax === bx && (ay > by || ay === by && az > bz)) {
      const sx = ax;
      const sy = ay;
      const sz = az;
      ax = bx;
      ay = by;
      az = bz;
      bx = sx;
      by = sy;
      bz = sz;
    }
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0))
      return !this.solid(ax, ay, az);
    return this.raycast(ax, ay, az, dx, dy, dz, len) >= len;
  }
  sightClear(ax, ay, az, bx, by, bz) {
    if (!this.segClear(ax, ay, az, bx, by, bz))
      return false;
    return !this.treesBlock(ax, ay, az, bx, by, bz);
  }
  canopyPath(ax, ay, az, bx, by, bz) {
    return this.treeWalk(ax, ay, az, bx, by, bz, Infinity);
  }
  treesBlock(ax, ay, az, bx, by, bz) {
    return this.treeWalk(ax, ay, az, bx, by, bz, this.canopyMaxPath) > this.canopyMaxPath;
  }
  treeWalk(ax, ay, az, bx, by, bz, limit) {
    if (ax > bx || ax === bx && (ay > by || ay === by && az > bz)) {
      const sx = ax;
      const sy = ay;
      const sz = az;
      ax = bx;
      ay = by;
      az = bz;
      bx = sx;
      by = sy;
      bz = sz;
    }
    const B = TREE_BUCKET;
    const bnx = this.bnx;
    const bny = this.bny;
    const lx0 = (ax - this.minX) / B;
    const ly0 = (ay - this.minY) / B;
    const lx1 = (bx - this.minX) / B;
    const ly1 = (by - this.minY) / B;
    let i = Math.floor(lx0);
    let j = Math.floor(ly0);
    const iEnd = Math.floor(lx1);
    const jEnd = Math.floor(ly1);
    const ddx = lx1 - lx0;
    const ddy = ly1 - ly0;
    const stepI = ddx > 0 ? 1 : -1;
    const stepJ = ddy > 0 ? 1 : -1;
    const tDX = ddx !== 0 ? Math.abs(1 / ddx) : Infinity;
    const tDY = ddy !== 0 ? Math.abs(1 / ddy) : Infinity;
    let tMX = ddx > 0 ? (i + 1 - lx0) / ddx : ddx < 0 ? (i - lx0) / ddx : Infinity;
    let tMY = ddy > 0 ? (j + 1 - ly0) / ddy : ddy < 0 ? (j - ly0) / ddy : Infinity;
    let steps = Math.abs(iEnd - i) + Math.abs(jEnd - j);
    if (!(steps >= 0) || steps > 1e5)
      return 0;
    const Dx = bx - ax;
    const Dy = by - ay;
    const Dz = bz - az;
    const a2 = Dx * Dx + Dy * Dy;
    const segLen = Math.sqrt(a2 + Dz * Dz);
    const tr = this.trees;
    const stampArr = this.treeStamp;
    const stamp = ++this.stamp;
    const bs = this.bucketStart;
    const items = this.bucketItems;
    let acc = 0;
    for (;; ) {
      if (i >= 0 && i < bnx && j >= 0 && j < bny) {
        const b = j * bnx + i;
        const e = bs[b + 1];
        for (let q = bs[b];q < e; q++) {
          const k = items[q];
          if (stampArr[k] === stamp)
            continue;
          stampArr[k] = stamp;
          {
            const rx = ax - tr.x[k];
            const ry = ay - tr.y[k];
            const r = tr.trunkR[k];
            const cc = rx * rx + ry * ry - r * r;
            let s0 = 0;
            let s1 = 1;
            let hit = false;
            if (a2 < 0.000000000001)
              hit = cc <= 0;
            else {
              const hb = rx * Dx + ry * Dy;
              const disc = hb * hb - a2 * cc;
              if (disc >= 0) {
                const sq = Math.sqrt(disc);
                s0 = (-hb - sq) / a2;
                s1 = (-hb + sq) / a2;
                if (s0 < 0)
                  s0 = 0;
                if (s1 > 1)
                  s1 = 1;
                hit = s0 <= s1;
              }
            }
            if (hit) {
              const za = az + Dz * s0;
              const zb = az + Dz * s1;
              if ((za > zb ? za : zb) >= tr.z0[k] && (za < zb ? za : zb) <= tr.z1[k])
                return Infinity;
            }
          }
          {
            const R = tr.crownR[k];
            const V = tr.crownV[k];
            if (R > 0 && V > 0) {
              const kz = R / V;
              const rx = ax - tr.cx[k];
              const ry = ay - tr.cy[k];
              const rz = (az - tr.cz[k]) * kz;
              const ez = Dz * kz;
              const a3 = a2 + ez * ez;
              if (a3 > 0.000000000001) {
                const hb = rx * Dx + ry * Dy + rz * ez;
                const disc = hb * hb - a3 * (rx * rx + ry * ry + rz * rz - R * R);
                if (disc > 0) {
                  const sq = Math.sqrt(disc);
                  let s0 = (-hb - sq) / a3;
                  let s1 = (-hb + sq) / a3;
                  if (s0 < 0)
                    s0 = 0;
                  if (s1 > 1)
                    s1 = 1;
                  if (s1 > s0) {
                    acc += (s1 - s0) * segLen;
                    if (acc > limit)
                      return acc;
                  }
                }
              }
            }
          }
        }
      }
      if (steps-- <= 0)
        break;
      if (tMX < tMY) {
        i += stepI;
        tMX += tDX;
      } else {
        j += stepJ;
        tMY += tDY;
      }
    }
    return acc;
  }
  canSee(ex, ey, ez, yaw, tx, ty, tz, th, range, fovDeg, nearRange) {
    const dx = tx - ex;
    const dy = ty - ey;
    const zc = tz + th * 0.5;
    const dzc = zc - ez;
    const d2 = dx * dx + dy * dy + dzc * dzc;
    const zt = tz + th;
    if (d2 <= nearRange * nearRange) {
      return this.segClear(ex, ey, ez, tx, ty, zc) || this.segClear(ex, ey, ez, tx, ty, zt);
    }
    if (d2 > range * range)
      return false;
    if (dx !== 0 || dy !== 0) {
      let da = Math.atan2(dy, dx) - yaw;
      da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(da) > fovDeg * Math.PI / 360)
        return false;
    }
    return this.sightClear(ex, ey, ez, tx, ty, zc) || this.sightClear(ex, ey, ez, tx, ty, zt);
  }
  cellWalled(c, stepUp = 1.2, height = 9) {
    const s = this.spanStart[c];
    const e = this.spanStart[c + 1];
    if (e === s)
      return false;
    const i = c % this.nx;
    const j = (c - i) / this.nx;
    const g = bilinear(this.terrain, this.nx, this.ny, i + 0.5, j + 0.5);
    const sd = this.spanData;
    for (let k = s;k < e; k++) {
      if (sd[2 * k + 1] > g + stepUp && sd[2 * k] < g + height)
        return true;
    }
    return false;
  }
  wallDist() {
    if (this.wallDistField)
      return this.wallDistField;
    const nx = this.nx;
    const ny = this.ny;
    const INF = 1000000000000;
    const f = new Float64Array(nx * ny);
    const bd = this.bounds;
    for (let j = 0;j < ny; j++) {
      const y = this.minY + j + 0.5;
      for (let i = 0;i < nx; i++) {
        const x = this.minX + i + 0.5;
        const c = j * nx + i;
        const outside = x < bd.minX || x > bd.maxX || y < bd.minY || y > bd.maxY;
        f[c] = outside || this.cellWalled(c) ? 0 : INF;
      }
    }
    const n = Math.max(nx, ny);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const g = new Float64Array(n);
    const edt1d = (m) => {
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1;q < m; q++) {
        let s = 0;
        for (;; ) {
          const p = v[k];
          s = (g[q] + q * q - (g[p] + p * p)) / (2 * q - 2 * p);
          if (s <= z[k] && k > 0)
            k--;
          else
            break;
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0;q < m; q++) {
        while (z[k + 1] < q)
          k++;
        const p = v[k];
        d[q] = (q - p) * (q - p) + g[p];
      }
    };
    for (let i = 0;i < nx; i++) {
      for (let j = 0;j < ny; j++)
        g[j] = f[j * nx + i];
      edt1d(ny);
      for (let j = 0;j < ny; j++)
        f[j * nx + i] = d[j];
    }
    const out = new Float32Array(nx * ny);
    for (let j = 0;j < ny; j++) {
      for (let i = 0;i < nx; i++)
        g[i] = f[j * nx + i];
      edt1d(nx);
      for (let i = 0;i < nx; i++) {
        const r = Math.sqrt(d[i]) - 0.5;
        out[j * nx + i] = r > 0 ? r : 0;
      }
    }
    this.wallDistField = out;
    return out;
  }
}
function clampInt(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// src/world/load.ts
function buildTrees(t) {
  const fields = t?.fields ?? [];
  const data = t?.data ?? [];
  const stride = fields.length || 1;
  const n = fields.length ? Math.floor(data.length / stride) : 0;
  const col = (name) => fields.indexOf(name);
  const fx = col("x");
  const fy = col("y");
  const fz = col("z");
  const fh = col("height");
  const fr = col("crownR");
  const fb = col("crownBase");
  const ft = col("trunkR");
  const fcx = col("crownX");
  const fcy = col("crownY");
  const ts = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    z0: new Float64Array(n),
    z1: new Float64Array(n),
    trunkR: new Float64Array(n),
    cx: new Float64Array(n),
    cy: new Float64Array(n),
    cz: new Float64Array(n),
    crownR: new Float64Array(n),
    crownV: new Float64Array(n)
  };
  for (let k = 0;k < n; k++) {
    const o = k * stride;
    const x = data[o + fx];
    const y = data[o + fy];
    const z = data[o + fz];
    const h = fh >= 0 ? data[o + fh] : 0;
    const cb = fb >= 0 ? data[o + fb] : h;
    ts.x[k] = x;
    ts.y[k] = y;
    ts.z0[k] = z;
    ts.z1[k] = z + h;
    ts.trunkR[k] = ft >= 0 ? data[o + ft] : 0;
    ts.cx[k] = fcx >= 0 ? data[o + fcx] : x;
    ts.cy[k] = fcy >= 0 ? data[o + fcy] : y;
    ts.cz[k] = z + (cb + h) * 0.5;
    ts.crownR[k] = fr >= 0 ? data[o + fr] : 0;
    ts.crownV[k] = Math.max(0, (h - cb) * 0.5);
  }
  return ts;
}
function buildWorld(json, terrainBytes) {
  const t = json.terrain;
  if (t.step !== 1)
    throw new Error(`terrain.step ${t.step} not supported (expected 1 m)`);
  const terrain = decodeTerrain(terrainBytes, t.nx, t.ny, t.scale ?? 0.01);
  const raster = buildRaster(terrain, t.nx, t.ny, t.minX, t.minY, json.prisms ?? []);
  const rules = {
    maxStep: json.rules?.maxStep ?? 1.5,
    maxSlopeDeg: json.rules?.maxSlopeDeg ?? 50,
    canopyDensity: json.rules?.canopyDensity ?? 0.35,
    canopyBlockT: json.rules?.canopyBlockT ?? 0.25
  };
  return new GridWorld(raster, { ...json.bounds }, rules, buildTrees(json.trees));
}
function loadWorld(dir) {
  const json = JSON.parse(readFileSync(join(dir, "v2", "world.json"), "utf8"));
  const bytes = readFileSync(join(dir, "v2", json.terrain.file ?? "terrain.i16"));
  return buildWorld(json, bytes);
}
// src/bot/perception/tracker.ts
var W_GUN = 1;
var W_MORTAR = 2;
var W_LASER = 4;
var W_LIGHTNING = 8;
function weaponBit(kind) {
  return kind === "gun" ? W_GUN : kind === "mortar" ? W_MORTAR : kind === "laser" ? W_LASER : kind === "lightning" ? W_LIGHTNING : 0;
}
var PI = Math.PI;
var TAU2 = 2 * Math.PI;
function wrapPi(a) {
  a = (a + PI) % TAU2;
  if (a < 0)
    a += TAU2;
  return a - PI;
}

class Track {
  id = -1;
  npc = false;
  known = false;
  visible = false;
  inView = false;
  dead = false;
  tDead = -1;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  ax = 0;
  ay = 0;
  az = 0;
  vxAvg = 0;
  vyAvg = 0;
  velJitter = 0;
  aimYaw = 0;
  aimPitch = 0;
  aimYawRate = 0;
  hp = -1;
  maxHp = -1;
  cubes = 0;
  weapons = 0;
  charging = false;
  tChargeStart = -1;
  radius = 2.5;
  height = 9;
  tSeen = -1e9;
  tFirstSeen = -1e9;
  tInView = -1e9;
  tBeamFix = -1e9;
  dist = Infinity;
  bearing = 0;
  aimErr = PI;
  aimingAtUs = false;
  tAimedAtUs = -1e9;
  dmgToUs = 0;
  dmgToUsRecent = 0;
  hitsOnUs = 0;
  rearHitsOnUs = 0;
  tShotAtUs = -1e9;
  lastHitBearing = 0;
  weaponsUsedOnUs = 0;
  dmgFromUs = 0;
  tHitByUs = -1e9;
  hpDropUnexplained = 0;
  tHpDropUnexplained = -1e9;
  threat = 0;
  _present = false;
  _hitNow = 0;
  constructor(id) {
    this.id = id;
    this.npc = id >= 100;
    if (this.npc) {
      this.radius = 1.8;
      this.height = 3.5;
    }
  }
  age(t) {
    const a = t - this.tSeen;
    const b = t - this.tBeamFix;
    return a < b ? a : b;
  }
}

class EnemyTracker {
  mechs = [];
  npcs = [];
  visible = [];
  nVisible = 0;
  selfId = -1;
  t = 0;
  dt = 0.1;
  alive = 16;
  ourKills = 0;
  otherDeaths = 0;
  tLastOtherDeath = -1e9;
  dmgTaken = 0;
  dmgTakenRecent = 0;
  tDamaged = -1e9;
  world;
  visRange = 200;
  visFov = 120;
  visNear = 45;
  memoryS = 5;
  mechRadius = 2.5;
  mechHeight = 9;
  sizePerCube = 0.05;
  nMechs = 16;
  started = false;
  constructor(config, world) {
    this.world = world ?? null;
    if (config) {
      this.visRange = config.vision.range;
      this.visFov = config.vision.fov_deg;
      this.visNear = config.vision.near_range;
      this.memoryS = config.vision.memory_s ?? 5;
      this.mechRadius = config.mech.radius ?? 2.5;
      this.mechHeight = config.mech.height ?? 9;
      this.sizePerCube = config.cubes.size_per_cube ?? 0.05;
      this.nMechs = config.match.mechs ?? 16;
    }
    for (let i = 0;i < this.nMechs; i++) {
      this.mechs.push(new Track(i));
      this.visible.push(this.mechs[i]);
    }
    this.alive = this.nMechs;
  }
  get(id) {
    if (id >= 0 && id < this.mechs.length)
      return this.mechs[id];
    for (let i = 0;i < this.npcs.length; i++)
      if (this.npcs[i].id === id)
        return this.npcs[i];
    return null;
  }
  getOrCreate(id) {
    if (id < 0)
      return null;
    if (id < this.mechs.length)
      return this.mechs[id];
    if (id < 100)
      return null;
    for (let i = 0;i < this.npcs.length; i++)
      if (this.npcs[i].id === id)
        return this.npcs[i];
    const tr = new Track(id);
    this.npcs.push(tr);
    return tr;
  }
  update(obs) {
    const self = obs.self;
    const t = obs.t;
    let dt = this.started ? t - this.t : 0.1;
    if (dt <= 0)
      dt = 0.1;
    const contiguous = this.started && dt < 0.16;
    this.dt = dt;
    this.t = t;
    this.selfId = self.id;
    this.started = true;
    const sx = self.pos[0], sy = self.pos[1], sz = self.pos[2];
    const selfR = self.stats.radius ?? 2.5;
    const eyeZ = sz + (self.stats.eye_height ?? 8);
    const decay = Math.exp(-dt / 5);
    this.dmgTakenRecent *= decay;
    const mechs = this.mechs;
    const npcs = this.npcs;
    for (let i = 0;i < mechs.length; i++) {
      const tr = mechs[i];
      tr._present = false;
      tr._hitNow = 0;
      tr.hpDropUnexplained = 0;
      tr.dmgToUsRecent *= decay;
    }
    for (let i = 0;i < npcs.length; i++) {
      const tr = npcs[i];
      tr._present = false;
      tr._hitNow = 0;
      tr.hpDropUnexplained = 0;
      tr.dmgToUsRecent *= decay;
    }
    let killsNow = 0;
    const events = obs.events;
    for (let i = 0;i < events.length; i++) {
      const e = events[i];
      if (e.type === "damaged") {
        if (e.by === null || e.by === undefined)
          continue;
        this.dmgTaken += e.amount;
        this.dmgTakenRecent += e.amount;
        this.tDamaged = t;
        const tr = this.getOrCreate(e.by);
        if (!tr)
          continue;
        tr.dmgToUs += e.amount;
        tr.dmgToUsRecent += e.amount;
        tr.hitsOnUs++;
        if (e.rear)
          tr.rearHitsOnUs++;
        tr.tShotAtUs = t;
        if (e.bearing !== null && e.bearing !== undefined)
          tr.lastHitBearing = e.bearing;
        const b = weaponBit(e.weapon);
        tr.weaponsUsedOnUs |= b;
        tr.weapons |= b;
      } else if (e.type === "hit") {
        const tr = this.getOrCreate(e.target);
        if (!tr)
          continue;
        tr.dmgFromUs += e.amount;
        tr.tHitByUs = t;
        tr._hitNow += e.amount;
      } else if (e.type === "kill") {
        killsNow++;
        this.ourKills++;
        const tr = this.getOrCreate(e.target);
        if (tr) {
          tr.dead = true;
          tr.tDead = t;
        }
      }
    }
    let nv = 0;
    const list = obs.mechs;
    for (let i = 0;i < list.length; i++) {
      const m = list[i];
      const tr = this.getOrCreate(m.id);
      if (!tr || m.id === self.id)
        continue;
      const wasFresh = contiguous && tr.visible;
      const px = m.pos[0], py = m.pos[1], pz = m.pos[2];
      const vx = m.vel[0], vy = m.vel[1], vz = m.vel[2];
      if (wasFresh) {
        const k = 0.5;
        tr.ax += k * ((vx - tr.vx) / dt - tr.ax);
        tr.ay += k * ((vy - tr.vy) / dt - tr.ay);
        tr.az += k * ((vz - tr.vz) / dt - tr.az);
        tr.aimYawRate = wrapPi(m.aim[0] - tr.aimYaw) / dt;
        const ka = 1 - Math.exp(-dt / 0.6);
        tr.vxAvg += ka * (vx - tr.vxAvg);
        tr.vyAvg += ka * (vy - tr.vyAvg);
        const ex = vx - tr.vxAvg, ey = vy - tr.vyAvg;
        const kj = 1 - Math.exp(-dt / 1.5);
        tr.velJitter = Math.sqrt(tr.velJitter * tr.velJitter + kj * (ex * ex + ey * ey - tr.velJitter * tr.velJitter));
      } else {
        tr.ax = 0;
        tr.ay = 0;
        tr.az = 0;
        tr.aimYawRate = 0;
        tr.vxAvg = vx;
        tr.vyAvg = vy;
        tr.velJitter = tr.npc ? 2 : 6;
      }
      if (m.hp !== undefined) {
        if (wasFresh && tr.hp >= 0) {
          const drop = tr.hp - m.hp - tr._hitNow;
          if (drop > 0.5) {
            tr.hpDropUnexplained = drop;
            tr.tHpDropUnexplained = t;
          }
        }
        tr.hp = m.hp;
      }
      if (m.max_hp !== undefined)
        tr.maxHp = m.max_hp;
      tr.x = px;
      tr.y = py;
      tr.z = pz;
      tr.vx = vx;
      tr.vy = vy;
      tr.vz = vz;
      tr.aimYaw = m.aim[0];
      tr.aimPitch = m.aim[1];
      if (!tr.npc) {
        tr.cubes = m.cubes ?? 0;
        const s = 1 + this.sizePerCube * tr.cubes;
        tr.radius = this.mechRadius * s;
        tr.height = this.mechHeight * s;
        if (m.weapons) {
          let mask = 0;
          for (let j = 0;j < m.weapons.length; j++)
            mask |= weaponBit(m.weapons[j]);
          tr.weapons = mask;
        }
        const ch = m.charging === true;
        if (ch && !tr.charging)
          tr.tChargeStart = t;
        if (!ch)
          tr.tChargeStart = -1;
        tr.charging = ch;
      }
      if (!tr.known)
        tr.tFirstSeen = t;
      tr.known = true;
      tr.tSeen = t;
      tr._present = true;
      if (tr.dead) {
        tr.dead = false;
        tr.tDead = -1;
      }
      const dx = px - sx, dy = py - sy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let inView;
      if (this.world) {
        inView = this.world.canSee(sx, sy, eyeZ, self.aim[0], px, py, pz, tr.height, this.visRange + (self.stats.vision_bonus ?? 0), this.visFov, this.visNear + (self.stats.near_range_bonus ?? 0));
      } else {
        inView = d <= this.visNear + (self.stats.near_range_bonus ?? 0) || d <= this.visRange + (self.stats.vision_bonus ?? 0) && Math.abs(wrapPi(Math.atan2(dy, dx) - self.aim[0])) <= 0.5 * this.visFov * PI / 180;
      }
      tr.inView = inView;
      if (inView)
        tr.tInView = t;
      if (!tr.npc)
        this.visible[nv++] = tr;
    }
    this.nVisible = nv;
    const beams = obs.beams;
    for (let i = 0;i < beams.length; i++) {
      const b = beams[i];
      const tr = this.getOrCreate(b.by);
      if (!tr || b.by === self.id)
        continue;
      tr.weapons |= weaponBit(b.kind);
      if (!tr._present && b.path.length > 0) {
        const p = b.path[0];
        tr.x = p[0];
        tr.y = p[1];
        tr.z = p[2] - 7 * (tr.height / this.mechHeight);
        tr.vx = 0;
        tr.vy = 0;
        tr.vz = 0;
        if (b.path.length > 1) {
          const q = b.path[1];
          tr.aimYaw = Math.atan2(q[1] - p[1], q[0] - p[0]);
        }
        tr.known = true;
        tr.tBeamFix = t - b.age;
      }
    }
    const drop = this.alive - obs.alive;
    if (drop > 0) {
      let unexplained = drop - killsNow;
      if (unexplained > 0) {
        this.otherDeaths += unexplained;
        this.tLastOtherDeath = t;
        while (unexplained > 0) {
          let best = null;
          for (let i = 0;i < mechs.length; i++) {
            const tr = mechs[i];
            if (tr.dead || tr._present || !tr.visible || !contiguous)
              continue;
            if (t - tr.tInView > this.memoryS - 0.5)
              continue;
            if (!best || tr.hp < best.hp)
              best = tr;
          }
          if (!best)
            break;
          best.dead = true;
          best.tDead = t;
          unexplained--;
        }
      }
    }
    this.alive = obs.alive;
    for (let i = 0;i < mechs.length; i++)
      this.relate(mechs[i], sx, sy, selfR, t);
    for (let i = 0;i < npcs.length; i++)
      this.relate(npcs[i], sx, sy, selfR, t);
  }
  relate(tr, sx, sy, selfR, t) {
    tr.visible = tr._present;
    if (!tr._present) {
      tr.inView = false;
      tr.charging = false;
      tr.tChargeStart = -1;
      tr.aimYawRate = 0;
    }
    if (!tr.known || tr.id === this.selfId) {
      tr.threat = 0;
      tr.aimingAtUs = false;
      return;
    }
    const dx = tr.x - sx, dy = tr.y - sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    tr.dist = d;
    tr.bearing = Math.atan2(dy, dx);
    tr.aimErr = Math.abs(wrapPi(tr.aimYaw - Math.atan2(-dy, -dx)));
    tr.aimingAtUs = tr.visible && !tr.dead && tr.aimErr < Math.atan2(selfR + 1.5, d) + 0.05;
    if (tr.aimingAtUs)
      tr.tAimedAtUs = t;
    if (tr.dead) {
      tr.threat = 0;
      return;
    }
    let th = 0;
    if (tr.npc) {
      th = d < 90 ? 0.25 : 0;
    } else {
      const w = tr.weapons === 0 ? W_GUN : tr.weapons;
      if (w & W_GUN && d < 240)
        th += d < 80 ? 1.2 : d < 160 ? 0.9 : 0.5;
      if (w & W_LASER && d < 290)
        th += 1.6;
      if (w & W_LIGHTNING)
        th += d < 50 ? 2 : d < 80 ? 0.6 : 0;
      if (w & W_MORTAR && d < 240)
        th += 0.7;
      th *= 1 + 0.04 * (tr.cubes < 10 ? tr.cubes : 10);
    }
    th *= tr.aimingAtUs ? 1.5 : tr.aimErr < 1.05 ? 1 : 0.6;
    if (tr.charging && tr.aimErr < 0.5)
      th += 2;
    th += tr.dmgToUsRecent / 150;
    if (!tr.visible)
      th *= Math.exp(-tr.age(t) / 4);
    tr.threat = th;
  }
  mostThreatening() {
    let best = null;
    for (let i = 0;i < this.nVisible; i++) {
      const tr = this.visible[i];
      if (!best || tr.threat > best.threat)
        best = tr;
    }
    return best;
  }
  nearestVisible() {
    let best = null;
    for (let i = 0;i < this.nVisible; i++) {
      const tr = this.visible[i];
      if (!best || tr.dist < best.dist)
        best = tr;
    }
    return best;
  }
  knownDead() {
    let n = 0;
    for (let i = 0;i < this.mechs.length; i++)
      if (this.mechs[i].dead)
        n++;
    return n;
  }
  leadVelocity(tr, tof, out) {
    let w = (tof - 0.15) / 0.45;
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    out.x = tr.vx + w * (tr.vxAvg - tr.vx);
    out.y = tr.vy + w * (tr.vyAvg - tr.vy);
    out.z = tr.vz * (1 - w);
  }
  predict(tr, dt, out, accelHorizon = 0) {
    const ta = dt < accelHorizon ? dt : accelHorizon;
    out.x = tr.x + tr.vx * dt + tr.ax * ta * (dt - 0.5 * ta);
    out.y = tr.y + tr.vy * dt + tr.ay * ta * (dt - 0.5 * ta);
    out.z = tr.z + tr.vz * dt;
  }
}

// src/bot/perception/sounds.ts
var SOUND_KINDS = ["step", "boost", "reload", "gun", "mortar", "explosion", "laser_charge", "laser", "lightning", "jet", "death", "crate", "npc_gun", "drop"];
var S_STEP = 0;
var S_BOOST = 1;
var S_RELOAD = 2;
var S_GUN = 3;
var S_MORTAR = 4;
var S_EXPLOSION = 5;
var S_LASER_CHARGE = 6;
var S_LASER = 7;
var S_LIGHTNING = 8;
var S_JET = 9;
var NK = SOUND_KINDS.length;
var D_NEAR = 0;
var D_MID = 1;
var D_FAR = 2;
var DEFAULT_RANGE = [40, 90, 60, 320, 420, 420, 140, 380, 160, 90, 600, 220, 200, 600];
var HEAT_W = [0.5, 0.6, 0.6, 1, 1, 0.6, 1.2, 1.2, 1.2, 0.6, 0.3, 0.4, 0.3, 0];
function soundKindIndex(kind) {
  for (let i = 0;i < NK; i++)
    if (SOUND_KINDS[i] === kind)
      return i;
  return -1;
}
var EV_CAP = 64;

class SoundMap {
  minX;
  minY;
  cell;
  nx;
  ny;
  heat;
  halfLife;
  evKind = new Int8Array(EV_CAP);
  evDist = new Int8Array(EV_CAP);
  evT = new Float32Array(EV_CAP);
  evBearing = new Float32Array(EV_CAP);
  evX = new Float32Array(EV_CAP);
  evY = new Float32Array(EV_CAP);
  evHead = 0;
  evCount = 0;
  lastHeard = new Float64Array(NK * 3).fill(-1e9);
  count = new Int32Array(NK);
  near = 60;
  mid = 160;
  sigma = 7 * Math.PI / 180;
  range = new Float32Array(DEFAULT_RANGE);
  t = -1;
  constructor(cfg, minX = -513, minY = -334, maxX = 557, maxY = 390, cell = 32, halfLife = 4) {
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell));
    this.heat = new Float32Array(this.nx * this.ny);
    this.halfLife = halfLife;
    if (cfg) {
      this.near = cfg.near;
      this.mid = cfg.mid;
      this.sigma = cfg.bearing_noise_deg * Math.PI / 180;
      for (let i = 0;i < NK; i++) {
        const r = cfg.range[SOUND_KINDS[i]];
        if (typeof r === "number")
          this.range[i] = r;
      }
    }
  }
  update(obs) {
    const t = obs.t;
    if (this.t >= 0) {
      const dt = t - this.t;
      if (dt > 0) {
        const k = Math.pow(0.5, dt / this.halfLife);
        const h = this.heat;
        for (let i = 0;i < h.length; i++)
          h[i] *= k;
      }
    }
    this.t = t;
    const sx = obs.self.pos[0], sy = obs.self.pos[1];
    const hearing = obs.self.stats.hearing ?? 1;
    const sounds = obs.sounds;
    for (let i = 0;i < sounds.length; i++) {
      const s = sounds[i];
      const k = soundKindIndex(s.kind);
      if (k < 0)
        continue;
      const b = s.dist === "near" ? D_NEAR : s.dist === "mid" ? D_MID : D_FAR;
      const r0 = b === D_NEAR ? 0 : b === D_MID ? this.near : this.mid;
      let r1 = b === D_NEAR ? this.near : b === D_MID ? this.mid : this.range[k] * hearing;
      if (r1 < r0 + 10)
        r1 = r0 + 10;
      const ts = t - s.age;
      this.lastHeard[k * 3 + b] = ts;
      this.count[k]++;
      const rm = 0.5 * (r0 + r1);
      const e = this.evHead;
      this.evKind[e] = k;
      this.evDist[e] = b;
      this.evT[e] = ts;
      this.evBearing[e] = s.bearing;
      this.evX[e] = sx + rm * Math.cos(s.bearing);
      this.evY[e] = sy + rm * Math.sin(s.bearing);
      this.evHead = (e + 1) % EV_CAP;
      if (this.evCount < EV_CAP)
        this.evCount++;
      const w = HEAT_W[k];
      if (w > 0)
        this.splat(sx, sy, s.bearing, r0, r1, w);
    }
  }
  splat(sx, sy, bearing, r0, r1, w) {
    const NA = 7;
    const nr = Math.max(1, Math.round((r1 - r0) / this.cell));
    const per = w / (nr * 3.6943);
    for (let a = 0;a < NA; a++) {
      const u = -2 + 4 * a / (NA - 1);
      const g = Math.exp(-0.5 * u * u) * per;
      const ang = bearing + u * this.sigma;
      const c = Math.cos(ang), s = Math.sin(ang);
      for (let k = 0;k < nr; k++) {
        const r = r0 + (k + 0.5) * (r1 - r0) / nr;
        const i = Math.floor((sx + r * c - this.minX) / this.cell);
        const j = Math.floor((sy + r * s - this.minY) / this.cell);
        if (i < 0 || j < 0 || i >= this.nx || j >= this.ny)
          continue;
        this.heat[j * this.nx + i] += g;
      }
    }
  }
  heatAt(x, y) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((y - this.minY) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny)
      return 0;
    return this.heat[j * this.nx + i];
  }
  hottest(out, minHeat = 0.05) {
    const n = out.length;
    for (let k = 0;k < n; k++) {
      out[k].heat = 0;
      out[k].x = 0;
      out[k].y = 0;
    }
    const h = this.heat;
    let found = 0;
    for (let c = 0;c < h.length; c++) {
      const v = h[c];
      if (v < minHeat || found === n && v <= out[n - 1].heat)
        continue;
      let p = found < n ? found : n - 1;
      while (p > 0 && out[p - 1].heat < v) {
        out[p].heat = out[p - 1].heat;
        out[p].x = out[p - 1].x;
        out[p].y = out[p - 1].y;
        p--;
      }
      out[p].heat = v;
      out[p].x = this.minX + (c % this.nx + 0.5) * this.cell;
      out[p].y = this.minY + (Math.floor(c / this.nx) + 0.5) * this.cell;
      if (found < n)
        found++;
    }
    return found;
  }
  since(kind, maxBucket = D_FAR) {
    let best = -1e9;
    for (let b = 0;b <= maxBucket; b++) {
      const v = this.lastHeard[kind * 3 + b];
      if (v > best)
        best = v;
    }
    return best < -1e8 ? Infinity : this.t - best;
  }
  weaponsHeard(maxBucket = D_NEAR, window = 3) {
    let m = 0;
    if (this.since(S_GUN, maxBucket) <= window)
      m |= 1;
    if (this.since(S_MORTAR, maxBucket) <= window || this.since(S_EXPLOSION, maxBucket) <= window)
      m |= 2;
    if (this.since(S_LASER, maxBucket) <= window || this.since(S_LASER_CHARGE, maxBucket) <= window)
      m |= 4;
    if (this.since(S_LIGHTNING, maxBucket) <= window)
      m |= 8;
    return m;
  }
  movementNear(window = 1.5) {
    return this.since(S_STEP, D_NEAR) <= window || this.since(S_BOOST, D_NEAR) <= window || this.since(S_JET, D_NEAR) <= window || this.since(S_RELOAD, D_NEAR) <= window;
  }
}

// src/bot/perception/mode.ts
var MODE_UNKNOWN = 0;
var MODE_SQUAD = 1;
var MODE_FFA = 2;
var PI2 = Math.PI;
var TAU3 = 2 * Math.PI;
function wrapPi2(a) {
  a = (a + PI2) % TAU3;
  if (a < 0)
    a += TAU3;
  return a - PI2;
}
var SEEN_CAP = 64;

class ModeDetector {
  logOdds = 0;
  mode = MODE_UNKNOWN;
  locked = false;
  tDecided = -1;
  otherDeaths = 0;
  beamHits = 0;
  hpDrops = 0;
  strayBullets = 0;
  crossAimObs = 0;
  farSounds = 0;
  peaceObs = 0;
  enter = 3;
  exit = 1;
  prevAlive = -1;
  t = -1;
  crossAimSum = 0;
  soundSum = 0;
  seenProj = new Int32Array(SEEN_CAP).fill(-1);
  seenHead = 0;
  startRadius;
  nMechs;
  constructor(nMechs = 16, zoneStartRadius = 560) {
    this.nMechs = nMechs;
    this.startRadius = zoneStartRadius;
  }
  get pFFA() {
    return 1 / (1 + Math.exp(-this.logOdds));
  }
  update(obs, tracker) {
    const t = obs.t;
    const dt = this.t >= 0 && t > this.t ? t - this.t : 0.1;
    const contiguous = this.t >= 0 && dt < 0.16;
    this.t = t;
    const self = obs.self;
    const sx = self.pos[0], sy = self.pos[1];
    let add = 0;
    if (this.prevAlive < 0)
      this.prevAlive = Math.max(obs.alive, this.nMechs);
    let died = this.prevAlive - obs.alive;
    this.prevAlive = obs.alive;
    if (died > 0) {
      const ev = obs.events;
      for (let i = 0;i < ev.length; i++)
        if (ev[i].type === "kill")
          died--;
      if (died > 0) {
        this.otherDeaths += died;
        const z = obs.zone;
        const early = z.radius >= 0.9 * this.startRadius || t < 100;
        const endGame = z.radius < 80;
        if (early) {
          add += 6 * died;
          this.locked = true;
        } else
          add += (endGame ? 0.7 : 2.5) * died;
      }
    }
    const beams = obs.beams;
    const list = obs.mechs;
    for (let i = 0;i < beams.length; i++) {
      const b = beams[i];
      if (b.by === self.id)
        continue;
      let hit = false;
      for (let p = 1;p < b.path.length && !hit; p++) {
        const q = b.path[p];
        for (let j = 0;j < list.length; j++) {
          const m = list[j];
          if (m.kind !== "mech" || m.id === b.by || m.id === self.id)
            continue;
          const s = 1 + 0.05 * (m.cubes ?? 0);
          const dx = q[0] - m.pos[0], dy = q[1] - m.pos[1];
          const r = 2.5 * s + 2.5;
          if (dx * dx + dy * dy <= r * r && q[2] >= m.pos[2] - 2 && q[2] <= m.pos[2] + 9 * s + 2) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        this.beamHits++;
        add += 3;
      }
    }
    const projs = obs.projectiles;
    for (let i = 0;i < projs.length; i++) {
      const p = projs[i];
      if (p.kind !== "gun")
        continue;
      const vx = p.vel[0], vy = p.vel[1];
      const vv = vx * vx + vy * vy;
      if (vv < 1)
        continue;
      const rx = sx - p.pos[0], ry = sy - p.pos[1];
      const cross = (rx * vy - ry * vx) / Math.sqrt(vv);
      if (Math.abs(cross) < 10)
        continue;
      let target = false;
      for (let j = 0;j < list.length; j++) {
        const m = list[j];
        if (m.kind !== "mech")
          continue;
        const mx = m.pos[0] - p.pos[0], my = m.pos[1] - p.pos[1];
        const along = (mx * vx + my * vy) / vv;
        if (along < 0 || along > 0.9)
          continue;
        const off = Math.abs(mx * vy - my * vx) / Math.sqrt(vv);
        const zAt = p.pos[2] + p.vel[2] * along;
        if (off <= 2.5 * (1 + 0.05 * (m.cubes ?? 0)) + 1 && zAt >= m.pos[2] - 1 && zAt <= m.pos[2] + 11) {
          target = true;
          break;
        }
      }
      if (!target)
        continue;
      let seen = false;
      for (let k = 0;k < SEEN_CAP; k++) {
        if (this.seenProj[k] === p.id) {
          seen = true;
          break;
        }
      }
      if (seen)
        continue;
      this.seenProj[this.seenHead] = p.id;
      this.seenHead = (this.seenHead + 1) % SEEN_CAP;
      this.strayBullets++;
      add += 0.6;
    }
    if (tracker) {
      const z = obs.zone;
      for (let i = 0;i < tracker.nVisible; i++) {
        const tr = tracker.visible[i];
        if (tr.hpDropUnexplained < 40)
          continue;
        const dx = tr.x - z.center[0], dy = tr.y - z.center[1];
        if (dx * dx + dy * dy > (z.radius - 5) * (z.radius - 5))
          continue;
        this.hpDrops++;
        add += 2.5;
      }
      let crossAim = false;
      let peace = 0;
      let peaceHostile = 0;
      for (let i = 0;i < tracker.nVisible; i++) {
        const a = tracker.visible[i];
        for (let j = i + 1;j < tracker.nVisible; j++) {
          const b = tracker.visible[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 200 || d < 0.1)
            continue;
          const bab = Math.atan2(dy, dx);
          const ea = Math.abs(wrapPi2(a.aimYaw - bab));
          const eb = Math.abs(wrapPi2(b.aimYaw - bab - PI2));
          const aOnB = ea < Math.atan2(b.radius + 1, d) + 0.035 && !this.alongUs(a, bab, sx, sy);
          const bOnA = eb < Math.atan2(a.radius + 1, d) + 0.035 && !this.alongUs(b, bab + PI2, sx, sy);
          if (aOnB || bOnA)
            crossAim = true;
          else if (d < 120 && (ea < 1.05 || d < 45) && (eb < 1.05 || d < 45)) {
            peace++;
            if (t - a.tShotAtUs < 3 && t - b.tShotAtUs < 3)
              peaceHostile++;
          }
        }
      }
      if (crossAim && contiguous) {
        this.crossAimObs++;
        if (this.crossAimSum < 2) {
          this.crossAimSum += 0.08;
          add += 0.08;
        }
      } else if (peace > 0 && contiguous) {
        this.peaceObs++;
        add -= peaceHostile > 0 ? 0.15 : 0.05;
      }
      if (this.soundSum < 1.5 && t - tracker.tDamaged > 3) {
        let aimed = false;
        for (let i = 0;i < tracker.nVisible; i++) {
          if (t - tracker.visible[i].tAimedAtUs < 1.5) {
            aimed = true;
            break;
          }
        }
        if (!aimed) {
          const snd = obs.sounds;
          for (let i = 0;i < snd.length; i++) {
            const s = snd[i];
            if (s.dist === "near")
              continue;
            if (s.kind === "gun" || s.kind === "laser" || s.kind === "mortar" || s.kind === "explosion" || s.kind === "lightning") {
              this.farSounds++;
              this.soundSum += 0.04;
              add += 0.04;
            }
          }
        }
      }
    }
    if (this.otherDeaths === 0 && t > 20)
      add -= 0.04 * (dt < 1 ? dt : 1);
    let L = this.logOdds + add;
    if (L > 10)
      L = 10;
    if (L < -8)
      L = -8;
    this.logOdds = L;
    let mode = this.mode;
    if (this.locked)
      mode = MODE_FFA;
    else if (L >= this.enter)
      mode = MODE_FFA;
    else if (L <= -this.enter)
      mode = MODE_SQUAD;
    else if (mode === MODE_FFA && L < -this.exit)
      mode = MODE_UNKNOWN;
    else if (mode === MODE_SQUAD && L > this.exit)
      mode = MODE_UNKNOWN;
    if (mode !== this.mode) {
      this.mode = mode;
      this.tDecided = t;
    }
    return mode;
  }
  alongUs(a, bearing, sx, sy) {
    return Math.abs(wrapPi2(Math.atan2(sy - a.y, sx - a.x) - bearing)) < 0.15;
  }
}

// src/bot/perception/seenBy.ts
var PI3 = Math.PI;
var TAU4 = 2 * Math.PI;
function wrapPi3(a) {
  a = (a + PI3) % TAU4;
  if (a < 0)
    a += TAU4;
  return a - PI3;
}
function inVisionWedge(ox, oy, yaw, x, y, range, fovDeg, nearRange) {
  const dx = x - ox, dy = y - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 <= nearRange * nearRange)
    return true;
  if (d2 > range * range)
    return false;
  return Math.abs(wrapPi3(Math.atan2(dy, dx) - yaw)) <= 0.5 * fovDeg * PI3 / 180;
}
function seenBy(track, self, world, visionCfg, rangeBonus = 0, nearBonus = 0) {
  if (!track.known || track.dead)
    return false;
  const range = visionCfg.range + rangeBonus;
  const near = visionCfg.near_range + nearBonus;
  const ourH = self.stats.height ?? 9;
  if (world) {
    const eye = track.z + (track.npc ? 0.9 * track.height : 8 / 9 * track.height);
    return world.canSee(track.x, track.y, eye, track.aimYaw, self.pos[0], self.pos[1], self.pos[2], ourH, range, visionCfg.fov_deg, near);
  }
  return inVisionWedge(track.x, track.y, track.aimYaw, self.pos[0], self.pos[1], range, visionCfg.fov_deg, near);
}

// src/bot/brain/zone.ts
class ZoneModel {
  cx = 0;
  cy = 0;
  r = 1e6;
  ncx = 0;
  ncy = 0;
  nr = 1e6;
  t0 = 1e9;
  t1 = 1e9;
  dps = 0;
  t = 0;
  phase = 0;
  phases;
  _c = { x: 0, y: 0 };
  constructor(cfg) {
    this.phases = cfg?.phases ?? [];
    if (cfg) {
      this.cx = this.ncx = cfg.start_center[0];
      this.cy = this.ncy = cfg.start_center[1];
      this.r = this.nr = cfg.start_radius;
    }
  }
  update(z, t) {
    this.t = t;
    this.cx = z.center[0];
    this.cy = z.center[1];
    this.r = z.radius;
    this.ncx = z.next_center[0];
    this.ncy = z.next_center[1];
    this.nr = z.next_radius;
    this.t0 = z.shrink_start;
    this.t1 = z.shrink_end;
    this.dps = z.dps;
    let best = this.phases.length;
    let bd = 1e9;
    for (let i = 0;i < this.phases.length; i++) {
      const d = Math.abs(this.phases[i].radius - z.next_radius);
      if (d < bd - 0.000001) {
        bd = d;
        best = i;
      }
    }
    this.phase = best;
  }
  get shrinking() {
    return this.t >= this.t0 && this.t < this.t1;
  }
  circleAt(t, out) {
    const from = this.t > this.t0 ? this.t : this.t0;
    if (t <= from && t < this.t1) {
      out.x = this.cx;
      out.y = this.cy;
      return this.r;
    }
    if (t < this.t1) {
      const f = (t - from) / (this.t1 - from);
      out.x = this.cx + (this.ncx - this.cx) * f;
      out.y = this.cy + (this.ncy - this.cy) * f;
      return this.r + (this.nr - this.r) * f;
    }
    out.x = this.ncx;
    out.y = this.ncy;
    let r = this.nr;
    let ts = this.t1;
    for (let i = this.phase + 1;i < this.phases.length; i++) {
      const p = this.phases[i];
      const h = ts + p.hold_s;
      if (t <= h)
        return r;
      const e = h + p.shrink_s;
      if (t < e)
        return r + (p.radius - r) * ((t - h) / p.shrink_s);
      r = p.radius;
      ts = e;
    }
    return r;
  }
  radiusAt(t) {
    return this.circleAt(t, this._c);
  }
  margin(x, y) {
    return this.r - Math.hypot(x - this.cx, y - this.cy);
  }
  marginNext(x, y) {
    return this.nr - Math.hypot(x - this.ncx, y - this.ncy);
  }
  marginAt(x, y, t) {
    const r = this.circleAt(t, this._c);
    return r - Math.hypot(x - this._c.x, y - this._c.y);
  }
  timeUntilOutside(x, y, horizon = 120) {
    if (this.margin(x, y) < 0)
      return 0;
    const step = 2;
    let prevT = this.t;
    let prevM = this.margin(x, y);
    for (let dt = step;dt <= horizon; dt += step) {
      const tt = this.t + dt;
      const m = this.marginAt(x, y, tt);
      if (m < 0) {
        const f = prevM / (prevM - m);
        return prevT + (tt - prevT) * f - this.t;
      }
      prevT = tt;
      prevM = m;
    }
    return Infinity;
  }
  dpsAt(t) {
    if (t < this.t1 || this.phases.length === 0)
      return this.dps;
    let ts = this.t1;
    let d = this.dps;
    for (let i = this.phase + 1;i < this.phases.length; i++) {
      const p = this.phases[i];
      d = p.dps;
      ts += p.hold_s + p.shrink_s;
      if (t < ts)
        return d;
    }
    return d;
  }
}

// src/bot/brain/intent.ts
var K_IDLE = 0;
var K_GOTO = 1;
var K_FIGHT = 2;
var K_LOOT = 3;
var K_FLEE = 4;
var K_HOLD = 5;
var K_CAPTURE = 6;
var PACE_SILENT = 0;
var PACE_WALK = 1;
var PACE_BOOST = 2;
var STYLE_PUSH = 0;
var STYLE_HOLD = 1;
var STYLE_PEEK = 3;
var FACE_SCAN = 0;
var FACE_THREATS = 1;
var FACE_YAW = 2;
var FACE_TRAVEL = 3;

class Intent {
  kind = K_IDLE;
  gx = 0;
  gy = 0;
  gz = 0;
  pace = PACE_WALK;
  arrive = 2;
  allowJet = true;
  targetId = -1;
  style = STYLE_PUSH;
  range = 25;
  shootCrate = -1;
  weaponsFree = true;
  face = FACE_SCAN;
  faceYaw = 0;
  takeId = -1;
  dropSlot = -1;
  dropOnly = -1;
  label = "";
  reset() {
    this.kind = K_IDLE;
    this.gx = this.gy = this.gz = 0;
    this.pace = PACE_WALK;
    this.arrive = 2;
    this.allowJet = true;
    this.targetId = -1;
    this.style = STYLE_PUSH;
    this.range = 25;
    this.shootCrate = -1;
    this.weaponsFree = true;
    this.face = FACE_SCAN;
    this.faceYaw = 0;
    this.takeId = -1;
    this.dropSlot = -1;
    this.dropOnly = -1;
    this.label = "";
    return this;
  }
  goto(x, y, z, pace, label) {
    this.kind = K_GOTO;
    this.gx = x;
    this.gy = y;
    this.gz = z;
    this.pace = pace;
    this.label = label;
    return this;
  }
  fight(targetId, style, range, label) {
    this.kind = K_FIGHT;
    this.targetId = targetId;
    this.style = style;
    this.range = range;
    this.face = FACE_THREATS;
    this.label = label;
    return this;
  }
  loot(x, y, z, pace, label) {
    this.kind = K_LOOT;
    this.gx = x;
    this.gy = y;
    this.gz = z;
    this.pace = pace;
    this.arrive = 0.8;
    this.label = label;
    return this;
  }
  flee(x, y, z, pace, label) {
    this.kind = K_FLEE;
    this.gx = x;
    this.gy = y;
    this.gz = z;
    this.pace = pace;
    this.face = FACE_THREATS;
    this.label = label;
    return this;
  }
  hold(x, y, z, label) {
    this.kind = K_HOLD;
    this.gx = x;
    this.gy = y;
    this.gz = z;
    this.pace = PACE_SILENT;
    this.arrive = 1.5;
    this.label = label;
    return this;
  }
  capture(x, y, z, pace, label) {
    this.kind = K_CAPTURE;
    this.gx = x;
    this.gy = y;
    this.gz = z;
    this.pace = pace;
    this.arrive = 1.5;
    this.label = label;
    return this;
  }
}

// src/bot/brain/blackboard.ts
var L_CRATE = 0;
var L_CUBE = 1;
var L_PICKUP = 2;

class LootItem {
  id = -1;
  type = L_CRATE;
  wk = 0;
  x = 0;
  y = 0;
  z = 0;
  hp = 0;
  tSeen = -1e9;
  miss = 0;
}
var ITEM_H = [2.4, 1, 1];

class LootMemory {
  items = [];
  byId = new Map;
  pool = [];
  get(id) {
    return this.byId.get(id) ?? null;
  }
  touch(id, type, x, y, z, t) {
    let it = this.byId.get(id);
    if (!it) {
      it = this.pool.pop() ?? new LootItem;
      it.id = id;
      it.type = type;
      it.wk = 0;
      it.hp = 0;
      this.byId.set(id, it);
      this.items.push(it);
    }
    it.x = x;
    it.y = y;
    it.z = z;
    it.tSeen = t;
    it.miss = 0;
    return it;
  }
  remove(id) {
    const it = this.byId.get(id);
    if (!it)
      return;
    this.byId.delete(id);
    const i = this.items.indexOf(it);
    if (i >= 0) {
      const last = this.items.pop();
      if (i < this.items.length)
        this.items[i] = last;
    }
    this.pool.push(it);
  }
  removeCubeNear(x, y, r) {
    let best = null;
    let bd = r * r;
    for (let i = 0;i < this.items.length; i++) {
      const it = this.items[i];
      if (it.type !== L_CUBE)
        continue;
      const d = (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    if (best)
      this.remove(best.id);
  }
  update(obs, world, cfg, forgetS) {
    const t = obs.t;
    for (let i = 0;i < obs.crates.length; i++) {
      const c = obs.crates[i];
      this.touch(c.id, L_CRATE, c.pos[0], c.pos[1], c.pos[2], t).hp = c.hp ?? 300;
    }
    for (let i = 0;i < obs.cubes.length; i++) {
      const c = obs.cubes[i];
      this.touch(c.id, L_CUBE, c.pos[0], c.pos[1], c.pos[2], t);
    }
    for (let i = 0;i < obs.pickups.length; i++) {
      const p = obs.pickups[i];
      this.touch(p.id, L_PICKUP, p.pos[0], p.pos[1], p.pos[2], t).wk = weaponBit(p.kind);
    }
    for (let i = 0;i < obs.events.length; i++) {
      const e = obs.events[i];
      if (e.type === "took")
        this.remove(e.id);
      else if (e.type === "take_failed" && (e.reason === "gone" || e.reason === "have")) {
        if (e.reason === "gone")
          this.remove(e.id);
      } else if (e.type === "pickup")
        this.removeCubeNear(obs.self.pos[0], obs.self.pos[1], 7);
    }
    const s = obs.self;
    const ex = s.pos[0], ey = s.pos[1], ez = s.pos[2] + (s.stats.eye_height ?? 8);
    const yaw = s.aim[0];
    const range = cfg.vision.range + (s.stats.vision_bonus ?? 0) - 10;
    const near = cfg.vision.near_range + (s.stats.near_range_bonus ?? 0) - 4;
    const fov = cfg.vision.fov_deg - 10;
    for (let i = this.items.length - 1;i >= 0; i--) {
      const it = this.items[i];
      if (it.tSeen === t)
        continue;
      if (t - it.tSeen > forgetS) {
        this.remove(it.id);
        continue;
      }
      const dx = it.x - ex, dy = it.y - ey;
      if (dx * dx + dy * dy > range * range)
        continue;
      const vis = world ? world.canSee(ex, ey, ez, yaw, it.x, it.y, it.z, ITEM_H[it.type], range, fov, near) : dx * dx + dy * dy < near * near;
      if (vis) {
        if (++it.miss >= 3)
          this.remove(it.id);
      }
    }
  }
}

class StratMemory {
  plan = 0;
  planUntil = -1;
  lootId = -1;
  lootScore = 0;
  hideX = 0;
  hideY = 0;
  hideZ = 0;
  hideOk = false;
  hideT = -1e9;
  hideScore = 0;
  coverX = 0;
  coverY = 0;
  coverZ = 0;
  coverOk = false;
  coverT = -1e9;
  targetId = -1;
  targetT = -1e9;
  fleeSince = -1;
  regen = false;
  calmSince = 0;
  dropId = -1;
  n0 = 0;
  n1 = 0;
  n2 = 0;
}

class Blackboard {
  hello;
  cfg;
  world;
  P;
  rng;
  tracker;
  sounds;
  modeDet;
  zone;
  loot = new LootMemory;
  intent = new Intent;
  mem = new StratMemory;
  obs;
  me;
  t = 0;
  dt = 0.1;
  tick = 0;
  mode = MODE_UNKNOWN;
  otherDeaths = 0;
  quietDeaths = 0;
  ffaLatched = false;
  prevAlive = 16;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  speed = 0;
  yaw = 0;
  hp = 0;
  maxHp = 1;
  hpFrac = 1;
  energy = 0;
  maxEnergy = 100;
  cubes = 0;
  radius = 2.5;
  height = 9;
  eyeZ = 8;
  muzzleH = 7;
  walk = 11.7;
  boostSpeed = 19.5;
  turnRate = 4;
  dmgMult = 1;
  inZone = true;
  grounded = true;
  gunSlot = -1;
  ltgSlot = -1;
  lasSlot = -1;
  morSlot = -1;
  gun = null;
  ltg = null;
  las = null;
  mor = null;
  freeSlot = -1;
  held = 0;
  en = [];
  nEn = 0;
  los;
  sees;
  nThreats = 0;
  nearest = null;
  nearestD = Infinity;
  nSeeing = 0;
  tHurt = -1e9;
  tCombat = -1e9;
  lastHurtBearing = 0;
  lastHurtBy = -1;
  npcAggressor = null;
  tZoneHurt = -1e9;
  regenIn = 0;
  tEnemySeen = -1e9;
  tSeenByEnemy = -1e9;
  drops = [];
  constructor(hello, world, P, rng) {
    this.hello = hello;
    this.cfg = hello.config;
    this.world = world;
    this.P = P;
    this.rng = rng;
    this.tracker = new EnemyTracker(this.cfg, world);
    const n = this.cfg.match.mechs ?? 16;
    this.los = new Uint8Array(n);
    this.sees = new Uint8Array(n);
    if (world)
      this.sounds = new SoundMap(this.cfg.sound, world.minX, world.minY, world.maxX, world.maxY);
    else
      this.sounds = new SoundMap(this.cfg.sound);
    this.modeDet = new ModeDetector(n, this.cfg.zone.start_radius);
    this.zone = new ZoneModel(this.cfg.zone);
    this.dt = (this.cfg.match.decide_every ?? 2) / (this.cfg.match.tick_hz ?? 20);
    this.prevAlive = n;
  }
  update(obs) {
    const me = obs.self;
    this.obs = obs;
    this.me = me;
    this.t = obs.t;
    this.tick = obs.tick;
    const st = me.stats;
    this.x = me.pos[0];
    this.y = me.pos[1];
    this.z = me.pos[2];
    this.vx = me.vel[0];
    this.vy = me.vel[1];
    this.speed = Math.hypot(this.vx, this.vy);
    this.yaw = me.aim[0];
    this.hp = me.hp;
    this.maxHp = me.max_hp > 0 ? me.max_hp : 1;
    this.hpFrac = this.hp / this.maxHp;
    this.energy = me.energy;
    this.maxEnergy = me.max_energy;
    this.cubes = me.cubes;
    this.radius = st.radius ?? 2.5;
    this.height = st.height ?? 9;
    this.eyeZ = st.eye_height ?? 8;
    this.muzzleH = st.muzzle_height ?? 7;
    this.walk = st.walk_speed ?? 11.7;
    this.boostSpeed = st.boost_speed ?? 19.5;
    this.turnRate = st.turn_rate ?? 4;
    this.inZone = me.in_zone;
    this.grounded = me.grounded;
    const cc = this.cfg.cubes;
    const cap = cc.stat_cap ?? 10;
    this.dmgMult = 1 + (cc.damage_per_cube ?? 0.04) * Math.min(this.cubes, cap);
    this.gunSlot = this.ltgSlot = this.lasSlot = this.morSlot = -1;
    this.gun = this.ltg = this.las = this.mor = null;
    this.freeSlot = -1;
    this.held = 0;
    for (let i = 1;i >= 0; i--) {
      const w = me.weapons[i];
      if (!w) {
        this.freeSlot = i;
        continue;
      }
      this.held |= weaponBit(w.kind);
      if (w.kind === "gun") {
        this.gunSlot = i;
        this.gun = w;
      } else if (w.kind === "lightning") {
        this.ltgSlot = i;
        this.ltg = w;
      } else if (w.kind === "laser") {
        this.lasSlot = i;
        this.las = w;
      } else if (w.kind === "mortar") {
        this.morSlot = i;
        this.mor = w;
      }
    }
    this.tracker.update(obs);
    this.sounds.update(obs);
    const det = this.modeDet.update(obs, this.tracker);
    let died = this.prevAlive - obs.alive;
    this.prevAlive = obs.alive;
    if (died > 0) {
      for (let i = 0;i < obs.events.length; i++)
        if (obs.events[i].type === "kill")
          died--;
      if (died > 0) {
        this.otherDeaths += died;
        if (obs.t - this.tCombat > this.P.quietDeathS && this.nThreats === 0)
          this.quietDeaths += died;
      }
    }
    if (this.quietDeaths >= 2 || this.quietDeaths >= 1 && obs.t < this.P.ffaEarlyT || this.otherDeaths >= this.P.ffaOtherDeaths)
      this.ffaLatched = true;
    let mode = MODE_UNKNOWN;
    if (this.ffaLatched)
      mode = MODE_FFA;
    else if (det === MODE_SQUAD || obs.t >= this.P.unknownSquadAfter)
      mode = MODE_SQUAD;
    this.mode = this.P.forceMode === 1 ? MODE_SQUAD : this.P.forceMode === 2 ? MODE_FFA : mode;
    this.zone.update(obs.zone, obs.t);
    this.loot.update(obs, this.world, this.cfg, this.P.lootForgetS);
    this.drops = obs.drops ?? [];
    for (let i = 0;i < obs.events.length; i++) {
      const e = obs.events[i];
      if (e.type === "damaged") {
        this.tCombat = obs.t;
        if (e.by === null || e.by === undefined)
          this.tZoneHurt = obs.t;
        else {
          this.tHurt = obs.t;
          this.lastHurtBy = e.by;
          if (e.bearing !== null && e.bearing !== undefined)
            this.lastHurtBearing = e.bearing;
        }
      } else if (e.type === "hit")
        this.tCombat = obs.t;
    }
    const regenDelay = st.regen_delay ?? 5;
    this.regenIn = this.hp >= this.maxHp ? 0 : Math.max(0, this.tCombat + regenDelay - obs.t);
    const tr = this.tracker;
    let n = 0;
    let nThreat = 0;
    let nSee = 0;
    let nearest = null;
    let nd = Infinity;
    const mz = this.z + this.muzzleH;
    const w = this.world;
    for (let i = 0;i < tr.nVisible; i++) {
      const e = tr.visible[i];
      if (e.dead)
        continue;
      if (n < this.en.length)
        this.en[n] = e;
      else
        this.en.push(e);
      n++;
      const cz = e.z + 0.5 * e.height;
      const los = w ? w.segClear(this.x, this.y, mz, e.x, e.y, cz) || w.segClear(this.x, this.y, mz, e.x, e.y, e.z + 0.85 * e.height) : true;
      this.los[e.id] = los ? 1 : 0;
      const sees = seenBy(e, me, w, this.cfg.vision, 0, 0);
      this.sees[e.id] = sees ? 1 : 0;
      if (sees)
        nSee++;
      if (e.aimingAtUs && los || obs.t - e.tShotAtUs < 3)
        nThreat++;
      if (e.dist < nd) {
        nd = e.dist;
        nearest = e;
      }
    }
    this.nEn = n;
    this.nThreats = nThreat;
    this.nSeeing = nSee;
    this.nearest = nearest;
    this.nearestD = nd;
    this.npcAggressor = null;
    const npcs = tr.npcs;
    for (let i = 0;i < npcs.length; i++) {
      const e = npcs[i];
      if (e.visible && e.hp !== 0 && obs.t - e.tShotAtUs < 3 && (!this.npcAggressor || e.dist < this.npcAggressor.dist))
        this.npcAggressor = e;
    }
    if (n > 0)
      this.tEnemySeen = obs.t;
    if (nSee > 0)
      this.tSeenByEnemy = obs.t;
  }
  enemyHas(e, bit) {
    return (e.weapons & bit) !== 0;
  }
  get haveLightning() {
    return (this.held & W_LIGHTNING) !== 0;
  }
  get haveLaser() {
    return (this.held & W_LASER) !== 0;
  }
  get haveMortar() {
    return (this.held & W_MORTAR) !== 0;
  }
  upgradeCount(id) {
    let n = 0;
    const u = this.me.upgrades;
    for (let i = 0;i < u.length; i++)
      if (u[i] === id)
        n++;
    return n;
  }
}

// src/bot/tactics/aim.ts
var TICK = 0.05;
var DECISION_DT = 0.1;
var PI4 = Math.PI;
var TAU5 = 2 * Math.PI;
var DEG = Math.PI / 180;
function wrapPi4(a) {
  a = (a + PI4) % TAU5;
  if (a < 0)
    a += TAU5;
  return a - PI4;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function slewStep(curYaw, curPitch, wantYaw, wantPitch, turnRate, pitchRate, dt, out, minPitch = -0.7, maxPitch = 1.3) {
  const dy = wrapPi4(wantYaw - curYaw);
  const my = turnRate * dt;
  out.yaw = dy > my ? wrapPi4(curYaw + my) : dy < -my ? wrapPi4(curYaw - my) : wrapPi4(wantYaw);
  const wp = clamp(wantPitch, minPitch, maxPitch);
  const dp = wp - curPitch;
  const mp = pitchRate * dt;
  out.pitch = dp > mp ? curPitch + mp : dp < -mp ? curPitch - mp : wp;
}
function slewTime(curYaw, curPitch, wantYaw, wantPitch, turnRate, pitchRate) {
  const ty = Math.abs(wrapPi4(wantYaw - curYaw)) / turnRate;
  const tp = Math.abs(wantPitch - curPitch) / pitchRate;
  return ty > tp ? ty : tp;
}
function newAimSolution() {
  return { yaw: 0, pitch: 0, tof: 0, tHit: 0, tFire: TICK, dist: 0, ix: 0, iy: 0, iz: 0, inRange: false };
}
function leadGun(sx, sy, sz, svx, svy, svz, aimYaw, aimPitch, tx, ty, tz, tvx, tvy, tvz, projSpeed, range, cooldown, out, muzzleHeight = 7, muzzleOut = 3, turnRate = 4, pitchRate = 3, minPitch = -0.7, maxPitch = 1.3, spawnStepTicks = 1) {
  let k = Math.ceil(cooldown / TICK - 0.000001);
  if (k < 1)
    k = 1;
  let yaw = 0, pitch = 0, s = 0, ix = tx, iy = ty, iz = tz, tL = 0;
  {
    const dx = tx - sx, dy = ty - sy, dz = tz - (sz + muzzleHeight);
    s = Math.sqrt(dx * dx + dy * dy + dz * dz) / projSpeed;
  }
  for (let outer = 0;outer < 5; outer++) {
    const tFire = k * TICK;
    tL = tFire - spawnStepTicks * TICK;
    const bx = sx + svx * tFire, by = sy + svy * tFire, bz = sz + svz * tFire + muzzleHeight;
    let h = 0, dz = 0, hx = 0, hy = 0;
    for (let i = 0;i < 3; i++) {
      const tt = tL + s;
      ix = tx + tvx * tt;
      iy = ty + tvy * tt;
      iz = tz + tvz * tt;
      hx = ix - bx;
      hy = iy - by;
      h = Math.sqrt(hx * hx + hy * hy) - muzzleOut;
      if (h < 0.01)
        h = 0.01;
      dz = iz - bz;
      s = Math.sqrt(h * h + dz * dz) / projSpeed;
    }
    yaw = Math.atan2(hy, hx);
    pitch = Math.atan2(dz, h);
    const ks = Math.ceil(slewTime(aimYaw, aimPitch, yaw, clamp(pitch, minPitch, maxPitch), turnRate, pitchRate) / TICK - 0.000001);
    if (ks <= k)
      break;
    k = ks;
  }
  out.yaw = yaw;
  out.pitch = pitch;
  out.tof = s;
  out.tFire = k * TICK;
  out.tHit = tL + s;
  out.dist = s * projSpeed;
  out.ix = ix;
  out.iy = iy;
  out.iz = iz;
  out.inRange = out.dist <= range && pitch >= minPitch && pitch <= maxPitch;
  return out.inRange;
}
function leadGunObs(self, slot, tx, ty, tz, tvx, tvy, tvz, out) {
  const w = self.weapons[slot];
  if (!w) {
    out.inRange = false;
    return false;
  }
  const st = self.stats;
  const cd = Math.max(w.cooldown, w.reload ?? 0);
  return leadGun(self.pos[0], self.pos[1], self.pos[2], self.vel[0], self.vel[1], self.vel[2], self.aim[0], self.aim[1], tx, ty, tz, tvx, tvy, tvz, w.stats.speed ?? 252, w.stats.range ?? 230, cd, out, st.muzzle_height ?? 7, (st.radius ?? 2.5) + 0.5, st.turn_rate ?? 4, st.pitch_rate ?? 3, st.min_pitch ?? -0.7, st.max_pitch ?? 1.3);
}
function aimAt(sx, sy, sz, tx, ty, tz, out, muzzleHeight = 7, muzzleOut = 3) {
  const hx = tx - sx, hy = ty - sy;
  let h = Math.sqrt(hx * hx + hy * hy) - muzzleOut;
  if (h < 0.01)
    h = 0.01;
  const dz = tz - (sz + muzzleHeight);
  out.yaw = Math.atan2(hy, hx);
  out.pitch = Math.atan2(dz, h);
  return Math.sqrt(h * h + dz * dz);
}
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function dodgeReach(t, dv, accel = 58.5) {
  if (t <= 0 || dv <= 0)
    return 0;
  const tr = dv / accel;
  return t <= tr ? 0.5 * accel * t * t : dv * t - 0.5 * dv * tr;
}
function hitProbGun(dist, targetRadius, targetHeight, targetSpeedUncertainty, spreadDeg, projSpeed = 252, accel = 58.5, projRadius = 0.3, extraDelay = 0) {
  if (dist < 0.01)
    return 1;
  const t = dist / projSpeed + extraDelay;
  const ss = dist * spreadDeg * DEG;
  const reach = dodgeReach(t, targetSpeedUncertainty, accel);
  const sd = reach * 0.5773502691896258;
  const sl = Math.sqrt(ss * ss + sd * sd);
  const pl = sl < 0.000000001 ? 1 : erf((targetRadius + projRadius) / (1.4142135623730951 * sl));
  const pv = ss < 0.000000001 ? 1 : erf((0.5 * targetHeight + projRadius) / (1.4142135623730951 * ss));
  return pl * pv;
}
var _slew = { yaw: 0, pitch: 0 };
function willHit(selfAim, sol, dist, targetRadius, targetHalfHeight = 4.5, spreadDeg = 0.6, turnRate = 4, pitchRate = 3, marginSigma = 1) {
  if (sol.tFire > DECISION_DT + 0.000001)
    return false;
  slewStep(selfAim[0], selfAim[1], sol.yaw, sol.pitch, turnRate, pitchRate, sol.tFire, _slew);
  const ey = Math.abs(wrapPi4(sol.yaw - _slew.yaw)) * Math.cos(sol.pitch);
  const ep = Math.abs(sol.pitch - _slew.pitch);
  const m = marginSigma * spreadDeg * DEG;
  const ay = Math.atan2(targetRadius, dist);
  const ap = Math.atan2(targetHalfHeight, dist);
  const ly = Math.max(ay - m, 0.35 * ay);
  const lp = Math.max(ap - m, 0.35 * ap);
  return ey <= ly && ep <= lp;
}
function rayHitsCylinder(ox, oy, oz, dx, dy, dz, cx, cy, cz, radius, height, maxDist) {
  const rx = ox - cx, ry = oy - cy;
  const a = dx * dx + dy * dy;
  let t0 = 0, t1 = maxDist;
  if (a < 0.000000000001) {
    if (rx * rx + ry * ry > radius * radius)
      return -1;
  } else {
    const b = rx * dx + ry * dy;
    const c = rx * rx + ry * ry - radius * radius;
    const disc = b * b - a * c;
    if (disc < 0)
      return -1;
    const sq = Math.sqrt(disc);
    const ta = (-b - sq) / a, tb = (-b + sq) / a;
    if (ta > t0)
      t0 = ta;
    if (tb < t1)
      t1 = tb;
  }
  if (Math.abs(dz) < 0.000000000001) {
    if (oz < cz || oz > cz + height)
      return -1;
  } else {
    let za = (cz - oz) / dz, zb = (cz + height - oz) / dz;
    if (za > zb) {
      const tmp = za;
      za = zb;
      zb = tmp;
    }
    if (za > t0)
      t0 = za;
    if (zb < t1)
      t1 = zb;
  }
  return t0 <= t1 ? t0 : -1;
}
function aimHitsCylinder(sx, sy, sz, yaw, pitch, cx, cy, cz, radius, height, maxDist, muzzleHeight = 7, muzzleOut = 3) {
  const cyaw = Math.cos(yaw), syaw = Math.sin(yaw), cp = Math.cos(pitch);
  return rayHitsCylinder(sx + muzzleOut * cyaw, sy + muzzleOut * syaw, sz + muzzleHeight, cp * cyaw, cp * syaw, Math.sin(pitch), cx, cy, cz, radius, height, maxDist);
}
var LASER_IDLE = 0;
var LASER_CHARGE = 1;
var LASER_RELEASE = 2;
function laserPlan(charge, cooldown, onTarget, tLosIn, tLosLeft, needCharge = 0.75, chargeFull = 0.75, minCharge = 0.15, holdS = 2) {
  if (needCharge > chargeFull)
    needCharge = chargeFull;
  if (charge <= 0) {
    if (cooldown > DECISION_DT)
      return LASER_IDLE;
    return tLosIn <= needCharge + 0.5 * holdS ? LASER_CHARGE : LASER_IDLE;
  }
  if (onTarget) {
    if (charge >= needCharge - 0.000001)
      return LASER_RELEASE;
    if (tLosLeft < needCharge - charge + DECISION_DT && charge >= minCharge)
      return LASER_RELEASE;
  }
  return LASER_CHARGE;
}
var _rel = { yaw: 0, pitch: 0 };
function laserReleaseGate(sx, sy, sz, svx, svy, svz, aimYaw, aimPitch, cmdYaw, cmdPitch, tx, ty, tz, tvx, tvy, tvz, targetRadius, targetHeight, range = 280, muzzleHeight = 7, muzzleOut = 3, turnRate = 4, pitchRate = 3, shrink = 0.8) {
  slewStep(aimYaw, aimPitch, cmdYaw, cmdPitch, turnRate, pitchRate, TICK, _rel);
  const r = targetRadius * shrink;
  const h = targetHeight * shrink;
  const zOff = 0.5 * (targetHeight - h);
  const d = aimHitsCylinder(sx + svx * TICK, sy + svy * TICK, sz + svz * TICK, _rel.yaw, _rel.pitch, tx + tvx * TICK, ty + tvy * TICK, tz + tvz * TICK + zOff, r, h, range, muzzleHeight, muzzleOut);
  return d >= 0;
}
function lightningTarget(obs, yaw, range = 45, coneDeg = 30, world) {
  const s = obs.self;
  const sx = s.pos[0], sy = s.pos[1], sz = s.pos[2] + (s.stats.muzzle_height ?? 7);
  const cone = coneDeg * DEG;
  let best = -1, bestD = range;
  const mechs = obs.mechs;
  for (let i = 0;i < mechs.length; i++) {
    const m = mechs[i];
    const dx = m.pos[0] - sx, dy = m.pos[1] - sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > bestD)
      continue;
    if (d > 0.000001 && Math.abs(wrapPi4(Math.atan2(dy, dx) - yaw)) > cone)
      continue;
    const cz = m.pos[2] + (m.kind === "npc" ? 1.75 : 4.5 * (1 + 0.05 * (m.cubes ?? 0)));
    if (world && !world.segClear(sx, sy, sz, m.pos[0], m.pos[1], cz))
      continue;
    best = m.id;
    bestD = d;
  }
  const crates = obs.crates;
  for (let i = 0;i < crates.length; i++) {
    const c = crates[i];
    const dx = c.pos[0] - sx, dy = c.pos[1] - sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > bestD)
      continue;
    if (d > 0.000001 && Math.abs(wrapPi4(Math.atan2(dy, dx) - yaw)) > cone)
      continue;
    if (world && !world.segClear(sx, sy, sz, c.pos[0], c.pos[1], c.pos[2] + 1))
      continue;
    best = c.id;
    bestD = d;
  }
  return best;
}

// src/bot/tactics/dodge.ts
var THREAT_GUN = 0;
var THREAT_MORTAR = 1;
var THREAT_NPC = 2;

class ThreatList {
  n = 0;
  cap;
  id;
  kind;
  tHit;
  miss;
  dirX;
  dirY;
  px;
  py;
  pz;
  urgency;
  constructor(cap = 48) {
    this.cap = cap;
    this.id = new Int32Array(cap);
    this.kind = new Uint8Array(cap);
    this.tHit = new Float32Array(cap);
    this.miss = new Float32Array(cap);
    this.dirX = new Float32Array(cap);
    this.dirY = new Float32Array(cap);
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.urgency = new Float32Array(cap);
  }
}
function threatsFromProjectiles(projectiles, self, out, gravity = 22, splashRadius = 7, groundZ, maxBulletT = 1.2) {
  const sx = self.pos[0], sy = self.pos[1], sz = self.pos[2];
  const svx = self.vel[0], svy = self.vel[1], svz = self.vel[2];
  const R = self.stats.radius ?? 2.5;
  const H = self.stats.height ?? 9;
  const walk = self.stats.walk_speed ?? 11.7;
  let n = 0, hot = 0;
  for (let i = 0;i < projectiles.length && n < out.cap; i++) {
    const p = projectiles[i];
    const rx = p.pos[0] - sx, ry = p.pos[1] - sy, rz = p.pos[2] - sz;
    let tHit = 0, miss = 0, dx = 0, dy = 0, px = 0, py = 0, pz = 0, urg = 0;
    let kind = THREAT_GUN;
    if (p.kind === "mortar") {
      kind = THREAT_MORTAR;
      const vz = p.vel[2];
      let gz = sz;
      let t = 0;
      for (let it = 0;it < (groundZ ? 3 : 1); it++) {
        const dz = p.pos[2] - gz;
        const disc = vz * vz + 2 * gravity * dz;
        t = disc <= 0 ? 0 : (vz + Math.sqrt(disc)) / gravity;
        if (t < 0)
          t = 0;
        px = p.pos[0] + p.vel[0] * t;
        py = p.pos[1] + p.vel[1] * t;
        if (groundZ)
          gz = groundZ(px, py);
      }
      pz = gz;
      tHit = t;
      let ex = sx - px, ey = sy - py;
      let d = Math.sqrt(ex * ex + ey * ey);
      if (d < 0.5) {
        const hv = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1]);
        if (hv > 0.001) {
          ex = -p.vel[1] / hv;
          ey = p.vel[0] / hv;
        } else {
          ex = 1;
          ey = 0;
        }
        if (ex * svx + ey * svy < 0) {
          ex = -ex;
          ey = -ey;
        }
        d = 1;
      }
      dx = ex / d;
      dy = ey / d;
      const dTrue = Math.sqrt((sx - px) * (sx - px) + (sy - py) * (sy - py));
      miss = dTrue - R;
      if (miss < 0)
        miss = 0;
      const danger = splashRadius + R + 1.5;
      if (dTrue < danger) {
        const need = (danger - dTrue) / walk;
        const slack = tHit - need;
        urg = slack > 1.5 ? 0.5 : slack > 0.6 ? 0.8 : 1;
      } else if (dTrue < danger + 6) {
        urg = 0.25 * (1 - (dTrue - danger) / 6);
      }
    } else {
      if (p.kind === "npc")
        kind = THREAT_NPC;
      const vx = p.vel[0] - svx, vy = p.vel[1] - svy, vz = p.vel[2] - svz;
      const vv = vx * vx + vy * vy;
      let t = vv > 0.000001 ? -(rx * vx + ry * vy) / vv : 0;
      if (t < 0)
        t = 0;
      if (t > maxBulletT)
        t = maxBulletT;
      tHit = t;
      const cx = rx + vx * t, cy = ry + vy * t, cz = rz + vz * t;
      px = sx + cx;
      py = sy + cy;
      pz = sz + cz;
      const dh = Math.sqrt(cx * cx + cy * cy);
      const dv = cz < 0 ? -cz : cz > H ? cz - H : 0;
      const lat = dh - R - 0.3;
      miss = lat > 0 ? Math.sqrt(lat * lat + dv * dv) : dv;
      if (dh > 0.05) {
        dx = -cx / dh;
        dy = -cy / dh;
      } else {
        const hv = Math.sqrt(vv);
        if (hv > 0.001) {
          dx = -vy / hv;
          dy = vx / hv;
        } else {
          dx = 1;
          dy = 0;
        }
        if (dx * svx + dy * svy < 0) {
          dx = -dx;
          dy = -dy;
        }
      }
      const approaching = rx * vx + ry * vy < 0;
      if (approaching && miss < 2.5) {
        urg = 1 - miss / 2.5;
        if (tHit < 0.06)
          urg *= 0.3;
        if (kind === THREAT_NPC)
          urg *= 0.6;
      }
    }
    out.id[n] = p.id;
    out.kind[n] = kind;
    out.tHit[n] = tHit;
    out.miss[n] = miss;
    out.dirX[n] = dx;
    out.dirY[n] = dy;
    out.px[n] = px;
    out.py[n] = py;
    out.pz[n] = pz;
    out.urgency[n] = urg;
    if (urg > 0)
      hot++;
    n++;
  }
  out.n = n;
  return hot;
}

class StrafeJitter {
  sign = 1;
  tFlip = -1;
  minPeriod;
  maxPeriod;
  constructor(minPeriod = 0.3, maxPeriod = 0.8) {
    this.minPeriod = minPeriod;
    this.maxPeriod = maxPeriod;
  }
  step(t, rng, axisX, axisY, blocked) {
    if (this.tFlip < 0) {
      this.sign = rng.next() < 0.5 ? 1 : -1;
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod);
    } else if (t >= this.tFlip) {
      const want = -this.sign;
      if (!blocked || !blocked(-axisY * want, axisX * want))
        this.sign = want;
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod);
    }
    if (blocked && blocked(-axisY * this.sign, axisX * this.sign) && !blocked(axisY * this.sign, -axisX * this.sign)) {
      this.sign = -this.sign;
      this.tFlip = t + rng.range(this.minPeriod, this.maxPeriod);
    }
    return this.sign;
  }
  reset() {
    this.tFlip = -1;
  }
}
function newDodgeOut() {
  return { mx: 0, my: 0, urgency: 0, breakLos: false, laserBy: -1, aimers: 0, primary: -1 };
}
var DEG2 = Math.PI / 180;
function dodgeVector(self, mechs, threats, t, rng, jitter, out, blocked, aimTolDeg = 4, maxAimerDist = 290) {
  const sx = self.pos[0], sy = self.pos[1];
  const R = self.stats.radius ?? 2.5;
  let ax = 0, ay = 0, urg = 0;
  let bestW = 0, bestX = 0, bestY = 0;
  out.breakLos = false;
  out.laserBy = -1;
  out.aimers = 0;
  out.primary = -1;
  if (threats) {
    for (let i = 0;i < threats.n; i++) {
      const u = threats.urgency[i];
      if (u <= 0)
        continue;
      const w = u * (threats.kind[i] === THREAT_MORTAR ? 3 : threats.kind[i] === THREAT_NPC ? 0.6 : 1);
      ax += w * threats.dirX[i];
      ay += w * threats.dirY[i];
      if (u > urg)
        urg = u;
      if (w > bestW) {
        bestW = w;
        bestX = threats.dirX[i];
        bestY = threats.dirY[i];
      }
    }
  }
  let primI = -1, primScore = 0;
  for (let i = 0;i < mechs.length; i++) {
    const m = mechs[i];
    const rx = sx - m.pos[0], ry = sy - m.pos[1];
    const d = Math.sqrt(rx * rx + ry * ry);
    if (d > maxAimerDist || d < 0.001)
      continue;
    const err = Math.abs(wrapPi4(m.aim[0] - Math.atan2(ry, rx)));
    const half = Math.atan2(R + 1, d);
    const onUs = err < half + aimTolDeg * DEG2;
    const charging = m.charging === true && err < 0.5;
    if (!onUs && !charging)
      continue;
    if (onUs)
      out.aimers++;
    let score = m.kind === "npc" ? 0.3 : 1;
    if (charging)
      score += onUs ? 3 : 1.5;
    score *= 1 + 40 / (d + 20);
    if (score > primScore) {
      primScore = score;
      primI = i;
    }
  }
  if (primI >= 0) {
    const pm = mechs[primI];
    out.primary = pm.id;
    let px = pm.pos[0] - sx, py = pm.pos[1] - sy;
    const pd = Math.sqrt(px * px + py * py);
    px /= pd;
    py /= pd;
    const side = jitter.step(t, rng, px, py, blocked);
    for (let i = 0;i < mechs.length; i++) {
      const m = mechs[i];
      const rx = sx - m.pos[0], ry = sy - m.pos[1];
      const d = Math.sqrt(rx * rx + ry * ry);
      if (d > maxAimerDist || d < 0.001)
        continue;
      const err = Math.abs(wrapPi4(m.aim[0] - Math.atan2(ry, rx)));
      const half = Math.atan2(R + 1, d);
      const onUs = err < half + aimTolDeg * DEG2;
      const charging = m.charging === true && err < 0.5;
      if (charging) {
        const cyaw = Math.cos(m.aim[0]), syaw = Math.sin(m.aim[0]);
        const cross = cyaw * ry - syaw * rx;
        let s = cross > 0.5 ? 1 : cross < -0.5 ? -1 : side;
        let nx = -syaw * s, ny = cyaw * s;
        if (blocked && blocked(nx, ny) && !blocked(-nx, -ny)) {
          s = -s;
          nx = -nx;
          ny = -ny;
        }
        const u = onUs ? 1 : 0.7;
        const w = 2.5 * u;
        ax += w * nx;
        ay += w * ny;
        if (u > urg)
          urg = u;
        if (w > bestW) {
          bestW = w;
          bestX = nx;
          bestY = ny;
        }
        out.breakLos = true;
        if (out.laserBy < 0 || i === primI)
          out.laserBy = m.id;
      } else if (onUs && i === primI) {
        const u = m.kind === "npc" ? 0.2 : 0.35 + 0.25 * (d < 60 ? 1 : d > 200 ? 0 : (200 - d) / 140);
        const w = 0.8;
        const nx = -py * side, ny = px * side;
        ax += w * nx;
        ay += w * ny;
        if (u > urg)
          urg = u;
        if (w > bestW) {
          bestW = w;
          bestX = nx;
          bestY = ny;
        }
      }
    }
  }
  let l = Math.sqrt(ax * ax + ay * ay);
  if (l < 0.25 * bestW) {
    ax = bestX;
    ay = bestY;
    l = Math.sqrt(ax * ax + ay * ay);
  }
  if (l < 0.000001 || urg <= 0) {
    out.mx = 0;
    out.my = 0;
    out.urgency = 0;
    return;
  }
  ax /= l;
  ay /= l;
  if (blocked && blocked(ax, ay)) {
    const c1x = -ay, c1y = ax;
    const first = c1x * bestX + c1y * bestY >= 0 ? 1 : -1;
    if (!blocked(c1x * first, c1y * first)) {
      const tx = c1x * first;
      ay = c1y * first;
      ax = tx;
    } else if (!blocked(-c1x * first, -c1y * first)) {
      const tx = -c1x * first;
      ay = -c1y * first;
      ax = tx;
    } else if (!blocked(-ax, -ay)) {
      ax = -ax;
      ay = -ay;
    }
  }
  out.mx = ax;
  out.my = ay;
  out.urgency = urg;
}
function faceThreatYaw(bearings, weights, n, curYaw, frontArcDeg = 180) {
  if (n <= 0)
    return curYaw;
  if (n === 1)
    return bearings[0];
  const half = 0.5 * frontArcDeg * DEG2;
  let gapMax = -1, gapStart = 0;
  let total = 0;
  for (let i = 0;i < n; i++) {
    total += weights ? weights[i] : 1;
    let g = 2 * Math.PI;
    for (let j = 0;j < n; j++) {
      if (j === i)
        continue;
      let d = bearings[j] - bearings[i];
      d = d % (2 * Math.PI);
      if (d < 0)
        d += 2 * Math.PI;
      if (d < 0.000000001)
        continue;
      if (d < g)
        g = d;
    }
    if (g > gapMax) {
      gapMax = g;
      gapStart = bearings[i];
    }
  }
  const span = 2 * Math.PI - gapMax;
  if (span <= 2 * half - 0.000000001) {
    return wrapPi4(gapStart + 0.5 * gapMax + Math.PI);
  }
  let bestYaw = curYaw, bestW = -1, bestTurn = Infinity;
  for (let i = 0;i < n; i++) {
    for (let e = -1;e <= 1; e++) {
      const yaw = wrapPi4(bearings[i] + e * (half - 0.02));
      let w = 0;
      for (let j = 0;j < n; j++) {
        if (Math.abs(wrapPi4(bearings[j] - yaw)) <= half)
          w += weights ? weights[j] : 1;
      }
      const turn = Math.abs(wrapPi4(yaw - curYaw));
      if (w > bestW + 0.000000001 || w > bestW - 0.000000001 && turn < bestTurn) {
        bestW = w;
        bestYaw = yaw;
        bestTurn = turn;
      }
    }
  }
  return bestYaw;
}

// src/bot/brain/execute.ts
class ExecStats {
  decisions = 0;
  slow = 0;
  stuckEpisodes = 0;
  shotsGun = 0;
  shotsLightning = 0;
  laserReleases = 0;
}

class Executor {
  stats = new ExecStats;
  bb;
  mv;
  jitter;
  threats = new ThreatList(48);
  dodge = newDodgeOut();
  sol = newAimSolution();
  a2 = { yaw: 0, pitch: 0 };
  slew = { yaw: 0, pitch: 0 };
  bearings = new Float64Array(8);
  weights = new Float64Array(8);
  fire = [false, false];
  blockedFn;
  groundFn;
  scanPhase;
  spinDir;
  noLosSince = -1;
  lastX = 0;
  lastY = 0;
  lastCmd = 0;
  slowRun = 0;
  unstickUntil = -1;
  unstickYaw = 0;
  unstickN = 0;
  mx = 0;
  my = 0;
  jump = false;
  boost = false;
  constructor(bb, mv) {
    this.bb = bb;
    this.mv = mv;
    this.jitter = new StrafeJitter(bb.P.strafeMin, bb.P.strafeMax);
    this.scanPhase = bb.rng.range(0, Math.PI * 2);
    this.spinDir = bb.rng.next() < 0.5 ? 1 : -1;
    this.blockedFn = (dx, dy) => this.mv.blocked(this.bb, dx, dy, this.bb.P.probeDist);
    this.groundFn = (x, y) => this.bb.world.groundZ(x, y);
  }
  run(it) {
    const bb = this.bb;
    const P = bb.P;
    const obs = bb.obs;
    const me = bb.me;
    const a = {};
    this.mx = this.my = 0;
    this.jump = this.boost = false;
    const st = this.stats;
    st.decisions++;
    const moved = Math.hypot(bb.x - this.lastX, bb.y - this.lastY);
    if (this.lastCmd > 0.5 && moved < 0.03 && bb.grounded) {
      st.slow++;
      if (++this.slowRun === 10)
        st.stuckEpisodes++;
    } else
      this.slowRun = 0;
    this.lastX = bb.x;
    this.lastY = bb.y;
    const tgt = it.targetId >= 0 ? this.liveTarget(it.targetId) : null;
    let speedScale = 1;
    if (it.kind === K_FIGHT) {
      if (tgt)
        this.fightMove(it, tgt);
      else if (it.targetId >= 0) {
        const tr = bb.tracker.get(it.targetId);
        if (tr && tr.known)
          this.gotoMove(tr.x, tr.y, tr.z, true, 3);
      }
    } else if (it.kind !== K_IDLE) {
      this.mv.goto(bb, it.gx, it.gy, it.gz, it.allowJet && bb.nThreats === 0 && bb.t - bb.tHurt > 3, it.arrive);
      this.mx = this.mv.mx;
      this.my = this.mv.my;
      this.jump = this.mv.jump;
      this.boost = this.mv.boost;
      if (it.kind === K_CAPTURE && this.mv.dist < 6)
        this.ringMove(it, tgt);
      else if (it.kind === K_HOLD && this.mv.arrived)
        this.mx = this.my = 0;
      if (it.pace === PACE_SILENT && !this.boost && bb.grounded)
        speedScale = Math.min(1, P.silentSpeed / bb.walk);
      else if (it.pace === PACE_BOOST && bb.grounded && !this.mv.noBoost && bb.energy > 12 && this.mv.dist > 10 && (this.mx !== 0 || this.my !== 0))
        this.boost = true;
    }
    if (this.mx === 0 && this.my === 0 && bb.grounded && bb.t - bb.tHurt < 1.5 && it.kind !== K_CAPTURE) {
      const bx = Math.cos(bb.lastHurtBearing), by = Math.sin(bb.lastHurtBearing);
      const side = this.jitter.step(bb.t, bb.rng, bx, by, this.blockedFn);
      this.mx = -by * side;
      this.my = bx * side;
      speedScale = 1;
    }
    const hot = threatsFromProjectiles(obs.projectiles, me, this.threats, bb.cfg.weapons.mortar.gravity ?? 22, bb.cfg.weapons.mortar.splash_radius ?? 7, this.groundFn);
    const dg = this.dodge;
    if (hot > 0 || bb.nEn > 0) {
      dodgeVector(me, obs.mechs, this.threats, bb.t, bb.rng, this.jitter, dg, this.blockedFn);
      if (dg.urgency >= P.dodgeOverride && bb.grounded) {
        this.mx = dg.mx;
        this.my = dg.my;
        speedScale = 1;
      } else if (dg.urgency > 0.3 && it.kind !== K_FIGHT && it.kind !== K_HOLD && it.kind !== K_CAPTURE && bb.grounded && !this.boost && speedScale === 1 && (this.mx !== 0 || this.my !== 0)) {
        const bx = this.mx + 0.6 * dg.mx, by = this.my + 0.6 * dg.my;
        const l = Math.hypot(bx, by);
        if (l > 0.2 && !this.blockedFn(bx / l, by / l)) {
          this.mx = bx / l;
          this.my = by / l;
        }
      }
    }
    const fire = this.fire;
    fire[0] = fire[1] = false;
    let wantYaw = bb.yaw;
    let wantPitch = 0;
    let aimed = false;
    let shootingNow = false;
    const pitchRate = me.stats.pitch_rate ?? 3;
    const mOut = bb.radius + 0.5;
    if (tgt && (it.weaponsFree || tgt.npc)) {
      const hh = 0.5 * tgt.height;
      const tz = tgt.z + hh;
      const sol = this.sol;
      let gunOk = false;
      if (bb.gun && bb.gunSlot >= 0) {
        leadGunObs(me, bb.gunSlot, tgt.x, tgt.y, tz, tgt.vx, tgt.vy, tgt.vz, sol);
        wantYaw = sol.yaw;
        wantPitch = sol.pitch;
        aimed = true;
        const g = bb.gun;
        if ((g.reload ?? 0) <= 0 && (g.ammo ?? 1) > 0 && sol.inRange) {
          const spread = g.stats.spread_deg ?? 0.6;
          const maxD = tgt.npc ? P.npcShootDist : P.gunMaxDist;
          if (sol.dist <= maxD && willHit(me.aim, sol, sol.dist, tgt.radius, hh, spread, bb.turnRate, pitchRate, P.fireMarginSigma)) {
            const p = tgt.npc ? 1 : hitProbGun(sol.dist, tgt.radius, tgt.height, P.targetJink, spread, g.stats.speed ?? 252);
            if (p >= P.fireMinP && this.muzzleClear(sol.yaw, mOut, sol.ix, sol.iy, sol.iz))
              gunOk = true;
          }
        }
      } else {
        aimAt(bb.x, bb.y, bb.z, tgt.x, tgt.y, tz, this.a2, bb.muzzleH, mOut);
        wantYaw = this.a2.yaw;
        wantPitch = this.a2.pitch;
        aimed = true;
      }
      if (bb.las && bb.lasSlot >= 0) {
        const las = bb.las;
        const full = las.stats.charge ?? 0.75;
        const charge = las.charge ?? 0;
        const px = tgt.x + tgt.vx * 0.1, py = tgt.y + tgt.vy * 0.1, pz = tz + tgt.vz * 0.1;
        const dist = aimAt(bb.x + bb.vx * 0.1, bb.y + bb.vy * 0.1, bb.z, px, py, pz, this.a2, bb.muzzleH, mOut);
        const los = bb.los[tgt.id] === 1 || tgt.npc;
        const useLaser = dist <= Math.min(P.laserMaxDist, las.stats.range ?? 280) && !tgt.npc;
        const laserAim = charge >= full - 0.25 || !gunOk;
        if (useLaser || charge > 0) {
          const cy = laserAim ? this.a2.yaw : wantYaw;
          const cp = laserAim ? this.a2.pitch : wantPitch;
          const on = los && laserReleaseGate(bb.x, bb.y, bb.z, bb.vx, bb.vy, me.vel[2], me.aim[0], me.aim[1], cy, cp, tgt.x, tgt.y, tgt.z, tgt.vx, tgt.vy, tgt.vz, tgt.radius, tgt.height, las.stats.range ?? 280, bb.muzzleH, mOut, bb.turnRate, pitchRate, P.laserShrink) && this.muzzleClear(cy, mOut, px, py, pz);
          const plan = laserPlan(charge, las.cooldown, on, los ? 0 : Infinity, Infinity, full, full, las.stats.min_charge ?? 0.15, las.stats.hold_s ?? 2);
          if (plan === LASER_CHARGE && (useLaser || charge > 0)) {
            fire[bb.lasSlot] = true;
            if (laserAim && charge > 0) {
              wantYaw = this.a2.yaw;
              wantPitch = this.a2.pitch;
            }
          } else if (charge > 0)
            st.laserReleases++;
        }
      }
      if (gunOk) {
        fire[bb.gunSlot] = true;
        shootingNow = true;
        st.shotsGun++;
      }
      if (bb.ltg && bb.ltgSlot >= 0 && bb.ltg.cooldown <= 0.1) {
        const lt = bb.ltg;
        const cost = lt.stats.energy ?? 3;
        const need = tgt.npc ? P.lightningFarmEnergy : cost + P.lightningReserve;
        const range = (lt.stats.range ?? 45) * P.lightningRangeFrac;
        if (bb.energy >= need && tgt.dist <= range + tgt.radius * 0.5) {
          slewStep(me.aim[0], me.aim[1], wantYaw, wantPitch, bb.turnRate, pitchRate, TICK, this.slew);
          const cone = lt.stats.cone_deg ?? 30;
          const hit = lightningTarget(obs, this.slew.yaw, range, cone * P.lightningConeFrac, bb.world);
          if (hit === tgt.id || hit >= 0 && hit < 100 && it.weaponsFree) {
            fire[bb.ltgSlot] = true;
            shootingNow = true;
            st.shotsLightning++;
          }
        }
      }
      if (bb.los[tgt.id] === 1 || tgt.npc)
        this.noLosSince = -1;
      else if (this.noLosSince < 0)
        this.noLosSince = bb.t;
    } else if (it.shootCrate >= 0) {
      const c = bb.loot.get(it.shootCrate);
      if (c && c.tSeen === bb.t) {
        const cz = c.z + 1.2;
        const d = Math.hypot(c.x - bb.x, c.y - bb.y);
        if (d <= P.crateShootDist) {
          const sol = this.sol;
          if (bb.gun && bb.gunSlot >= 0) {
            leadGunObs(me, bb.gunSlot, c.x, c.y, cz, 0, 0, 0, sol);
            wantYaw = sol.yaw;
            wantPitch = sol.pitch;
            aimed = true;
            const g = bb.gun;
            if ((g.reload ?? 0) <= 0 && (g.ammo ?? 1) > 0 && sol.inRange && willHit(me.aim, sol, sol.dist, 1.4, 1.2, g.stats.spread_deg ?? 0.6, bb.turnRate, pitchRate, 0.3) && this.muzzleClear(sol.yaw, mOut, c.x, c.y, cz)) {
              fire[bb.gunSlot] = true;
              shootingNow = true;
              st.shotsGun++;
            }
          }
          if (bb.ltg && bb.ltgSlot >= 0 && bb.ltg.cooldown <= 0.1 && bb.energy >= P.lightningFarmEnergy && d <= (bb.ltg.stats.range ?? 45) * 0.95) {
            slewStep(me.aim[0], me.aim[1], wantYaw, wantPitch, bb.turnRate, pitchRate, TICK, this.slew);
            if (lightningTarget(obs, this.slew.yaw, (bb.ltg.stats.range ?? 45) * 0.95, (bb.ltg.stats.cone_deg ?? 30) * 0.85, bb.world) === c.id) {
              fire[bb.ltgSlot] = true;
              shootingNow = true;
            }
          }
        }
      }
      this.noLosSince = -1;
    } else
      this.noLosSince = -1;
    if (bb.las && bb.lasSlot >= 0 && (bb.las.charge ?? 0) > 0 && !tgt)
      fire[bb.lasSlot] = true;
    if (!aimed) {
      wantPitch = 0;
      wantYaw = this.faceYaw(it);
    }
    const g = bb.gun;
    if (g && (g.reload ?? 0) <= 0) {
      const ammo = g.ammo ?? 0;
      const mag = g.stats.mag ?? 12;
      if (ammo <= 0)
        a.reload = true;
      else if (ammo < mag && !shootingNow) {
        if (!tgt && it.shootCrate < 0 && bb.nThreats === 0 && ammo < mag * P.reloadIdleFrac)
          a.reload = true;
        else if (tgt && this.noLosSince >= 0 && bb.t - this.noLosSince >= P.reloadNoLosS && ammo <= P.reloadLowAmmo)
          a.reload = true;
        else if (!tgt && bb.nEn === 0 && ammo <= P.reloadLowAmmo)
          a.reload = true;
      }
    }
    if (it.takeId >= 0) {
      const p = bb.loot.get(it.takeId);
      const reach = (bb.cfg.loot.pickup_radius ?? 4) - 0.25;
      if (p && p.type === L_PICKUP && Math.hypot(p.x - bb.x, p.y - bb.y) <= reach && Math.abs(p.z - bb.z) <= 3.8) {
        a.take = p.id;
        if (it.dropSlot >= 0 && bb.freeSlot < 0)
          a.drop = it.dropSlot;
      }
    } else if (it.dropOnly >= 0)
      a.drop = it.dropOnly;
    if (this.slowRun >= 12 && bb.t >= this.unstickUntil) {
      this.unstickN++;
      const base = Math.atan2(this.my, this.mx);
      const turn = this.unstickN % 4 === 1 ? 0 : this.unstickN % 4 === 2 ? 1.4 : this.unstickN % 4 === 3 ? -1.4 : Math.PI;
      this.unstickYaw = base + turn;
      this.unstickUntil = bb.t + 1.4;
      this.slowRun = 0;
    }
    if (bb.t < this.unstickUntil) {
      this.mx = Math.cos(this.unstickYaw);
      this.my = Math.sin(this.unstickYaw);
      speedScale = 1;
      if (bb.grounded)
        this.jump = true;
      else if (bb.energy > 8)
        this.boost = bb.t < this.unstickUntil - 0.4;
    }
    let mx = this.mx * speedScale, my = this.my * speedScale;
    const l = Math.hypot(mx, my);
    if (l > 1) {
      mx /= l;
      my /= l;
    }
    this.lastCmd = Math.hypot(mx, my);
    a.move = [mx, my];
    if (this.boost)
      a.boost = true;
    if (this.jump)
      a.jump = true;
    const minP = me.stats.min_pitch ?? -0.7, maxP = me.stats.max_pitch ?? 1.3;
    a.aim = [wrapPi4(wantYaw), wantPitch < minP ? minP : wantPitch > maxP ? maxP : wantPitch];
    if (fire[0] || fire[1])
      a.fire = [fire[0], fire[1]];
    return a;
  }
  liveTarget(id) {
    const tr = this.bb.tracker.get(id);
    if (!tr || tr.dead || !tr.visible)
      return null;
    if (tr.npc && tr.hp === 0)
      return null;
    return tr;
  }
  muzzleClear(yaw, out, tx, ty, tz) {
    const bb = this.bb;
    const w = bb.world;
    if (!w)
      return true;
    const mx = bb.x + out * Math.cos(yaw), my = bb.y + out * Math.sin(yaw), mz = bb.z + bb.muzzleH;
    if (!w.segClear(bb.x, bb.y, mz, mx, my, mz))
      return false;
    return w.segClear(mx, my, mz, tx, ty, tz);
  }
  gotoMove(x, y, z, jet, arrive) {
    const mv = this.mv;
    mv.goto(this.bb, x, y, z, jet, arrive);
    this.mx = mv.mx;
    this.my = mv.my;
    this.jump = mv.jump;
    this.boost = mv.boost;
  }
  fightMove(it, e) {
    const bb = this.bb;
    const P = bb.P;
    const d = e.dist > 0.01 ? e.dist : 0.01;
    const ux = (e.x - bb.x) / d, uy = (e.y - bb.y) / d;
    const los = bb.los[e.id] === 1 || e.npc;
    const R = it.range;
    const hold = it.style === STYLE_HOLD || it.style === STYLE_PEEK;
    if (!los) {
      const g = bb.gun;
      const reloading = g !== null && (g.reload ?? 0) > 0.3;
      if (reloading || hold) {
        const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn);
        this.mx = -uy * side * 0.5;
        this.my = ux * side * 0.5;
        if (this.blockedFn(this.mx * 2, this.my * 2))
          this.mx = this.my = 0;
        return;
      }
      this.gotoMove(e.x, e.y, e.z, false, Math.min(R, 10));
      return;
    }
    if (!hold && d > R + 18) {
      this.gotoMove(e.x, e.y, e.z, false, R);
      const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn);
      const bx = this.mx - uy * side * 0.55, by = this.my + ux * side * 0.55;
      const l = Math.hypot(bx, by);
      if (l > 0.1 && !this.blockedFn(bx / l, by / l)) {
        this.mx = bx / l;
        this.my = by / l;
      }
      return;
    }
    let radial = 0;
    if (!hold)
      radial = d > R + P.rangeBand ? 1 : d < R - P.rangeBand ? -1 : 0.5 * (d - R) / P.rangeBand;
    const side = this.jitter.step(bb.t, bb.rng, ux, uy, this.blockedFn);
    const sw = P.strafeSpeed;
    let mx = ux * radial - uy * side * sw;
    let my = uy * radial + ux * side * sw;
    const zm = bb.zone.margin(bb.x, bb.y);
    if (zm < P.zoneMargin) {
      const cx = bb.zone.ncx - bb.x, cy = bb.zone.ncy - bb.y;
      const cl = Math.hypot(cx, cy) || 1;
      const k = 1.5 * (1 - Math.max(0, zm) / P.zoneMargin);
      mx += cx / cl * k;
      my += cy / cl * k;
    }
    let l = Math.hypot(mx, my);
    if (l > 0.000001) {
      mx /= l;
      my /= l;
    }
    if (radial < 0 && d < R - P.kiteBoostGap && !e.npc) {
      let bs = -1e9, bx = 0, by = 0;
      for (let k = -3;k <= 3; k++) {
        const a = k * 0.42;
        const c = Math.cos(a), sn = Math.sin(a);
        const rx = -ux * c + uy * sn, ry = -uy * c - ux * sn;
        let free = 0;
        if (this.mv.walkOk(bb, bb.x + rx * 6, bb.y + ry * 6))
          free = this.mv.walkOk(bb, bb.x + rx * 16, bb.y + ry * 16) ? 16 : 6;
        if (free === 0)
          continue;
        const zm2 = bb.zone.marginNext(bb.x + rx * 30, bb.y + ry * 30);
        const sc = free * 1.5 - Math.abs(k) * 2 + (zm2 < 20 ? (zm2 - 20) * 0.5 : 0) + (k * side > 0 ? 1.5 : 0);
        if (sc > bs) {
          bs = sc;
          bx = rx;
          by = ry;
        }
      }
      if (bs > -1e8) {
        this.mx = bx;
        this.my = by;
        if (bb.energy > P.kiteBoostEnergy && bb.grounded && !(bb.haveLightning && d < 50))
          this.boost = true;
        return;
      }
    }
    if (l > 0.000001 && this.blockedFn(mx, my)) {
      const sx = -uy * side, sy = ux * side;
      if (!this.blockedFn(sx, sy)) {
        mx = sx;
        my = sy;
      } else if (!this.blockedFn(-sx, -sy)) {
        mx = -sx;
        my = -sy;
        this.jitter.sign = -side;
      } else if (radial !== 0 && !this.blockedFn(ux * Math.sign(radial), uy * Math.sign(radial))) {
        mx = ux * Math.sign(radial);
        my = uy * Math.sign(radial);
      } else {
        mx = -ux;
        my = -uy;
      }
    }
    l = Math.hypot(mx, my);
    this.mx = mx;
    this.my = my;
    if (P.fightJumpRate > 0 && bb.grounded && bb.rng.next() < P.fightJumpRate * bb.dt)
      this.jump = true;
  }
  ringMove(it, e) {
    const bb = this.bb;
    const cx = it.gx - bb.x, cy = it.gy - bb.y;
    const d = Math.hypot(cx, cy);
    const ringR = (bb.cfg.drops?.radius ?? 8) - bb.radius * 0 - 2.5;
    if (!e || d > ringR - 1.5) {
      if (d > 1.2) {
        this.mx = cx / d;
        this.my = cy / d;
      } else
        this.mx = this.my = 0;
      return;
    }
    const ed = e.dist > 0.01 ? e.dist : 0.01;
    const ux = (e.x - bb.x) / ed, uy = (e.y - bb.y) / ed;
    const side = this.jitter.step(bb.t, bb.rng, ux, uy);
    let mx = -uy * side, my = ux * side;
    const nx = bb.x + mx * 2.5 - it.gx, ny = bb.y + my * 2.5 - it.gy;
    if (Math.hypot(nx, ny) > ringR) {
      mx = -mx;
      my = -my;
      this.jitter.sign = -side;
      const n2x = bb.x + mx * 2.5 - it.gx, n2y = bb.y + my * 2.5 - it.gy;
      if (Math.hypot(n2x, n2y) > ringR) {
        mx = d > 0.5 ? cx / d : 0;
        my = d > 0.5 ? cy / d : 0;
      }
    }
    this.mx = mx;
    this.my = my;
    this.jump = false;
    this.boost = false;
  }
  faceYaw(it) {
    const bb = this.bb;
    const P = bb.P;
    if (it.face === FACE_YAW)
      return it.faceYaw;
    const moving = Math.hypot(this.mx, this.my) > 0.2;
    if (it.face === FACE_TRAVEL && moving)
      return Math.atan2(this.my, this.mx);
    if (it.face === FACE_THREATS || bb.t - bb.tHurt < P.lookDamageS) {
      let n = 0;
      const tr = bb.tracker.mechs;
      for (let i = 0;i < tr.length && n < 8; i++) {
        const e = tr[i];
        if (!e.known || e.dead || e.id === bb.me.id)
          continue;
        const recentHit = bb.t - e.tShotAtUs < 4;
        const fresh = e.age(bb.t) < 6;
        if (!(recentHit || fresh && e.dist < 220))
          continue;
        this.bearings[n] = fresh ? e.bearing : e.lastHitBearing;
        this.weights[n] = (recentHit ? 3 : 1) + (e.aimingAtUs ? 1 : 0) + 30 / (e.dist + 30);
        n++;
      }
      if (n > 0)
        return faceThreatYaw(this.bearings, this.weights, n, bb.yaw, bb.cfg.mech.front_arc_deg ?? 180);
      if (bb.t - bb.tHurt < P.lookDamageS)
        return bb.lastHurtBearing;
    }
    if (moving && it.face !== FACE_THREATS) {
      return Math.atan2(this.my, this.mx) + Math.sin(bb.t * P.scanFreq + this.scanPhase) * P.scanAmp;
    }
    return bb.yaw + this.spinDir * P.scanSpin * bb.dt * 1.5;
  }
}

// src/world/nav/graph.ts
var DEFAULT_PARAMS = {
  radius: 2.5,
  height: 9,
  walkSpeed: 11.7,
  boostSpeed: 19.5,
  gravity: 22,
  jumpSpeed: 11,
  maxRiseSpeed: 8.9,
  jetDrain: 15,
  maxEnergy: 100,
  stepUp: 1.2,
  maxSlopeDeg: 50,
  dt: 0.1,
  cell: 2,
  maxExpansions: 50000,
  heuristicWeight: 1.2,
  clearanceSlack: 0,
  jetEnergyBase: 8,
  jetEnergyPerM: 1.7,
  jetEnergyCost: 0.03,
  maxClimb: 64
};
var E_NONE = 0;
var E_WALK = 1;
var E_DROP = 2;
var E_JET = 3;
var K_GROUND = 0;
var K_TOP = 1;
var TIER_SCALE = [1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.6, 2];
var NT = TIER_SCALE.length;
var CLR_Q = 16;
var SCAN_R = 7.5;
var DX = [1, 1, 0, -1, -1, -1, 0, 1];
var DY = [0, 1, 1, 1, 0, -1, -1, -1];
function tierFor(scale) {
  for (let t = 0;t < NT; t++)
    if (TIER_SCALE[t] >= scale - 0.001)
      return t;
  return NT - 1;
}
function buildGraph(world, p) {
  const t0 = performance.now();
  const cs = Math.max(1, Math.round(p.cell));
  const nx = world.nx;
  const ny = world.ny;
  const gnx = Math.ceil(nx / cs);
  const gny = Math.ceil(ny / cs);
  const ncol = gnx * gny;
  const spanStart = world.spanStart;
  const spanData = world.spanData;
  const stepUp = p.stepUp;
  const minX = world.minX;
  const minY = world.minY;
  let cap = ncol;
  for (let J = 0;J < gny; J++) {
    const row = J * cs * nx;
    for (let I = 0;I < gnx; I++) {
      const c = row + I * cs;
      cap += spanStart[c + 1] - spanStart[c];
    }
  }
  const colStart = new Int32Array(ncol + 1);
  const nzA = new Float32Array(cap);
  const nIA = new Int16Array(cap);
  const nJA = new Int16Array(cap);
  const kindA = new Uint8Array(cap);
  const roofA = new Uint8Array(cap);
  const headA = new Float32Array(cap);
  let n = 0;
  for (let J = 0;J < gny; J++) {
    const y = minY + J * cs + 0.5;
    for (let I = 0;I < gnx; I++) {
      const c = J * cs * nx + I * cs;
      colStart[J * gnx + I] = n;
      const tz = world.groundZ(minX + I * cs + 0.5, y);
      const s0 = spanStart[c];
      const s1 = spanStart[c + 1];
      let inside = false;
      let ceil = Infinity;
      for (let k = s0;k < s1; k++) {
        const b = spanData[2 * k];
        const t = spanData[2 * k + 1];
        if (b <= tz && t > tz)
          inside = true;
        else if (b > tz && b < ceil)
          ceil = b;
      }
      if (!inside) {
        nzA[n] = tz;
        nIA[n] = I;
        nJA[n] = J;
        kindA[n] = K_GROUND;
        headA[n] = ceil - tz;
        n++;
      }
      for (let k = s0;k < s1; k++) {
        const t = spanData[2 * k + 1];
        if (t <= tz)
          continue;
        let h = Infinity;
        for (let k2 = s0;k2 < s1; k2++) {
          const b2 = spanData[2 * k2];
          if (b2 >= t && b2 - t < h)
            h = b2 - t;
        }
        nzA[n] = t;
        nIA[n] = I;
        nJA[n] = J;
        kindA[n] = K_TOP;
        roofA[n] = t - tz > 3 ? 1 : 0;
        headA[n] = h;
        n++;
      }
    }
  }
  colStart[ncol] = n;
  const nz = nzA.slice(0, n);
  const nI = nIA.slice(0, n);
  const nJ = nJA.slice(0, n);
  const kind = kindA.slice(0, n);
  const roof = roofA.slice(0, n);
  const head = headA.slice(0, n);
  const tierH = new Float64Array(NT);
  for (let t = 0;t < NT; t++)
    tierH[t] = p.height * TIER_SCALE[t];
  const R = Math.ceil(SCAN_R);
  const offs = [];
  for (let j = -R;j <= R; j++)
    for (let i = -R;i <= R; i++) {
      const d = Math.hypot(i, j);
      if (d <= SCAN_R)
        offs.push({ i, j, d });
    }
  offs.sort((a, b) => a.d - b.d);
  const no = offs.length;
  const offI = new Int32Array(no);
  const offJ = new Int32Array(no);
  const offQ = new Uint8Array(no);
  for (let o = 0;o < no; o++) {
    offI[o] = offs[o].i;
    offJ[o] = offs[o].j;
    offQ[o] = Math.max(0, Math.min(254, Math.floor((offs[o].d - 0.5) * CLR_Q)));
  }
  const b = world.bounds;
  const iLo = Math.max(0, Math.ceil(b.minX - minX - 0.5));
  const iHi = Math.min(nx - 1, Math.floor(b.maxX - minX - 0.5));
  const jLo = Math.max(0, Math.ceil(b.minY - minY - 0.5));
  const jHi = Math.min(ny - 1, Math.floor(b.maxY - minY - 0.5));
  const busy = new Uint8Array(ncol);
  {
    const rc = Math.ceil((SCAN_R + 1) / cs) + 1;
    for (let j = 0;j < ny; j++) {
      for (let i = 0;i < nx; i++) {
        const c = j * nx + i;
        const out = i < iLo || i > iHi || j < jLo || j > jHi;
        if (!out && spanStart[c] === spanStart[c + 1])
          continue;
        const I0 = Math.floor(i / cs);
        const J0 = Math.floor(j / cs);
        const centre = J0 * gnx + I0;
        if (busy[centre] === 2)
          continue;
        busy[centre] = 2;
        const ja = Math.max(0, J0 - rc);
        const jb = Math.min(gny - 1, J0 + rc);
        const ia = Math.max(0, I0 - rc);
        const ib = Math.min(gnx - 1, I0 + rc);
        for (let J = ja;J <= jb; J++) {
          const row = J * gnx;
          for (let I = ia;I <= ib; I++)
            if (busy[row + I] === 0)
              busy[row + I] = 1;
        }
      }
    }
  }
  const clr = new Uint8Array(NT * n).fill(255);
  for (let u = 0;u < n; u++) {
    const I = nI[u];
    const J = nJ[u];
    if (busy[J * gnx + I] === 0)
      continue;
    const ci = I * cs;
    const cj = J * cs;
    const z = nz[u];
    const zs = z + stepUp;
    let lowest = NT;
    for (let o = 0;o < no; o++) {
      const i = ci + offI[o];
      const j = cj + offJ[o];
      let tmin = NT;
      if (i < iLo || i > iHi || j < jLo || j > jHi)
        tmin = 0;
      else {
        const c = j * nx + i;
        const s0 = spanStart[c];
        const s1 = spanStart[c + 1];
        if (s0 === s1)
          continue;
        for (let k = s0;k < s1; k++) {
          if (spanData[2 * k + 1] <= zs)
            continue;
          const hb = spanData[2 * k] - z;
          if (hb <= stepUp)
            tmin = 0;
          else {
            tmin = 0;
            while (tmin < NT && tierH[tmin] <= hb)
              tmin++;
          }
          break;
        }
        if (tmin >= lowest)
          continue;
      }
      const q = offQ[o];
      for (let t = tmin;t < lowest; t++)
        clr[t * n + u] = q;
      lowest = tmin;
      if (lowest === 0)
        break;
    }
  }
  const nbr = new Int32Array(8 * n).fill(-1);
  const nbrType = new Uint8Array(8 * n);
  const tanMax = Math.tan(p.maxSlopeDeg * Math.PI / 180);
  for (let u = 0;u < n; u++) {
    const I = nI[u];
    const J = nJ[u];
    const za = nz[u];
    const ka = kind[u];
    const ax = minX + I * cs + 0.5;
    const ay = minY + J * cs + 0.5;
    for (let d = 0;d < 8; d++) {
      const I2 = I + DX[d];
      const J2 = J + DY[d];
      if (I2 < 0 || J2 < 0 || I2 >= gnx || J2 >= gny)
        continue;
      const col2 = J2 * gnx + I2;
      const s = colStart[col2];
      const e = colStart[col2 + 1];
      const L = (d & 1) === 1 ? cs * Math.SQRT2 : cs;
      const allow = tanMax * L;
      let target = -1;
      let type = E_NONE;
      for (let v = e - 1;v >= s; v--) {
        const dz = nz[v] - za;
        const bothGround = ka === K_GROUND && kind[v] === K_GROUND;
        if (bothGround) {
          if (dz > allow + 0.05)
            continue;
          const mz = world.groundZ(ax + DX[d] * cs * 0.5, ay + DY[d] * cs * 0.5);
          const half = allow * 0.5 + 0.1;
          const r1 = mz - za;
          const r2 = nz[v] - mz;
          let upOk = r1 <= half && r2 <= half;
          if (upOk && (r1 > half * 0.5 || r2 > half * 0.5)) {
            const q1 = world.groundZ(ax + DX[d] * cs * 0.25, ay + DY[d] * cs * 0.25);
            const q3 = world.groundZ(ax + DX[d] * cs * 0.75, ay + DY[d] * cs * 0.75);
            const quarter = allow * 0.25 + 0.05;
            upOk = q1 - za <= quarter && mz - q1 <= quarter && q3 - mz <= quarter && nz[v] - q3 <= quarter;
          }
          if (dz >= 0) {
            if (!upOk)
              continue;
            target = v;
            type = E_WALK;
          } else {
            target = v;
            type = upOk && -dz <= allow + 0.05 ? E_WALK : E_DROP;
          }
          break;
        }
        if (dz > stepUp + 0.01)
          continue;
        if (dz > 0.3 && kind[v] === K_GROUND) {
          const mz = world.groundZ(ax + DX[d] * cs * 0.5, ay + DY[d] * cs * 0.5);
          const q3 = world.groundZ(ax + DX[d] * cs * 0.75, ay + DY[d] * cs * 0.75);
          const quarter = allow * 0.25 + 0.05;
          if (nz[v] - q3 > quarter || mz > za && q3 - mz > quarter)
            continue;
        }
        target = v;
        type = dz < -stepUp ? E_DROP : E_WALK;
        break;
      }
      if (target < 0 && ka === K_GROUND && s < e && kind[s] === K_GROUND) {
        const dz = nz[s] - za;
        if (dz > 0 && dz <= p.maxClimb) {
          target = s;
          type = E_JET;
        }
      }
      if (target >= 0) {
        nbr[u * 8 + d] = target;
        nbrType[u * 8 + d] = type;
      }
    }
  }
  let pcap = 1 << 16;
  let pFrom = new Int32Array(pcap);
  let pTo = new Int32Array(pcap);
  let pType = new Uint8Array(pcap);
  let pLen = new Float32Array(pcap);
  let pClr = new Uint8Array(pcap);
  let np = 0;
  const push = (from, to, type, len, cc) => {
    if (np === pcap) {
      pcap *= 2;
      const a = new Int32Array(pcap);
      a.set(pFrom);
      pFrom = a;
      const b2 = new Int32Array(pcap);
      b2.set(pTo);
      pTo = b2;
      const c2 = new Uint8Array(pcap);
      c2.set(pType);
      pType = c2;
      const d2 = new Float32Array(pcap);
      d2.set(pLen);
      pLen = d2;
      const e2 = new Uint8Array(pcap);
      e2.set(pClr);
      pClr = e2;
    }
    pFrom[np] = from;
    pTo[np] = to;
    pType[np] = type;
    pLen[np] = len;
    pClr[np] = cc;
    np++;
  };
  const H0 = p.height;
  const HC = p.height * 1.25;
  const levelClear = (ci, cj, z) => {
    for (let o = 0;o < no; o++) {
      const i = ci + offI[o];
      const j = cj + offJ[o];
      if (i < iLo || i > iHi || j < jLo || j > jHi)
        return offQ[o];
      const c = j * nx + i;
      for (let k = spanStart[c], e = spanStart[c + 1];k < e; k++) {
        if (spanData[2 * k + 1] > z + 0.3 && spanData[2 * k] < z + HC)
          return offQ[o];
      }
    }
    return 255;
  };
  for (let r = 0;r < n; r++) {
    if (kind[r] !== K_TOP)
      continue;
    const I = nI[r];
    const J = nJ[r];
    const zr = nz[r];
    for (let d = 0;d < 8; d++) {
      const t1 = nbrType[r * 8 + d];
      if (t1 === E_WALK || t1 === E_JET)
        continue;
      const diag = (d & 1) === 1;
      const K = diag ? 3 : 4;
      let cc = 255;
      for (let k = 1;k <= K; k++) {
        const I2 = I + DX[d] * k;
        const J2 = J + DY[d] * k;
        if (I2 < 0 || J2 < 0 || I2 >= gnx || J2 >= gny)
          break;
        const c = J2 * cs * nx + I2 * cs;
        let blocked = false;
        for (let s = spanStart[c];s < spanStart[c + 1]; s++) {
          if (spanData[2 * s + 1] > zr + stepUp && spanData[2 * s] < zr + H0) {
            blocked = true;
            break;
          }
        }
        if (blocked)
          break;
        const col2 = J2 * gnx + I2;
        let sNode = -1;
        for (let v = colStart[col2 + 1] - 1;v >= colStart[col2]; v--) {
          if (nz[v] <= zr + stepUp) {
            sNode = v;
            break;
          }
        }
        if (sNode < 0)
          break;
        const dz = zr - nz[sNode];
        if (dz <= stepUp)
          break;
        const lc = levelClear(I2 * cs, J2 * cs, zr);
        if (lc < cc)
          cc = lc;
        if (k < 2)
          continue;
        const len = k * cs * (diag ? Math.SQRT2 : 1);
        push(r, sNode, E_DROP, len, cc);
        if (dz <= p.maxClimb)
          push(sNode, r, E_JET, len, cc);
      }
    }
  }
  const xStart = new Int32Array(n + 1);
  for (let e = 0;e < np; e++)
    xStart[pFrom[e] + 1] = xStart[pFrom[e] + 1] + 1;
  for (let u = 0;u < n; u++)
    xStart[u + 1] = xStart[u + 1] + xStart[u];
  const fill = xStart.slice(0, n);
  const xTo = new Int32Array(np);
  const xType = new Uint8Array(np);
  const xLen = new Float32Array(np);
  const xClr = new Uint8Array(np);
  for (let e = 0;e < np; e++) {
    const at = fill[pFrom[e]];
    fill[pFrom[e]] = at + 1;
    xTo[at] = pTo[e];
    xType[at] = pType[e];
    xLen[at] = pLen[e];
    xClr[at] = pClr[e];
  }
  return { cs, gnx, gny, minX, minY, n, colStart, nz, nI, nJ, kind, roof, head, clr, nbr, nbrType, xStart, xTo, xType, xLen, xClr, buildMs: performance.now() - t0 };
}
function navParamsFromMech(m, tickDt = 0.05) {
  const o = {};
  if (!m)
    return o;
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (num(m.radius))
    o.radius = m.radius;
  if (num(m.height))
    o.height = m.height;
  if (num(m.walk_speed))
    o.walkSpeed = m.walk_speed;
  if (num(m.boost_speed))
    o.boostSpeed = m.boost_speed;
  if (num(m.gravity))
    o.gravity = m.gravity;
  if (num(m.jump_speed))
    o.jumpSpeed = m.jump_speed;
  if (num(m.step_up))
    o.stepUp = m.step_up;
  if (num(m.max_slope_deg))
    o.maxSlopeDeg = m.max_slope_deg;
  if (num(m.energy))
    o.maxEnergy = m.energy;
  if (num(m.jet_drain))
    o.jetDrain = m.jet_drain;
  const g = o.gravity ?? DEFAULT_PARAMS.gravity;
  if (num(m.max_rise_speed))
    o.maxRiseSpeed = Math.max(1, m.max_rise_speed - g * tickDt);
  const rise = o.maxRiseSpeed ?? DEFAULT_PARAMS.maxRiseSpeed;
  o.jetEnergyPerM = Math.round((o.jetDrain ?? DEFAULT_PARAMS.jetDrain) / rise * 100) / 100;
  return o;
}

// src/world/nav/index.ts
var WP_WALK = 0;
var WP_DROP = 1;
var WP_JET = 2;
var cache = new WeakMap;
function createNav(world, mech) {
  const P = { ...DEFAULT_PARAMS };
  if (mech) {
    for (const k of Object.keys(mech))
      if (typeof mech[k] === "number" && Number.isFinite(mech[k]))
        P[k] = mech[k];
  }
  const key = JSON.stringify(P);
  let m = cache.get(world);
  if (!m)
    cache.set(world, m = new Map);
  let nav = m.get(key);
  if (!nav)
    m.set(key, nav = makeNav(world, P));
  return nav;
}

class Follower {
  path = null;
  serial = -1;
  idx = 0;
  bestDist = Infinity;
  since = 0;
  wait = 0;
  jetTries = 0;
  wasAir = false;
  stall = 0;
  lastX = 0;
  lastY = 0;
  bad = new Int32Array(8).fill(-1);
  nbad = 0;
  done = false;
  recovering = false;
  waiting = false;
}
var DIRLUT = new Int8Array(9);
for (let d = 0;d < 8; d++)
  DIRLUT[DX[d] + 1 + 3 * (DY[d] + 1)] = d;
DIRLUT[4] = -1;
var P_WALK = 1;
var P_ADROP = 2;
var P_AJET = 3;
var P_XDROP = 4;
var P_XJET = 5;
function makeNav(world, P) {
  const G = buildGraph(world, P);
  const { cs, gnx, gny, minX, minY, n: N, colStart, nz, nI, nJ, kind, roof, clr, nbr, nbrType, xStart, xTo, xType, xLen, xClr } = G;
  const gS = new Float32Array(N);
  const fS = new Float32Array(N);
  const parent = new Int32Array(N);
  const pedge = new Uint8Array(N);
  const stamp = new Uint32Array(N);
  const hpos = new Int32Array(N);
  const heap = new Int32Array(N);
  let gen = 0;
  let hn = 0;
  const CHAIN = 16384;
  const chain = new Int32Array(CHAIN);
  const cedge = new Uint8Array(CHAIN);
  const WPCAP = 2048;
  const wp = new Float32Array(WPCAP * 3);
  const wpk = new Uint8Array(WPCAP);
  let nwp = 0;
  const pool = [];
  let serial = 0;
  const mask = new Uint8Array(N);
  const queue = new Int32Array(N);
  const reach = { mask, count: 0 };
  const compCache = new Map;
  let off = 0;
  let thr = 0;
  const maxThr = Math.floor((7.5 - 0.5) * CLR_Q) - 4;
  function setBody(radius, height) {
    const scale = Math.max(radius / P.radius, height / P.height);
    off = tierFor(scale) * N;
    thr = Math.min(maxThr, Math.max(0, Math.ceil((radius - P.clearanceSlack) * CLR_Q)));
  }
  const colI = (x) => {
    const I = Math.floor((x - minX - 0.5) / cs + 0.5);
    return I < 0 ? 0 : I >= gnx ? gnx - 1 : I;
  };
  const colJ = (y) => {
    const J = Math.floor((y - minY - 0.5) / cs + 0.5);
    return J < 0 ? 0 : J >= gny ? gny - 1 : J;
  };
  const nodeX = (u) => minX + nI[u] * cs + 0.5;
  const nodeY = (u) => minY + nJ[u] * cs + 0.5;
  function nearestNode(x, y, z) {
    const col = colJ(y) * gnx + colI(x);
    const s = colStart[col];
    for (let v = colStart[col + 1] - 1;v >= s; v--)
      if (nz[v] <= z + 1.5)
        return v;
    return s;
  }
  function snap(x, y, z, thrS) {
    const I0 = colI(x);
    const J0 = colJ(y);
    let best = -1;
    let bestC = 1000000000000000000000000000000;
    const R = Math.ceil(8 / cs);
    for (let J = Math.max(0, J0 - R);J <= Math.min(gny - 1, J0 + R); J++) {
      const dy = minY + J * cs + 0.5 - y;
      for (let I = Math.max(0, I0 - R);I <= Math.min(gnx - 1, I0 + R); I++) {
        const dx = minX + I * cs + 0.5 - x;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestC)
          continue;
        const col = J * gnx + I;
        for (let v = colStart[col], e = colStart[col + 1];v < e; v++) {
          const dz = nz[v] - z;
          if (dz > 2.5)
            break;
          if (clr[off + v] < thrS)
            continue;
          const c = d2 + (dz < 0 ? 0.09 : 1) * dz * dz;
          if (c < bestC) {
            bestC = c;
            best = v;
          }
        }
      }
    }
    return best;
  }
  function stepTo(u, dI, dJ, thrL) {
    if (dI > 1 || dI < -1 || dJ > 1 || dJ < -1)
      return -1;
    const e = u * 8 + DIRLUT[dI + 1 + 3 * (dJ + 1)];
    const v = nbr[e];
    if (v < 0 || nbrType[e] === E_JET || clr[off + v] < thrL)
      return -1;
    return v;
  }
  function lineWalk(u, ax, ay, bx, by, thrL) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len / (cs * 0.45));
    let cI = nI[u];
    let cJ = nJ[u];
    for (let s = 1;s <= steps; s++) {
      const t = s / steps;
      let I = colI(ax + dx * t);
      let J = colJ(ay + dy * t);
      if (I === cI && J === cJ)
        continue;
      let v = stepTo(u, I - cI, J - cJ, thrL);
      if (v < 0) {
        if (s === steps)
          return -1;
        s++;
        const t2 = s / steps;
        I = colI(ax + dx * t2);
        J = colJ(ay + dy * t2);
        if (I === cI && J === cJ)
          return -1;
        v = stepTo(u, I - cI, J - cJ, thrL);
        if (v < 0)
          return -1;
      }
      u = v;
      cI = I;
      cJ = J;
    }
    return u;
  }
  function walkClear(ax, ay, az, bx, by, bz, radius) {
    setBody(radius, radius * P.height / P.radius);
    const u = nearestNode(ax, ay, az);
    if (nz[u] > az + 3)
      return false;
    const e = lineWalk(u, ax, ay, bx, by, thr);
    return e >= 0 && Math.abs(nz[e] - bz) <= 2.5;
  }
  function hup(v) {
    let i = hpos[v];
    const fv = fS[v];
    while (i > 0) {
      const pi = i - 1 >> 1;
      const pv = heap[pi];
      if (fS[pv] <= fv)
        break;
      heap[i] = pv;
      hpos[pv] = i;
      i = pi;
    }
    heap[i] = v;
    hpos[v] = i;
  }
  function hpop() {
    const top = heap[0];
    hn--;
    if (hn > 0) {
      const v = heap[hn];
      const fv = fS[v];
      let i = 0;
      for (;; ) {
        let c = 2 * i + 1;
        if (c >= hn)
          break;
        if (c + 1 < hn && fS[heap[c + 1]] < fS[heap[c]])
          c++;
        const cv = heap[c];
        if (fS[cv] >= fv)
          break;
        heap[i] = cv;
        hpos[cv] = i;
        i = c;
      }
      heap[i] = v;
      hpos[v] = i;
    }
    hpos[top] = -1;
    return top;
  }
  const jumpFree = P.jumpSpeed * P.jumpSpeed / (2 * P.gravity) * 0.8;
  function jetEnergy(dz) {
    if (dz <= jumpFree * 0.9)
      return 0;
    return P.jetEnergyBase + P.jetEnergyPerM * (dz - jumpFree);
  }
  function maxJetDz(q) {
    if (!q.allowJet)
      return -1;
    const e = q.energy * 0.9;
    if (e < P.jetEnergyBase)
      return jumpFree * 0.9;
    return Math.min(P.maxClimb, (e - P.jetEnergyBase) / P.jetEnergyPerM + jumpFree);
  }
  function emit(x, y, z, k) {
    if (nwp >= WPCAP)
      return;
    wp[nwp * 3] = x;
    wp[nwp * 3 + 1] = y;
    wp[nwp * 3 + 2] = z;
    wpk[nwp] = k;
    nwp++;
  }
  const emitNode = (u, k) => emit(nodeX(u), nodeY(u), nz[u], k);
  function plan(sx, sy, sz, gx, gy, gz, q, out) {
    setBody(q.radius, q.height);
    const start = snap(sx, sy, sz, thr);
    if (start < 0)
      return null;
    let goal = snap(gx, gy, gz, thr);
    let maxExp = q.maxExpansions ?? P.maxExpansions;
    let goalValid = true;
    if (goal < 0) {
      goal = nearestNode(gx, gy, gz);
      goalValid = false;
      maxExp = Math.min(maxExp, 8000);
    }
    const gI = nI[goal];
    const gJ = nJ[goal];
    const axisT = cs / P.walkSpeed;
    const diagT = axisT * Math.SQRT2;
    const vertT = 0.5 / P.walkSpeed;
    const hk = axisT * P.heuristicWeight;
    const mjz = maxJetDz(q);
    const soft = thr + 24;
    const grav = P.gravity;
    const invWalk = 1 / P.walkSpeed;
    const invRise = 1 / P.maxRiseSpeed;
    const eCost = P.jetEnergyCost;
    const avoid = q.avoid;
    const bad = avoid && avoid.nbad > 0 ? avoid.bad : null;
    const thrJet = thr + 8;
    gen++;
    if (gen >= 4294967295) {
      stamp.fill(0);
      gen = 1;
    }
    hn = 0;
    let hdx = nI[start] - gI;
    let hdy = nJ[start] - gJ;
    if (hdx < 0)
      hdx = -hdx;
    if (hdy < 0)
      hdy = -hdy;
    let h0 = (hdx > hdy ? hdx + 0.4142 * hdy : hdy + 0.4142 * hdx) * hk;
    stamp[start] = gen;
    gS[start] = 0;
    fS[start] = h0;
    parent[start] = -1;
    pedge[start] = 0;
    heap[0] = start;
    hpos[start] = 0;
    hn = 1;
    let best = start;
    let bestH = h0;
    let found = false;
    let exp = 0;
    while (hn > 0) {
      const u = hpop();
      if (u === goal && goalValid) {
        found = true;
        break;
      }
      const gu = gS[u];
      const hu = fS[u] - gu;
      if (hu < bestH) {
        bestH = hu;
        best = u;
      }
      if (++exp > maxExp)
        break;
      const zu = nz[u];
      const e0 = u * 8;
      const x0 = xStart[u];
      const x1 = xStart[u + 1];
      const ne = 8 + x1 - x0;
      for (let k = 0;k < ne; k++) {
        let v;
        let c;
        let pe;
        if (k < 8) {
          v = nbr[e0 + k];
          if (v < 0)
            continue;
          const cv = clr[off + v];
          if (cv < thr)
            continue;
          const t = nbrType[e0 + k];
          const dz = nz[v] - zu;
          const base = (k & 1) === 1 ? diagT : axisT;
          if (t === E_WALK) {
            c = base + (dz < 0 ? -dz : dz) * vertT;
            pe = P_WALK;
          } else if (t === E_DROP) {
            c = base + 0.5 * Math.sqrt(-2 * dz / grav);
            pe = P_ADROP;
          } else {
            if (dz > mjz)
              continue;
            if (bad !== null && bad.indexOf(v) >= 0)
              continue;
            c = base + 0.4 + dz * invRise + jetEnergy(dz) * eCost;
            pe = P_AJET;
          }
          if (cv < soft)
            c *= 1 + 0.6 * (soft - cv) / 24;
        } else {
          const e = x0 + k - 8;
          v = xTo[e];
          const cv = clr[off + v];
          if (cv < thr || xClr[e] < thr)
            continue;
          const dz = nz[v] - zu;
          if (xType[e] === E_DROP) {
            c = xLen[e] * invWalk + 0.5 * Math.sqrt(-2 * dz / grav);
            pe = P_XDROP;
          } else {
            if (dz > mjz || xClr[e] < thrJet)
              continue;
            if (bad !== null && bad.indexOf(v) >= 0)
              continue;
            c = xLen[e] * invWalk + 0.5 + dz * invRise + jetEnergy(dz) * eCost;
            pe = P_XJET;
          }
        }
        const ng = gu + c;
        if (stamp[v] !== gen) {
          stamp[v] = gen;
          let ddx = nI[v] - gI;
          let ddy = nJ[v] - gJ;
          if (ddx < 0)
            ddx = -ddx;
          if (ddy < 0)
            ddy = -ddy;
          gS[v] = ng;
          fS[v] = ng + (ddx > ddy ? ddx + 0.4142 * ddy : ddy + 0.4142 * ddx) * hk;
          parent[v] = u;
          pedge[v] = pe;
          hpos[v] = hn++;
          hup(v);
        } else if (ng < gS[v] && hpos[v] >= 0) {
          fS[v] = fS[v] - gS[v] + ng;
          gS[v] = ng;
          parent[v] = u;
          pedge[v] = pe;
          hup(v);
        }
      }
    }
    let target = found ? goal : best;
    let complete = found;
    let count = 1;
    for (let v = target;v !== start; v = parent[v])
      count++;
    while (count > CHAIN) {
      target = parent[target];
      count--;
      complete = false;
    }
    let time = 0;
    for (let i = count - 1, v = target;i >= 0; i--) {
      chain[i] = v;
      const pe = pedge[v];
      cedge[i] = pe;
      if (i > 0) {
        const u = parent[v];
        const dz = nz[v] - nz[u];
        const hl = cs * Math.hypot(nI[v] - nI[u], nJ[v] - nJ[u]);
        if (pe === P_WALK)
          time += Math.sqrt(hl * hl + dz * dz) * invWalk;
        else if (pe === P_ADROP || pe === P_XDROP)
          time += Math.max(hl * invWalk, Math.sqrt(-2 * dz / grav));
        else
          time += hl * invWalk + 0.3 + dz * invRise;
        v = u;
      }
    }
    nwp = 0;
    emitNode(chain[0], WP_WALK);
    const thrL = thr + 8;
    let i = 0;
    while (i < count - 1) {
      const e = cedge[i + 1];
      if (e === P_WALK || e === P_ADROP) {
        let j = i + 1;
        while (j + 1 < count && (cedge[j + 1] === P_WALK || cedge[j + 1] === P_ADROP))
          j++;
        let a = i;
        while (a < j) {
          const ua = chain[a];
          const ax = nodeX(ua);
          const ay = nodeY(ua);
          let lo = a + 1;
          let step = 2;
          let hi = -1;
          while (lo < j) {
            const pr = Math.min(j, lo + step);
            const up = chain[pr];
            if (lineWalk(ua, ax, ay, nodeX(up), nodeY(up), thrL) === up) {
              lo = pr;
              step *= 2;
            } else {
              hi = pr;
              break;
            }
          }
          while (hi - lo > 1) {
            const mid = lo + hi >> 1;
            const um = chain[mid];
            if (lineWalk(ua, ax, ay, nodeX(um), nodeY(um), thrL) === um)
              lo = mid;
            else
              hi = mid;
          }
          emitNode(chain[lo], WP_WALK);
          a = lo;
        }
        i = j;
      } else {
        emitNode(chain[i + 1], e === P_XDROP ? WP_DROP : WP_JET);
        i++;
      }
    }
    if (complete && nwp > 0 && colI(gx) === gI && colJ(gy) === gJ) {
      const o = (nwp - 1) * 3;
      if (nwp === 1)
        emit(gx, gy, nz[goal], WP_WALK);
      else {
        wp[o] = gx;
        wp[o + 1] = gy;
      }
    }
    let p = out;
    if (!p)
      p = pool.pop();
    if (!p)
      p = { pts: new Float32Array(96), kinds: new Uint8Array(32), n: 0, complete: false, cost: 0, radius: 0, height: 0, serial: 0, expansions: 0 };
    if (!p.kinds || p.kinds.length < nwp || p.pts.length < nwp * 3) {
      const capN = Math.max(32, nwp * 2);
      p.pts = new Float32Array(capN * 3);
      p.kinds = new Uint8Array(capN);
    }
    p.pts.set(wp.subarray(0, nwp * 3));
    p.kinds.set(wpk.subarray(0, nwp));
    p.n = nwp;
    p.complete = complete;
    p.cost = time;
    p.radius = q.radius;
    p.height = q.height;
    p.serial = ++serial;
    p.expansions = exp;
    return p;
  }
  function releasePath(p) {
    const e = p;
    if (e.kinds && pool.length < 64 && pool.indexOf(e) < 0)
      pool.push(e);
  }
  const stuckTicks = Math.max(3, Math.round(1 / P.dt));
  const stageTicks = Math.max(2, Math.round(0.4 / P.dt));
  const waitTicks = Math.round(8 / P.dt);
  const stallTicks = Math.max(3, Math.round(0.5 / P.dt));
  function markBad(f, x, y, z) {
    const u = nearestNode(x, y, z);
    if (f.bad.indexOf(u) >= 0)
      return;
    f.bad[f.nbad % f.bad.length] = u;
    f.nbad++;
  }
  function kindOf(path, i) {
    const k = path.kinds;
    if (k)
      return k[i];
    if (i === 0)
      return WP_WALK;
    const dz = path.pts[i * 3 + 2] - path.pts[i * 3 - 1];
    return dz > P.stepUp * 2 ? WP_JET : dz < -P.stepUp * 2 ? WP_DROP : WP_WALK;
  }
  function steer(state, path, x, y, z, vx, vy, vz, grounded, energy, out) {
    const f = state;
    out.mx = 0;
    out.my = 0;
    out.jump = false;
    out.boost = false;
    out.stuck = false;
    const n = path ? path.n : 0;
    if (n <= 0)
      return;
    const ex = path;
    const ser = ex.serial ?? 0;
    if (f.path !== path || f.serial !== ser) {
      f.path = path;
      f.serial = ser;
      f.idx = 0;
      f.bestDist = Infinity;
      f.since = 0;
      f.wait = 0;
      f.jetTries = 0;
      f.wasAir = false;
      f.stall = 0;
    }
    f.done = false;
    f.recovering = false;
    f.waiting = false;
    setBody(ex.radius ?? P.radius, ex.height ?? P.height);
    const pts = path.pts;
    const stepUp = P.stepUp;
    const thrL = thr + 8;
    let here = -1;
    let i = f.idx;
    if (i >= n)
      i = f.idx = n - 1;
    let k = WP_WALK;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let dxy = 0;
    for (let it = 0;it < 6; it++) {
      i = f.idx;
      k = kindOf(path, i);
      tx = pts[i * 3];
      ty = pts[i * 3 + 1];
      tz = pts[i * 3 + 2];
      dxy = Math.hypot(tx - x, ty - y);
      const onLevel = grounded && z >= tz - stepUp;
      if (k === WP_JET && !onLevel)
        break;
      if (i === n - 1)
        break;
      const dzt = z - tz;
      if (k === WP_JET && dzt < 3 || dxy < (k === WP_DROP ? 2.5 : 1.3) && dzt < 3 && dzt > -2.5) {
        f.idx++;
        f.bestDist = Infinity;
        f.since = 0;
        f.wait = 0;
        f.jetTries = 0;
        f.wasAir = false;
        continue;
      }
      if (kindOf(path, i + 1) === WP_WALK && grounded && (k !== WP_DROP || dzt < 2)) {
        if (here < 0)
          here = nearestNode(x, y, z);
        if (Math.abs(nz[here] - z) <= 2) {
          const bx = pts[i * 3 + 3];
          const by = pts[i * 3 + 4];
          const e = lineWalk(here, x, y, bx, by, thrL);
          if (e >= 0 && nI[e] === colI(bx) && nJ[e] === colJ(by) && Math.abs(nz[e] - pts[i * 3 + 5]) < 1.5) {
            f.idx++;
            f.bestDist = Infinity;
            f.since = 0;
            continue;
          }
        }
      }
      break;
    }
    let dirx = dxy > 0.000001 ? (tx - x) / dxy : 0;
    let diry = dxy > 0.000001 ? (ty - y) / dxy : 0;
    if (k === WP_JET && !(grounded && z >= tz - stepUp)) {
      if (grounded) {
        if (f.wasAir) {
          f.jetTries++;
          f.wasAir = false;
        }
        f.stall = 0;
        if (f.jetTries >= 2) {
          markBad(f, tx, ty, tz);
          out.stuck = true;
        }
        const sxp = i > 0 ? pts[i * 3 - 3] : x;
        const syp = i > 0 ? pts[i * 3 - 2] : y;
        const dS = Math.hypot(sxp - x, syp - y);
        if (dS > 3 && dxy > Math.hypot(tx - sxp, ty - syp) + 1) {
          out.mx = (sxp - x) / dS;
          out.my = (syp - y) / dS;
          return;
        }
        const need = Math.min(jetEnergy(tz - z) + 3, P.maxEnergy * 0.97);
        if (energy < need) {
          f.waiting = true;
          if (++f.wait > waitTicks)
            out.stuck = true;
          return;
        }
        out.jump = true;
        out.boost = true;
        out.mx = dirx;
        out.my = diry;
        return;
      }
      f.wasAir = true;
      const above = z > tz - 0.1;
      if (above && world.floorZ(x, y, z + 0.5, 0) >= tz - stepUp) {
        const m = dxy < 3 ? Math.max(0.2, dxy / 3) : 1;
        out.mx = dirx * m;
        out.my = diry * m;
        f.stall = 0;
        return;
      }
      out.boost = z + vz * 0.3 < tz + 0.8;
      if (above) {
        const moved = Math.hypot(x - f.lastX, y - f.lastY);
        if (moved < 0.03)
          f.stall++;
        else if (f.stall > 0 && moved > 0.15)
          f.stall = 0;
      }
      f.lastX = x;
      f.lastY = y;
      if (f.stall >= stallTicks) {
        const s = f.stall - stallTicks;
        const side = s < stageTicks ? 1 : s < 3 * stageTicks ? -1 : 0;
        if (side === 0) {
          markBad(f, tx, ty, tz);
          out.stuck = true;
          out.boost = false;
        } else {
          f.recovering = true;
          const px = -diry * side;
          const py = dirx * side;
          dirx = px * 0.9 + dirx * 0.4;
          diry = py * 0.9 + diry * 0.4;
          const l = Math.hypot(dirx, diry);
          dirx /= l;
          diry /= l;
        }
      }
      out.mx = dirx;
      out.my = diry;
      return;
    }
    let sp = 1;
    if (i === n - 1) {
      if (dxy < 0.35) {
        f.done = true;
        f.since = 0;
        return;
      }
      if (dxy < 1.5)
        sp = dxy / 1.5;
    }
    if (k === WP_DROP && z - tz > 2.5) {
      const h = z - tz;
      const tf = grounded ? Math.sqrt(2 * h / P.gravity) : (vz + Math.sqrt(vz * vz + 2 * P.gravity * h)) / P.gravity;
      const want = (dxy - (grounded ? 1 : 0)) / (Math.max(0.1, tf) * P.walkSpeed);
      sp = want > 1 ? 1 : want < (grounded ? 0.3 : 0) ? grounded ? 0.3 : 0 : want;
    }
    if (grounded) {
      if (here < 0)
        here = nearestNode(x, y, z);
      const c = clr[off + here];
      const band = thr + 16;
      if (c < band && Math.abs(nz[here] - z) <= 1.5) {
        let gx = 0;
        let gy = 0;
        for (let d = 0;d < 8; d++) {
          const v = nbr[here * 8 + d];
          const cv = v < 0 || nbrType[here * 8 + d] === E_JET ? 0 : clr[off + v];
          const w = (d & 1) === 1 ? 0.7071 : 1;
          gx += DX[d] * w * (cv - c);
          gy += DY[d] * w * (cv - c);
        }
        const gl = Math.hypot(gx, gy);
        if (gl > 0.000001) {
          const w = Math.min(0.8, 0.7 * (band - c) / 16);
          dirx += gx / gl * w;
          diry += gy / gl * w;
          const l = Math.hypot(dirx, diry);
          if (l > 0.000001) {
            dirx /= l;
            diry /= l;
          }
        }
      }
    }
    if (dxy < f.bestDist - 0.25) {
      f.bestDist = dxy;
      f.since = 0;
    } else
      f.since++;
    if (f.since >= stuckTicks) {
      const s = f.since - stuckTicks;
      const stage = Math.floor(s / stageTicks);
      const px = -diry;
      const py = dirx;
      f.recovering = true;
      if (stage === 0) {
        dirx = px * 0.9 + dirx * 0.35;
        diry = py * 0.9 + diry * 0.35;
      } else if (stage === 1 || stage === 2) {
        dirx = -px * 0.9 + dirx * 0.35;
        diry = -py * 0.9 + diry * 0.35;
      } else if (stage === 3) {
        out.jump = grounded;
      } else if (stage === 4 || stage === 5) {
        out.jump = grounded;
        out.boost = !grounded || s % stageTicks === 0;
      } else {
        out.stuck = true;
        f.recovering = false;
      }
      const l = Math.hypot(dirx, diry);
      if (l > 1) {
        dirx /= l;
        diry /= l;
      }
      sp = 1;
    }
    if (!grounded && sp < 1 && !f.recovering) {
      const vAlong = vx * dirx + vy * diry;
      if (vAlong > sp * P.walkSpeed + 1)
        sp = 0;
    }
    out.mx = dirx * sp;
    out.my = diry * sp;
  }
  function followerInfo(state) {
    const f = state;
    return { idx: f.idx, done: f.done, recovering: f.recovering, waiting: f.waiting };
  }
  function reachableFrom(x, y, z, q) {
    setBody(q.radius, q.height);
    const s = snap(x, y, z, thr);
    if (s < 0)
      return null;
    const mjz = maxJetDz(q);
    mask.fill(0);
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    mask[s] = 1;
    while (qh < qt) {
      const u = queue[qh++];
      const zu = nz[u];
      for (let d = 0;d < 8; d++) {
        const v = nbr[u * 8 + d];
        if (v < 0 || mask[v] === 1 || clr[off + v] < thr)
          continue;
        if (nbrType[u * 8 + d] === E_JET && nz[v] - zu > mjz)
          continue;
        mask[v] = 1;
        queue[qt++] = v;
      }
      for (let e = xStart[u], e1 = xStart[u + 1];e < e1; e++) {
        const v = xTo[e];
        if (mask[v] === 1 || clr[off + v] < thr || xClr[e] < thr)
          continue;
        if (xType[e] === E_JET && (nz[v] - zu > mjz || xClr[e] < thr + 8))
          continue;
        mask[v] = 1;
        queue[qt++] = v;
      }
    }
    reach.count = qt;
    return reach;
  }
  function components(q) {
    setBody(q.radius, q.height);
    const key = off * 256 + thr;
    let comp = compCache.get(key);
    if (comp)
      return comp;
    if (compCache.size >= 6)
      compCache.clear();
    comp = new Int32Array(N).fill(-1);
    let id = 0;
    for (let s0 = 0;s0 < N; s0++) {
      if (comp[s0] !== -1 || clr[off + s0] < thr)
        continue;
      let qh = 0;
      let qt = 0;
      queue[qt++] = s0;
      comp[s0] = id;
      while (qh < qt) {
        const u = queue[qh++];
        for (let d = 0;d < 8; d++) {
          const v = nbr[u * 8 + d];
          if (v < 0 || comp[v] !== -1 || clr[off + v] < thr)
            continue;
          if (nbrType[u * 8 + d] === E_JET)
            continue;
          const back = v * 8 + (d + 4 & 7);
          if (nbr[back] !== u || nbrType[back] === E_JET)
            continue;
          comp[v] = id;
          queue[qt++] = v;
        }
      }
      id++;
    }
    compCache.set(key, comp);
    return comp;
  }
  function componentAt(x, y, z, q) {
    const comp = components(q);
    const s = snap(x, y, z, thr);
    return s < 0 ? -1 : comp[s];
  }
  function roofNodesNear(x, y, r, out) {
    const R = Math.ceil(r / cs);
    const I0 = colI(x);
    const J0 = colJ(y);
    const r2 = r * r;
    let cnt = 0;
    for (let J = Math.max(0, J0 - R);J <= Math.min(gny - 1, J0 + R); J++) {
      const dy = minY + J * cs + 0.5 - y;
      for (let I = Math.max(0, I0 - R);I <= Math.min(gnx - 1, I0 + R); I++) {
        const dx = minX + I * cs + 0.5 - x;
        if (dx * dx + dy * dy > r2)
          continue;
        const col = J * gnx + I;
        for (let v = colStart[col], e = colStart[col + 1];v < e; v++) {
          if (kind[v] === K_TOP && roof[v] === 1) {
            if (cnt >= out.length)
              return cnt;
            out[cnt++] = v;
          }
        }
      }
    }
    return cnt;
  }
  return {
    params: P,
    graph: G,
    plan,
    releasePath,
    steer,
    newFollower: () => new Follower,
    followerInfo,
    walkClear,
    nearestNode,
    nearestValidNode(x, y, z, q) {
      setBody(q.radius, q.height);
      return snap(x, y, z, thr);
    },
    nodeSurfaceZ: (u) => nz[u],
    nodeX,
    nodeY,
    clearanceAt(x, y, z) {
      const u = nearestNode(x, y, z);
      const c = clr[u];
      return c === 255 ? 7 : c / CLR_Q;
    },
    reachableFrom,
    components,
    componentAt,
    roofNodesNear,
    jetEnergy
  };
}

// src/bot/brain/navx.ts
var TAU6 = Math.PI * 2;
var EXP_CELL = 6;
var EXP_RAYS = 12;
var exposureCache = new WeakMap;
function exposureField(world) {
  let f = exposureCache.get(world);
  if (!f) {
    const nx = Math.ceil((world.maxX - world.minX) / EXP_CELL);
    const ny = Math.ceil((world.maxY - world.minY) / EXP_CELL);
    f = { nx, ny, v: new Float32Array(nx * ny).fill(-1) };
    exposureCache.set(world, f);
  }
  return f;
}
function exposureAt(world, x, y, rayLen) {
  const f = exposureField(world);
  const i = Math.floor((x - world.minX) / EXP_CELL);
  const j = Math.floor((y - world.minY) / EXP_CELL);
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny)
    return 1;
  const c = j * f.nx + i;
  let e = f.v[c];
  if (e >= 0)
    return e;
  const cx = world.minX + (i + 0.5) * EXP_CELL;
  const cy = world.minY + (j + 0.5) * EXP_CELL;
  const z = world.groundZ(cx, cy) + 8.5;
  let sum = 0;
  for (let k = 0;k < EXP_RAYS; k++) {
    const a = (k + 0.5) * (TAU6 / EXP_RAYS);
    sum += world.raycast(cx, cy, z, Math.cos(a), Math.sin(a), 0, rayLen);
  }
  e = sum / (EXP_RAYS * rayLen);
  f.v[c] = e;
  return e;
}
var newSpot = () => ({ x: 0, y: 0, z: 0, ok: false, score: 0 });

class Mover {
  nav;
  world;
  follower;
  path = null;
  havePath = false;
  goalX = 1e9;
  goalY = 1e9;
  goalZ = 0;
  planTick = -1e9;
  lastGotoTick = -1e9;
  plannedTick = -1;
  q = { radius: 2.5, height: 9, allowJet: true, energy: 100, maxExpansions: 30000 };
  so = { mx: 0, my: 0, jump: false, boost: false, stuck: false };
  stuckFor = 0;
  bugSign = 1;
  bugUntil = -1;
  mx = 0;
  my = 0;
  jump = false;
  boost = false;
  dist = 0;
  arrived = false;
  incomplete = false;
  noBoost = false;
  plans = 0;
  stuckEvents = 0;
  constructor(world, mech) {
    this.world = world;
    let nav = null;
    try {
      if (world)
        nav = mech ? createNav(world, navParamsFromMech(mech)) : createNav(world);
    } catch {
      nav = null;
    }
    this.nav = nav;
    this.follower = nav ? nav.newFollower() : null;
  }
  floor(x, y, z) {
    return this.world.floorZ(x, y, z + 1.3, 0);
  }
  walkOk(bb, tx, ty) {
    const b = this.world.bounds;
    const m = bb.radius + 0.8;
    if (tx < b.minX + m || tx > b.maxX - m || ty < b.minY + m || ty > b.maxY - m)
      return false;
    if (this.nav)
      return this.nav.walkClear(bb.x, bb.y, bb.z, tx, ty, this.floor(tx, ty, bb.z), bb.radius);
    return this.localOk(bb.x, bb.y, bb.z, tx, ty, bb.height);
  }
  walkOkFrom(ax, ay, az, tx, ty, radius) {
    if (this.nav)
      return this.nav.walkClear(ax, ay, az, tx, ty, this.floor(tx, ty, az), radius);
    return this.localOk(ax, ay, az, tx, ty, 9);
  }
  localOk(ax, ay, az, bx, by, height) {
    const w = this.world;
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d));
    let z = az;
    for (let i = 1;i <= n; i++) {
      const f = i / n;
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
      if (px < w.bounds.minX + 3 || px > w.bounds.maxX - 3 || py < w.bounds.minY + 3 || py > w.bounds.maxY - 3)
        return false;
      const fz = w.floorZ(px, py, z + 1.2, 0);
      if (fz > z + 1.25)
        return false;
      if (w.solid(px, py, fz + 1.5) || w.solid(px, py, fz + height - 0.5))
        return false;
      z = fz;
    }
    return true;
  }
  blocked(bb, dx, dy, dist) {
    return !this.walkOk(bb, bb.x + dx * dist, bb.y + dy * dist);
  }
  standZ(bb, x, y, z) {
    const w = this.world;
    if (x < w.bounds.minX + 4 || x > w.bounds.maxX - 4 || y < w.bounds.minY + 4 || y > w.bounds.maxY - 4)
      return NaN;
    const fz = this.floor(x, y, z);
    if (this.nav) {
      if (this.nav.clearanceAt(x, y, fz) < bb.radius + 0.3)
        return NaN;
      return fz;
    }
    if (w.solid(x, y, fz + 1.5) || w.solid(x, y, fz + bb.height - 0.5))
      return NaN;
    return fz;
  }
  goto(bb, gx, gy, gz, allowJet, arrive) {
    const P = bb.P;
    this.mx = this.my = 0;
    this.jump = this.boost = false;
    const dx = gx - bb.x, dy = gy - bb.y;
    const d = Math.hypot(dx, dy);
    this.dist = d;
    this.arrived = d <= arrive && Math.abs(gz - bb.z) < 4;
    this.incomplete = false;
    this.noBoost = false;
    if (this.arrived) {
      this.lastGotoTick = bb.tick;
      return;
    }
    const nav = this.nav;
    if (nav && this.follower) {
      const moved = Math.hypot(gx - this.goalX, gy - this.goalY) + Math.abs(gz - this.goalZ);
      const interrupted = bb.tick - this.lastGotoTick > (bb.cfg.match.decide_every ?? 2) * 2;
      const old = bb.tick - this.planTick >= P.replanTicks * 2;
      const need = !this.havePath || moved > Math.min(P.replanGoalDist, 0.25 * d + 1) || interrupted || old || this.stuckFor >= 1;
      if (need && this.plannedTick !== bb.tick && (bb.grounded || !this.havePath)) {
        this.plannedTick = bb.tick;
        const q = this.q;
        q.radius = bb.radius;
        q.height = bb.height;
        q.allowJet = allowJet;
        q.energy = Math.max(bb.energy, bb.maxEnergy * 0.95);
        q.maxExpansions = P.navMaxExp;
        q.avoid = this.stuckFor >= 1 ? this.follower : undefined;
        const p = nav.plan(bb.x, bb.y, bb.z, gx, gy, gz, q, this.path ?? undefined);
        this.plans++;
        if (p) {
          this.path = p;
          this.havePath = true;
        } else
          this.havePath = false;
        this.goalX = gx;
        this.goalY = gy;
        this.goalZ = gz;
        this.planTick = bb.tick;
        if (this.stuckFor > 0)
          this.stuckFor = -30;
      }
      this.lastGotoTick = bb.tick;
      if (this.havePath && this.path) {
        const so = this.so;
        nav.steer(this.follower, this.path, bb.x, bb.y, bb.z, bb.vx, bb.vy, bb.me.vel[2], bb.grounded, bb.energy, so);
        this.mx = so.mx;
        this.my = so.my;
        this.jump = so.jump;
        this.boost = so.boost;
        this.incomplete = !this.path.complete;
        const fi = nav.followerInfo(this.follower);
        const kinds = this.path.kinds;
        this.noBoost = fi.waiting || so.boost || so.jump || kinds !== undefined && fi.idx < this.path.n && kinds[fi.idx] === WP_JET;
        if (so.stuck) {
          if (this.stuckFor <= 0)
            this.stuckEvents++;
          this.stuckFor = 1;
        } else if (this.stuckFor < 0)
          this.stuckFor++;
        if (so.mx !== 0 || so.my !== 0 || so.jump || so.boost)
          return;
        if (fi.waiting)
          return;
        if (d <= arrive + 1.5)
          return;
      }
    }
    this.lastGotoTick = bb.tick;
    this.local(bb, dx / (d || 1), dy / (d || 1));
  }
  local(bb, ux, uy) {
    const probe = 5;
    if (!this.blocked(bb, ux, uy, probe) && bb.t >= this.bugUntil) {
      this.mx = ux;
      this.my = uy;
      return;
    }
    if (bb.t >= this.bugUntil) {
      this.bugSign = bb.rng.next() < 0.5 ? 1 : -1;
      this.bugUntil = bb.t + 1.5;
    }
    for (let k = 1;k <= 5; k++) {
      const a = k * 0.5 * this.bugSign;
      const c = Math.cos(a), s = Math.sin(a);
      const rx = ux * c - uy * s, ry = ux * s + uy * c;
      if (!this.blocked(bb, rx, ry, probe)) {
        this.mx = rx;
        this.my = ry;
        return;
      }
    }
    this.mx = ux;
    this.my = uy;
    this.jump = bb.grounded;
    this.boost = !bb.grounded && bb.energy > 20;
  }
  findCover(bb, threats, n, maxDist, out) {
    out.ok = false;
    if (n <= 0)
      return false;
    const w = this.world;
    let best = 1e9;
    const base = bb.rng.next() * TAU6;
    for (let ring = 0;ring < 6; ring++) {
      const r = ring === 0 ? 6 : ring === 1 ? 10 : ring === 2 ? 15 : ring === 3 ? 22 : ring === 4 ? 32 : 45;
      if (r > maxDist)
        break;
      if (best < r)
        break;
      for (let k = 0;k < 16; k++) {
        const a = base + k * TAU6 / 16;
        const px = bb.x + r * Math.cos(a), py = bb.y + r * Math.sin(a);
        const pz = this.standZ(bb, px, py, bb.z);
        if (pz !== pz)
          continue;
        if (bb.zone.margin(px, py) < 6)
          continue;
        let hidden = true;
        let toward = 0;
        for (let i = 0;i < n && hidden; i++) {
          const e = threats[i];
          const ez = e.z + 8 / 9 * e.height;
          if (w.segClear(e.x, e.y, ez, px, py, pz + 0.5 * bb.height) || w.segClear(e.x, e.y, ez, px, py, pz + bb.height))
            hidden = false;
          const ed = e.dist > 1 ? e.dist : 1;
          const dot = ((e.x - bb.x) * (px - bb.x) + (e.y - bb.y) * (py - bb.y)) / (ed * r);
          if (dot > toward)
            toward = dot;
        }
        if (!hidden)
          continue;
        let score = r + toward * 12;
        if (!this.walkOk(bb, px, py))
          score += 14;
        if (score < best) {
          best = score;
          out.x = px;
          out.y = py;
          out.z = pz;
          out.ok = true;
          out.score = score;
        }
      }
    }
    return out.ok;
  }
  findHide(bb, cur, samples, out) {
    const P = bb.P;
    const w = this.world;
    const zn = bb.zone;
    out.ok = false;
    let best = -1e9;
    const nav = this.nav;
    const myComp = nav ? nav.componentAt(bb.x, bb.y, bb.z, this.qFor(bb)) : 0;
    for (let s = -1;s < samples; s++) {
      let px, py;
      if (s < 0) {
        if (!cur || !cur.ok)
          continue;
        px = cur.x;
        py = cur.y;
      } else {
        const a = bb.rng.next() * TAU6;
        const r = 8 + Math.sqrt(bb.rng.next()) * P.hideSearchR;
        px = bb.x + r * Math.cos(a);
        py = bb.y + r * Math.sin(a);
      }
      const gz = w.groundZ(px, py);
      const pz = this.standZ(bb, px, py, gz);
      if (pz !== pz || Math.abs(pz - gz) > 1.5)
        continue;
      if (nav && myComp >= 0 && nav.componentAt(px, py, pz, this.q) !== myComp)
        continue;
      const score = this.hideScore(bb, px, py, pz) + (s < 0 ? P.hideSwitchMargin : 0);
      if (score > best) {
        best = score;
        out.x = px;
        out.y = py;
        out.z = pz;
        out.ok = true;
        out.score = score - (s < 0 ? P.hideSwitchMargin : 0);
      }
    }
    return out.ok;
  }
  hideScore(bb, px, py, pz) {
    const P = bb.P;
    const w = this.world;
    const zn = bb.zone;
    const d = Math.hypot(px - bb.x, py - bb.y);
    let score = -P.hideWExposure * exposureAt(w, px, py, P.exposureRay) - P.hideWDist * d;
    const eta = d / bb.walk + 6;
    const mNow = zn.marginAt(px, py, bb.t + eta);
    if (mNow < 12)
      score -= 500 + (12 - mNow) * 5;
    const mNext = zn.marginNext(px, py);
    const untilShrink = zn.t0 - bb.t;
    if (mNext < 15)
      score -= untilShrink < 40 ? 200 + (15 - mNext) : 12 + 0.1 * (15 - mNext);
    const tr = bb.tracker.mechs;
    let minD = 150;
    for (let i = 0;i < tr.length; i++) {
      const e = tr[i];
      if (!e.known || e.dead || e.id === bb.me.id)
        continue;
      const age = e.age(bb.t);
      if (age > P.enemyMemoryS)
        continue;
      const ed = Math.hypot(px - e.x, py - e.y);
      if (ed < minD)
        minD = ed;
      if (age < 6 && ed < 220) {
        const ez = e.z + 8 / 9 * e.height;
        if (w.segClear(e.x, e.y, ez, px, py, pz + 0.5 * bb.height) || w.segClear(e.x, e.y, ez, px, py, pz + bb.height))
          score -= 60;
      }
    }
    score += P.hideWEnemy * minD;
    const npcs = bb.tracker.npcs;
    for (let i = 0;i < npcs.length; i++) {
      const e = npcs[i];
      if (e.known && e.hp !== 0 && Math.hypot(px - e.x, py - e.y) < 60)
        score -= 40;
    }
    score -= P.hideWHeat * Math.min(3, bb.sounds.heatAt(px, py));
    return score;
  }
  qFor(bb) {
    const q = this.q;
    q.radius = bb.radius;
    q.height = bb.height;
    q.allowJet = false;
    q.energy = bb.energy;
    return q;
  }
}

// src/bot/brain/params.ts
var DEFAULTS = {
  forceMode: 0,
  unknownSquadAfter: 12,
  quietDeathS: 6,
  ffaEarlyT: 45,
  ffaOtherDeaths: 5,
  rangeGun: 115,
  rangeLightning: 22,
  rangeVsLightning: 58,
  rangeLaserVsMortar: 70,
  rangeVsMortar: 16,
  engageDist: 90,
  kiteBoostGap: 999,
  kiteBoostEnergy: 25,
  rangeKite: 75,
  rangeBand: 5,
  strafeSpeed: 1,
  strafeMin: 0.35,
  strafeMax: 1,
  fightJumpRate: 0,
  fireMinP: 0.12,
  gunMaxDist: 210,
  fireMarginSigma: 0.6,
  targetJink: 9,
  lightningReserve: 4,
  lightningFarmEnergy: 60,
  lightningConeFrac: 0.42,
  lightningRangeFrac: 0.97,
  laserMaxDist: 230,
  laserShrink: 0.75,
  reloadIdleFrac: 0.7,
  reloadNoLosS: 0.6,
  reloadLowAmmo: 5,
  crateShootDist: 110,
  npcShootDist: 70,
  enemyHitP0: 0.75,
  enemyHitHalfDist: 85,
  squadDisengageRatio: 0.55,
  squadDisengageHp: 0.45,
  squadFinishHp: 0.3,
  squadRegenUntil: 0.9,
  coverMaxDist: 45,
  reloadCoverHp: 0,
  reloadCoverDist: 14,
  ffaFightRatio: 2.2,
  ffaFinishHp: 0.3,
  ffaCorneredDist: 38,
  ffaFleePatience: 4,
  ffaDuelAlive: 2,
  ffaDuelRadius: 30,
  valCube: 10,
  valCrate: 9,
  valNpc: 13,
  valLightning: 40,
  valLaser: 22,
  valMortar: 0,
  valSwapToLightning: 14,
  valSwapFromMortar: 20,
  lootTimeCost: 1,
  lootZoneCost: 0.5,
  lootMaxDist: 260,
  cubeOverCapMult: 0.35,
  npcMinHp: 0.55,
  lootForgetS: 150,
  lootSwitchMargin: 4,
  valDrop: 60,
  dropEnemyClear: 60,
  dropLeadS: 12,
  zoneMargin: 18,
  zoneSlackS: 10,
  zoneAimFrac: 0.55,
  zoneEarlyS: 25,
  silentSpeed: 4.7,
  silentEnemyDist: 75,
  hideSearchR: 140,
  exposureRay: 140,
  hideWExposure: 100,
  hideWDist: 0.25,
  hideWEnemy: 0.25,
  hideWHeat: 10,
  hideSwitchMargin: 14,
  hideReplanS: 4,
  ffaQuietUntil: 9999,
  ffaLootDist: 90,
  ffaLootEnemyClear: 130,
  enemyMemoryS: 20,
  replanGoalDist: 6,
  replanTicks: 40,
  navMaxExp: 20000,
  arriveDist: 2,
  jetMinEnergy: 45,
  boostTravelDist: 9999,
  boostMinEnergy: 70,
  probeDist: 4.5,
  dodgeOverride: 0.75,
  scanAmp: 1.15,
  scanFreq: 1.5,
  scanSpin: 2.2,
  lookDamageS: 2.5,
  upPlating: 100,
  upArmor: 92,
  upNanites: 70,
  upGunDamage: 88,
  upGunRate: 86,
  upLightningEfficiency: 90,
  upLightningRange: 60,
  upLightningChain: 30,
  upLaserDamage: 80,
  upLaserCharge: 72,
  upLaserPierce: 10,
  upGunMag: 55,
  upGunVelocity: 50,
  upGyros: 45,
  upServos: 58,
  upReactor: 40,
  upCapacitor: 42,
  upJets: 20,
  upSensors: 35,
  upMortar: 1
};
function resolveParams(p) {
  const out = { ...DEFAULTS };
  if (p) {
    for (const k in p) {
      const v = p[k];
      if (k in out && typeof v === "number" && Number.isFinite(v))
        out[k] = v;
    }
  }
  return out;
}

// src/bot/strategies/common.ts
function ourDps(bb, e, dist) {
  const P = bb.P;
  let dps = 0;
  const g = bb.gun;
  if (g) {
    const cd = Math.max(0.25, g.stats.cooldown ?? 0.24);
    const mag = g.stats.mag ?? 12;
    const rel = g.stats.reload ?? 2.4;
    const p = dist > (g.stats.range ?? 230) ? 0 : hitProbGun(dist, e.radius, e.height, P.targetJink, g.stats.spread_deg ?? 0.6, g.stats.speed ?? 252);
    dps += (g.stats.damage ?? 45) * p / cd * (mag * cd / (mag * cd + rel));
  }
  const lt = bb.ltg;
  if (lt && dist <= (lt.stats.range ?? 45) * P.lightningRangeFrac)
    dps += (lt.stats.damage ?? 60) / 0.3;
  const la = bb.las;
  if (la && dist <= (la.stats.range ?? 280)) {
    let d = (la.stats.damage ?? 315) * 0.6 / ((la.stats.charge ?? 0.75) + (la.stats.cooldown ?? 1.65));
    if (e.weapons & W_MORTAR)
      d *= 1 + (la.stats.cookoff ?? 0.6);
    dps += d;
  }
  return dps * bb.dmgMult;
}
function theirDps(bb, e, dist) {
  const P = bb.P;
  const w = e.weapons === 0 ? W_GUN : e.weapons | W_GUN;
  const wc = bb.cfg.weapons;
  let dps = 0;
  if (w & W_GUN && dist < (wc.gun.range ?? 230)) {
    const p = P.enemyHitP0 / (1 + dist / P.enemyHitHalfDist * (dist / P.enemyHitHalfDist));
    const cd = 0.25;
    const mag = wc.gun.mag ?? 12;
    dps += (wc.gun.damage ?? 45) * p / cd * (mag * cd / (mag * cd + (wc.gun.reload ?? 2.4)));
  }
  if (w & W_LIGHTNING && dist <= (wc.lightning.range ?? 45) + 3)
    dps += (wc.lightning.damage ?? 60) / 0.3;
  if (w & W_LASER && dist <= (wc.laser.range ?? 280)) {
    let d = (wc.laser.damage ?? 315) * 0.3 / ((wc.laser.charge ?? 0.75) + (wc.laser.cooldown ?? 1.65));
    if (bb.haveMortar)
      d *= 1 + (wc.laser.cookoff ?? 0.6);
    dps += d;
  }
  if (w & W_MORTAR && dist > 12 && dist < 200)
    dps += 25;
  const cap = bb.cfg.cubes.stat_cap ?? 10;
  dps *= 1 + (bb.cfg.cubes.damage_per_cube ?? 0.04) * Math.min(e.cubes, cap);
  return dps * (1 - (bb.me.stats.armor ?? 0));
}
function timeToKill(bb, e) {
  const hp = e.hp >= 0 ? e.hp : bb.cfg.mech.hp ?? 1400;
  const d = ourDps(bb, e, e.dist);
  return d > 1 ? hp / d : 1000;
}
function timeToDie(bb) {
  let dps = 0;
  for (let i = 0;i < bb.nEn; i++) {
    const e = bb.en[i];
    if (bb.los[e.id] !== 1)
      continue;
    const engaged = e.aimingAtUs || bb.t - e.tShotAtUs < 3 || e.aimErr < 0.6;
    dps += theirDps(bb, e, e.dist) * (engaged ? 1 : 0.4);
  }
  return dps > 1 ? bb.hp / dps : 1000;
}
function fightRatio(bb, e) {
  return timeToDie(bb) / Math.max(0.5, timeToKill(bb, e));
}
function duelRange(bb, e) {
  const P = bb.P;
  if (e.npc)
    return 28;
  const eLtg = (e.weapons & W_LIGHTNING) !== 0;
  const eMor = (e.weapons & W_MORTAR) !== 0;
  if (bb.haveLightning && bb.energy > 15 && bb.nThreats <= 1 && bb.nEn <= 1)
    return P.rangeLightning;
  if (eLtg)
    return P.rangeVsLightning;
  if (eMor)
    return bb.haveLaser ? P.rangeLaserVsMortar : P.rangeVsMortar;
  return P.rangeGun;
}
function pickTarget(bb) {
  const m = bb.mem;
  let best = null;
  let bs = 1e9;
  for (let i = 0;i < bb.nEn; i++) {
    const e = bb.en[i];
    let s = Math.min(40, timeToKill(bb, e)) + e.dist / 30;
    if (bb.los[e.id] !== 1)
      s += 6;
    if (e.aimingAtUs)
      s -= 1.5;
    if (bb.t - e.tShotAtUs < 3)
      s -= 1.5;
    if (e.id === m.targetId && bb.t - m.targetT < 1)
      s -= 2.5;
    if (s < bs) {
      bs = s;
      best = e;
    }
  }
  if (best) {
    m.targetId = best.id;
    m.targetT = bb.t;
  }
  return best;
}
var newZoneGoal = () => ({ x: 0, y: 0, level: 0 });
function zoneDuty(bb, out) {
  const P = bb.P;
  const zn = bb.zone;
  const dx = bb.x - zn.ncx, dy = bb.y - zn.ncy;
  const dNext = Math.hypot(dx, dy);
  const aimFrac = zn.nr <= 30 ? 0.2 : P.zoneAimFrac;
  const want = zn.nr * aimFrac;
  if (dNext > want) {
    out.x = zn.ncx + dx / dNext * want;
    out.y = zn.ncy + dy / dNext * want;
  } else {
    out.x = bb.x;
    out.y = bb.y;
  }
  const need = Math.max(0, dNext - zn.nr + P.zoneMargin);
  const needT = need / bb.walk * 1.35;
  const margin = zn.margin(bb.x, bb.y);
  const tOut = zn.timeUntilOutside(bb.x, bb.y, 90);
  let level = 0;
  if (!bb.inZone || margin < 4 || tOut < needT + 2)
    level = 2;
  else if (margin < P.zoneMargin || tOut < needT + P.zoneSlackS)
    level = 1;
  else if (need > 0 && zn.t0 - bb.t < needT + P.zoneEarlyS)
    level = 1;
  out.level = level;
  return level;
}
var newLootChoice = () => ({ item: null, npc: null, score: 0 });
function pickupValue(bb, wk) {
  const P = bb.P;
  if (bb.held & wk)
    return 0;
  const free = bb.freeSlot >= 0;
  if (wk === W_LIGHTNING)
    return free ? P.valLightning : bb.haveMortar ? P.valLightning : bb.haveLaser ? P.valSwapToLightning : 0;
  if (wk === W_LASER)
    return free ? P.valLaser : bb.haveMortar ? P.valSwapFromMortar : 0;
  if (wk === W_MORTAR)
    return free ? P.valMortar : 0;
  return 0;
}
function swapSlot(bb, wk) {
  if (bb.freeSlot >= 0)
    return -1;
  if (bb.morSlot >= 0)
    return bb.morSlot;
  if (wk === W_LIGHTNING && bb.lasSlot >= 0 && (bb.las?.charge ?? 0) <= 0)
    return bb.lasSlot;
  return -1;
}
function bestLoot(bb, silentOnly, maxDist, out) {
  const P = bb.P;
  const zn = bb.zone;
  const m = bb.mem;
  out.item = null;
  out.npc = null;
  out.score = 0;
  let best = 0;
  const cap = bb.cfg.cubes.stat_cap ?? 10;
  const cubeMult = bb.cubes >= cap ? P.cubeOverCapMult : 1;
  const items = bb.loot.items;
  const w = bb.world;
  for (let i = 0;i < items.length; i++) {
    const it = items[i];
    const d = Math.hypot(it.x - bb.x, it.y - bb.y);
    if (d > maxDist)
      continue;
    let val = 0;
    let extra = 0;
    if (it.type === L_CUBE)
      val = P.valCube * cubeMult;
    else if (it.type === L_CRATE) {
      if (silentOnly || !bb.gun)
        continue;
      val = P.valCrate * cubeMult + 0.5 * Math.max(0, pickupValue(bb, W_LIGHTNING)) * 0.33;
      extra = 2;
    } else if (it.type === L_PICKUP)
      val = pickupValue(bb, it.wk);
    if (val <= 0)
      continue;
    const dz = it.z - (w ? w.groundZ(it.x, it.y) : it.z);
    const climb = it.z - bb.z;
    if (climb > 45)
      continue;
    if (climb > 3)
      extra += climb / 8 + 4;
    else if (dz > 3 && climb < -3)
      extra += 1;
    const eta = d / bb.walk * 1.25 + extra;
    const mz = zn.marginAt(it.x, it.y, bb.t + eta + 2);
    if (mz < 6)
      continue;
    let s = val - P.lootTimeCost * eta;
    const mNext = zn.marginNext(it.x, it.y);
    if (mNext < 0 && zn.t0 - bb.t < 40)
      s += P.lootZoneCost * Math.max(-60, mNext) * 0.2;
    if (it.id === m.lootId)
      s += P.lootSwitchMargin;
    if (s > best) {
      best = s;
      out.item = it;
      out.npc = null;
    }
  }
  if (!silentOnly && bb.gun && bb.hpFrac >= P.npcMinHp) {
    const npcs = bb.tracker.npcs;
    for (let i = 0;i < npcs.length; i++) {
      const n = npcs[i];
      if (!n.known || n.dead || n.hp === 0)
        continue;
      if (!n.visible && bb.t - n.tSeen > 25)
        continue;
      const d = n.dist;
      if (d > maxDist)
        continue;
      const eta = Math.max(0, d - 30) / bb.walk * 1.25 + 3.5;
      if (zn.marginAt(n.x, n.y, bb.t + eta + 3) < 10)
        continue;
      let s = P.valNpc * cubeMult - P.lootTimeCost * eta;
      if (n.id === m.lootId)
        s += P.lootSwitchMargin;
      if (s > best) {
        best = s;
        out.item = null;
        out.npc = n;
      }
    }
  }
  out.score = best;
  m.lootId = out.item ? out.item.id : out.npc ? out.npc.id : -1;
  return best > 0;
}
function lootIntent(bb, c, it, pace) {
  if (c.npc) {
    it.fight(c.npc.id, 0, 28, "npc");
    return;
  }
  const item = c.item;
  if (item.type === L_CRATE) {
    it.loot(item.x, item.y, item.z, pace, "crate");
    it.shootCrate = item.id;
    it.arrive = 3;
  } else if (item.type === L_CUBE) {
    it.loot(item.x, item.y, item.z, pace, "cube");
    it.arrive = 0.6;
  } else {
    it.loot(item.x, item.y, item.z, pace, "weapon");
    it.arrive = 1.2;
    it.takeId = item.id;
    it.dropSlot = swapSlot(bb, item.wk);
  }
}
function weaponReflex(bb, it) {
  if (it.takeId >= 0)
    return;
  const reach = (bb.cfg.loot.pickup_radius ?? 4) - 0.25;
  const items = bb.loot.items;
  let bv = 0;
  for (let i = 0;i < items.length; i++) {
    const p = items[i];
    if (p.type !== L_PICKUP || p.tSeen !== bb.t)
      continue;
    if (Math.hypot(p.x - bb.x, p.y - bb.y) > reach || Math.abs(p.z - bb.z) > 3.8)
      continue;
    const v = pickupValue(bb, p.wk);
    if (v > bv) {
      const slot = swapSlot(bb, p.wk);
      if (bb.freeSlot < 0 && slot < 0)
        continue;
      bv = v;
      it.takeId = p.id;
      it.dropSlot = slot;
    }
  }
}
function wantDrop(bb, enemyClear) {
  const P = bb.P;
  let best = -1;
  let bs = 0;
  for (let i = 0;i < bb.drops.length; i++) {
    const d = bb.drops[i];
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y);
    const eta = dist / bb.walk * 1.3;
    if (d.lands_in > eta + P.dropLeadS)
      continue;
    if (bb.zone.marginAt(d.pos[0], d.pos[1], bb.t + Math.max(eta, d.lands_in) + d.capture_s + 2) < 4)
      continue;
    if (d.holder !== null && d.holder !== bb.me.id && d.capture_s - d.progress < eta)
      continue;
    if (enemyClear > 0) {
      let near = false;
      const tr = bb.tracker.mechs;
      for (let k = 0;k < tr.length; k++) {
        const e = tr[k];
        if (!e.known || e.dead || e.id === bb.me.id || e.age(bb.t) > 8)
          continue;
        if (Math.hypot(e.x - d.pos[0], e.y - d.pos[1]) < enemyClear)
          near = true;
      }
      if (near)
        continue;
    }
    const s = P.valDrop * (0.4 + 0.6 * (1 - bb.hpFrac) + 0.3) - P.lootTimeCost * Math.max(eta, d.lands_in);
    if (s > bs) {
      bs = s;
      best = i;
    }
  }
  return best;
}
function pickUpgrade(bb, offer) {
  const P = bb.P;
  let best = 0;
  let bs = -1e9;
  for (let i = 0;i < offer.choices.length; i++) {
    const id = offer.choices[i].id;
    let key = "up" + id.replace(/(^|_)([a-z])/g, (_m, _a, c) => c.toUpperCase());
    if (id.startsWith("mortar"))
      key = "upMortar";
    let s = P[key] ?? 5;
    s -= 4 * bb.upgradeCount(id);
    if (id.startsWith("lightning") && !bb.haveLightning)
      s = 2;
    if (id.startsWith("laser") && !bb.haveLaser)
      s = 2;
    if (s > bs) {
      bs = s;
      best = i;
    }
  }
  return best;
}
function zoneIntent(bb, zg, it, target) {
  const z = bb.world ? bb.world.groundZ(zg.x, zg.y) : bb.z;
  it.goto(zg.x, zg.y, z, zg.level >= 2 && (!bb.inZone || bb.zone.margin(bb.x, bb.y) < 0) ? PACE_BOOST : PACE_WALK, zg.level >= 2 ? "zone!" : "zone");
  it.arrive = 4;
  it.face = FACE_THREATS;
  if (target)
    it.targetId = target.id;
}

// src/bot/strategies/squad.ts
class SquadScratch {
  zg = newZoneGoal();
  lc = newLootChoice();
  spot = newSpot();
  spot2 = newSpot();
  one = [];
  phantom = new Track(50);
}
function duelIntent(bb, mv, sc, it, target, allowDisengage) {
  const P = bb.P;
  const m = bb.mem;
  const ratio = fightRatio(bb, target);
  const tHpFrac = target.hp >= 0 && target.maxHp > 0 ? target.hp / target.maxHp : 1;
  const g = bb.gun;
  const ltgUsable = bb.haveLightning && bb.energy > 12 && target.dist < 48;
  if (allowDisengage) {
    if (!m.regen && ratio < P.squadDisengageRatio && bb.hpFrac < P.squadDisengageHp && tHpFrac > P.squadFinishHp) {
      if (bb.t - m.coverT > 0.5) {
        m.coverT = bb.t;
        m.coverOk = mv.findCover(bb, bb.en, bb.nEn, P.coverMaxDist, sc.spot);
        if (m.coverOk) {
          m.coverX = sc.spot.x;
          m.coverY = sc.spot.y;
          m.coverZ = sc.spot.z;
        }
      }
      if (m.coverOk)
        m.regen = true;
    }
    if (m.regen) {
      if (bb.hpFrac >= P.squadRegenUntil || tHpFrac <= P.squadFinishHp)
        m.regen = false;
      else {
        const seen = bb.los[target.id] === 1;
        if (seen && bb.t - m.coverT > 0.5) {
          m.coverT = bb.t;
          m.coverOk = mv.findCover(bb, bb.en, bb.nEn, P.coverMaxDist, sc.spot);
          if (m.coverOk) {
            m.coverX = sc.spot.x;
            m.coverY = sc.spot.y;
            m.coverZ = sc.spot.z;
          }
        }
        if (m.coverOk && !(seen && target.dist < 14)) {
          it.flee(m.coverX, m.coverY, m.coverZ, bb.energy > 30 && seen ? PACE_BOOST : PACE_WALK, "regen");
          it.targetId = target.id;
          it.arrive = 1;
          return;
        }
        m.regen = false;
      }
    }
  }
  if (P.reloadCoverHp > 0 && g && (g.reload ?? 0) > 0.7 && !ltgUsable && tHpFrac > P.reloadCoverHp && bb.los[target.id] === 1) {
    if (bb.t - m.coverT > 0.4) {
      m.coverT = bb.t;
      sc.one[0] = target;
      m.coverOk = mv.findCover(bb, sc.one, 1, P.reloadCoverDist, sc.spot);
      if (m.coverOk) {
        m.coverX = sc.spot.x;
        m.coverY = sc.spot.y;
        m.coverZ = sc.spot.z;
      }
    }
    if (m.coverOk && Math.hypot(m.coverX - bb.x, m.coverY - bb.y) < P.reloadCoverDist + 4) {
      it.flee(m.coverX, m.coverY, m.coverZ, PACE_WALK, "reload");
      it.targetId = target.id;
      it.arrive = 0.8;
      return;
    }
  }
  it.fight(target.id, STYLE_PUSH, duelRange(bb, target), "duel");
}
function underFire(bb, mv, sc, it) {
  const m = bb.mem;
  const npc = bb.npcAggressor;
  if (npc) {
    it.fight(npc.id, STYLE_PUSH, 26, "npc!");
    return true;
  }
  if (bb.t - bb.tHurt > 2.5 || bb.lastHurtBy < 0 || bb.lastHurtBy >= 100)
    return false;
  const ph = sc.phantom;
  const d = 90;
  ph.x = bb.x + d * Math.cos(bb.lastHurtBearing);
  ph.y = bb.y + d * Math.sin(bb.lastHurtBearing);
  ph.z = bb.world ? bb.world.groundZ(ph.x, ph.y) : bb.z;
  ph.dist = d;
  if (bb.t - m.coverT > 0.5) {
    m.coverT = bb.t;
    sc.one[0] = ph;
    m.coverOk = mv.findCover(bb, sc.one, 1, 35, sc.spot);
    if (m.coverOk) {
      m.coverX = sc.spot.x;
      m.coverY = sc.spot.y;
      m.coverZ = sc.spot.z;
    }
  }
  if (m.coverOk)
    it.flee(m.coverX, m.coverY, m.coverZ, PACE_WALK, "sniped");
  else
    it.hold(bb.x, bb.y, bb.z, "sniped");
  it.face = FACE_THREATS;
  return true;
}
function decideSquad(bb, mv, sc) {
  const P = bb.P;
  const m = bb.mem;
  const it = bb.intent.reset();
  const target = pickTarget(bb);
  const zl = zoneDuty(bb, sc.zg);
  if (zl >= 2) {
    zoneIntent(bb, sc.zg, it, target);
    weaponReflex(bb, it);
    return it;
  }
  const di = wantDrop(bb, 0);
  if (di >= 0) {
    const d = bb.drops[di];
    const dist = Math.hypot(d.pos[0] - bb.x, d.pos[1] - bb.y);
    if (!target || bb.nThreats === 0 || dist < 35) {
      it.capture(d.pos[0], d.pos[1], d.pos[2], target || dist < 40 ? PACE_WALK : PACE_BOOST, "drop");
      it.face = FACE_THREATS;
      if (target)
        it.targetId = target.id;
      weaponReflex(bb, it);
      return it;
    }
  }
  const engaged = target !== null && (bb.nThreats > 0 || target.dist < P.engageDist || bb.t - target.tShotAtUs < 4 || bb.t - target.tHitByUs < 2);
  if (target && engaged) {
    duelIntent(bb, mv, sc, it, target, true);
    weaponReflex(bb, it);
    return it;
  }
  if (underFire(bb, mv, sc, it)) {
    weaponReflex(bb, it);
    return it;
  }
  const hurt = bb.hpFrac < P.squadRegenUntil;
  if (!hurt)
    m.regen = false;
  const recentEnemy = bb.t - bb.tEnemySeen < 6;
  if (zl >= 1 && !(bestLoot(bb, hurt, 60, sc.lc) && sc.lc.score > 6)) {
    zoneIntent(bb, sc.zg, it, target);
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN;
    weaponReflex(bb, it);
    return it;
  }
  if (bestLoot(bb, hurt && bb.regenIn <= 0.01 ? true : hurt && bb.hpFrac < 0.6, P.lootMaxDist, sc.lc)) {
    lootIntent(bb, sc.lc, it, PACE_WALK);
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN;
    if (target && it.targetId < 0 && it.shootCrate < 0)
      it.targetId = target.id;
    weaponReflex(bb, it);
    return it;
  }
  if (hurt) {
    it.hold(bb.x, bb.y, bb.z, "heal");
    it.face = recentEnemy ? FACE_THREATS : FACE_SCAN;
    weaponReflex(bb, it);
    return it;
  }
  if (bb.t >= m.n2 || Math.hypot(m.n0 - bb.x, m.n1 - bb.y) < 8 || bb.zone.marginNext(m.n0, m.n1) < 10) {
    const a = bb.rng.next() * Math.PI * 2;
    const r = Math.sqrt(bb.rng.next()) * bb.zone.nr * 0.75;
    m.n0 = bb.zone.ncx + r * Math.cos(a);
    m.n1 = bb.zone.ncy + r * Math.sin(a);
    m.n2 = bb.t + 25;
  }
  it.goto(m.n0, m.n1, bb.world ? bb.world.groundZ(m.n0, m.n1) : bb.z, PACE_WALK, "explore");
  it.arrive = 6;
  it.allowJet = false;
  weaponReflex(bb, it);
  return it;
}

// src/bot/strategies/ffa.ts
function hideSpot(bb, mv, sc, force) {
  const P = bb.P;
  const m = bb.mem;
  if (force || !m.hideOk || bb.t - m.hideT >= P.hideReplanS) {
    m.hideT = bb.t;
    const cur = sc.spot;
    cur.ok = m.hideOk;
    cur.x = m.hideX;
    cur.y = m.hideY;
    cur.z = m.hideZ;
    if (mv.findHide(bb, cur, force ? 28 : 14, sc.spot2)) {
      m.hideOk = true;
      m.hideX = sc.spot2.x;
      m.hideY = sc.spot2.y;
      m.hideZ = sc.spot2.z;
      m.hideScore = sc.spot2.score;
    }
  }
  return m.hideOk;
}
function someoneNear(bb, dist, maxAge) {
  const tr = bb.tracker.mechs;
  for (let i = 0;i < tr.length; i++) {
    const e = tr[i];
    if (!e.known || e.dead || e.id === bb.me.id)
      continue;
    if (e.age(bb.t) <= maxAge && Math.hypot(e.x - bb.x, e.y - bb.y) < dist)
      return true;
  }
  return bb.sounds.movementNear(2.5);
}
function decideFfa(bb, mv, sc) {
  const P = bb.P;
  const m = bb.mem;
  const it = bb.intent.reset();
  const target = pickTarget(bb);
  const zl = zoneDuty(bb, sc.zg);
  const quiet = someoneNear(bb, P.silentEnemyDist, 8);
  const pace = quiet ? PACE_SILENT : PACE_WALK;
  let found = null;
  let nFound = 0;
  for (let i = 0;i < bb.nEn; i++) {
    const e = bb.en[i];
    const on = bb.t - e.tShotAtUs < 3 || bb.los[e.id] === 1 && (e.aimingAtUs || bb.sees[e.id] === 1 && e.aimErr < 0.5);
    if (on) {
      nFound++;
      if (!found || e.dist < found.dist)
        found = e;
    }
  }
  if (!found)
    m.fleeSince = -1;
  if (zl >= 2) {
    zoneIntent(bb, sc.zg, it, found ? target ?? found : null);
    it.weaponsFree = found !== null;
    weaponReflex(bb, it);
    return it;
  }
  const endGame = bb.obs.alive <= P.ffaDuelAlive || bb.zone.r <= P.ffaDuelRadius;
  if (endGame && target && (bb.zone.r <= P.ffaDuelRadius || found || fightRatio(bb, target) > 0.9)) {
    duelIntent(bb, mv, sc, it, target, true);
    weaponReflex(bb, it);
    return it;
  }
  if (found) {
    const tgt = target && (bb.t - target.tShotAtUs < 3 || target.aimingAtUs) ? target : found;
    const tHp = tgt.hp >= 0 && tgt.maxHp > 0 ? tgt.hp / tgt.maxHp : 1;
    if (m.fleeSince < 0)
      m.fleeSince = bb.t;
    const ratio = fightRatio(bb, tgt);
    const cornered = found.dist < P.ffaCorneredDist || bb.t - m.fleeSince > P.ffaFleePatience && bb.t - bb.tHurt < 1.5;
    const finishing = tHp < P.ffaFinishHp && bb.hpFrac > 0.45;
    if (cornered && nFound <= 2 || finishing || ratio > P.ffaFightRatio) {
      duelIntent(bb, mv, sc, it, tgt, true);
      it.label = cornered ? "cornered" : finishing ? "finish" : "adv";
      weaponReflex(bb, it);
      return it;
    }
    if (bb.t - m.coverT > 0.4) {
      m.coverT = bb.t;
      m.coverOk = mv.findCover(bb, bb.en, bb.nEn, 60, sc.spot);
      if (m.coverOk) {
        m.coverX = sc.spot.x;
        m.coverY = sc.spot.y;
        m.coverZ = sc.spot.z;
      }
    }
    if (m.coverOk) {
      it.flee(m.coverX, m.coverY, m.coverZ, bb.energy > 25 ? PACE_BOOST : PACE_WALK, "break");
      it.arrive = 1;
    } else if (hideSpot(bb, mv, sc, bb.t - m.hideT > 1.5))
      it.flee(m.hideX, m.hideY, m.hideZ, bb.energy > 25 ? PACE_BOOST : PACE_WALK, "run");
    else {
      duelIntent(bb, mv, sc, it, tgt, false);
      weaponReflex(bb, it);
      return it;
    }
    it.targetId = tgt.id;
    it.weaponsFree = bb.t - bb.tHurt < 3 || tgt.dist < 60;
    weaponReflex(bb, it);
    return it;
  }
  if (target) {
    const tHp = target.hp >= 0 && target.maxHp > 0 ? target.hp / target.maxHp : 1;
    if (tHp < P.ffaFinishHp && bb.hpFrac > 0.6 && target.dist < 110 && bb.nEn <= 2) {
      duelIntent(bb, mv, sc, it, target, false);
      it.label = "ambush";
      weaponReflex(bb, it);
      return it;
    }
    let exposed = false;
    for (let i = 0;i < bb.nEn; i++)
      if (bb.los[bb.en[i].id] === 1)
        exposed = true;
    if (exposed) {
      if (bb.t - m.coverT > 0.5) {
        m.coverT = bb.t;
        m.coverOk = mv.findCover(bb, bb.en, bb.nEn, 50, sc.spot);
        if (m.coverOk) {
          m.coverX = sc.spot.x;
          m.coverY = sc.spot.y;
          m.coverZ = sc.spot.z;
        }
      }
      if (m.coverOk) {
        it.flee(m.coverX, m.coverY, m.coverZ, bb.nearestD < 45 ? PACE_SILENT : PACE_WALK, "hide");
        it.arrive = 1;
      } else if (hideSpot(bb, mv, sc, bb.t - m.hideT > 1.5))
        it.goto(m.hideX, m.hideY, m.hideZ, pace, "away");
      else
        it.hold(bb.x, bb.y, bb.z, "freeze");
    } else {
      it.hold(bb.x, bb.y, bb.z, "lurk");
    }
    it.weaponsFree = false;
    it.face = FACE_YAW;
    it.faceYaw = (bb.nearest ?? target).bearing;
    weaponReflex(bb, it);
    return it;
  }
  if (underFire(bb, mv, sc, it)) {
    weaponReflex(bb, it);
    return it;
  }
  it.weaponsFree = false;
  const calm = !someoneNear(bb, P.ffaLootEnemyClear, 10);
  if (zl >= 1 && !(calm && bestLoot(bb, true, 40, sc.lc) && sc.lc.score > 6)) {
    if (hideSpot(bb, mv, sc, false) && bb.zone.marginNext(m.hideX, m.hideY) > 10)
      it.goto(m.hideX, m.hideY, m.hideZ, pace, "rotate");
    else {
      zoneIntent(bb, sc.zg, it, null);
      it.pace = pace;
      m.hideOk = false;
    }
    it.face = FACE_SCAN;
    weaponReflex(bb, it);
    return it;
  }
  if (calm) {
    const noisy = bb.t >= P.ffaQuietUntil;
    if (bestLoot(bb, !noisy, P.ffaLootDist, sc.lc)) {
      lootIntent(bb, sc.lc, it, pace);
      it.weaponsFree = false;
      weaponReflex(bb, it);
      return it;
    }
  }
  if (hideSpot(bb, mv, sc, false)) {
    it.hold(m.hideX, m.hideY, m.hideZ, "ghost");
    if (Math.hypot(m.hideX - bb.x, m.hideY - bb.y) > 2.5)
      it.kind = K_GOTO;
    it.pace = pace;
    it.arrive = 1.5;
  } else
    it.hold(bb.x, bb.y, bb.z, "still");
  it.face = bb.t - bb.tEnemySeen < 8 ? FACE_THREATS : FACE_SCAN;
  weaponReflex(bb, it);
  return it;
}

// src/bot/brain/index.ts
var BOT_NAME = "ai-caramba";
function createBrain(ctx) {
  const bb = new Blackboard(ctx.hello, ctx.world, resolveParams(ctx.params), ctx.rng);
  const mover = new Mover(ctx.world, ctx.hello.config.mech);
  const exec = new Executor(bb, mover);
  const sc = new SquadScratch;
  let last = bb.intent;
  const act = (obs) => {
    bb.update(obs);
    let it;
    if (bb.mode === MODE_SQUAD)
      it = decideSquad(bb, mover, sc);
    else
      it = decideFfa(bb, mover, sc);
    last = it;
    const a = exec.run(it);
    if (obs.offer)
      a.pick = pickUpgrade(bb, obs.offer);
    return a;
  };
  return { name: BOT_NAME, act, bb, exec, mover, lastIntent: () => last };
}
var mainBot = (ctx) => createBrain(ctx);

// src/bot/brain/warmup.ts
function selfWeapons(cfg, second) {
  const g = cfg.weapons.gun;
  const w0 = { kind: "gun", cooldown: 0, ammo: g.mag ?? 12, reload: 0, stats: { ...g } };
  if (!second)
    return [w0, null];
  const s = cfg.weapons[second];
  return [w0, { kind: second, cooldown: 0, charge: 0, stats: { ...s } }];
}
function warmup(bot, hello, decisions = 240) {
  const world = bot.bb?.world;
  if (!world)
    return;
  const cfg = hello.config;
  const zc = cfg.zone.start_center;
  for (let variant = 0;variant < 3; variant++) {
    const ctx = {
      hello,
      world,
      params: { forceMode: variant === 0 ? 2 : variant === 1 ? 1 : 0 },
      rng: makeRng(1234 + variant),
      realtime: false,
      log: () => {}
    };
    const b = createBrain(ctx);
    let x = zc[0] + 60 * variant - 40;
    let y = zc[1] + 35 * variant;
    let z = world.floorZ(x, y, 1000, 0);
    let yaw = 0;
    const stats = { ...cfg.mech };
    const enemy = { id: (hello.slot + 1) % 16, kind: "mech", pos: [x + 40, y + 10, z], vel: [0, 6, 0], aim: [Math.PI, 0], hp: 900, max_hp: 1400, cubes: 2, weapons: ["gun", "laser"], charging: false };
    const npc = { id: 104, kind: "npc", pos: [x - 30, y - 20, z], vel: [1, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 };
    for (let k = 0;k < decisions; k++) {
      const t = k * 0.1;
      const phase = Math.floor(k * 4 / decisions);
      const withEnemy = phase === 1 || phase === 3;
      const withLoot = phase >= 2;
      enemy.pos[0] = x + 45 * Math.cos(t * 0.3);
      enemy.pos[1] = y + 45 * Math.sin(t * 0.3);
      enemy.pos[2] = world.groundZ(enemy.pos[0], enemy.pos[1]);
      enemy.aim[0] = Math.atan2(y - enemy.pos[1], x - enemy.pos[0]);
      enemy.charging = k % 30 < 6;
      const obs = {
        type: "obs",
        tick: k * 2,
        t,
        alive: 16,
        self: {
          id: hello.slot,
          pos: [x, y, z],
          vel: [0, 0, 0],
          aim: [yaw, 0],
          hp: phase === 3 ? 500 : 1400,
          max_hp: 1400,
          energy: 80,
          max_energy: 100,
          grounded: true,
          cubes: 0,
          upgrades: [],
          weapons: selfWeapons(cfg, phase === 0 ? null : variant === 1 ? "lightning" : "laser"),
          in_zone: true,
          stats
        },
        mechs: withEnemy ? [enemy, npc] : withLoot ? [npc] : [],
        projectiles: withEnemy ? [{ id: 300 + k, kind: "gun", pos: [enemy.pos[0], enemy.pos[1], enemy.pos[2] + 7], vel: [(x - enemy.pos[0]) * 5, (y - enemy.pos[1]) * 5, 0] }] : [],
        crates: withLoot ? [{ id: 1001, pos: [x + 25, y - 30, world.groundZ(x + 25, y - 30)], hp: 300 }] : [],
        cubes: withLoot ? [{ id: 5001, pos: [x - 20, y + 30, world.groundZ(x - 20, y + 30)] }] : [],
        pickups: withLoot ? [{ id: 8001, kind: "lightning", pos: [x + 50, y + 40, world.groundZ(x + 50, y + 40)] }] : [],
        sounds: k % 7 === 0 ? [{ kind: "gun", bearing: 1, dist: "mid", age: 0.05 }] : [],
        beams: [],
        events: withEnemy && k % 5 === 0 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: enemy.aim[0] + Math.PI, by: enemy.id }] : [],
        zone: { center: [zc[0], zc[1]], radius: cfg.zone.start_radius, next_center: [zc[0], zc[1]], next_radius: cfg.zone.phases[0]?.radius ?? 380, shrink_start: 60, shrink_end: 110, dps: 20 },
        offer: k === 50 ? { id: 1, expires: t + 5, choices: [{ id: "plating", name: "", desc: "" }, { id: "armor", name: "", desc: "" }, { id: "gun_rate", name: "", desc: "" }] } : null,
        drops: []
      };
      const a = b.act(obs);
      const m = a.move;
      if (m) {
        const nx = x + m[0] * 1.1, ny = y + m[1] * 1.1;
        const nz = world.floorZ(nx, ny, z + 1.2, 0);
        if (nz <= z + 1.25 && !world.solid(nx, ny, nz + 2)) {
          x = nx;
          y = ny;
          z = nz;
        }
      }
      if (a.aim)
        yaw = a.aim[0];
    }
  }
}

// src/entries/main.ts
runProcess({ name: BOT_NAME, factory: mainBot, loadWorld, warmup });
