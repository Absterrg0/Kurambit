import type { GameRecipe } from "@t3tools/contracts";

/**
 * Engine-neutral recipe metadata. Nothing here names a Godot node, property or
 * path: the Godot code lives under `recipes/godot/` and is joined to this list
 * by id in `recipeCatalog.ts`. Tags are the retrieval vocabulary, so every entry
 * declares the genre, mechanic and defect words a builder or repairer would use.
 */
export const gameRecipeMetadata: ReadonlyArray<GameRecipe> = [
  {
    id: "feel.buffer",
    version: 1,
    title: "Queue a jump pressed before landing",
    genres: ["platformer", "action"],
    mechanics: ["jump", "input-buffer"],
    defects: ["unresponsive-jump", "dropped-input"],
    aliases: ["jump buffering", "input buffering", "early jump press"],
    intent: "Remember a jump pressed during the airborne arc and spend it on the landing frame.",
    why: "A press that arrives a few frames before touchdown is read as a dropped input, not a mistake. Buffering turns the early press into the jump the player intended.",
    failure:
      "Without it the body lands, ignores the press and stands still; the player blames the controls and mashes harder.",
    restyle:
      "Keep the window and the single spend. Choose this game's jump arc, landing cue and the forgiveness window that fits its pace.",
    verificationQuestion:
      "Without a second press after landing, does the character jump once more as it touches down?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "Standard jump-buffer technique; R4 jump reference (spec60 item 1).",
    },
  },
  {
    id: "feel.coyote",
    version: 1,
    title: "Keep a short jump grace past the ledge",
    genres: ["platformer", "action"],
    mechanics: ["jump", "coyote-time"],
    defects: ["late-jump", "unfair-ledge"],
    aliases: ["coyote time", "ledge grace", "late jump"],
    intent: "Accept a jump for a short grace period after a body has left a ledge.",
    why: "Players time jumps from the edge they can see. A strict edge drops a fair attempt, and the game feels unresponsive at exactly the moment it should feel forgiving.",
    failure:
      "A press just past the lip is ignored although the body still looks supported; the player reads it as input loss.",
    restyle:
      "Keep the per-body grace and the single spend. Choose this game's own forgiveness window and ledge cues.",
    verificationQuestion:
      "Does a press just after leaving the ledge still jump, while a press after the grace window is ignored?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "Standard coyote-time technique; R4 first-gap failure (spec60 item 2).",
    },
  },
  {
    id: "feel.hit-stop",
    version: 1,
    title: "Hold only the impact without stopping time",
    genres: ["action", "platformer"],
    mechanics: ["impact", "game-feel"],
    defects: ["weak-impact", "floaty-hit"],
    aliases: ["hit stop", "hitstop", "impact freeze"],
    intent: "Hold only the two bodies of an impact for a beat, then resume.",
    why: "A bounded local hold sells contact weight while the HUD, scenery and other actors keep running. Nothing outside the impact changes speed.",
    failure:
      "Global time-scale tricks slow everything, including feedback and music, and a missing hold makes a hit read as a pass-through.",
    restyle:
      "Keep the local pause and its short length. Choose this game's impact flash, recoil and input feel.",
    verificationQuestion:
      "Does the striker hold at contact and then resume while the rest of the scene keeps running?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "Standard hit-stop technique; requested game feel (spec60 item 3).",
    },
  },
  {
    id: "feel.shake",
    version: 1,
    title: "Shake the camera from a seeded impact",
    genres: ["action", "platformer"],
    mechanics: ["impact", "camera-shake"],
    defects: ["weak-impact", "disorienting-camera"],
    aliases: ["screen shake", "camera shake"],
    intent: "Offset the camera on a seeded random ride that decays back to its exact base.",
    why: "A short, repeatable shake adds impact emphasis. A shake that never returns or uses fresh noise leaves the view crooked and makes a run hard to reproduce.",
    failure:
      "The camera drifts away from the action or stays offset after the hit, so the player loses the frame they were reading.",
    restyle:
      "Keep the decay and the exact return. Choose this game's strength, frequency and whether an impact shakes at all.",
    verificationQuestion: "Does the view move on impact and return to the same frame afterwards?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "Standard seeded screen-shake technique; requested game feel (spec60 item 4).",
    },
  },
  {
    id: "feel.pickup",
    version: 1,
    title: "Make a pickup read once, then clear",
    genres: ["platformer", "action"],
    mechanics: ["pickup", "feedback"],
    defects: ["invisible-pickup", "silent-pickup"],
    aliases: ["pickup feedback", "collect popup", "pickup cleared"],
    intent: "Emit one piece of pickup feedback when an item is collected, then clear it.",
    why: "A single, time-bounded confirmation proves the collection without leaving stale labels on screen. The effect count returning to zero is part of the mechanism.",
    failure:
      "Feedback that exists at boot, repeats every frame, or never clears hides the world and lies about what is still collectable.",
    restyle:
      "Keep the one-shot guard and the clear. Choose this game's pickup shape, popup and sound.",
    verificationQuestion:
      "Is the pickup absent at boot, shown once on collection, and gone afterwards?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:162 (persistent feedback); standard pickup confirmation.",
    },
  },
];
