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
      "Is the pickup feedback absent at boot, shown once on collection, and gone afterwards?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:162 (persistent feedback); standard pickup confirmation.",
    },
  },
  {
    id: "audio.feedback",
    version: 1,
    title: "Give each action its own short, bounded sound cue",
    genres: ["platformer", "top-down", "action"],
    mechanics: ["audio-feedback", "feedback"],
    defects: ["silent-pickup", "no-audio-feedback", "unbounded-audio"],
    aliases: [
      "sound",
      "audio feedback",
      "event sounds",
      "silent pickup",
      "sound cues",
      "mute sound",
    ],
    intent:
      "Two short, distinct cues — a confirmation and a damage or rejection — play only on real actions, stay bounded, and stop on mute.",
    why: "Two pitches tell success from failure without reading the HUD. Bounded voices and a mute that stops a sounding cue keep feedback pleasant and controllable.",
    failure:
      "A silent action leaves the player unsure it landed; a cue that loops or keeps playing after mute becomes noise.",
    restyle:
      "Keep the event mapping, one voice per cue, the echo guard and the mute stop. Pick this game's two cues; use licensed samples when available.",
    verificationQuestion:
      "Do two different actions produce two different short cues, and does muting silence a cue already playing?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "P6 audio request (t87); short event-cue practice with bounded voices and mute.",
    },
  },
  {
    id: "read.silhouette",
    version: 1,
    title: "Separate actor and hazard from the background",
    genres: ["platformer", "top-down"],
    mechanics: ["readability", "silhouette"],
    defects: ["indistinct-silhouette", "low-contrast"],
    aliases: ["silhouette contrast", "low visibility", "outline contrast"],
    intent:
      "Separate the actor, the hazard, the walkable edge and the objective from a busy background by value and contour.",
    why: "At gameplay scale the eye needs the actor, the threat, the safe ground and the goal to differ before colour or detail is read. Value and shape do that work in one frame, so terrain reads as a path and scenery does not.",
    failure:
      "Similar values and contours make the player lose the actor in motion, walk into a hazard they could not see, or read scenery as the route.",
    restyle:
      "Keep the separation of actor, hazard, walkable ground and objective. Choose this game's own palette, shapes and background density.",
    verificationQuestion:
      "At gameplay scale, can you identify the actor, the hazard, the walkable edge and the objective in one frame?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:102 (indistinct silhouettes); standard contrast technique.",
    },
  },
  {
    id: "state.world",
    version: 1,
    title: "Draw the gate from its real state",
    genres: ["platformer", "top-down", "action"],
    mechanics: ["world-state", "readability"],
    defects: ["misleading-world-state", "invisible-change"],
    aliases: ["world state", "locked gate", "state driven visual"],
    intent:
      "Draw every world object that carries state from that state, not a separate animation flag.",
    why: "A gate, door or lamp opened by a special animation can drift from the state the rest of the game reads. One source keeps the picture and the rules in step.",
    failure:
      "The world shows a locked gate while the state says unlocked, so the player is told to act on something already done.",
    restyle:
      "Keep the single source of truth. Choose this game's own gate, lamp or prop and its open/closed treatment.",
    verificationQuestion: "Does the closed gate visibly differ after its unlocking action?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:162 (misleading world state); standard state-driven rendering.",
    },
  },
  {
    id: "read.hud",
    version: 1,
    title: "Keep critical HUD readable during feedback",
    genres: ["platformer", "action", "top-down"],
    mechanics: ["hud", "feedback-priority"],
    defects: ["obscured-hud", "unreadable-feedback"],
    aliases: ["hud priority", "damage banner", "readable hud"],
    intent:
      "Give the current action and state a fixed, high-priority place that transient feedback cannot cover, and fit instruction text inside the viewport.",
    why: "Damage flashes and toasts are read at the moment the player most needs health and the objective. The critical layer has to sit above them and outside their band, and a long instruction line has to wrap or shrink instead of running off the edge.",
    failure:
      "A full-screen banner or a toast hides the health the player needs, a moving HUD drops the information, or clipped instruction text leaves the player guessing the control.",
    restyle:
      "Keep the fixed zones, the layer order and the measured fit. Choose this game's HUD placement and feedback vocabulary.",
    verificationQuestion:
      "During the damage feedback, are health, the objective and the instruction line fully readable and uncropped?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:162 (death banner); standard layered-HUD technique.",
    },
  },
  {
    id: "read.onboarding",
    version: 1,
    title: "Show the action prompt only while it applies",
    genres: ["platformer", "top-down", "action"],
    mechanics: ["onboarding", "prompt"],
    defects: ["missing-onboarding", "unexplained-prompt"],
    aliases: ["onboarding prompt", "contextual hint", "action prompt"],
    intent:
      "Show a contextual action prompt only while the action is available, with distinct hover, focus and pressed states, and clear it when it is taken.",
    why: "A prompt attached to the thing it acts on teaches the control at the moment of need. A control that never reacts to the pointer or the press reads as a label, and a stale prompt sends the player looking for an action already done.",
    failure:
      "A prompt that stays after the gate opens, one with no visible target, or one that never shows hover, focus or press reads as broken or as unfinished onboarding.",
    restyle:
      "Keep the range test, the clear-on-action and the three control states. Choose this game's input, wording and prompt placement.",
    verificationQuestion:
      "Do the prompt's hover, focus and pressed states look distinct, and does the action clear it?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "t50d/verdict.md:228 (missing onboarding); standard contextual prompt.",
    },
  },
  {
    id: "loop.platformer",
    version: 1,
    title: "Build a move, jump, collect and retry platformer",
    genres: ["platformer"],
    mechanics: ["movement", "jump", "pickup", "retry"],
    defects: ["unresponsive-jump", "no-retry", "unclear-pickup"],
    aliases: ["platformer loop", "run and jump", "respawn loop"],
    intent:
      "One body runs, jumps a gap with a forgiving press, scores a pickup and respawns after a fall.",
    why: "The smallest platformer that is a game: movement to learn, a gap to read, a reward to want and a failure that costs a second instead of a run.",
    failure:
      "Without the retry the first fall ends the session, and without the pickup the gap has no reason to be crossed.",
    restyle:
      "Keep the move-jump-collect-retry shape. Choose this game's physics, reward and fail state.",
    verificationQuestion:
      "After the pickup is collected, does falling into a pit return control at the start with the score kept?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 platformer loop request (spec60 item 10); standard platformer structure.",
    },
  },
  {
    id: "loop.top-down",
    version: 1,
    title: "Aim and hit a target in a top-down arena",
    genres: ["top-down", "action"],
    mechanics: ["movement", "aim", "projectile"],
    defects: ["unclear-hit", "no-target-response"],
    aliases: ["twin stick", "top down shooter", "aim and shoot"],
    intent: "Eight-way movement, an aiming direction and a shot whose hit changes the target.",
    why: "A top-down action loop reads from the response: the shot must travel, land and show damage, or the player cannot tell aiming from decoration.",
    failure:
      "A shot that never visibly changes the target leaves the player guessing whether the action worked.",
    restyle:
      "Keep the aim, the travelling shot and the hit feedback. Choose this game's weapon, target and arena.",
    verificationQuestion:
      "Does firing at the target visibly reduce its health and finally disable it?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 twin-stick evidence (spec60 item 11); standard top-down action loop.",
    },
  },
  {
    id: "loop.card",
    version: 1,
    title: "Drag a card to its target and spend its cost",
    genres: ["card", "turn-based"],
    mechanics: ["drag-and-drop", "resource-cost", "turn"],
    defects: ["double-spend", "illegal-play"],
    aliases: ["card game loop", "energy cost", "drag to play"],
    intent:
      "Drag a card onto a target, pay its cost once, and start a new turn with restored resources.",
    why: "The turn loop is a closed resource budget: every play removes exactly its cost, and a play the budget cannot afford leaves the board untouched.",
    failure:
      "A double spend or a free illegal play makes the counter meaningless and the choices unreadable.",
    restyle:
      "Keep the drag-to-target, one cost per play and the turn refill. Choose this game's cards and resources.",
    verificationQuestion:
      "Is a legal play charged once, and an unaffordable play ignored without changing energy or the board?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 card loop request (spec60 item 12); standard turn and resource loop.",
    },
  },
  {
    id: "loop.dialogue",
    version: 1,
    title: "Gate dialogue choices on state the scene keeps",
    genres: ["dialogue", "rpg"],
    mechanics: ["choice-graph", "conditions", "consequences"],
    defects: ["dead-choice", "unclear-consequence"],
    aliases: ["dialogue tree", "branching choices", "conditional choice"],
    intent:
      "A choice graph where each option moves to a node, some options are gated by flags, and a locked option changes nothing.",
    why: "Conditions make a conversation feel like it remembers the player, and showing a locked option tells them which earlier choice would have opened it.",
    failure:
      "A choice that looks available but does nothing, or one that jumps nodes without its flag, breaks trust in the fiction.",
    restyle:
      "Keep the flags, the availability test and one node change per choice. Choose this game's voices and stakes.",
    verificationQuestion:
      "Does an open choice change the node while a locked choice leaves the node and its flags unchanged?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 dialogue loop request (spec60 item 13); standard choice graph.",
    },
  },
  {
    id: "loop.tower",
    version: 1,
    title: "Place a tower, spend gold and clear a wave",
    genres: ["tower-defense", "strategy"],
    mechanics: ["placement", "resource-cost", "targeting", "wave"],
    defects: ["no-attack", "unclear-targeting"],
    aliases: ["tower defense loop", "place tower", "wave defense"],
    intent:
      "Buy one tower on a pad, watch it pick a target and fire, and roll into the next wave when the lane is clear.",
    why: "The loop is placement, spend, targeting and a wave clock. Each part has to be visible or the player cannot judge a purchase.",
    failure:
      "A purchase that does not spend, or a tower whose shots never reach a creep, makes the strategy unreadable.",
    restyle:
      "Keep the pad purchase, the leading-target rule and the wave break. Choose this game's towers and enemies.",
    verificationQuestion:
      "Does one purchase remove its gold exactly once, and does the tower visibly fire at a creep?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference:
        "R4 tower-defense loop request (spec60 item 14); standard placement and wave loop.",
    },
  },
  {
    id: "loop.racing",
    version: 1,
    title: "Order checkpoints so only a clean lap counts",
    genres: ["racing"],
    mechanics: ["steering", "checkpoint-order", "lap"],
    defects: ["missed-checkpoint", "shortcut-lap"],
    aliases: ["race loop", "checkpoint order", "lap counting"],
    intent: "Steer a car around a circuit where only the expected checkpoint advances the lap.",
    why: "Checkpoints are the difference between a lap and a shortcut. The expected index is the rule; every gate is visible but only one counts.",
    failure:
      "A finish that counts after a skipped gate teaches the player to cut the course, and the lap time stops meaning anything.",
    restyle:
      "Keep the ordered index and the single finish test. Choose this game's handling, track and lap length.",
    verificationQuestion:
      "Does crossing the finish after a skipped checkpoint leave the lap count unchanged?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 racing loop request (spec60 item 15); standard ordered-checkpoint lap.",
    },
  },
  {
    id: "loop.puzzle",
    version: 1,
    title: "Push a crate on a grid with exact undo",
    genres: ["puzzle"],
    mechanics: ["grid-push", "blocked-move", "undo"],
    defects: ["imprecise-undo", "stuck-state"],
    aliases: ["sokoban", "grid puzzle", "undo move"],
    intent:
      "Grid movement pushes a crate one cell when the cell beyond is free, refuses blocked moves, and undo returns the exact previous board.",
    why: "Push puzzles are only fair when a move can be taken back; undo has to restore the whole board, not just the player.",
    failure:
      "An undo that misses a crate, or a push that passes through a wall, makes a solvable level feel broken.",
    restyle:
      "Keep the cell rules and the full-board undo. Choose this game's grid, objects and win condition.",
    verificationQuestion:
      "After one legal push and undo, are the player, the crate and the target count exactly as before?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 Sokoban evidence (spec60 item 16); standard grid-push puzzle loop.",
    },
  },
  {
    id: "loop.first-person",
    version: 1,
    title: "Capture the mouse, look and walk in 3D",
    genres: ["first-person", "action"],
    mechanics: ["mouse-look", "movement", "pointer-capture"],
    defects: ["dead-camera", "trapped-cursor"],
    aliases: ["first person controller", "mouse look", "fps camera"],
    intent:
      "Click to capture the pointer, look with relative mouse motion, walk on WASD, and release the pointer with Escape.",
    why: "First-person feel depends on captured relative look. Without a release the player cannot leave the game, which is a trap, not an immersive frame.",
    failure:
      "A camera that ignores the mouse, or a capture with no way out, makes the mode unusable.",
    restyle:
      "Keep the capture, the mouse look and the Escape release; the arrow keys are a keyboard mirror, not a substitute. Choose this game's speed, sensitivity and world.",
    verificationQuestion:
      "Does the view turn with look input, and does Escape release the captured pointer?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "R4 first-person fix 5 (spec60 item 17); standard captured mouse-look controller.",
    },
  },
  {
    id: "look.lighting-2d",
    version: 1,
    title: "Give a 2D scene depth with one bounded local light",
    genres: ["platformer", "top-down", "action"],
    mechanics: ["lighting", "ambient-tone", "local-light"],
    defects: ["flat-lighting", "unreadable-dark", "washed-out-world"],
    aliases: ["2d lighting", "ambient light", "point light", "local light", "night lighting"],
    intent:
      "Give a 2D scene depth with a tinted ambient world, one bounded local light on the focal area, and a HUD that stays readable in the dark.",
    why: "A warm pool over a cool ambient frame separates the player and ground from the background without flattening the screen. Use it when the brief wants night, mood or a lit focal point, not flat bright arcade art.",
    failure:
      "A full-screen tint that crushes detail, light with no edge, or HUD text dimmed with the world hides what the player must read.",
    restyle:
      "Keep the ambient tone, one bounded light and the unlit HUD. Choose this game's palette, radius and energy.",
    verificationQuestion:
      "With the lamp toggled off and on, does the world visibly change while the HUD stays equally readable?",
    source: {
      kind: "write-original",
      license: "MIT",
      reference: "Godot 4 2D canvas lighting and layers; P6 lighting/look request (t80).",
    },
  },
];
