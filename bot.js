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

// src/entries/p5-d12.ts
runProcess({ name: "ai-caramba", factory: simpleBot, params: { prefDist: 12 } });
