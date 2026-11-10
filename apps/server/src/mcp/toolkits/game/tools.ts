import { McpSchema, Tool, Toolkit } from "effect/ai";
import type * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import {
  GAME_EXPLORE_BOUNDS,
  GameActionResult,
  GameBlenderCarveInput,
  GameBlenderCarveResult,
  GameAnimateInput,
  GameAnimateResult,
  GameBlenderCharacterInput,
  GameBlenderCharacterResult,
  GameBlenderPaintInput,
  GameBlenderPaintResult,
  GameGenerateInput,
  GameGenerateResult,
  GameImageEditInput,
  GameGenerateWaitInput,
  GameBlenderCodeInput,
  GameBlenderCodeResult,
  GameBlenderExportInput,
  GameBlenderExportResult,
  GameBlenderLookInput,
  GameBlenderLookResult,
  GameBlenderRenderSpritesInput,
  GameBlenderRenderSpritesResult,
  GameBlenderSceneInput,
  GameBlenderSceneResult,
  GameBlenderAssetsSearchInput,
  GameBlenderAssetsSearchResult,
  GameBlenderAssetsImportInput,
  GameBlenderAssetsImportResult,
  GameAssetsAddInput,
  GameAssetsAddResult,
  GameAssetsSearchInput,
  GameAssetsSearchResult,
  GameBuildComparison,
  GameBuildFacts,
  GameBuildId,
  GameBuildRestoreResult,
  GameBuildsResult,
  GameCheckResult,
  GameUnityConsoleInput,
  GameUnityEditInput,
  GameUnityEvalInput,
  GameUnityPlayInput,
  GameUnityRecompileResult,
  GameUnityScreenshotInput,
  GameUnityScreenshotResult,
  GameUnityTextResult,
  GameUnityToolsResult,
  GameOperationFailure,
  GameStatus,
  GameExploreStartInput,
  GameExploreActInput,
  GameExploreCloseInput,
  GameExploreStartResult,
  GameExploreActResult,
  GameExploreCloseResult,
  GameKeepGoingInput,
  GameKeepGoingStatus,
  GameKeepValuesInput,
  GameKeepValuesResult,
  GameKeepGoingSteerInput,
  GameKeepGoingSteerResult,
  GameBotRunInput,
  GameBotRunResult,
  GameBotReportResult,
  GameBotViewInput,
  GameBotViewResult,
  GameMediaSaveFields,
  GameSavedDeleteFields,
  GameSavedListResult,
  GameSavedMedia,
  GameWebPackage,
  GameWindowsPackage,
  OrchestratorMcpFailure,
} from "@kurambit/contracts";
import { PROFILES, type GameEngineProfile } from "../../../game/engineProfile.ts";
import { isGameEngineActive } from "@kurambit/contracts";
import * as GameArt from "../../../game/art/GameArt.ts";
import * as GameAssetLibrary from "../../../game/GameAssetLibrary.ts";
import * as GameBlender from "../../../game/GameBlender.ts";
import * as GameBot from "../../../game/GameBot.ts";
import * as GameBuilds from "../../../game/GameBuilds.ts";
import * as GameEngine from "../../../game/GameEngine.ts";
import * as GameExplore from "../../../game/GameExplore.ts";
import * as GameExport from "../../../game/GameExport.ts";
import * as GameRunControl from "../../../game/GameRunControl.ts";
import * as GameSavedMediaService from "../../../game/GameSavedMediaService.ts";
import * as GameStage from "../../../game/GameStage.ts";
import * as GameStatusService from "../../../game/GameStatusService.ts";
import * as GameUnity from "../../../game/GameUnity.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ASKABLE_TOOLS, listedFor } from "./placement.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
/** A game tool's services: the one that owns its operation, and the caller's thread. */
const on = <I, S>(owner: Context.Key<I, S>) => [
  owner,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([GameOperationFailure, OrchestratorMcpFailure]);
/** Each active engine's own sentence for a tool whose behaviour differs by engine, from its profile. */
const perEngine = (line: (tools: GameEngineProfile["tools"]) => string) =>
  PROFILES.filter((profile) => isGameEngineActive(profile.id))
    .map((profile) => line(profile.tools))
    .join(" ");
const GameStatusTool = Tool.make("game_status", {
  description:
    "Inspect this thread's Kurambit project: the manifest, the engine tool's readiness (`engineTool`, with repair instructions), the release targets its engine exports, its builds, managed processes, playable preview URL and `characters`: how the person chose to make this game's characters (library, blender or generated; only they change it), and `artLanes`: per art lane, the provider game_generate would use now, or null when the person has set none up for it. Read-only. `sourcesDifferFromPlay` is `unknown` unless `checkSources` is true, which walks and hashes every source file.",
  parameters: Schema.Struct({ checkSources: Schema.optionalKey(Schema.Boolean) }),
  success: GameStatus,
  failure,
  failureMode: "return",
  dependencies: on(GameStatusService.GameStatusService),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_status"));
const BlenderCodeTool = Tool.make("game_blender_code", {
  description:
    'Run Python bpy code in this game\'s live Blender scene (pinned mcp-for-blender execute_blender_code, adapted). The scene stays alive across calls on a private display; the first call starts it. Anything Blender can do, you can do, including rendering PNGs and writing WAVs with numpy and wave. Relative paths resolve from the game root; print every path you write. The live Blender has its own private home, so ~ in a path is not yours: write game-relative or absolute paths. A Python error fails the call with its traceback. The .blend source is saved in the game after each successful call. Use game_blender_look to see the result and game_blender_scene for counts, sizes and positions. You can make any asset from the ground up here: model (sculpt brushes need a viewport, so sculpt with modifiers and code), UV and texture, rig, key named actions, look, export (art-pipeline skill, Made from scratch). An armature you rig and animate yourself enters on its own rig when its armature carries its own clips and is marked arm["kurambit_rig"] = "<rig name>"; every action keying its bones ships with it.',
  parameters: GameBlenderCodeInput,
  success: GameBlenderCodeResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_code"));
export const GameBlenderLookTool = Tool.make("game_blender_look", {
  description:
    "See the live Blender scene as one image: from the viewport (default), the scene camera, angles around the target, or frames over the animation; shading solid, material, rendered, wireframe or xray. For counts, sizes and positions use game_blender_scene. mode review shows exactly what game_blender_export would write: the objects go through the style pass and are measured in a separate Blender, and one image shows a turnaround, silhouettes, the model at game distance (gamePx), each walk, run and jump clip, the palette and art/concepts/<name>.png; the text gives the concept, the measurements and what the export would refuse. Fix what is wrong and review again before exporting. A review refuses an image painted in the scene but never saved or packed, and a model whose credits cannot fit one sidecar.",
  parameters: GameBlenderLookInput,
  success: GameBlenderLookResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_look"));
const BlenderSceneTool = Tool.make("game_blender_scene", {
  description:
    "Facts about the live Blender scene as text (pinned mcp-for-blender get_scene_info, adapted): object counts, active object, then one line per object with location, size and children. No image; use game_blender_look to see the scene. For anything else about an object, read it with game_blender_code.",
  parameters: GameBlenderSceneInput,
  success: GameBlenderSceneResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_scene"));
const BlenderAssetsSearchTool = Tool.make("game_blender_assets_search", {
  description:
    "Search a library of existing assets for the live Blender scene (pinned mcp-for-blender search_assets, adapted). Sources: polyhaven (HDRIs, PBR textures and realistic models, all CC0, no key), sketchfab (user-made models; needs the user's Sketchfab API key in the scene) and polypizza (stylised low-poly, CC0 or CC-BY; needs the user's Poly Pizza API key). Pass the result id to game_blender_assets_import. With a STYLE.json, only sources its imports list may be imported, and the result says when an import would be refused.",
  parameters: GameBlenderAssetsSearchInput,
  success: GameBlenderAssetsSearchResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_assets_search"));
const BlenderAssetsImportTool = Tool.make("game_blender_assets_import", {
  description:
    "Bring an asset into the live Blender scene, marked with its source and licence, and save the .blend; review and export it like anything you build. source generated takes path: a model or creature game_generate delivered under art/generated/ (a creature keeps its own rig, clips and size; a generated humanoid goes through game_blender_character instead). The other sources import a game_blender_assets_search result by id; Poly Haven textures need applyTo object names or the material is unused. Models arrive at their own scale and facing: check the reported size, stand them on the ground facing -Y, and look at them. With a STYLE.json, a source its imports does not list is refused before anything downloads, and a rigged model off its rig is refused and taken out again. A generated creature is refused unless the person's character route (characters in game_status) is generated.",
  parameters: GameBlenderAssetsImportInput,
  success: GameBlenderAssetsImportResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_assets_import"));
const GenerateTool = Tool.make("game_generate", {
  description:
    "Start making art with a provider the person set up in Settings (their own keys, or Codex on their ChatGPT plan), by lane: image (key art, concepts, character sheets, sprites, UI art), texture (options.seamless; options.edit changes one from words), character (a humanoid, rigged on the standard skeleton so it plays the clip library), creature (any other body: options.body, options.clips), model (a prop, vehicle or building; options.parts for moving parts), motion (a clip every humanoid plays; look in the clip library first: game_assets_search pack quaternius-universal-animation-library), sfx, music, voice (options.seconds, options.loop); options.lowPoly with options.polycount asks for game topology. To change an image the game has, use game_image_edit. prompt says what the thing itself is; the look comes from references: an image or texture takes the key art, while a character, creature or model takes only the picked picture of that one subject, never the key art, because a 3D generator models everything its picture shows. directions (2-4) makes one candidate per look for the person to pick in the chat (Keep going takes the first); style grounds a direction in a library pack id or a reference image. options.mesh rigs an unrigged GLB the game has instead of making one. It answers at once with the generation's id: pick it up with game_generate_wait, and never start the same one again. A character or creature made while the person directs stops after its paid model for their \"Rig this\" or Cancel. character and creature are refused unless the person's character route (characters in game_status) is generated. A refusal names the key, limit or route missing: say so in your reply rather than making it another way. Say in your reply what the generations cost. What follows each lane is in the art-pipeline skill (Generated art).",
  parameters: GameGenerateInput,
  success: GameGenerateResult,
  failure,
  failureMode: "return",
  dependencies: on(GameArt.GameArt),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_generate"));
const ImageEditTool = Tool.make("game_image_edit", {
  description:
    'Change an image the game already has from words, keeping everything else in it; with transparent, cut its subject out onto a transparent background. Use it whenever the person asks to change an image ("Change <file>: …", "make the cat orange"), never game_generate with the image as a reference, which makes a new image. The person then picks "Changed" or "As it was" in the chat: the original file is never touched, and Keep going takes "Changed". It answers at once with the generation\'s id: pick it up with game_generate_wait. After "Changed", point the game at the new file where it used the original, and if the original is STYLE.json\'s anchor, read the palette again from the new file. It costs one image, against the person\'s daily limit.',
  parameters: GameImageEditInput,
  success: GameGenerateResult,
  failure,
  failureMode: "return",
  dependencies: on(GameArt.GameArt),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_image_edit"));
const GenerateWaitTool = Tool.make("game_generate_wait", {
  description:
    "Wait for a generation from game_generate: it returns when the files are in the game (done), when its candidates wait for the person's pick (choosing: tell the person to pick one in the chat, and end your turn unless other work remains; their pick arrives as their next message; a direction the provider refused is named with its reason), when it failed or was cancelled, or after seconds (default 120, up to 540) with it still making. Never start the same generation again while one is making: each start is paid.",
  parameters: GameGenerateWaitInput,
  success: GameGenerateResult,
  failure,
  failureMode: "return",
  dependencies: on(GameArt.GameArt),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_generate_wait"));
const BlenderCharacterTool = Tool.make("game_blender_character", {
  description:
    "Build a rigged, animated character in the live Blender scene on the standard skeleton, correct by construction: for a humanoid that plays the library's clips, use this instead of rigging or retargeting yourself (a model that plays only clips you key on your own rig is made with game_blender_code: art-pipeline skill, Made from scratch). body is a library body ({library: {pack, file}}, as game_assets_search lists them), an MPFB2 human ({mpfb: {age, gender, weight, …}}; needs MPFB2, which the person installs in Settings → Game tools) or a rigged humanoid in this game ({game: path}: an earlier export or a character game_generate delivered, whatever its bones are named). Every library clip plays on it unchanged, and the body's own clips and skinned extra bones (hair, a robe) are kept. clips are names from the lock's animation packs or a motion GLB's game path (the standard set when omitted); chains are extra bones the game springs (a tail, ears). fit (arms, calm) changes clips only when you ask; replace: true rebuilds the body and armature and keeps your parts. Needs STYLE.json's rig to be standard-humanoid; an MPFB2 body needs the person's character route (characters in game_status) to be blender, a generated body that it is generated. Then model the rest with game_blender_code, then game_blender_look mode review, then game_blender_export (art-pipeline skill, Made characters).",
  parameters: GameBlenderCharacterInput,
  success: GameBlenderCharacterResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_character"));
const BlenderPaintTool = Tool.make("game_blender_paint", {
  description:
    "Paint models in the live Blender scene from their turnaround sheet, so a model with the right silhouette and big forms looks like the picture. sheet is a game path: a character sheet game_generate made (front, side and back on a plain background, nothing overlapping) or the person's own picture; the texture is credited to it. objects are the meshes, or a character's armature for all its meshes; leave out what keeps its own material. The sheet's views are measured (views overrides the reading) and fitted to the model's silhouette; the overlap is reported with an image of the outlines, and under 50% it is refused before anything is baked: pose the model as the sheet shows it (pose: {arms, legs} sets a standard-skeleton character's A-pose for the projection only). One side view paints both sides; noMirror lists sheet pixel boxes of one-sided details. Writes the textures under art/blender/textures/<name>/. Then game_blender_look mode review, then game_blender_export (art-pipeline skill, Painted from a sheet).",
  parameters: GameBlenderPaintInput,
  success: GameBlenderPaintResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_paint"));
const BlenderCarveTool = Tool.make("game_blender_carve", {
  description:
    "Carve an organic hard prop (a statue, a carving, a rock, a tree trunk) into the live Blender scene from its three-view sheet (front, side and back on a plain background, like a character sheet): a visual hull of the views with rounded sections, a relief sculpted from the painting's light and dark, decimated to triangles (default STYLE.json's budget.prop), then painted from the sheet with a normal map baked from the sculpt. It lands as name, in a collection of that name, height metres tall, standing at the origin facing -Y, credited to the sheet's source. box keeps sections below that height square (a plinth); relief scales the carved depth (default 1). Not for buildings, vehicles or anything with straight edges and holes: model those. replace: true carves a name again, where the old one stood. Then game_blender_look mode review, then game_blender_export.",
  parameters: GameBlenderCarveInput,
  success: GameBlenderCarveResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_carve"));
const BlenderExportTool = Tool.make("game_blender_export", {
  description:
    "Export the objects you last reviewed (game_blender_look mode review), exactly as reviewed, as a GLB under the game's engine directory with its sidecar <stem>.asset.json (skeleton, clips with ground speed, springs, height, measurements and where every part came from), and record it in ASSETS.md; file defaults to <engine dir>/assets/blender/<name>.glb. Refused when these objects changed since their review, or when the review's measurements break the lock (an armature off its rig and not marked on its own, one marked on its own rig without clips of its own, rest frames off the standard skeleton, triangles or texture size over STYLE.json's budget, a character with no idle clip) or the person's character route. A model on its own rig ships every clip keyed on it, and its sidecar names the rig as its skeleton. Where the game loads the GLB itself it ships compressed: never compress it again; simplify caps its triangles (a character drawn small rarely needs over 20000). The result says how the game loads it.",
  parameters: GameBlenderExportInput,
  success: GameBlenderExportResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_export"));
export const GameBlenderLookToolkit = Toolkit.make(GameBlenderLookTool);
export const GameAnimateTool = Tool.make("game_animate", {
  description:
    'Author a move no library clip has (a combo, a dodge roll, a boss\'s slam) on a character game_blender_character made, when no clip in the library (game_assets_search pack quaternius-universal-animation-library) fits. You write poses on beats as JSON; the kit adds the craft (easing, anticipation, arcs, foot locking, root motion, overlap, a held prop\'s swing) and keys the clip as <character>|<clip>. spec: {name?, start?: a named pose, poses?: {name: pose}, loop?: true, craft?: {ease, antic, over, lift, clearance, overlap: {chest: [hz, damping, clamp°], head: [...], hand: [hz, damping]}, arcs, pivot, lock_feet, hip_drop}, beats: [{at: frame (30 fps), pose?: name, ease?: linear|in|out|inout|in2|out2, antic?, over?, pivot?: foot_l|foot_r, lift?, note?, ...pose keys}]}. Leave ease out: the default curve carries the motion on through a beat and settles only where a value holds or turns back; a named ease breaks the motion at that beat (in arrives at full speed: a hit). loop: true makes a cycle (a walk, a run): write the last beat as the first one cycle on, moved forward by one cycle\'s travel; it is keyed in place and played with moveSpeed. Body space: x the character\'s right, y forward, z up, metres; yaw + turns left, degrees. Pose keys, each carried over from the beat before when left out: root [x, y, yaw] (where the move is on the ground), hips {at: [x, y, z], turn: [yaw, pitch, roll]}, chest [yaw, pitch, roll], head [yaw, pitch, roll], look [x, y, z] or null, prop {grip: [x, y, z], tip: [x, y, z] (the direction it points), edge?, space?: root|chest, way?: cw|ccw} for a prop modelled in a hand (parented to hand_r or skinned rigidly to it), hand_l / hand_r "grip" (on the prop\'s handle) or {at, space?: root|chest, turn?}, foot_l / foot_r {at: [x, y, 0], yaw, heel (degrees up on the ball), space?: ground|root|hips, orbit?}, elbow_l / elbow_r / knee_l / knee_r (the direction each points). Named poses: stand (this body\'s own), spec.poses, and any clip the character has (its first frame): start the move from the idle the game plays and end it there ("start": "Sword_Idle", the last beat {pose: "Sword_Idle", root: where it ended}), so the crossfades into and out of it slide nothing. Every call returns pictures and numbers (foot slide, balance, joint limits, limbs through the body, strike frames, pops and spins, which the game shows worse than the pictures) beside a library clip\'s on this body (bar), and warnings: a warning means the spec asked for what this body cannot do. Change the spec and call again with the same clip until neither improves. Stances and strike frames go into the sidecar at export. Then game_blender_look mode review and game_blender_export.',
  parameters: GameAnimateInput,
  success: GameAnimateResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_animate"));
export const GameAnimateToolkit = Toolkit.make(GameAnimateTool);
export const GameBlenderRenderSpritesTool = Tool.make("game_blender_render_sprites", {
  description:
    "Render 2D sprite strips from the live Blender scene, framed by construction: use this instead of writing camera, light and render code. A fixed orthographic camera per view fits the objects across every frame, so the scale and the feet's pixel row stay the same in every frame and view; a clip with root motion is refused (render an in-place one). Pass objects, an animation (action with frameCount, frameStart/frameEnd, or frames; nothing renders the current pose), views (front, back, left, right, top, isometric or {name, azimuth, elevation}), size, anchor, margin and lighting, and for a character's later strips the pixelsPerUnit its first strip reports. pixelArt quantizes every frame to one palette (palette, colors) with an optional outline. A STYLE.json pixel lock fills pixelArt, size and views when you leave them out and refuses another palette; a smooth lock refuses pixelArt. Writes <output>_N.png under the engine's assets, credited in ASSETS.md, and returns the anchor and a contact sheet to look at (art-pipeline skill, 2D sprites from 3D).",
  parameters: GameBlenderRenderSpritesInput,
  success: GameBlenderRenderSpritesResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBlender.GameBlender),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_blender_render_sprites"));
export const GameBlenderRenderSpritesToolkit = Toolkit.make(GameBlenderRenderSpritesTool);
export const GameAssetsSearchTool = Tool.make("game_assets_search", {
  description:
    "Search Kurambit's pinned open asset library: every Kenney 3D kit, Quaternius' packs (animated animals, dinosaurs, fish, monsters and people, each on its own skeleton with its own clips), KayKit, Poly Haven (photo-real models, materials, HDR skies), ambientCG (materials, skies, decals), sound and 2D packs, and Poly Pizza's low-poly models live when the person set their Poly Pizza key. Licences are CC0 or, where an entry says so, CC BY with its credit line, which game_assets_add credits for you. With words, it ranks packs and single assets together (filter by kind, family, animated or licence cc0) and attaches a contact sheet of the sources' own pictures numbered like the list; with no words and no kind, it lists the whole library by style family (choose one family and pass it as game_assets_add's lock; a lock admits all of its family, so its entries come first). Pass pack to look inside one entry: matching files come with a contact sheet, or the pack's own preview pictures when you pass no query and no kind. Page through long lists with offset. Only formats this game's engine loads are listed. Look at the sheet before adding, and keep one family's look per game. Add files with game_assets_add by the exact paths listed.",
  parameters: GameAssetsSearchInput,
  success: GameAssetsSearchResult,
  failure,
  failureMode: "return",
  dependencies: on(GameAssetLibrary.GameAssetLibrary),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_assets_search"));
export const GameAssetsSearchToolkit = Toolkit.make(GameAssetsSearchTool);
const AssetsAddTool = Tool.make("game_assets_add", {
  description:
    "Copy files or whole folders from a library pack (paths as game_assets_search lists them) into this game's assets under library/<pack>/, with names made path-safe: use the paths the result reports. Models bring the textures they load; a folder add keeps one format per model, the one search shows. Never overwrites a file that differs; files already there are left alone. Appends each file's entry, source page, licence and pin to ASSETS.md, gives the game's credits file (the credits screen) one line per entry with the source's own credit wording when its licence asks for credit, and measures each added sound's loudness against STYLE.json's targets. An entry is fetched once into a shared, size-capped cache and checked against its pin. lock (a style family and the view) writes STYLE.json at the game root first: the family, its rig, pixel palette and tile, its curated packs and sources, keeping what else a lock there holds. Pass it with the first add, and again only to change the look. With a STYLE.json, an entry outside its family and its packs (or audio.packs; a listed source such as polyhaven admits all its assets) is refused, and so are characters on a shared rig other than its rig; an animated model on a skeleton of its own comes in with its own clips. The refusal says how to change the lock. Where the engine has an import step, run game_import after.",
  parameters: GameAssetsAddInput,
  success: GameAssetsAddResult,
  failure,
  failureMode: "return",
  dependencies: on(GameAssetLibrary.GameAssetLibrary),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_assets_add"));
const UnityToolsTool = Tool.make("game_unity_tools", {
  description:
    "List the editing tools of this Unity game's live editor (Unity's official `unity mcp`): scene, GameObject, component, prefab, material, settings and lighting tools, each with its input schema. Call one with game_unity_edit. The first game_unity_* call opens the editor on a private display, which can take a few minutes on a fresh project.",
  success: GameUnityToolsResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_tools"));
const UnityEditTool = Tool.make("game_unity_edit", {
  description:
    "Call one editing tool from game_unity_tools in this Unity game's live editor, such as gameobject_create, gameobject_set_transform, component_add, component_set_field, script_attach or scene_get_hierarchy, with its arguments. Open scenes are saved after every call. Never hand-edit .unity, .prefab or .asset YAML; edit through this.",
  parameters: GameUnityEditInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_edit"));
const UnityEvalTool = Tool.make("game_unity_eval", {
  description:
    "Evaluate C# in this Unity game's live editor on its main thread (Pipeline script eval); `return <value>;` sends a value back. UnityEngine and UnityEditor are available, and in play mode the running game is reachable. Use it for anything the editing tools do not cover; save scenes you change with UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes().",
  parameters: GameUnityEvalInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_eval"));
const UnityRecompileTool = Tool.make("game_unity_recompile", {
  description:
    "Import changed files and recompile this Unity game's scripts in the live editor. Returns every C# compiler error with file and line. Run it after writing C# and fix errors before anything else.",
  success: GameUnityRecompileResult,
  failure,
  failureMode: "return",
  dependencies: on(GameEngine.GameEngine),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_recompile"));
const UnityPlayTool = Tool.make("game_unity_play", {
  description:
    "Enter (start) or leave (stop) play mode in this Unity game's live editor, for a quick look with game_unity_screenshot, game_unity_console or game_unity_eval. Real playtests with input use game_explore_*.",
  parameters: GameUnityPlayInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_play"));
const UnityConsoleTool = Tool.make("game_unity_console", {
  description:
    "Read recent console entries of this Unity game's live editor, with stack traces. level is a minimum severity (log, warn, error).",
  parameters: GameUnityConsoleInput,
  success: GameUnityTextResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_console"));
export const GameUnityScreenshotTool = Tool.make("game_unity_screenshot", {
  description:
    "See this Unity game's Game view through its main camera as one image (Pipeline capture game_view, camera source). Works in and out of play mode; Screen Space Overlay UI only shows in game_explore_* pictures.",
  parameters: GameUnityScreenshotInput,
  success: GameUnityScreenshotResult,
  failure,
  failureMode: "return",
  dependencies: on(GameUnity.GameUnity),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_unity_screenshot"));
export const GameUnityScreenshotToolkit = Toolkit.make(GameUnityScreenshotTool);
const ImportTool = Tool.make("game_import", {
  description: `Import this thread's game in its engine. ${perEngine((t) => t.import)} Call after every asset transfer or engine change. Returns success=false on parse errors, missing resources, compile or import errors, with the output and log path; a tool Kurambit runs failing on its own is an error with reason tool-failed instead, which says nothing about the game. Fix failures before export.`,
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies: on(GameEngine.GameEngine),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_import"));
const CheckTool = Tool.make("game_check", {
  description: `Fast static and boot check for this thread's game: it imports, then boots the entry the player opens and the gameplay entry game.json declares, and reports what the game did as errors and warnings with file:line, and which entries ran. ${perEngine((t) => t.check)} \`scene\` is the scene report: a few seconds of random input on the gameplay entry, and a line for each thing a person would see is wrong (the player hidden, off screen or too small, an empty view, a character buried or inside a solid, bodies inside each other, something fallen out of the world, the camera inside a wall, sliding in idle), each naming a frame that outlines it; fix those too before you end the turn. The call fails only when the check could not be made (reason tool-failed, tool-missing, busy or low-memory). Start every build or fix loop with this; it is much faster than a playtest.`,
  success: GameCheckResult,
  failure,
  failureMode: "return",
  dependencies: on(GameEngine.GameEngine),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_check"));
const ExportTool = Tool.make("game_export", {
  description: `Import and export this thread's game for one target; a target its engine does not make is refused. ${perEngine((t) => t.export)} A release is staged and checked, then replaces the previous one only when the sources did not change while it was made, so a failed export leaves the last good build in place. Web exports to a content-addressed build. Returns the published artifact's path and the command output, or why it failed.`,
  parameters: Schema.Struct({ target: Schema.Literals(["Web", "Linux", "Windows"]) }),
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies: on(GameExport.GameExport),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_export"));
const PackageWindowsTool = Tool.make("game_package_windows", {
  description:
    "Package the Windows release this game already exported as a downloadable ZIP, for an engine whose Windows release Kurambit packages (a game whose Windows release is a whole folder is refused: ship the folder). It never exports: if builds/windows/game.exe is missing, is not a checked x86_64 executable with the game's pack, or changes while packaging, it returns the exact reason and leaves existing release files and any earlier package untouched. The ZIP contains game.exe and, only for a non-embedded preset, game.pck, at the archive root so extraction is runnable. Returns the absolute archive path, byte count, SHA-256, per-file hashes and notes; the creator downloads it from Export… in the Stage's More menu. Packaging does not prove Windows booted.",
  // No `parameters`: an explicit empty Schema.Struct({}) serializes to a root
  // anyOf, which no MCP client accepts, and the whole server fails to register.
  success: GameWindowsPackage,
  failure,
  failureMode: "return",
  dependencies: on(GameExport.GameExport),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_package_windows"));
const PackageWebTool = Tool.make("game_package_web", {
  description:
    "Package the exact immutable Web build Play currently serves as a downloadable ZIP for an ordinary static game host. It never exports, never rebuilds and never packages a draft: if no build is selected, or the selected build is missing or its bytes changed, it returns the exact reason and leaves the selection, sources and any earlier package untouched. The ZIP contains every served build file at its relative path with index.html at the archive root. The archive is bound to the selected build id and its own SHA-256. Upload and serve the extracted files over HTTP; opening index.html through file:// is not a supported play path because WebAssembly needs HTTP. Returns the absolute archive path, byte count, SHA-256, per-file hashes, entry and notes; the creator downloads it from Export… in the Stage's More menu. An engine with no Web build is refused.",
  // No `parameters` here either; see game_package_windows.
  success: GameWebPackage,
  failure,
  failureMode: "return",
  dependencies: on(GameExport.GameExport),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_package_web"));
const MediaSaveTool = Tool.make("game_media_save", {
  description:
    "Keep a video or image Kurambit generated when the creator wants it: a bot run's run.mp4 or frames, an explore session's screenshots, a sprite render. The storage cleanup deletes game logs after a while; this copies the file into the game's saved/ folder (ignored by git) under a readable dated name, and the original keeps working until the cleanup removes it. source is the game-relative or absolute path a game tool returned, inside builds/logs; label gives the words after the date (\"level 2 bot run\"). Nothing in saved/ is overwritten: a taken name gets a number.",
  parameters: Schema.Struct(GameMediaSaveFields),
  success: GameSavedMedia,
  failure,
  failureMode: "return",
  dependencies: on(GameSavedMediaService.GameSavedMediaService),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_media_save"));
const SavedListTool = Tool.make("game_saved_list", {
  description:
    "The videos and images saved in this game's saved/ folder with game_media_save or the Save button, newest first, with absolute paths.",
  success: GameSavedListResult,
  failure,
  failureMode: "return",
  dependencies: on(GameSavedMediaService.GameSavedMediaService),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_saved_list"));
const SavedDeleteTool = Tool.make("game_saved_delete", {
  description:
    "Delete one saved video or image from this game's saved/ folder when the creator asks, by the name game_saved_list gives. Only files directly in saved/ can be deleted.",
  parameters: Schema.Struct(GameSavedDeleteFields),
  success: Schema.Struct({}),
  failure,
  failureMode: "return",
  dependencies: on(GameSavedMediaService.GameSavedMediaService),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_saved_delete"));
const PreviewTool = Tool.make("game_preview", {
  description:
    "A playable build of this thread's current sources. For a three.js game the folder is served live: it returns the loopback URL of web/ itself, which reloads on the person's Stage as you save, with no export (game_export Web makes a release without changing what Play shows). For an engine with a Web build (Godot): when the selected build is missing, damaged or exported from other sources than the folder holds now, it exports Web again (the same export the Stage's Rebuild runs), then serves it from a managed loopback static server and returns the playable URL; a build of the current sources is served without another export. This is the actual game, not a screenshot. For an engine whose games play as a built player (Unity), it prepares that player of the current sources and returns its path; game_explore_start and game_bot_run play it. game_stop closes the server.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies: on(GameStage.GameStage),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_preview"));
const StopTool = Tool.make("game_stop", {
  description:
    "Stop only this game's processes spawned by Kurambit, including running operations, live editors, bot runs and native play, and close its Web preview server. On a three.js game this also stops the live game on the person's Stage: it stays stopped, for every client, until Play opens it again. Returns after managed processes exit and says which did not stop (success false). Does not kill external editors or other games.",
  success: GameActionResult,
  failure,
  failureMode: "return",
  dependencies: on(GameStage.GameStage),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_stop"));
/**
 * Bounded persistent exploration: open one paused session on the current game sources, poke it with short act/observe cycles across turns, then close it
 */
const ExploreStartTool = Tool.make("game_explore_start", {
  description:
    `Open a bounded exploration session on this thread's game. ${perEngine((t) => t.explore)}` +
    " Probes, visible text, interactive controls, errors and a picture (native games need a window for it: Xvfb on Linux, a window kept off-screen on Windows and macOS; web games always have one). Nothing is exported. Pass target native or web to pick the runner, or omit it for the game's own engine. Returns a session id for game_explore_act. Only one live session exists per game: its owning thread must close it before that game starts another. Sessions start with no saved data; saves keep reuses one save location across kept sessions, to check that what the game saves (best scores, settings, unlocks) survives a relaunch.",
  parameters: GameExploreStartInput,
  success: GameExploreStartResult,
  failure,
  failureMode: "return",
  dependencies: on(GameExplore.GameExplore),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_explore_start"));
const ExploreActTool = Tool.make("game_explore_act", {
  description: `Run one input batch (1–${GAME_EXPLORE_BOUNDS.maxStepsPerCall} steps, at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall / 1000} s nominal) in an exploration session and observe what happened: the current probe, one persisted screenshot path (null with a reason when the session has no display) and bounded console text, plus visible screenText, interactive ui controls, script/engine errors, per-ui-step receipt and per-inspect-step read-only values; use ui {id, action} for real mouse input at a listed control and inspect {path} for read-only reflection. A session allows ${GAME_EXPLORE_BOUNDS.maxCalls} calls, ${GAME_EXPLORE_BOUNDS.maxTotalSteps} steps and ${GAME_EXPLORE_BOUNDS.maxTotalNominalMs / 1000} s of input, so the calls spend that input only at about ${Math.round(GAME_EXPLORE_BOUNDS.maxTotalNominalMs / GAME_EXPLORE_BOUNDS.maxCalls / 1000)} s per call: after one short hold shows how a control responds, send 2–3 held steps per call, at most ${GAME_EXPLORE_BOUNDS.maxSequenceMsPerCall / 1000} s of input per call in total. Each result says the input used and the seconds per remaining call that spend the rest. Native games stay paused between calls; three.js games keep running in real time. Descriptive only, never a verdict.`,
  parameters: GameExploreActInput,
  success: GameExploreActResult,
  failure,
  failureMode: "return",
  dependencies: on(GameExplore.GameExplore),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_explore_act"));
const ExploreCloseTool = Tool.make("game_explore_close", {
  description:
    "Close an exploration session, releasing its runner and profile. Idle and wall-clock expiry close the same way with the reason saved.",
  parameters: GameExploreCloseInput,
  success: GameExploreCloseResult,
  failure,
  failureMode: "return",
  dependencies: on(GameExplore.GameExplore),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_explore_close"));
const BotRunTool = Tool.make("game_bot_run", {
  description:
    "Play this thread's game in real time with a model-written bot file under .studio/bot/ (goal, observe, options with facts and executors, status, optional policy). Godot games run continuously at normal speed in a window the user never sees, Unity games as a player of the current sources in one; three.js games run in headless Chromium. Holds and releases go out at 10 Hz, one continuous video per run is recorded from the game's own frames, and in-game detectors report findings with time and position. decider policy (default) uses the bot's own policy; jev asks the optional Jev route, which decides asynchronously without stopping play and falls back to policy on failure. mode play (default) tries to finish with a win bot; mode explore wanders with an exploration bot (broad options, no win goal) and may make several sequential runs when runs is set (1-10, default 1), writing a facts-only player report to .studio/player-report.md. The service records every run itself, with a readable copy in .studio/bot-results.jsonl. The bot may write state only through an explicit set-state call; a run that did is marked and is not pure play. Runs start with no saved data; saves keep carries the game's saved data across kept runs and exploration sessions, to check it survives a relaunch. Pass the bot file, seconds budget, decider, mode and runs.",
  parameters: GameBotRunInput,
  success: GameBotRunResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBot.GameBot),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_bot_run"));
const BotReportTool = Tool.make("game_bot_report", {
  description:
    "Rebuild the facts-only player report across this game's recorded bot runs and save it to .studio/player-report.md: run endings, what was picked and how often, offered-but-never-picked and rarely-picked options, first-action times, death/stall position clusters, sampled areas, detector findings and explicit state writes. Code states facts and interprets nothing.",
  success: GameBotReportResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBot.GameBot),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_bot_report"));
const BotViewTool = Tool.make("game_bot_view", {
  description:
    "Take a quick look at a finished bot run: goal status, measured tick rate and game/wall ratio, decisions, findings and server-owned paths to the trace, video and frames. Pass the runId from game_bot_run.",
  parameters: GameBotViewInput,
  success: GameBotViewResult,
  failure,
  failureMode: "return",
  dependencies: on(GameBot.GameBot),
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_bot_view"));
const commandId = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
    description:
      "Any id of yours for this request. Pass the same one when you retry a call that may have gone through, so it applies once.",
  }),
);
/** The studio toolkit: status, export and play-level tools for every thread. */
const buildDependencies = [
  GameBuilds.GameBuilds,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const BuildsTool = Tool.make("game_builds", {
  description:
    "This game's builds, newest first: every turn of any chat that changed the engine project, art, ASSETS.md or the play bot (.studio/bot), each with when, which turn or round, what changed, its base and its facts once measured (facts.chips, and how many were not measured). base is the build it was made from, so restoring base undoes that build (null when unknown); current is the build the folder was last made from; restore is the latest restore, whose undo build undoes it. Pass before with a next cursor for older builds, or compare with two build ids to diff their facts: each delta reads up, down, same, changed or not-comparable with why. Facts are read as measured; game_facts measures. Read-only.",
  parameters: Schema.Struct({
    compare: Schema.optionalKey(Schema.Tuple([GameBuildId, GameBuildId])),
    before: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Union([GameBuildsResult, GameBuildComparison]),
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_builds"));
const FactsTool = Tool.make("game_facts", {
  description:
    "What the harness measured on one build of this game (the newest when build is omitted), the facts the Builds rail shows: whether it boots; how it ends with no input (idle), random input (masher) and the game's latest play-mode bot (skilled); whether it is winnable without skill; still stretches, motion, detail and colour in the random-input video; input response; and where the engine reports them, asset use (use.unused: shipped files no play loaded, so wire them in or delete them; use.silent: sounds never started) and performance (one not measured because the harness drew in software is Kurambit's machine, never the game); and scene: the scene report game_check shows, over the random-input play. Each is measured, or not measured with why. A build is measured once, in a copy, in about 3 to 5 minutes; this call measures what is missing, waits up to 30 s, and otherwise returns with the rest pending: call again later. Facts are of builds (a turn's end), not of uncommitted work.",
  parameters: Schema.Struct({ build: Schema.optionalKey(GameBuildId) }),
  success: GameBuildFacts,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_facts"));
const BuildRestoreTool = Tool.make("game_build_restore", {
  description:
    "Put one of this game's builds (an id from game_builds) back in the game folder when the creator asks: its engine project, art, ASSETS.md and play bot (.studio/bot) return, and what the folder held before is kept first as a build of its own, so restoring that one undoes it (game_builds `restore.undo`). To undo a turn, restore its build's `base`; to go back to an older build, restore that build. The result says whether the folder has moved (`done`).",
  parameters: Schema.Struct({ build: GameBuildId, commandId }),
  success: GameBuildRestoreResult,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_build_restore"));
const TuneTool = Tool.make("game_tune", {
  description:
    "Keep live values as a build, as the person's Keep as a build on the Stage does: writes each thing's values (by the id its ctx.tune uses) into web/tune.json, which the game reads at boot, and keeps the game folder as a build whose `base` (the folder just before) game_build_restore restores to undo it. Pass min and max with a number to have it checked against the range; values merge with the file's others. Use it when the person asks to keep values; to change what a value means or its defaults, edit the code. three.js games only.",
  parameters: Schema.Struct({ things: GameKeepValuesInput.fields.things, commandId }),
  success: GameKeepValuesResult,
  failure,
  failureMode: "return",
  dependencies: buildDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_tune"));

/** Keep going: the same service the composer control and the banner reach. */
const keepGoingDependencies = [
  GameRunControl.GameRunControl,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];
const KeepGoingTool = Tool.make("game_keep_going", {
  description:
    "Turn Keep going on or off for this chat, only when the person asks. off stops it; a step's turn in flight ends and still becomes a build. guided proposes each next step in the composer and starts it after a minute unless the person changes it; autopilot takes each next step itself. Both undo a step that makes a measured fact worse (the person can redo it). Choosing a mode while it is paused resumes it, keeping the steps it set aside and the notes waiting for it. budgetMinutes (null for no limit; a new run's is 60) applies when it starts or resumes. Keep going runs only on games Kurambit plays after every turn (three.js); elsewhere, or while it is on in another chat of the game, it is refused with why. Returns what game_keep_going_status returns.",
  parameters: Schema.Struct({
    mode: GameKeepGoingInput.fields.mode,
    budgetMinutes: GameKeepGoingInput.fields.budgetMinutes,
    commandId,
  }),
  success: GameKeepGoingStatus,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_keep_going"));
const KeepGoingStatusTool = Tool.make("game_keep_going_status", {
  description:
    "Keep going on this game: off, guided or autopilot; what it is doing now (waiting for a turn to end, reading the build's facts, a proposal and when it starts, a step's turn, measuring, undoing); its last 10 steps with each verdict, reason and fact changes; the person's notes waiting for the next step; the steps it set aside and why; when its budget ends; and why it last stopped and whether choosing a mode resumes it. A message in this chat that starts \"Keep going · step N\" is a step: do that one change as it asks, like any turn. The person's own messages always come first. Read-only.",
  success: GameKeepGoingStatus,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, listedFor("game_keep_going_status"));
const KeepGoingSteerTool = Tool.make("game_keep_going_steer", {
  description:
    "Give Keep going the person's words for its next step, when they ask for that from another chat of the game, or want it taken up after the step in flight: the next step carries them as they said them, before anything keep going would choose. One request per call, in their words. Returns how many notes are waiting. In the chat keep going runs in, the person's own message goes first anyway.",
  parameters: Schema.Struct({ text: GameKeepGoingSteerInput.fields.text, commandId }),
  success: GameKeepGoingSteerResult,
  failure,
  failureMode: "return",
  dependencies: keepGoingDependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_keep_going_steer"));

export const GameToolkit = Toolkit.make(
  GameStatusTool,
  BlenderCodeTool,
  BlenderSceneTool,
  BlenderAssetsSearchTool,
  BlenderAssetsImportTool,
  BlenderExportTool,
  BlenderCharacterTool,
  BlenderPaintTool,
  BlenderCarveTool,
  GenerateTool,
  ImageEditTool,
  GenerateWaitTool,
  AssetsAddTool,
  UnityToolsTool,
  UnityEditTool,
  UnityEvalTool,
  UnityRecompileTool,
  UnityPlayTool,
  UnityConsoleTool,
  ImportTool,
  CheckTool,
  ExportTool,
  PackageWindowsTool,
  PackageWebTool,
  MediaSaveTool,
  SavedListTool,
  SavedDeleteTool,
  PreviewTool,
  StopTool,
  ExploreStartTool,
  ExploreActTool,
  ExploreCloseTool,
  BotRunTool,
  BotViewTool,
  BotReportTool,
  BuildsTool,
  FactsTool,
  BuildRestoreTool,
  TuneTool,
  KeepGoingTool,
  KeepGoingStatusTool,
  KeepGoingSteerTool,
);

/**
 * The tools a chat uses only when the person asks for them stay out of every
 * turn's tool list (placement.ts `asked`); this one tool names them and runs them.
 */
export const GameMoreTool = Tool.make("game_more", {
  description: [
    "Reach a game tool kept out of your list until it is needed. Pass tool alone to read its description and parameters, then tool and input to run it exactly as the tool itself runs. A tool this game or machine cannot run is refused with why.",
    // Tools reached for the same reason share one line.
    ...Object.entries(Object.groupBy(ASKABLE_TOOLS, ([, asked]) => asked)).map(
      ([asked, tools = []]) => `- ${tools.map(([name]) => name).join(", ")}: ${asked}.`,
    ),
  ].join("\n"),
  parameters: Schema.Struct({
    tool: Schema.Literals(ASKABLE_TOOLS.map(([name]) => name)),
    input: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "The tool's parameters, as its description gives them. Omit to read them.",
      }),
    ),
  }),
  success: Schema.Unknown,
  // The tool's own failure as it would have returned it, under its message.
  failure: Schema.Struct({ message: Schema.String, failure: Schema.optionalKey(Schema.Unknown) }),
  failureMode: "return",
  // It runs any game tool, so it stands on every service they do.
  dependencies: [
    GameStatusService.GameStatusService,
    GameBlender.GameBlender,
    GameArt.GameArt,
    GameAssetLibrary.GameAssetLibrary,
    GameUnity.GameUnity,
    GameEngine.GameEngine,
    GameExport.GameExport,
    GameSavedMediaService.GameSavedMediaService,
    GameStage.GameStage,
    GameExplore.GameExplore,
    GameBot.GameBot,
    GameBuilds.GameBuilds,
    GameRunControl.GameRunControl,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, listedFor("game_more"));
export const GameMoreToolkit = Toolkit.make(GameMoreTool);
