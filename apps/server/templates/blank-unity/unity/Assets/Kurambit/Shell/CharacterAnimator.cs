using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

/// <summary>
/// Character animation by state for an imported rigged model (a GLB from
/// Blender or the library, or an FBX) with its clips. No Animator Controller:
/// choose the state from gameplay every frame and call Play(state); this finds
/// the clip by name, crossfades, plays one-shots through and returns to the loop.
///
///   // In the scene builder (Assets/Editor/BuildGame.cs), on the placed model:
///   CharacterAnimator.On(hero);                  // finds hero.glb's clips, saved with the scene
///   // In gameplay:
///   var anim = GetComponentInChildren<CharacterAnimator>();
///   anim.Play(!grounded ? "fall" : speed > 4f ? "run" : speed > 0.1f ? "walk" : "idle",
///             Mathf.Max(speed / 3f, 0.6f));      // playback rate: moving speed / the clip's own
///   if (Controls.Pressed("action")) anim.Play("attack");   // one-shot, then back to the loop
///
/// States: idle, walk, run, jump, fall, attack, hit, die, or any word in a clip
/// name ("dance", "roll"). Names match by word, case-insensitive: "Idle",
/// "Walk_Loop", "CharacterArmature|Run", "attack-melee-right". A missing run
/// plays walk, then idle (fall plays jump); each miss warns once with the clips
/// the model has. jump, attack and hit play once each time the state is entered
/// (asked for again, they hold their last pose), then the loop asked for
/// meanwhile takes over; die plays once and holds until Revive(). The console
/// shows which clip each role got. It runs on game time, so it freezes on pause.
/// </summary>
[DisallowMultipleComponent]
public sealed class CharacterAnimator : MonoBehaviour
{
    private static readonly Dictionary<string, string[]> Roles = new Dictionary<string, string[]>
    {
        ["idle"] = new[] { "idle", "fly", "flying", "hover" },
        ["walk"] = new[] { "walk", "walking" },
        ["run"] = new[] { "run", "running", "jog", "sprint" },
        ["jump"] = new[] { "jump" },
        ["fall"] = new[] { "fall", "falling", "air", "airborne" },
        ["attack"] = new[] { "attack", "punch", "slash", "swing", "melee", "kick", "shoot" },
        ["hit"] = new[] { "hit", "hurt", "damage", "recievehit", "receivehit" },
        ["die"] = new[] { "die", "death", "dead", "defeat", "dying" },
    };
    private static readonly Dictionary<string, string> Fallback = new Dictionary<string, string>
    {
        ["run"] = "walk", ["walk"] = "idle", ["fall"] = "jump", ["jump"] = "idle",
    };
    private static readonly HashSet<string> Once = new HashSet<string> { "attack", "hit", "die", "jump" };
    // Words that say nothing about the motion; any other word makes a clip a variant.
    private static readonly HashSet<string> Filler = new HashSet<string> { "loop", "anim", "animation", "fwd", "forward", "inplace", "cycle" };
    // Clips with these words are held poses or guards, never a role's pick
    // (KayKit's "Block_Attack" is not its attack); play them by their own word.
    private static readonly string[] NotARole = { "block", "blocking", "pose", "aiming", "reload" };

    [Tooltip("The model's clips; filled from the model's file when this component is added in the editor.")]
    public AnimationClip[] clips = new AnimationClip[0];
    [Tooltip("Seconds each change blends over.")]
    public float fade = 0.2f;

    /// <summary>The state playing now.</summary>
    public string State { get; private set; } = "";

    private PlayableGraph graph;
    private AnimationMixerPlayable mixer;
    private AnimationClipPlayable[] playables = new AnimationClipPlayable[0];
    private readonly Dictionary<string, int> resolved = new Dictionary<string, int>();
    private readonly HashSet<string> warned = new HashSet<string>();
    private int current = -1;
    private bool currentOnce;
    private bool done;
    private bool held;
    private string asked = "";
    private string loopState = "idle";
    private float loopSpeed = 1f;
    private float blend;

    /// <summary>The animator on a placed model: adds it (finding the clips in the editor) or returns the one there.</summary>
    public static CharacterAnimator On(GameObject model, AnimationClip[] clips = null)
    {
        var animator = model.GetComponentInChildren<CharacterAnimator>();
        if (animator == null)
        {
            var host = model.GetComponentInChildren<Animator>() != null ? model.GetComponentInChildren<Animator>().gameObject : model;
            animator = host.AddComponent<CharacterAnimator>();
        }
        if (clips != null) animator.clips = clips;
#if UNITY_EDITOR
        if (animator.clips.Length == 0) animator.FindClips();
#endif
        return animator;
    }

    public IEnumerable<string> ClipNames => clips.Where(clip => clip != null).Select(clip => clip.name);

    private void Awake()
    {
        clips = clips.Where(clip => clip != null).ToArray();
        if (clips.Length == 0)
        {
            Debug.LogWarning($"CharacterAnimator on {name}: no clips. Add it in the editor (CharacterAnimator.On in the scene builder) so it finds the model's clips, or pass them.");
            return;
        }
        var animator = GetComponent<Animator>();
        if (animator == null) animator = gameObject.AddComponent<Animator>();
        animator.applyRootMotion = false;
        animator.runtimeAnimatorController = null;
        graph = PlayableGraph.Create($"{name} CharacterAnimator");
        graph.SetTimeUpdateMode(DirectorUpdateMode.GameTime);
        mixer = AnimationMixerPlayable.Create(graph, clips.Length);
        playables = new AnimationClipPlayable[clips.Length];
        for (var i = 0; i < clips.Length; i++)
        {
            playables[i] = AnimationClipPlayable.Create(graph, clips[i]);
            graph.Connect(playables[i], 0, mixer, i);
            mixer.SetInputWeight(i, 0f);
        }
        AnimationPlayableOutput.Create(graph, "Animation", animator).SetSourcePlayable(mixer);
        graph.Play();
        Debug.Log($"CharacterAnimator {name}: clips {string.Join(", ", ClipNames)}; " +
                  string.Join(" ", Roles.Keys.Select(role => $"{role}={(FindClip(ClipNames, role) ?? "-")}")));
        Play("idle");
    }

    private void OnDestroy()
    {
        if (graph.IsValid()) graph.Destroy();
    }

    /// <summary>The clip for a role: one whose words hold a role keyword, fewest extra words, earliest keyword.</summary>
    public static string FindClip(IEnumerable<string> names, string wanted)
    {
        var keys = Roles.TryGetValue(wanted, out var found) ? found : new[] { wanted.ToLowerInvariant() };
        string best = null;
        var bestScore = int.MaxValue;
        foreach (var clip in names)
        {
            var w = Words(clip);
            if (Roles.ContainsKey(wanted) && NotARole.Any(w.Contains)) continue;
            var k = System.Array.FindIndex(keys, key => w.Contains(key));
            if (k < 0) continue;
            // A lone letter is a variant tag ("Hit_A"), not another motion.
            var score = w.Count(x => !keys.Contains(x) && !Filler.Contains(x) && x.Length > 1) * 10 + k;
            if (score < bestScore)
            {
                bestScore = score;
                best = clip;
            }
        }
        return best;
    }

    private static List<string> Words(string clip)
    {
        var name = clip.Split('|').Last();
        var split = Regex.Replace(name, "([a-z])([A-Z])", "$1 $2").ToLowerInvariant();
        return Regex.Matches(split, "[a-z]+").Cast<Match>().Select(match => match.Value).ToList();
    }

    public void Play(string wanted, float speed = 1f, bool? once = null, float? blendSeconds = null)
    {
        var entered = wanted != asked;
        asked = wanted;
        if (playables.Length == 0 || held) return;
        var index = ClipFor(wanted);
        if (index < 0) return;
        var isOnce = once ?? Once.Contains(wanted);
        if (isOnce)
        {
            if (!entered && current == index) return;
            if (wanted == "die") held = true;
            Begin(wanted, index, true, speed, blendSeconds ?? fade);
            return;
        }
        loopState = wanted;
        loopSpeed = speed;
        // A one-shot plays through; the loop asked for meanwhile follows it.
        if (currentOnce && !done) return;
        if (current == index && !currentOnce)
        {
            State = wanted;
            playables[index].SetSpeed(speed);
            return;
        }
        Begin(wanted, index, false, speed, blendSeconds ?? fade);
    }

    /// <summary>Back to playing after die (a respawn).</summary>
    public void Revive()
    {
        held = false;
        asked = "";
        current = -1;
        Play("idle");
    }

    private void Begin(string wanted, int index, bool isOnce, float speed, float blendSeconds)
    {
        var next = playables[index];
        // Loop to loop keeps the step phase (walk to run lands on the same foot).
        var phase = -1.0;
        if (!isOnce && !currentOnce && current >= 0 && current != index && clips[current].length > 0f)
            phase = playables[current].GetTime() / clips[current].length % 1.0;
        next.SetTime(phase >= 0 ? phase * clips[index].length : 0.0);
        next.SetSpeed(speed);
        current = index;
        currentOnce = isOnce;
        done = false;
        blend = Mathf.Max(0.0001f, blendSeconds);
        State = wanted;
    }

    private void Update()
    {
        if (current < 0 || playables.Length == 0) return;
        var delta = Time.deltaTime;
        if (delta <= 0f) return;
        if (currentOnce && !done)
        {
            var playable = playables[current];
            var length = clips[current].length;
            // Stop on the last frame before the graph would wrap the clip round.
            if (playable.GetTime() + delta * playable.GetSpeed() >= length)
            {
                playable.SetTime(Mathf.Max(0f, length - 0.001f));
                playable.SetSpeed(0);
                done = true;
                // Still asked for (airborne in a jump): hold the last pose until the game moves on.
                if (!held && asked != State)
                {
                    var next = ClipFor(loopState);
                    if (next >= 0) Begin(loopState, next, false, loopSpeed, fade);
                }
            }
        }
        var step = delta / blend;
        var total = 0f;
        for (var i = 0; i < playables.Length; i++)
        {
            var weight = Mathf.MoveTowards(mixer.GetInputWeight(i), i == current ? 1f : 0f, step);
            mixer.SetInputWeight(i, weight);
            total += weight;
        }
        if (total > 0f && !Mathf.Approximately(total, 1f))
            for (var i = 0; i < playables.Length; i++) mixer.SetInputWeight(i, mixer.GetInputWeight(i) / total);
    }

    private int ClipFor(string wanted)
    {
        if (resolved.TryGetValue(wanted, out var cached)) return cached;
        var names = clips.Select(clip => clip.name).ToList();
        string clip = null;
        for (var s = wanted; s != null && clip == null; s = Fallback.TryGetValue(s, out var f) ? f : null)
            clip = FindClip(names, s);
        if (clip == null && (wanted == "idle" || !Roles.ContainsKey(wanted) || Fallback.ContainsKey(wanted)))
            clip = FindClip(names, "idle") ?? names.FirstOrDefault();
        if (clip != FindClip(names, wanted) && warned.Add(wanted))
            Debug.LogWarning($"CharacterAnimator {name}: no \"{wanted}\" clip{(clip == null ? "" : ", playing " + clip)}; clips: {string.Join(", ", names)}");
        var index = clip == null ? -1 : names.IndexOf(clip);
        resolved[wanted] = index;
        return index;
    }

#if UNITY_EDITOR
    private void Reset() => FindClips();

    /// <summary>Every clip in the model file this object was placed from (GLB through glTFast, FBX).</summary>
    internal void FindClips()
    {
        var source = UnityEditor.PrefabUtility.GetCorrespondingObjectFromOriginalSource(gameObject);
        var path = source != null ? UnityEditor.AssetDatabase.GetAssetPath(source) : "";
        if (string.IsNullOrEmpty(path)) return;
        clips = UnityEditor.AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
            .Where(clip => !clip.name.StartsWith("__preview__")).ToArray();
    }
#endif
}
