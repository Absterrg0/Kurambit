using UnityEngine;
using UnityEngine.Events;
using UnityEngine.UI;

/// <summary>
/// The look of the demo shell and the HUD, in one place: restyle the game by
/// changing these values to match its key art. A font at Assets/UI/font.ttf
/// (or .otf) replaces the built-in one; Assets/UI/title_bg.png goes behind the
/// title. Screens are built in code by Shell.cs, so there is no scene YAML to edit.
/// </summary>
public static class ShellTheme
{
    public static Color Backdrop = new Color(0.06f, 0.07f, 0.10f, 1f);
    public static Color BackdropTop = new Color(0.16f, 0.20f, 0.30f, 1f);
    /// <summary>Behind pause, settings, controls, credits and end screens.</summary>
    public static Color Dim = new Color(0f, 0f, 0f, 0.72f);
    /// <summary>Darkens the title art so the buttons read over a bright picture.</summary>
    public static Color TitleArtTint = new Color(0.55f, 0.55f, 0.6f, 1f);
    public static Color Text = new Color(0.95f, 0.95f, 0.97f, 1f);
    public static Color MutedText = new Color(0.72f, 0.74f, 0.80f, 1f);
    public static Color Button = new Color(0.20f, 0.23f, 0.31f, 0.95f);
    /// <summary>The selected button (keys, gamepad).</summary>
    public static Color ButtonHighlight = new Color(0.98f, 0.73f, 0.27f, 1f);
    /// <summary>A button under the mouse that is not selected.</summary>
    public static Color ButtonHover = new Color(0.30f, 0.34f, 0.45f, 0.98f);
    public static Color ButtonPressed = new Color(0.85f, 0.55f, 0.15f, 1f);
    public static Color ButtonDisabled = new Color(0.20f, 0.22f, 0.26f, 0.6f);
    public static Color Win = new Color(0.55f, 0.92f, 0.55f, 1f);
    public static Color Lose = new Color(1f, 0.48f, 0.42f, 1f);
    public static Color Accent = new Color(1f, 0.79f, 0.3f, 1f);
    public static Color Heart = new Color(1f, 0.48f, 0.42f, 1f);
    public static Color Panel = new Color(0f, 0f, 0f, 0.42f);

    public static int TitleSize = 64;
    public static int HeadingSize = 40;
    public static int ButtonSize = 24;
    public static int BodySize = 20;
    public static int HudSize = 22;
    public static int ToastSize = 34;
    public static Vector2 ButtonBox = new Vector2(320, 46);

    private static Font font;

    /// <summary>Assets/UI/font.ttf when the game has one, else Unity's built-in runtime font.</summary>
    public static Font Font
    {
        get
        {
            if (font != null) return font;
            var art = ShellAssets.Load();
            font = art != null && art.font != null ? art.font : Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            return font;
        }
    }
}

/// <summary>uGUI built in code for the shell and the HUD: legacy Text, which always has a font.</summary>
internal static class Ui
{
    public static RectTransform Rect(string name, Transform parent)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.layer = 5;
        var rect = (RectTransform)go.transform;
        rect.SetParent(parent, false);
        return rect;
    }

    public static RectTransform Fill(RectTransform rect)
    {
        rect.anchorMin = Vector2.zero;
        rect.anchorMax = Vector2.one;
        rect.offsetMin = Vector2.zero;
        rect.offsetMax = Vector2.zero;
        return rect;
    }

    public static Image Image(Transform parent, string name, Color color, bool raycast = false)
    {
        var image = Rect(name, parent).gameObject.AddComponent<Image>();
        image.color = color;
        image.raycastTarget = raycast;
        return image;
    }

    public static Text Label(Transform parent, string name, string text, int size, TextAnchor align = TextAnchor.MiddleCenter, Color? color = null)
    {
        var label = Rect(name, parent).gameObject.AddComponent<Text>();
        label.font = ShellTheme.Font;
        label.fontSize = size;
        label.alignment = align;
        label.color = color ?? ShellTheme.Text;
        label.horizontalOverflow = HorizontalWrapMode.Wrap;
        label.verticalOverflow = VerticalWrapMode.Overflow;
        label.raycastTarget = false;
        label.text = text;
        return label;
    }

    /// <summary>A text with a dark outline, for HUD text over any scene.</summary>
    public static Text OutlinedLabel(Transform parent, string name, int size, TextAnchor align)
    {
        var label = Label(parent, name, "", size, align);
        var outline = label.gameObject.AddComponent<Outline>();
        outline.effectColor = new Color(0f, 0f, 0f, 0.85f);
        outline.effectDistance = new Vector2(1.5f, -1.5f);
        return label;
    }

    public static VerticalLayoutGroup Column(RectTransform rect, float spacing, TextAnchor align = TextAnchor.MiddleCenter)
    {
        var column = rect.gameObject.AddComponent<VerticalLayoutGroup>();
        column.spacing = spacing;
        column.childAlignment = align;
        column.childControlWidth = false;
        column.childControlHeight = false;
        column.childForceExpandWidth = false;
        column.childForceExpandHeight = false;
        return column;
    }

    public static LayoutElement Size(Component component, float width, float height)
    {
        var rect = (RectTransform)component.transform;
        rect.sizeDelta = new Vector2(width, height);
        var element = component.gameObject.GetComponent<LayoutElement>();
        if (element == null) element = component.gameObject.AddComponent<LayoutElement>();
        element.preferredWidth = width;
        element.preferredHeight = height;
        return element;
    }

    public static Button Button(Transform parent, string name, string text, UnityAction onClick, Vector2? box = null, int? size = null)
    {
        var background = Image(parent, name, Color.white, true);
        var button = background.gameObject.AddComponent<Button>();
        button.targetGraphic = background;
        button.colors = new ColorBlock
        {
            normalColor = ShellTheme.Button,
            highlightedColor = ShellTheme.ButtonHover,
            selectedColor = ShellTheme.ButtonHighlight,
            pressedColor = ShellTheme.ButtonPressed,
            disabledColor = ShellTheme.ButtonDisabled,
            colorMultiplier = 1f,
            fadeDuration = 0.08f,
        };
        var label = Label(background.transform, "Label", text, size ?? ShellTheme.ButtonSize);
        Fill(label.rectTransform);
        var selected = label.gameObject.AddComponent<SelectedText>();
        selected.owner = button;
        Size(button, (box ?? ShellTheme.ButtonBox).x, (box ?? ShellTheme.ButtonBox).y);
        button.onClick.AddListener(Shell.Click);
        if (onClick != null) button.onClick.AddListener(onClick);
        return button;
    }

    public static Slider Slider(Transform parent, string name, UnityAction<float> onChange)
    {
        var root = Rect(name, parent);
        var slider = root.gameObject.AddComponent<Slider>();
        var track = Image(root, "Track", ShellTheme.Button);
        var trackRect = Fill(track.rectTransform);
        trackRect.anchorMin = new Vector2(0f, 0.4f);
        trackRect.anchorMax = new Vector2(1f, 0.6f);
        // The slider resets its fill's anchors, so the track's height is the fill area's.
        var fillArea = Fill(Rect("Fill Area", root));
        fillArea.anchorMin = new Vector2(0f, 0.4f);
        fillArea.anchorMax = new Vector2(1f, 0.6f);
        var fill = Image(fillArea, "Fill", ShellTheme.Accent);
        var fillRect = Fill(fill.rectTransform);
        var handleArea = Fill(Rect("Handle Area", root));
        handleArea.offsetMin = new Vector2(10f, 0f);
        handleArea.offsetMax = new Vector2(-10f, 0f);
        var handle = Image(handleArea, "Handle", Color.white, true);
        handle.rectTransform.sizeDelta = new Vector2(20f, 0f);
        slider.fillRect = fillRect;
        slider.handleRect = handle.rectTransform;
        slider.targetGraphic = handle;
        slider.colors = new ColorBlock
        {
            normalColor = ShellTheme.MutedText,
            highlightedColor = ShellTheme.ButtonHighlight,
            selectedColor = ShellTheme.ButtonHighlight,
            pressedColor = ShellTheme.ButtonPressed,
            disabledColor = ShellTheme.ButtonDisabled,
            colorMultiplier = 1f,
            fadeDuration = 0.08f,
        };
        slider.minValue = 0f;
        slider.maxValue = 1f;
        slider.onValueChanged.AddListener(onChange);
        return slider;
    }

    /// <summary>A screen-filling layer under the shell canvas, hidden until shown.</summary>
    public static RectTransform Screen(Transform canvas, string name, Color background)
    {
        var rect = Fill(Rect(name, canvas));
        var image = rect.gameObject.AddComponent<Image>();
        image.color = background;
        image.raycastTarget = true;
        Column(rect, 14f);
        rect.gameObject.SetActive(false);
        return rect;
    }

    /// <summary>A label that ignores the screen's layout, anchored to a corner or edge.</summary>
    public static Text Pinned(Transform parent, string name, string text, int size, Vector2 anchor, Vector2 offset)
    {
        var label = Label(parent, name, text, size, TextAnchor.MiddleCenter, ShellTheme.MutedText);
        var rect = label.rectTransform;
        rect.anchorMin = anchor;
        rect.anchorMax = anchor;
        rect.pivot = anchor;
        rect.anchoredPosition = offset;
        rect.sizeDelta = new Vector2(900f, 40f);
        label.gameObject.AddComponent<LayoutElement>().ignoreLayout = true;
        return label;
    }
}

/// <summary>Dark label text on a highlighted (selected) button, light otherwise.</summary>
internal sealed class SelectedText : MonoBehaviour
{
    public Button owner;
    private Text label;
    private bool dark;

    private void Awake() => label = GetComponent<Text>();

    private void LateUpdate()
    {
        var system = UnityEngine.EventSystems.EventSystem.current;
        var want = owner != null && owner.interactable && system != null && system.currentSelectedGameObject == owner.gameObject;
        if (want == dark) return;
        dark = want;
        label.color = want ? ShellTheme.Backdrop : ShellTheme.Text;
    }
}
