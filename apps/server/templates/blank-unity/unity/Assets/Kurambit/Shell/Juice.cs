using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// Game feel, one call each. Every player action wants an answer the player
/// can see and hear; overlapping calls combine instead of fighting, and
/// nothing here can leave the game stuck.
///
///   Juice.Shake(0.4f);                    // camera shake: trauma 0..1 adds up, decays
///   Juice.HitPause();                     // ~60 ms time dip on a hit; overlaps extend it
///   Juice.Pop(transform);                 // quick scale-up and settle (pickups, hits)
///   Juice.Squash(transform);              // wide-and-short, springs back (jumps, landings)
///   Juice.Flash(enemy);                   // flash white (or a colour), fades back
///   Juice.Burst(position, Color.yellow);  // one-shot particles
///   Juice.Sfx(hitClip);                   // pooled one-shot at the SFX volume, slight pitch jitter
///
/// The shake moves Camera.main only while it renders, so it adds to whatever
/// the game's camera code (or FollowCamera2D/3D) put there and never drifts.
/// Pop and squash animate localScale from the scale the object had; flash
/// reaches child renderers. All of it runs on game time, so it freezes on pause.
/// </summary>
public static class Juice
{
    public static float ShakeUnits = 0.25f;
    public static float ShakeDegrees = 1.2f;
    /// <summary>Trauma lost per second.</summary>
    public static float ShakeDecay = 1.6f;
    internal const float MaxHitPause = 0.3f;

    private static JuiceRunner runner;
    private static JuiceRunner Runner
    {
        get
        {
            if (runner != null) return runner;
            var host = new GameObject("Juice");
            Object.DontDestroyOnLoad(host);
            runner = host.AddComponent<JuiceRunner>();
            return runner;
        }
    }

    public static void Shake(float amount = 0.4f) => Runner.trauma = Mathf.Clamp01(Runner.trauma + amount);

    public static void HitPause(float seconds = 0.06f, float timeScale = 0.05f) => Runner.HitPause(seconds, timeScale);

    public static void Pop(Transform target, float amount = 0.25f, float seconds = 0.18f) =>
        Runner.Scale(target, new Vector3(1f + amount, 1f + amount, 1f + amount), seconds);

    public static void Squash(Transform target, float amount = 0.3f, float seconds = 0.22f) =>
        Runner.Scale(target, new Vector3(1f + amount, 1f - amount, 1f + amount), seconds);

    public static void Flash(Component target, Color? colour = null, float seconds = 0.12f) =>
        Runner.Flash(target.gameObject, colour ?? Color.white, seconds);

    public static void Flash(GameObject target, Color? colour = null, float seconds = 0.12f) =>
        Runner.Flash(target, colour ?? Color.white, seconds);

    public static void Burst(Vector3 position, Color? colour = null, int count = 18, float speed = 4f) =>
        Runner.Burst(position, colour ?? new Color(1f, 0.8f, 0.35f), count, speed);

    public static void Sfx(AudioClip clip, float volume = 1f, float pitchJitter = 0.05f) => Sound.Sfx(clip, volume, pitchJitter);
}

internal sealed class JuiceRunner : MonoBehaviour
{
    public float trauma;
    private Vector3 shakeOffset;
    private Quaternion shakeTurn = Quaternion.identity;
    private Camera shaken;
    private float hitLeft;
    private float hitScale = 1f;
    private bool hitting;
    private readonly Dictionary<Transform, Coroutine> scaling = new Dictionary<Transform, Coroutine>();
    private readonly Dictionary<Transform, Vector3> restScale = new Dictionary<Transform, Vector3>();
    private readonly Dictionary<Renderer, Coroutine> flashing = new Dictionary<Renderer, Coroutine>();
    private MaterialPropertyBlock block;

    private void OnEnable()
    {
        RenderPipelineManager.beginCameraRendering += BeginCamera;
        RenderPipelineManager.endCameraRendering += EndCamera;
    }

    private void OnDisable()
    {
        RenderPipelineManager.beginCameraRendering -= BeginCamera;
        RenderPipelineManager.endCameraRendering -= EndCamera;
    }

    private void Update()
    {
        trauma = Mathf.Max(0f, trauma - Juice.ShakeDecay * Time.deltaTime);
        // A hit pause counts only time that is running: a pause menu or the
        // explore runner holding the game must not let it end underneath them.
        if (hitting && Time.timeScale > 0f)
        {
            hitLeft -= Time.unscaledDeltaTime;
            if (hitLeft <= 0f)
            {
                hitting = false;
                if (Mathf.Approximately(Time.timeScale, hitScale)) Time.timeScale = 1f;
            }
        }
    }

    private void BeginCamera(ScriptableRenderContext context, Camera camera)
    {
        if (trauma <= 0f || camera != Camera.main) return;
        var t = Time.time * 25f;
        var power = trauma * trauma;
        shakeOffset = new Vector3(Mathf.PerlinNoise(t, 0.1f) - 0.5f, Mathf.PerlinNoise(0.3f, t) - 0.5f, 0f) * (2f * power * Juice.ShakeUnits);
        shakeTurn = Quaternion.Euler(0f, 0f, (Mathf.PerlinNoise(t, t) - 0.5f) * 2f * power * Juice.ShakeDegrees);
        var transformOf = camera.transform;
        transformOf.localPosition += transformOf.localRotation * shakeOffset;
        transformOf.localRotation *= shakeTurn;
        shaken = camera;
    }

    private void EndCamera(ScriptableRenderContext context, Camera camera)
    {
        if (camera != shaken) return;
        var transformOf = camera.transform;
        transformOf.localRotation *= Quaternion.Inverse(shakeTurn);
        transformOf.localPosition -= transformOf.localRotation * shakeOffset;
        shaken = null;
    }

    public void HitPause(float seconds, float scale)
    {
        var state = GameState.Instance != null ? GameState.Instance.state : "playing";
        if (state != "playing") return;
        hitLeft = Mathf.Min(Juice.MaxHitPause, (hitting ? hitLeft : 0f) + seconds);
        if (!hitting && Time.timeScale < 1f) return;
        hitting = true;
        hitScale = scale;
        Time.timeScale = scale;
    }

    public void Scale(Transform target, Vector3 peak, float seconds)
    {
        if (target == null) return;
        if (scaling.TryGetValue(target, out var running) && running != null) StopCoroutine(running);
        if (!restScale.ContainsKey(target)) restScale[target] = target.localScale;
        scaling[target] = StartCoroutine(ScaleRoutine(target, peak, seconds));
    }

    private IEnumerator ScaleRoutine(Transform target, Vector3 peak, float seconds)
    {
        var rest = restScale[target];
        for (var age = 0f; age < seconds; age += Time.deltaTime)
        {
            if (target == null) yield break;
            var k = Mathf.Sin(age / seconds * Mathf.PI);
            target.localScale = Vector3.Scale(rest, Vector3.LerpUnclamped(Vector3.one, peak, k));
            yield return null;
        }
        if (target != null) target.localScale = rest;
        scaling.Remove(target);
        restScale.Remove(target);
    }

    public void Flash(GameObject target, Color colour, float seconds)
    {
        if (target == null) return;
        foreach (var renderer in target.GetComponentsInChildren<Renderer>())
        {
            if (renderer is ParticleSystemRenderer) continue;
            if (flashing.TryGetValue(renderer, out var running) && running != null) StopCoroutine(running);
            flashing[renderer] = StartCoroutine(FlashRoutine(renderer, colour, seconds));
        }
    }

    private IEnumerator FlashRoutine(Renderer renderer, Color colour, float seconds)
    {
        block ??= new MaterialPropertyBlock();
        var sprite = renderer as SpriteRenderer;
        var material = renderer.sharedMaterial;
        var baseColour = sprite != null ? sprite.color
            : material != null && material.HasProperty("_BaseColor") ? material.GetColor("_BaseColor")
            : material != null && material.HasProperty("_Color") ? material.color : Color.white;
        var property = material != null && material.HasProperty("_BaseColor") ? "_BaseColor" : "_Color";
        for (var age = 0f; age < seconds; age += Time.deltaTime)
        {
            if (renderer == null) yield break;
            var c = Color.Lerp(colour, baseColour, age / seconds);
            if (sprite != null) sprite.color = c;
            else
            {
                renderer.GetPropertyBlock(block);
                block.SetColor(property, c);
                renderer.SetPropertyBlock(block);
            }
            yield return null;
        }
        if (renderer == null) yield break;
        if (sprite != null) sprite.color = baseColour;
        else renderer.SetPropertyBlock(null);
        flashing.Remove(renderer);
    }

    public void Burst(Vector3 position, Color colour, int count, float speed)
    {
        var host = new GameObject("Burst");
        host.transform.position = position;
        var particles = host.AddComponent<ParticleSystem>();
        particles.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
        var main = particles.main;
        main.duration = 0.5f;
        main.loop = false;
        main.startLifetime = new ParticleSystem.MinMaxCurve(0.25f, 0.6f);
        main.startSpeed = new ParticleSystem.MinMaxCurve(speed * 0.5f, speed);
        main.startSize = new ParticleSystem.MinMaxCurve(0.08f, 0.2f);
        main.startColor = colour;
        main.gravityModifier = 0.6f;
        main.simulationSpace = ParticleSystemSimulationSpace.World;
        main.stopAction = ParticleSystemStopAction.Destroy;
        var emission = particles.emission;
        emission.rateOverTime = 0f;
        emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(count, 1, 200)) });
        var shape = particles.shape;
        shape.shapeType = ParticleSystemShapeType.Sphere;
        shape.radius = 0.1f;
        var size = particles.sizeOverLifetime;
        size.enabled = true;
        size.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, 0f));
        var assets = ShellAssets.Load();
        host.GetComponent<ParticleSystemRenderer>().sharedMaterial = assets != null ? assets.burstMaterial : null;
        particles.Play();
    }
}

/// <summary>
/// Music and sound effects at the Settings volumes: Sound.Music(clip) loops one
/// track, Sound.Sfx(clip) (or Juice.Sfx) plays a pooled one-shot. Master volume
/// reaches every AudioSource; music and effects volumes reach only these.
/// </summary>
public static class Sound
{
    private const int Voices = 12;
    private static float music = 1f;
    private static float sfx = 1f;
    private static AudioSource musicSource;
    private static readonly List<AudioSource> voices = new List<AudioSource>();
    private static int next;
    private static GameObject host;

    public static float MusicVolume
    {
        get => music;
        set
        {
            music = Mathf.Clamp01(value);
            if (musicSource != null) musicSource.volume = music;
        }
    }

    public static float SfxVolume
    {
        get => sfx;
        set => sfx = Mathf.Clamp01(value);
    }

    private static GameObject Host
    {
        get
        {
            if (host != null) return host;
            host = new GameObject("Sound");
            Object.DontDestroyOnLoad(host);
            return host;
        }
    }

    public static void Music(AudioClip clip, float volume = 1f)
    {
        if (musicSource == null)
        {
            musicSource = Host.AddComponent<AudioSource>();
            musicSource.loop = true;
            musicSource.playOnAwake = false;
            // Music keeps going under the pause menu; gameplay sounds pause.
            musicSource.ignoreListenerPause = true;
        }
        musicSource.volume = music * Mathf.Clamp01(volume);
        if (musicSource.clip == clip && musicSource.isPlaying) return;
        musicSource.clip = clip;
        if (clip != null) musicSource.Play();
        else musicSource.Stop();
    }

    public static void StopMusic() => Music(null);

    public static void Sfx(AudioClip clip, float volume = 1f, float pitchJitter = 0.05f, bool ignorePause = false)
    {
        if (clip == null) return;
        while (voices.Count < Voices)
        {
            var source = Host.AddComponent<AudioSource>();
            source.playOnAwake = false;
            voices.Add(source);
        }
        var voice = voices[next];
        next = (next + 1) % voices.Count;
        voice.ignoreListenerPause = ignorePause;
        voice.pitch = 1f + Random.Range(-pitchJitter, pitchJitter);
        voice.PlayOneShot(clip, Mathf.Clamp01(volume) * sfx);
    }
}
