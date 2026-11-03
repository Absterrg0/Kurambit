using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Named actions over the Input System, declared in Assets/Scripts/GameControls.cs
/// with keyboard, mouse and gamepad bindings. Gameplay reads actions, never keys,
/// so the gamepad and the player's rebinding (Settings > Controls) always work:
///
///   Vector2 move = Controls.Move();          // move_left/right/up/down; y is up; analog on a stick
///   if (Controls.Pressed("jump")) Jump();    // once per press
///   if (Controls.Down("action")) Charge();   // held
///   if (Controls.Released("alt")) Drop();
///   float turn = Controls.Axis("move_left", "move_right");
///   Hud.Hint("{jump} to jump", () => jumped);   // {action} becomes its current key
///
/// Actions read as idle outside play (title, pause, end screen), so a menu
/// press never reaches the game. Reading an action GameControls does not
/// declare throws, naming the declared ones. "pause" (Esc, P, gamepad Start)
/// belongs to the shell.
/// </summary>
public static class Controls
{
    public const string PauseAction = "pause";
    private static readonly string[] PauseBindings = { "<Keyboard>/escape", "<Keyboard>/p", "<Gamepad>/start" };

    private static InputActionMap map;

    private static InputActionMap Map
    {
        get
        {
            if (map != null) return map;
            map = new InputActionMap("Game");
            foreach (var (name, bindings) in GameControls.Actions)
            {
                if (name == PauseAction) continue;
                var action = map.AddAction(name, InputActionType.Button);
                foreach (var path in bindings) action.AddBinding(path);
            }
            var pause = map.AddAction(PauseAction, InputActionType.Button);
            foreach (var path in PauseBindings) pause.AddBinding(path);
            map.Enable();
            return map;
        }
    }

    /// <summary>Every action in declared order, pause last.</summary>
    public static IEnumerable<string> Names => Map.actions.Select(action => action.name);

    private static bool Live => GameState.IsPlaying;

    internal static InputAction Action(string name)
    {
        var action = Map.FindAction(name);
        if (action == null)
            throw new ArgumentException($"Controls: no action \"{name}\"; GameControls.Actions declares {string.Join(", ", Names)}.");
        return action;
    }

    public static bool Down(string name) => Action(name).IsPressed() && Live;
    public static bool Pressed(string name) => Action(name).WasPressedThisFrame() && Live;
    public static bool Released(string name) => Action(name).WasReleasedThisFrame() && Live;
    /// <summary>0..1, analog on a stick or trigger.</summary>
    public static float Value(string name) => Live ? Action(name).ReadValue<float>() : 0f;
    public static float Axis(string negative, string positive) => Value(positive) - Value(negative);

    /// <summary>The four move actions as one vector: x right, y up, length at most 1.</summary>
    public static Vector2 Move() =>
        Vector2.ClampMagnitude(new Vector2(Axis("move_left", "move_right"), Axis("move_down", "move_up")), 1f);

    internal static bool PausePressed() => Action(PauseAction).WasPressedThisFrame();

    /// <summary>The first key bound to an action ("Space"), for a hint that stays true after a rebind.</summary>
    public static string KeyLabel(string name)
    {
        var action = Map.FindAction(name);
        if (action == null) return name;
        foreach (var binding in action.bindings)
            if (IsKeyboard(binding.effectivePath)) return Label(binding.effectivePath);
        foreach (var binding in action.bindings)
            if (binding.effectivePath.StartsWith("<Mouse>")) return Label(binding.effectivePath);
        return name;
    }

    /// <summary>One action's keyboard and mouse, or gamepad, inputs as the Controls screen shows them.</summary>
    internal static string BindingText(string name, bool keyboard)
    {
        var parts = new List<string>();
        foreach (var binding in Action(name).bindings)
        {
            var path = binding.effectivePath;
            if (string.IsNullOrEmpty(path)) continue;
            var isPad = path.StartsWith("<Gamepad>") || path.StartsWith("<Joystick>");
            if (keyboard != isPad) parts.Add(Label(path));
        }
        return parts.Count > 0 ? string.Join(", ", parts) : "None";
    }

    private static bool IsKeyboard(string path) => path != null && path.StartsWith("<Keyboard>");

    private static readonly Dictionary<string, string> PadNames = new Dictionary<string, string>
    {
        ["buttonSouth"] = "A", ["buttonEast"] = "B", ["buttonWest"] = "X", ["buttonNorth"] = "Y",
        ["start"] = "Start", ["select"] = "Back", ["leftShoulder"] = "LB", ["rightShoulder"] = "RB",
        ["leftTrigger"] = "LT", ["rightTrigger"] = "RT", ["leftStickPress"] = "L3", ["rightStickPress"] = "R3",
        ["leftStick/left"] = "Stick left", ["leftStick/right"] = "Stick right", ["leftStick/up"] = "Stick up", ["leftStick/down"] = "Stick down",
        ["rightStick/left"] = "Right stick left", ["rightStick/right"] = "Right stick right", ["rightStick/up"] = "Right stick up", ["rightStick/down"] = "Right stick down",
        ["dpad/left"] = "D-pad left", ["dpad/right"] = "D-pad right", ["dpad/up"] = "D-pad up", ["dpad/down"] = "D-pad down",
    };

    private static string Label(string path)
    {
        var slash = path.IndexOf('/');
        var control = slash >= 0 ? path.Substring(slash + 1) : path;
        if (path.StartsWith("<Gamepad>") && PadNames.TryGetValue(control, out var pad)) return pad;
        if (path.StartsWith("<Mouse>"))
            return control == "leftButton" ? "Left click" : control == "rightButton" ? "Right click" : control == "middleButton" ? "Middle click" : control;
        return InputControlPath.ToHumanReadableString(path, InputControlPath.HumanReadableStringOptions.OmitDevice);
    }

    // --- rebinding (the Controls screen) ---

    internal static bool Fixed(string name) => name == PauseAction;

    private static int KeyIndex(InputAction action)
    {
        for (var i = 0; i < action.bindings.Count; i++)
            if (IsKeyboard(action.bindings[i].effectivePath)) return i;
        return -1;
    }

    internal static bool CanRebind(string name) => !Fixed(name) && KeyIndex(Action(name)) >= 0;

    /// <summary>
    /// Puts `key` ("&lt;Keyboard&gt;/l") on the action's first key. A key another
    /// action holds moves over in exchange for this one's old key; a key the
    /// pause action holds is refused. Returns the sentence the screen shows.
    /// </summary>
    internal static string Rebind(string name, string key)
    {
        var action = Action(name);
        var index = KeyIndex(action);
        if (index < 0) return $"{Pretty(name)} has no key to change";
        var old = action.bindings[index].effectivePath;
        if (old == key) return $"{Pretty(name)} stays on {Label(key)}";
        foreach (var other in Map.actions)
        {
            for (var i = 0; i < other.bindings.Count; i++)
            {
                if (other.bindings[i].effectivePath != key || (other == action && i == index)) continue;
                if (Fixed(other.name)) return $"{Label(key)} stays on {Pretty(other.name)}";
                other.ApplyBindingOverride(i, old);
                action.ApplyBindingOverride(index, key);
                return other == action
                    ? $"{Pretty(name)}: {Label(key)} first"
                    : $"{Pretty(name)} is now {Label(key)}; {Label(old)} moved to {Pretty(other.name)}";
            }
        }
        action.ApplyBindingOverride(index, key);
        return $"{Pretty(name)} is now {Label(key)}";
    }

    // Saved by action name and binding index: actions built in code get new
    // binding ids every launch, so the Input System's own id-keyed JSON would
    // never match on the next run.
    internal static Dictionary<string, object> SaveOverrides()
    {
        var saved = new Dictionary<string, object>();
        foreach (var action in Map.actions)
        {
            var keys = new Dictionary<string, object>();
            for (var i = 0; i < action.bindings.Count; i++)
                if (action.bindings[i].overridePath != null) keys[i.ToString()] = action.bindings[i].overridePath;
            if (keys.Count > 0) saved[action.name] = keys;
        }
        return saved;
    }

    internal static void LoadOverrides(Dictionary<string, object> saved)
    {
        if (saved == null) return;
        foreach (var entry in saved)
        {
            var action = Map.FindAction(entry.Key);
            if (action == null || Fixed(action.name) || !(entry.Value is Dictionary<string, object> keys)) continue;
            foreach (var key in keys)
            {
                // Only a key over a key: an edited GameControls may have moved its bindings.
                if (int.TryParse(key.Key, out var index) && index < action.bindings.Count && key.Value is string path &&
                    IsKeyboard(path) && IsKeyboard(action.bindings[index].path))
                    action.ApplyBindingOverride(index, path);
            }
        }
    }

    internal static void ResetOverrides() => Map.RemoveAllBindingOverrides();

    /// <summary>"move_left" -> "Move left".</summary>
    internal static string Pretty(string name)
    {
        var words = name.Replace('_', ' ');
        return words.Length == 0 ? words : char.ToUpperInvariant(words[0]) + words.Substring(1);
    }
}
