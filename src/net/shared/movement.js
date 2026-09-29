import { clamp, EPS, makeBox } from './math.js';
import { PLAYER } from './constants.js';

/**
 * Player movement, shared byte-for-byte between client prediction and the
 * authoritative server.
 *
 * Design notes:
 *   - A Quake-style accelerate/friction model. It is simple, feels responsive,
 *     and gives real air control instead of "floaty" or "on rails" motion.
 *   - The collider is a square-footprint box of variable height (crouching
 *     shrinks it). Yaw never affects the collider, which keeps resolution
 *     stable and makes the predicted position match the server's exactly.
 *   - Collision is resolved one axis at a time against every overlapping solid,
 *     with a step-up retry so ramps, curbs and crates are walkable.
 *
 * The order of operations is fixed: stance -> wish direction -> accelerate ->
 * gravity -> horizontal sweeps -> vertical sweep -> ground snap. Any deviation
 * between client and server shows up as rubber banding, so this file must stay
 * the single source of truth.
 */

const HALF = PLAYER.width / 2;

function writeBox(out, pos, height) {
  out[0] = pos[0] - HALF;
  out[1] = pos[1];
  out[2] = pos[2] - HALF;
  out[3] = pos[0] + HALF;
  out[4] = pos[1] + height;
  out[5] = pos[2] + HALF;
  return out;
}

const _probe = makeBox(0, 0, 0, 0, 0, 0);

/**
 * Sweep the player box along one axis and return how far it may actually move.
 * Axis 0/2 use the square footprint; axis 1 respects the asymmetric height.
 */
export function sweepAxis(world, pos, height, delta, axis) {
  if (delta === 0) return 0;
  writeBox(_probe, pos, height);
  if (axis === 0) {
    _probe[0] += delta;
    _probe[3] += delta;
  } else if (axis === 1) {
    _probe[1] += delta;
    _probe[4] += delta;
  } else {
    _probe[2] += delta;
    _probe[5] += delta;
  }
  const hits = world.collectSolids(_probe, { navOnly: false });
  if (!hits.length) return delta;

  const slack = 1e-3;
  let allowed = delta;
  for (let i = 0; i < hits.length; i++) {
    const b = hits[i].box;
    if (axis === 1) {
      if (delta > 0) {
        const limit = b[1] - (pos[1] + height) - slack;
        if (limit < allowed) allowed = limit;
      } else {
        const limit = b[4] - pos[1] + slack;
        if (limit > allowed) allowed = limit;
      }
    } else if (delta > 0) {
      const limit = b[axis] - (pos[axis] + HALF) - slack;
      if (limit < allowed) allowed = limit;
    } else {
      const limit = b[axis + 3] - (pos[axis] - HALF) + slack;
      if (limit > allowed) allowed = limit;
    }
  }
  // If the correction flipped the sign we were fully blocked.
  if (delta > 0 && allowed < 0) return 0;
  if (delta < 0 && allowed > 0) return 0;
  return allowed;
}

/** Highest collider surface directly under the box, for landing and snapping. */
function supportHeight(world, pos, height) {
  writeBox(_probe, pos, height);
  return world.groundAtSolid(pos[0], pos[2], pos[1] + PLAYER.stepHeight + 0.02);
}

export function makePlayerState(spawn, yaw = 0, options = {}) {
  return {
    pos: [spawn[0], spawn[1] + 0.02, spawn[2]],
    vel: [0, 0, 0],
    yaw,
    pitch: options.pitch ?? 0,
    height: PLAYER.heightStand,
    crouching: false,
    sprinting: false,
    grounded: false,
    groundY: spawn[1],
    coyote: 0,
    jumpBuffer: 0,
    airTime: 0,
    stepDistance: 0,
    swing: 0,
    bob: 0,
  };
}

/** Eye position derived from the collider: a constant 0.9 of body height. */
export function eyePosition(p, out = [0, 0, 0]) {
  out[0] = p.pos[0];
  out[1] = p.pos[1] + p.height * 0.9;
  out[2] = p.pos[2];
  return out;
}

export function eyeHeight(p) {
  return p.height * 0.9;
}

/**
 * Advance one player by `dt` seconds.
 *
 * `input`  { forward, right, jump, crouch, sprint, walk, yaw, pitch, ads }
 * `ctx`    { moveMult, canJump, jumpSpeed }
 * returns  events { jumped, landed, landSpeed, footstep, blocked, crouchChanged }
 */
export function stepPlayer(world, p, input, dt, ctx = {}) {
  const events = {
    jumped: false,
    landed: false,
    landSpeed: 0,
    footstep: false,
    blocked: false,
    crouchChanged: false,
  };

  // ---------------------------------------------------------------------
  // Stance. Growing is gated on headroom so a player cannot stand up inside a
  // duct; shrinking is always allowed.
  // ---------------------------------------------------------------------
  const wantCrouch = !!input.crouch;
  const targetHeight = wantCrouch ? PLAYER.heightCrouch : PLAYER.heightStand;
  if (targetHeight > p.height) {
    const ceil = world.ceilingOver(
      p.pos[0] - HALF,
      p.pos[2] - HALF,
      p.pos[0] + HALF,
      p.pos[2] + HALF,
      p.pos[1] + 0.25,
    );
    const maxHeight = Math.max(PLAYER.heightCrouch, ceil - p.pos[1] - 0.02);
    const wanted = Math.min(targetHeight, maxHeight);
    const rate = ((PLAYER.heightStand - PLAYER.heightCrouch) / PLAYER.crouchTime) * dt;
    p.height = Math.min(wanted, p.height + rate);
    p.crouching = p.height < PLAYER.heightStand - 0.02;
  } else {
    const rate = ((PLAYER.heightStand - PLAYER.heightCrouch) / PLAYER.crouchTime) * dt;
    p.height = Math.max(targetHeight, p.height - rate);
    p.crouching = p.height < PLAYER.heightStand - 0.02;
  }
  const crouching = p.crouching || wantCrouch;

  // ---------------------------------------------------------------------
  // View angles come from the client; the server clamps them for sanity.
  // ---------------------------------------------------------------------
  p.yaw = input.yaw;
  p.pitch = clamp(input.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

  // ---------------------------------------------------------------------
  // Wish direction in world space.
  // ---------------------------------------------------------------------
  let fx = input.forward || 0;
  let rx = input.right || 0;
  const mag = Math.hypot(fx, rx);
  if (mag > 1) {
    fx /= mag;
    rx /= mag;
  }
  const sy = Math.sin(p.yaw);
  const cy = Math.cos(p.yaw);
  const wishX = -sy * fx + cy * rx;
  const wishZ = -cy * fx - sy * rx;

  // Sprinting requires commitment: forward input, on the ground, not crouched.
  const wantsSprint = !!input.sprint && fx > 0.4 && !crouching;
  const wasSprinting = p.sprinting;
  p.sprinting = wantsSprint && p.grounded && (ctx.canSprint !== false) && !input.ads;
  if (wasSprinting && !p.sprinting && p.grounded) {
    // Dropping a sprint costs a little speed, which reads as "braking".
    p.vel[0] *= 0.92;
    p.vel[2] *= 0.92;
  }

  // ---------------------------------------------------------------------
  // Target speed from stance, then direction-dependent penalties.
  // ---------------------------------------------------------------------
  let speed;
  if (crouching) speed = PLAYER.speedCrouch;
  else if (p.sprinting) speed = PLAYER.speedSprint;
  else if (input.walk) speed = PLAYER.speedWalk;
  else speed = PLAYER.speedRun;
  if (input.ads) speed = Math.min(speed, PLAYER.speedAds);
  speed *= ctx.moveMult ?? 1;
  if (fx < -0.1) speed *= PLAYER.backwardMult;
  if (Math.abs(rx) > Math.abs(fx) + 0.05) speed *= PLAYER.strafeMult;

  // ---------------------------------------------------------------------
  // Accelerate / friction.
  // ---------------------------------------------------------------------
  if (p.grounded) {
    const hs = Math.hypot(p.vel[0], p.vel[2]);
    if (hs > 0.0001) {
      const drop = hs * PLAYER.frictionGround * dt;
      const scale = Math.max(0, hs - drop) / hs;
      p.vel[0] *= scale;
      p.vel[2] *= scale;
    } else {
      p.vel[0] = 0;
      p.vel[2] = 0;
    }
    if (mag > 0.01) {
      const current = p.vel[0] * wishX + p.vel[2] * wishZ;
      const add = speed - current;
      if (add > 0) {
        const amount = Math.min(PLAYER.accelGround * dt, add);
        p.vel[0] += wishX * amount;
        p.vel[2] += wishZ * amount;
      }
    }
  } else if (mag > 0.01) {
    p.vel[0] += wishX * PLAYER.accelAir * dt * PLAYER.airControl * 2.2;
    p.vel[2] += wishZ * PLAYER.accelAir * dt * PLAYER.airControl * 2.2;
  }

  // ---------------------------------------------------------------------
  // Jump: buffered press + coyote time on the ledge.
  // ---------------------------------------------------------------------
  if (input.jump) p.jumpBuffer = PLAYER.jumpBuffer;
  else p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  if (p.grounded) p.coyote = PLAYER.coyoteTime;
  else p.coyote = Math.max(0, p.coyote - dt);

  if (p.jumpBuffer > 0 && p.coyote > 0 && !crouching && ctx.canJump !== false) {
    p.vel[1] = ctx.jumpSpeed ?? PLAYER.jumpSpeed;
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    events.jumped = true;
  }

  // ---------------------------------------------------------------------
  // Gravity.
  // ---------------------------------------------------------------------
  p.vel[1] = Math.max(PLAYER.maxFallSpeed, p.vel[1] + PLAYER.gravity * dt);

  // ---------------------------------------------------------------------
  // Horizontal movement, with one step-up retry per axis.
  // ---------------------------------------------------------------------
  const startX = p.pos[0];
  const startZ = p.pos[2];
  const stepUp = PLAYER.stepHeight;
  const canStep = p.grounded || p.coyote > 0;

  for (const axis of [0, 2]) {
    const delta = p.vel[axis] * dt;
    if (delta === 0) continue;
    const allowed = sweepAxis(world, p.pos, p.height, delta, axis);
    if (allowed === delta) {
      p.pos[axis] += delta;
      continue;
    }
    events.blocked = true;
    // Blocked: try the same move from a stepped-up position. If there is solid
    // ground within step height at the destination this is a kerb, not a wall.
    if (canStep && stepUp > 0.02) {
      const savedY = p.pos[1];
      const raised = [p.pos[0], savedY + stepUp, p.pos[2]];
      const upAllowed = sweepAxis(world, raised, p.height, delta, axis);
      if (upAllowed === delta) {
        raised[axis] += delta;
        const support = supportHeight(world, raised, p.height);
        if (support > -Infinity && support <= savedY + stepUp + 0.01 && support >= savedY - 0.6) {
          p.pos[axis] += delta;
          p.pos[1] = support;
          p.vel[1] = Math.max(0, p.vel[1]);
          continue;
        }
      }
    }
    p.pos[axis] += allowed;
    // Kill the velocity component that ran into the wall so friction can work.
    if (Math.abs(allowed) < Math.abs(delta) * 0.5) p.vel[axis] *= 0.1;
  }

  // ---------------------------------------------------------------------
  // Vertical movement.
  // ---------------------------------------------------------------------
  const dy = p.vel[1] * dt;
  if (dy !== 0) {
    const allowed = sweepAxis(world, p.pos, p.height, dy, 1);
    p.pos[1] += allowed;
    if (allowed !== dy) {
      if (dy < 0) {
        // Landed.
        const impact = -p.vel[1];
        if (!p.grounded) {
          events.landed = true;
          events.landSpeed = impact;
        }
        p.grounded = true;
        p.vel[1] = 0;
      } else {
        // Hit a ceiling.
        p.vel[1] = Math.min(0, p.vel[1]);
      }
    } else if (dy > 0) {
      p.grounded = false;
    }
  }

  // ---------------------------------------------------------------------
  // Ground probe + snap. Keeps the player glued to ramps going downhill and
  // detects walking off an edge without a jump.
  // ---------------------------------------------------------------------
  if (p.vel[1] <= 0.001) {
    const support = supportHeight(world, p.pos, p.height);
    if (support > -Infinity) {
      const gap = p.pos[1] - support;
      if (gap <= 0.02) {
        p.pos[1] = support;
        p.grounded = true;
        p.groundY = support;
        p.vel[1] = 0;
      } else if (gap <= PLAYER.groundSnap && p.grounded) {
        // Slopes and stair lips: stay glued while descending.
        const probe = makeBox(p.pos[0], support + 0.05, p.pos[2], HALF * 2, Math.max(0.05, gap - 0.06), HALF * 2);
        if (!world.overlapsSolid(probe, { navOnly: false })) {
          p.pos[1] = support;
          p.groundY = support;
        } else {
          p.grounded = false;
        }
      } else {
        p.grounded = false;
      }
    } else {
      p.grounded = false;
    }
  } else {
    p.grounded = false;
  }

  if (p.grounded) {
    p.airTime = 0;
  } else {
    p.airTime += dt;
  }

  // ---------------------------------------------------------------------
  // Locomotion bookkeeping used for footsteps, weapon sway and bot leg motion.
  // ---------------------------------------------------------------------
  const travelled = Math.hypot(p.pos[0] - startX, p.pos[2] - startZ);
  const horizontalSpeed = Math.hypot(p.vel[0], p.vel[2]);
  p.bob += travelled;
  if (p.grounded && horizontalSpeed > PLAYER.footstepSpeed) {
    p.stepDistance += travelled;
    const interval = p.sprinting ? PLAYER.sprintFootstepInterval : PLAYER.footstepInterval;
    // Faster movement means shorter strides; the interval is distance based so
    // it stays in step with the animation at every speed.
    const threshold = interval * (p.sprinting ? PLAYER.speedSprint : PLAYER.speedRun) * 0.55;
    if (p.stepDistance >= threshold) {
      p.stepDistance = 0;
      events.footstep = true;
    }
  } else {
    p.stepDistance = Math.min(p.stepDistance, 0.05);
  }
  p.swing = (p.swing + travelled * 2.4) % (Math.PI * 2);

  return events;
}

/**
 * Fall damage from a landing speed. Zero below the threshold, then quadratic,
 * so falling off a crate is free but falling off the catwalk is not.
 */
export function fallDamage(landSpeed) {
  const threshold = 13.5;
  if (landSpeed <= threshold) return 0;
  const excess = landSpeed - threshold;
  return Math.round(Math.min(120, excess * excess * 0.55));
}

/** True when the player is in a state that lets them shoot accurately. */
export function canFireFromStance(p) {
  return !p.sprinting;
}

/**
 * Rewind-and-replay for client-side prediction.
 *
 * `pending` is the list of unacknowledged inputs, oldest first. The client
 * restores the authoritative state, then re-applies each pending input through
 * exactly the same `stepPlayer` the server used.
 */
export function replayInputs(world, p, pending, dtFor, ctx) {
  for (let i = 0; i < pending.length; i++) {
    const cmd = pending[i];
    stepPlayer(world, p, cmd.input, dtFor(cmd), ctx);
  }
  return p;
}

/**
 * Compare a predicted state against the authoritative one. Returns the squared
 * positional error; callers smooth small errors and snap large ones.
 */
export function stateError(a, b) {
  const dx = a.pos[0] - b.pos[0];
  const dy = a.pos[1] - b.pos[1];
  const dz = a.pos[2] - b.pos[2];
  return dx * dx + dy * dy + dz * dz;
}

export { EPS };
