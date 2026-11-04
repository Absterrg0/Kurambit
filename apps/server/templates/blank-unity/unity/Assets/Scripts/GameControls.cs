// The game's controls: one line per action, with its default keyboard, mouse
// and gamepad bindings as Input System paths. Gameplay reads them through
// Controls (Assets/Kurambit/Shell/Controls.cs); Settings > Controls lists them
// in this order and rebinds their first key. Add the game's own actions here,
// for example ("dash", new[] { "<Keyboard>/l", "<Gamepad>/rightShoulder" }),
// and delete the ones the game never reads, so the Controls screen lists only
// controls that work. "pause" (Esc, P, gamepad Start) is the shell's.
//
// Paths: <Keyboard>/a .. /z, /space, /enter, /leftShift, /leftCtrl, /tab,
// /upArrow, /digit1; <Mouse>/leftButton, /rightButton; <Gamepad>/buttonSouth (A),
// /buttonEast (B), /buttonWest (X), /buttonNorth (Y), /leftShoulder, /rightShoulder,
// /leftTrigger, /rightTrigger, /leftStick/left, /dpad/up.
public static class GameControls
{
    public static readonly (string name, string[] bindings)[] Actions =
    {
        ("move_left", new[] { "<Keyboard>/a", "<Keyboard>/leftArrow", "<Gamepad>/leftStick/left", "<Gamepad>/dpad/left" }),
        ("move_right", new[] { "<Keyboard>/d", "<Keyboard>/rightArrow", "<Gamepad>/leftStick/right", "<Gamepad>/dpad/right" }),
        ("move_up", new[] { "<Keyboard>/w", "<Keyboard>/upArrow", "<Gamepad>/leftStick/up", "<Gamepad>/dpad/up" }),
        ("move_down", new[] { "<Keyboard>/s", "<Keyboard>/downArrow", "<Gamepad>/leftStick/down", "<Gamepad>/dpad/down" }),
        ("jump", new[] { "<Keyboard>/space", "<Gamepad>/buttonSouth" }),
        ("action", new[] { "<Keyboard>/j", "<Keyboard>/enter", "<Mouse>/leftButton", "<Gamepad>/buttonWest" }),
        ("alt", new[] { "<Keyboard>/k", "<Keyboard>/leftShift", "<Gamepad>/buttonEast" }),
    };
}
