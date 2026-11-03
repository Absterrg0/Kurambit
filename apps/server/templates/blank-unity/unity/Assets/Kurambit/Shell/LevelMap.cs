using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

// Levels as text maps. Write the level as rows of characters and a legend;
// LevelMap builds it under a parent with real colliders and records the
// spawns and the bounds, so nothing is placed by coordinates. Build it in the
// scene builder (Assets/Editor/BuildGame.cs) so the level is saved in
// Game.unity: every still, the probe and the first frame then show it.
//
//   static readonly string[] Rooms =
//   {
//       "#########   #########",
//       "#P......#   #.....E.#",
//       "#.......#####...G...#",
//       "#.......=...=.......#",   // two rooms joined by a corridor
//       "#####################",   // every walkable edge closed: " " is void
//   };
//   var level = LevelMap.Build(gameRoot, Rooms, new Dictionary<char, object>
//   {
//       ['#'] = Load("Assets/Library/<pack>/wall.glb"),          // a solid piece (a prefab or model)
//       ['c'] = new LevelMap.Piece { prefab = barrel, rotate = 90, solid = false },
//       ['='] = "floor",
//       ['P'] = "spawn", ['E'] = "spawn", ['G'] = "spawn",
//       ['x'] = new Color(0.4f, 0.3f, 0.3f),                      // a plain block, for a blockout
//   }, new LevelMap.Options { cell = 2f, floor = Load("Assets/Library/<pack>/floor.glb") });
//   player.position = level.Spawn('P');            // cell centres on the floor, by letter
//   // at runtime: var level = FindAnyObjectByType<LevelMap>(); level.Spawns('E'), level.bounds
//
// " " is void (no floor, no collider: a pit in 3D, open space in 2D); "." is
// plain floor (the `floor` option's piece, or a grey slab in 3D) unless the
// legend says otherwise; any other character must be in the legend, or Build
// reports it as an error. Legend values: "spawn", "floor", "void", a
// GameObject (a solid piece), a Color (a plain solid block) or a Piece.
// Solid cells get box colliders merged along each row, as tall as the piece,
// so a CharacterController or Rigidbody stops at them and FollowCamera3D
// pulls in at them; every non-void 3D cell has floor collision. Options.flat
// builds in the XY plane for 2D and top-down games (rows run down the screen,
// BoxCollider2D walls, Bounds2D for FollowCamera2D); otherwise rows run
// toward +z on the XZ plane. Column c, row r sits at ((c + 0.5) * cell, 0,
// (r + 0.5) * cell) from the parent. Building again replaces the last build.
[DisallowMultipleComponent]
public sealed class LevelMap : MonoBehaviour
{
    [Serializable]
    public sealed class Options
    {
        public float cell = 1f;
        /// <summary>2D / top-down: the XY plane, BoxCollider2D walls.</summary>
        public bool flat;
        /// <summary>The floor piece under every walkable cell; null draws a plain slab (3D only).</summary>
        public GameObject floor;
        /// <summary>Wall collider height when a piece is lower (3D).</summary>
        public float wallHeight = 1f;
        public float scale = 1f;
        public string name = "Level";
    }

    [Serializable]
    public sealed class Piece
    {
        public GameObject prefab;
        /// <summary>Default: solid when it has a prefab or colour.</summary>
        public bool? solid;
        public Color? color;
        /// <summary>This cell's own floor piece instead of the level's.</summary>
        public GameObject floor;
        public bool noFloor;
        public bool spawn;
        /// <summary>Degrees about the up axis.</summary>
        public float rotate;
        /// <summary>Lift above the floor.</summary>
        public float y;
        public float scale = 1f;
    }

    [Serializable]
    public struct SpawnPoint
    {
        public string letter;
        public Vector3 position;
    }

    public float cell = 1f;
    public bool flat;
    public int width;
    public int height;
    public string[] rows = new string[0];
    /// <summary>World-space extent of every non-void cell.</summary>
    public Bounds bounds;
    public List<SpawnPoint> spawns = new List<SpawnPoint>();
    /// <summary>What the last Build reported (unknown legend characters, bad entries).</summary>
    public List<string> errors = new List<string>();

    /// <summary>The bounds as a Rect on the XY plane, for FollowCamera2D.bounds.</summary>
    public Rect Bounds2D => new Rect(bounds.min.x, bounds.min.y, bounds.size.x, bounds.size.y);

    public List<Vector3> Spawns(char letter) =>
        spawns.Where(spawn => spawn.letter == letter.ToString()).Select(spawn => spawn.position).ToList();

    public Vector3 Spawn(char letter, int index = 0)
    {
        var found = Spawns(letter);
        if (found.Count > index) return found[index];
        Debug.LogError($"LevelMap: no spawn \"{letter}\" #{index}; the map has {string.Join(", ", spawns.Select(spawn => spawn.letter).Distinct())}.");
        return transform.position;
    }

    /// <summary>The map character at a world position; ' ' outside the map.</summary>
    public char At(Vector3 position)
    {
        var local = transform.InverseTransformPoint(position);
        var c = Mathf.FloorToInt(local.x / cell);
        var r = Mathf.FloorToInt((flat ? -local.y : local.z) / cell);
        if (c < 0 || r < 0 || r >= rows.Length || c >= rows[r].Length) return ' ';
        return rows[r][c];
    }

    private struct Entry
    {
        public bool isVoid;
        public bool solid;
        public bool spawn;
        public GameObject prefab;
        public Color? color;
        public GameObject floor;
        public bool noFloor;
        public float rotate;
        public float y;
        public float scale;
    }

    public static LevelMap Build(Transform parent, string[] rows, Dictionary<char, object> legend, Options options = null)
    {
        options ??= new Options();
        var old = parent.Find(options.name);
        if (old != null) DestroyNow(old.gameObject);
        var root = new GameObject(options.name);
        root.transform.SetParent(parent, false);
        var level = root.AddComponent<LevelMap>();
        level.cell = options.cell;
        level.flat = options.flat;
        level.rows = rows.ToArray();
        level.height = rows.Length;
        level.width = rows.Length == 0 ? 0 : rows.Max(row => row.Length);
        var cell = options.cell;
        var pieces = new GameObject("Pieces").transform;
        pieces.SetParent(root.transform, false);
        var unknown = new SortedSet<char>();
        var entries = new Entry[level.height, level.width];
        for (var r = 0; r < level.height; r++)
            for (var c = 0; c < level.width; c++)
            {
                var ch = c < rows[r].Length ? rows[r][c] : ' ';
                entries[r, c] = level.EntryFor(ch, legend, options, unknown);
            }
        if (unknown.Count > 0)
            level.Report($"no legend entry for {string.Join(", ", unknown.Select(ch => $"\"{ch}\""))}; the legend has {string.Join(", ", legend.Keys.Select(ch => $"\"{ch}\""))}");
        var heights = new Dictionary<GameObject, float>();
        var any = false;
        var min = Vector3.zero;
        var max = Vector3.zero;
        for (var r = 0; r < level.height; r++)
            for (var c = 0; c < level.width; c++)
            {
                var entry = entries[r, c];
                if (entry.isVoid) continue;
                var centre = level.Centre(c, r);
                var lo = centre - (options.flat ? new Vector3(cell, cell, 0f) : new Vector3(cell, 0f, cell)) * 0.5f;
                var hi = centre + (options.flat ? new Vector3(cell, cell, 0f) : new Vector3(cell, cell, cell)) * 0.5f;
                min = any ? Vector3.Min(min, lo) : lo;
                max = any ? Vector3.Max(max, hi) : hi;
                any = true;
                var floor = entry.noFloor ? null : entry.floor != null ? entry.floor : options.floor;
                if (floor != null) Place(floor, pieces, centre, 0f, options.scale, 0f, options.flat, true);
                if (entry.prefab != null)
                {
                    var placed = Place(entry.prefab, pieces, centre, entry.rotate, entry.scale * options.scale, entry.y, options.flat, false);
                    if (!heights.ContainsKey(entry.prefab)) heights[entry.prefab] = MeasureHeight(placed, centre, options.flat);
                }
                else if (entry.color.HasValue)
                    Block(pieces, centre, entry.color.Value, cell, options);
                if (entry.spawn) level.spawns.Add(new SpawnPoint { letter = level.rows[r].Length > c ? level.rows[r][c].ToString() : " ", position = root.transform.TransformPoint(centre) });
            }
        level.Colliders(root.transform, entries, heights, options);
        level.bounds = new Bounds(root.transform.TransformPoint((min + max) * 0.5f), Vector3.Scale(max - min, root.transform.lossyScale));
        return level;
    }

    private Vector3 Centre(int c, int r) =>
        flat ? new Vector3((c + 0.5f) * cell, -(r + 0.5f) * cell, 0f) : new Vector3((c + 0.5f) * cell, 0f, (r + 0.5f) * cell);

    private Entry EntryFor(char ch, Dictionary<char, object> legend, Options options, SortedSet<char> unknown)
    {
        var entry = new Entry { scale = 1f };
        if (!legend.TryGetValue(ch, out var raw))
        {
            if (ch == '.') return entry;
            if (ch != ' ') unknown.Add(ch);
            entry.isVoid = true;
            return entry;
        }
        switch (raw)
        {
            case "spawn": entry.spawn = true; return entry;
            case "floor": return entry;
            case "void": entry.isVoid = true; return entry;
            case GameObject prefab: entry.prefab = prefab; entry.solid = true; return entry;
            case Color colour: entry.color = colour; entry.solid = true; return entry;
            case Piece piece:
                entry.prefab = piece.prefab;
                entry.color = piece.color;
                entry.solid = piece.solid ?? (piece.prefab != null || piece.color.HasValue);
                entry.floor = piece.floor;
                entry.noFloor = piece.noFloor;
                entry.spawn = piece.spawn;
                entry.rotate = piece.rotate;
                entry.y = piece.y;
                entry.scale = piece.scale;
                return entry;
            case null:
                Report($"legend \"{ch}\" is null (a prefab that did not load? check its path and run game_import)");
                return entry;
            default:
                Report($"legend \"{ch}\" is a {raw.GetType().Name}; use \"spawn\", \"floor\", \"void\", a GameObject, a Color or a LevelMap.Piece");
                return entry;
        }
    }

    private void Report(string message)
    {
        if (errors.Contains(message)) return;
        errors.Add(message);
        Debug.LogError($"LevelMap: {message}");
    }

    private static GameObject Place(GameObject prefab, Transform parent, Vector3 centre, float rotate, float scale, float y, bool flat, bool isFloor)
    {
        GameObject placed;
#if UNITY_EDITOR
        if (!Application.isPlaying && UnityEditor.PrefabUtility.IsPartOfPrefabAsset(prefab))
            placed = (GameObject)UnityEditor.PrefabUtility.InstantiatePrefab(prefab, parent);
        else
#endif
            placed = Instantiate(prefab, parent);
        var up = flat ? Vector3.forward * -1f : Vector3.up;
        placed.transform.localPosition = centre + (flat ? Vector3.back * y : Vector3.up * y) + (isFloor && flat ? Vector3.forward * 0.5f : Vector3.zero);
        placed.transform.localRotation = Quaternion.AngleAxis(rotate, up) * prefab.transform.localRotation;
        placed.transform.localScale = prefab.transform.localScale * scale;
        MarkStatic(placed);
        return placed;
    }

    private static void Block(Transform parent, Vector3 centre, Color colour, float cell, Options options)
    {
        var block = GameObject.CreatePrimitive(PrimitiveType.Cube);
        block.name = "Block";
        DestroyNow(block.GetComponent<Collider>());
        block.transform.SetParent(parent, false);
        var tall = Mathf.Max(options.wallHeight, cell);
        block.transform.localPosition = options.flat ? centre : centre + Vector3.up * tall * 0.5f;
        block.transform.localScale = options.flat ? new Vector3(cell, cell, cell * 0.2f) : new Vector3(cell, tall, cell);
        var renderer = block.GetComponent<MeshRenderer>();
        var material = new Material(renderer.sharedMaterial) { name = "Block " + ColorUtility.ToHtmlStringRGB(colour) };
        if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", colour);
        else material.color = colour;
        renderer.sharedMaterial = material;
        MarkStatic(block);
    }

    private static float MeasureHeight(GameObject placed, Vector3 centre, bool flat)
    {
        var renderers = placed.GetComponentsInChildren<Renderer>();
        if (renderers.Length == 0) return 0f;
        var box = renderers[0].bounds;
        foreach (var renderer in renderers) box.Encapsulate(renderer.bounds);
        var origin = placed.transform.parent.TransformPoint(centre);
        return flat ? 0f : box.max.y - origin.y;
    }

    /// <summary>Box colliders over runs of one solid character along a row, plus floor slabs (3D).</summary>
    private void Colliders(Transform root, Entry[,] entries, Dictionary<GameObject, float> heights, Options options)
    {
        var walls = new GameObject("Collision").transform;
        walls.SetParent(root, false);
        var plain = new List<(Vector3 centre, float length)>();
        for (var r = 0; r < height; r++)
        {
            var c = 0;
            while (c < width)
            {
                var entry = entries[r, c];
                var ch = c < rows[r].Length ? rows[r][c] : ' ';
                var run = 1;
                while (c + run < width && (c + run < rows[r].Length ? rows[r][c + run] : ' ') == ch) run++;
                if (!entry.isVoid)
                {
                    var mid = flat
                        ? new Vector3((c + run / 2f) * cell, -(r + 0.5f) * cell, 0f)
                        : new Vector3((c + run / 2f) * cell, 0f, (r + 0.5f) * cell);
                    if (!flat)
                    {
                        Box(walls, "Floor", mid + Vector3.down * 0.5f, new Vector3(run * cell, 1f, cell));
                        var hasFloor = !entry.noFloor && (entry.floor != null || options.floor != null);
                        if (!hasFloor) plain.Add((mid, run * cell));
                    }
                    if (entry.solid)
                    {
                        if (flat) Box2D(walls, mid, new Vector2(run * cell, cell));
                        else
                        {
                            var measured = entry.prefab != null && heights.TryGetValue(entry.prefab, out var h) ? h : 0f;
                            var tall = Mathf.Max(options.wallHeight, measured, entry.color.HasValue ? cell : 0f);
                            Box(walls, "Wall", mid + Vector3.up * tall * 0.5f, new Vector3(run * cell, tall, cell));
                        }
                    }
                }
                c += run;
            }
        }
        if (plain.Count == 0) return;
        // A grey slab per row run where no floor piece was given, drawn and lit like the walls.
        var slabs = new GameObject("Floor").transform;
        slabs.SetParent(root, false);
        Material grey = null;
        foreach (var (centre, length) in plain)
        {
            var slab = GameObject.CreatePrimitive(PrimitiveType.Cube);
            slab.name = "Slab";
            DestroyNow(slab.GetComponent<Collider>());
            slab.transform.SetParent(slabs, false);
            slab.transform.localPosition = centre + Vector3.down * 0.05f;
            slab.transform.localScale = new Vector3(length, 0.1f, cell);
            var renderer = slab.GetComponent<MeshRenderer>();
            if (grey == null)
            {
                grey = new Material(renderer.sharedMaterial) { name = "Level floor" };
                var colour = new Color(0.33f, 0.34f, 0.37f);
                if (grey.HasProperty("_BaseColor")) grey.SetColor("_BaseColor", colour);
                else grey.color = colour;
            }
            renderer.sharedMaterial = grey;
            MarkStatic(slab);
        }
    }

    private static void Box(Transform parent, string name, Vector3 centre, Vector3 size)
    {
        var box = new GameObject(name).AddComponent<BoxCollider>();
        box.transform.SetParent(parent, false);
        box.transform.localPosition = centre;
        box.size = size;
        box.gameObject.isStatic = true;
    }

    private static void Box2D(Transform parent, Vector3 centre, Vector2 size)
    {
        var box = new GameObject("Wall").AddComponent<BoxCollider2D>();
        box.transform.SetParent(parent, false);
        box.transform.localPosition = centre;
        box.size = size;
        box.gameObject.isStatic = true;
    }

    private static void MarkStatic(GameObject placed)
    {
        foreach (var child in placed.GetComponentsInChildren<Transform>(true)) child.gameObject.isStatic = true;
    }

    private static void DestroyNow(UnityEngine.Object target)
    {
        if (Application.isPlaying) Destroy(target);
        else DestroyImmediate(target);
    }
}
