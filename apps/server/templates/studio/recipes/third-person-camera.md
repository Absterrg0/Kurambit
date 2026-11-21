# Third-person camera

**When.** A character the player steers from behind: a duel, an adventure, a boat seen from
astern.

## Numbers

- Unity Cinemachine Third Person Follow defaults: shoulder offset **(0.5, -0.4, 0)** m, vertical
  arm **0.4** m, camera distance **2.0** m, damping **(0.1, 0.5, 0.3)** s, collision radius
  **0.2** m, damping into a collision **0** (snap in), out of it **0.5** s (ease out).
- The player at least **7% of the view's height** (50 px of 720); hidden or off screen under
  **25%** of play (the scene report's lines).
- In a duel, the foe on screen at least **80%** of the fight (judgement).

John Nesky's rules (Journey, GDC 2014): a sphere collider so the camera never enters
geometry; whisker rays to the sides to swing early; change pitch, distance and FOV together;
widen the FOV looking up; turn yaw toward the run direction; never let the near plane cut the
character; let thin obstacles pass; treat hills unlike walls; the player's input wins over the
camera's avoidance.

## Steps

1. Start from the runtime's follow camera; set height, shoulder and distance for the subject.
2. Add collision with a sphere: snap in, ease out.
3. Lock-on in a duel: frame player and foe together (`cam.focus`), the foe a little off centre.
4. Clamp pitch; widen FOV when looking up.
5. Play it: run into a wall, round a pillar, fight at the arena's edge.

## Pitfalls

- Two systems moving the camera at once (Nesky #8).
- A 180° cut that flips left and right (#20).
- Tall clutter between camera and player; a camera inside a wall.
- Shake applied to the camera's real position instead of only the drawn view.

## Code

Cinemachine is under the Unity Companion License: learn, do not copy.

## Sources

Unity Cinemachine 3.1 docs and `CinemachineThirdPersonFollow.cs` defaults (read). John Nesky,
"50 Game Camera Mistakes", GDC 2014 (read in translation).
