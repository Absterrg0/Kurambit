# Controller feel

**When.** Any character the player runs, jumps or dashes with.

## Numbers

Celeste's released `Player.cs` (MIT):

- MaxRun **90 px/s**, RunAccel **1000 px/s²** (full speed in 0.09 s), RunReduce 400.
- AirMult **0.65** (less control in the air).
- JumpGraceTime **0.1 s** (coyote time), VarJumpTime 0.2 s (hold to jump higher).
- Upward corner correction **4 px** on 8 px tiles; DashTime 0.15 s.
- Gravity 900, MaxFall 160.

SpriteCook: coyote 0.1 s, jump buffer 0.1 s, corner correction 1/8 to 1/2 tile; count physics
ticks, never drawn frames.

3D action: top speed in **0.1 to 0.2 s**, stop in 0.1 to 0.15 s, turn at least **540°/s**
(judgement). The first held direction moves the player within 0.25 s (judgement).

## Steps

1. Move with acceleration and deceleration read from `ctx.tune`, not set speeds.
2. Separate air control from ground control.
3. Add coyote time and a jump buffer, both in ticks of the fixed step.
4. Variable jump height by hold time; corner correction on ledges.
5. Turn the model toward the move fast; let the camera follow (`third-person-camera`).

## Pitfalls

- Coyote time that grants a double jump.
- A buffer not cleared on death or pause.
- Windows counted in drawn frames.
- Correcting corners on the ground.

## Code

Celeste's `Player.cs` (MIT) for constants. `@dimforge/rapier3d-compat` (Apache-2.0) has a
kinematic character controller if the game needs collision.

## Sources

NoelFB/Celeste `Player.cs` and LICENSE (read). SpriteCook, coyote time, jump buffer and corner
correction (read; numbers cited).
