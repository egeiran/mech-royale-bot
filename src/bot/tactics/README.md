# tactics/ and perception/ - contracts

Units: m, s, rad (deg only where the name says so). Yaw 0 = east, CCW; pitch up-positive. "feet" = `pos`.
Nothing allocates per call; results go to a caller-owned `out`. State lives only in the classes (one per bot).
Timing model (measured on the recorded stream): per tick the server slews, moves, then fires. A shot ordered at
obs N leaves on tick N+k, k = max(1, ceil(cooldown/0.05)), along the aim after k ticks of slew, from
`(x + 3cos(yaw), y + 3sin(yaw), z + muzzle_height)` (the 3 m offset is horizontal), and advances one step in its spawn tick.

## tactics/aim.ts
- `wrapPi(a)`, `angDiff(a,b)` -> rad in [-pi, pi).
- `slewStep(curYaw,curPitch,wantYaw,wantPitch,turnRate,pitchRate,dt,out{yaw,pitch},minPitch?,maxPitch?)` exact torso model.
- `slewTime(curYaw,curPitch,wantYaw,wantPitch,turnRate,pitchRate)` -> s until on aim.
- `aimError(selfAim[yaw,pitch],wantYaw,wantPitch)` -> rad between actual and wanted aim.
- `leadGun(sx,sy,sz, svx,svy,svz, aimYaw,aimPitch, tx,ty,tz, tvx,tvy,tvz, projSpeed,range,cooldown, out, muzzleHeight?,muzzleOut?,turnRate?,pitchRate?,minPitch?,maxPitch?)`
  -> `out{yaw,pitch,tof,tHit,tFire,dist,ix,iy,iz,inRange}`; s* = shooter feet/vel, t* = point to hit/its vel; returns inRange.
  With a long cooldown/reload the aim is for when the shot leaves: pass min(cooldown, 0.3) to keep tracking.
- `leadGunObs(self,slot,tx,ty,tz,tvx,tvy,tvz,out)` same, numbers from `self` (weapon stats, cooldown/reload, muzzle, rates).
- `leadActor(self,slot,actor,out)` leads the centre of an `obs.mechs` entry (size +5 %/cube).
- `aimAt(sx,sy,sz,tx,ty,tz,out{yaw,pitch},muzzleHeight?,muzzleOut?)` -> m; direct aim from the muzzle (hitscan).
- `hitProbGun(dist,targetRadius,targetHeight,targetSpeedUncertainty,spreadDeg,projSpeed?,accel?,projRadius?,extraDelay?)` -> 0..1;
  uncertainty = m/s the target may change its velocity by during the flight (0 still/unaware, 11.7 strafing).
- `dodgeReach(t,dv,accel?)` -> m a mech can leave its predicted spot in t s.
- `willHit(selfAim,sol,dist,targetRadius,targetHalfHeight?,spreadDeg?,turnRate?,pitchRate?,marginSigma?)` -> fire gate: shot leaves
  this decision (sol.tFire <= 0.1) and the actual aim then is inside the target's angular size minus the spread margin.
- `fireTick(cooldown)` -> tick (1, 2 = this decision) the weapon can fire on.
- `rayHitsCylinder(ox,oy,oz,dx,dy,dz,cx,cy,cz,radius,height,maxDist)` -> m along a unit ray, -1 = miss.
- `aimHitsCylinder(sx,sy,sz,yaw,pitch,cx,cy,cz,radius,height,maxDist,muzzleHeight?,muzzleOut?)` -> m from the muzzle, -1 = miss.
- `mortarSolve(dx,dz,speed,gravity,high,minPitch?,maxPitch?)` -> pitch rad (NaN = out of reach / pitch limit); dx horizontal m,
  dz target minus tube height. `mortarTof(dx,pitch,speed)` s, `mortarApex(pitch,speed,g)` m above the tube,
  `mortarApexDist`, `mortarHeightAt(x,pitch,speed,g)` m, `mortarRange(pitch,dz,speed,g)` m, `mortarClears(pitch,speed,g,wallDist,wallTopRel,margin?)`.
- `leadMortar(sx,sy,sz,svx,svy, aimYaw,aimPitch, tx,ty,tz,tvx,tvy, speed,gravity,high,cooldown, out, launchHeight?=9.5,...)`
  -> `out{yaw,pitch,tof,apex,tFire,tHit,ix,iy,iz,ok}`; (tx,ty,tz) = where the shell should land (target feet).
- `laserPlan(charge,cooldown,onTarget,tLosIn,tLosLeft,needCharge?,chargeFull?,minCharge?,holdS?)` -> `LASER_IDLE|LASER_CHARGE|LASER_RELEASE`.
- `laserReleaseGate(s..6, aimYaw,aimPitch, cmdYaw,cmdPitch, t..6 (target feet, vel), targetRadius,targetHeight, range?,...)` -> bool:
  the beam fired next tick (aim slewed one tick toward cmd) passes through the target cylinder. LOS is the caller's check.
- `laserDamage(charge,damage?,chargeFull?,minFrac?)` -> hp.
- `lightningTarget(obs,yaw,range?,coneDeg?,world?)` -> id the arc would hit (nearest mech/NPC/crate in cone and range), -1 = none.
- Gun/laser aim v1 (params `aimV`, `aimPStar`; measured in `src/tools/aimlab`): `AIM_V1` options, `TargetKin` (`newTargetKin()`),
  `predictKin(k,t,opts,out)` (constant velocity + 0.65 x latest accel for <= 0.25 s capped at the recent top speed, ballistic z when
  airborne and not jetting), `leadGunV1(s..6, aimYaw,aimPitch, kin, aimZ, speed,range,cooldown, t0, out, opts, ...)` (t0 = s until our
  command acts), `hitProbV1(sol,shotYaw,shotPitch,kin,aimZ,spreadDeg,opts)`.
  `new GunAimer(opts?, fixedLag?)`: per decision `observe(t,aim..)` -> `updateTarget(id,t,pos,vel,radius,height,floorZ)` -> `solve(ShooterIn,GunIn,pStar,maxDist)`
  (true = fire; aim in `.sol`, estimate in `.p`) / `laserAim(s,out)` / `laserGate(s,cmdYaw,cmdPitch,shrink,range)` (beam in `bx..ez` for a
  wall check) -> `commit(finalYaw,finalPitch,gunFired)` on EVERY decision. `.lag` = online estimate of the extra action latency in decisions
  (0 lockstep scorer, 2 public play server), used for the fire time, the pending commands' cooldown/ammo and the laser release tick.

## tactics/dodge.ts
- `threatsFromProjectiles(obs.projectiles,self,out:ThreatList,gravity?,splashRadius?,groundZ?,maxBulletT?)` -> count with urgency > 0.
  Per projectile: `tHit` s, `miss` m from our surface, `dirX/dirY` unit dodge direction, `px/py/pz` closest/impact point, `urgency` 0..1.
- `dodgeVector(self,mechs,threats|null,t,rng,jitter,out:DodgeOut,blocked?,aimTolDeg?,maxAimerDist?)` -> `out{mx,my,urgency,breakLos,laserBy,aimers,primary}`.
- `new StrafeJitter(minPeriod?,maxPeriod?).step(t,rng,axisX,axisY,blocked?)` -> +1 (left of axis) / -1, flips every 0.3..0.8 s, wall-aware.
- `faceThreatYaw(bearings,weights|null,n,curYaw,frontArcDeg?)` -> yaw keeping the attackers in the front arc. `isRear(aimYaw,bearing)`.
- `aimOffTarget(actor,x,y)` -> rad between an actor's aim yaw and the bearing from it to a point.

## perception/
- `tracker.ts` `new EnemyTracker(config?,world?)`; `.update(obs)` each decision; `.get(id)`; `.mechs[0..15]`, `.npcs[]`, `.visible[0..nVisible)`;
  `.alive`, `.ourKills`, `.otherDeaths`, `.dmgTaken`, `.dmgTakenRecent`, `.tDamaged`; `.mostThreatening()`, `.nearestVisible()`, `.knownDead()`,
  `.predict(track,dt,out{x,y,z},accelHorizon?)`, `.leadVelocity(track,tof,out)`. `Track`: `known, visible` (in obs.mechs, incl. 5 s server memory),
  `inView, dead, x..z, vx..vz, ax..az, vxAvg, vyAvg, velJitter` (m/s RMS, feed to hitProbGun), `aimYaw, aimPitch, aimYawRate, hp, maxHp, cubes, weapons` (W_GUN|W_MORTAR|W_LASER|W_LIGHTNING), `charging, tChargeStart, radius, height,
  tSeen, tInView, dist, bearing, aimErr, aimingAtUs, tAimedAtUs, dmgToUs, dmgToUsRecent, hitsOnUs, rearHitsOnUs, tShotAtUs, lastHitBearing,
  weaponsUsedOnUs, dmgFromUs, tHitByUs, hpDropUnexplained, threat`, `.age(t)`.
- `seenBy.ts` `seenBy(track,self,world|null,visionCfg,rangeBonus?,nearBonus?)` -> bool; `inVisionWedge(...)`, `wedgeMargin(track,self,fovDeg)` rad,
  `inRearArcOf(track,self)`.
- `sounds.ts` `new SoundMap(soundCfg?,minX?,minY?,maxX?,maxY?,cell?=32,halfLife?=4)`; `.update(obs)`; `.heatAt(x,y)`; `.hottest(out:Sector[])`;
  `.since(S_kind,maxBucket?)` s; `.weaponsHeard(maxBucket?,window?)` W_* mask; `.movementNear(window?)`; ring buffer `ev*`.
- `mode.ts` `new ModeDetector(nMechs?,zoneStartRadius?)`; `.update(obs,tracker?)` -> `MODE_UNKNOWN|MODE_SQUAD|MODE_FFA`; `.pFFA`, `.logOdds`, `.locked`.
