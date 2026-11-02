/**
 * Godot's Windows Desktop preset, added to a game that predates it without
 * rewriting any preset the creator wrote. Godot's export_presets.cfg is a
 * ConfigFile: sections and keys we do not touch are copied through byte for
 * byte, which is what keeps user-chosen filters and options intact.
 */
const WINDOWS_PLATFORM = "Windows Desktop";

export interface WindowsPresetPlan {
  readonly ok: true;
  readonly name: string;
  /** Full replacement text when the preset had to be added; null when it already exists. */
  readonly text: string | null;
  readonly embeddedPck: boolean;
}

export interface WindowsPresetConflict {
  readonly ok: false;
  readonly detail: string;
}

interface PresetSection {
  readonly kind: "preset" | "options";
  readonly index: number;
  readonly name: string;
  readonly platform: string;
  readonly options: ReadonlyMap<string, string>;
}

const sectionPattern = /^\[preset\.(\d+)(\.options)?\]\s*$/;
const settingPattern = /^([A-Za-z0-9_/]+)\s*=\s*(.*)$/;

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let result = "";
  for (let index = 1; index < trimmed.length; index++) {
    const character = trimmed[index]!;
    if (character === "\\" && index + 1 < trimmed.length) {
      result += trimmed[++index]!;
      continue;
    }
    if (character === '"') return result;
    result += character;
  }
  return result;
};

const parseSections = (text: string): PresetSection[] => {
  const sections: PresetSection[] = [];
  interface ParsedSection {
    kind: "preset" | "options";
    index: number;
    name: string;
    platform: string;
    options: Map<string, string>;
  }
  let current: ParsedSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = sectionPattern.exec(line);
    if (header !== null) {
      const index = Number(header[1]);
      if (header[2] === ".options") {
        // Options belong to the preset block immediately before them.
        if (current !== null && current.index === index) continue;
        const options = new Map<string, string>();
        current = { kind: "options", index, name: "", platform: "", options };
        sections.push(current);
      } else {
        current = { kind: "preset", index, name: "", platform: "", options: new Map() };
        sections.push(current);
      }
      continue;
    }
    if (current === null) continue;
    const setting = settingPattern.exec(line);
    if (setting === null) continue;
    const value = unquote(setting[2]!);
    if (setting[1] === "name") current.name = value;
    else if (setting[1] === "platform") current.platform = value;
    current.options.set(setting[1]!, value);
  }
  return sections;
};

const presetText = (index: number, name: string): string =>
  [
    `[preset.${index}]`,
    `name=${JSON.stringify(name)}`,
    `platform=${JSON.stringify(WINDOWS_PLATFORM)}`,
    "runnable=true",
    "advanced_options=false",
    "dedicated_server=false",
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter="tests/*,tools/*"',
    'export_path="../builds/windows/game.exe"',
    'encryption_include_filters=""',
    'encryption_exclude_filters=""',
    "encrypt_pck=false",
    "encrypt_directory=false",
    "",
    `[preset.${index}.options]`,
    'custom_template/debug=""',
    'custom_template/release=""',
    // Release exports need no console wrapper. Disabling resource rewriting
    // keeps the template's PE headers untouched on a Linux host.
    "debug/export_console_wrapper=0",
    "binary_format/embed_pck=true",
    "texture_format/s3tc_bptc=true",
    "texture_format/etc2_astc=false",
    'binary_format/architecture="x86_64"',
    "codesign/enable=false",
    "application/modify_resources=false",
    "ssh_remote_deploy/enabled=false",
  ].join("\n");

/**
 * Chooses the preset `--export-release` should name. A creator's existing
 * Windows Desktop preset is reused exactly as written. Anything ambiguous or
 * incompatible becomes an actionable error instead of a silent settings edit.
 */
export const planWindowsPreset = (
  existing: string | null,
): WindowsPresetPlan | WindowsPresetConflict => {
  const text = existing ?? "";
  const sections = parseSections(text);
  const presets = sections.filter((section) => section.name !== "");
  const windows = presets.filter((section) => section.platform === WINDOWS_PLATFORM);
  if (windows.length > 1) {
    const names = windows.map((section) => `"${section.name}"`).join(", ");
    return {
      ok: false,
      detail: `This game has ${windows.length} Windows Desktop export presets (${names}). Keep one and remove the others, then export Windows again. Kurambit does not guess which preset to use.`,
    };
  }
  const reuse = windows[0];
  if (reuse !== undefined) {
    const architecture = reuse.options.get("binary_format/architecture") ?? "x86_64";
    if (architecture !== "x86_64")
      return {
        ok: false,
        detail: `The game's Windows Desktop preset "${reuse.name}" exports ${architecture}, not x86_64. Change its architecture to x86_64, or remove the preset and export Windows again to add a standard one. Its other settings were left untouched.`,
      };
    const sameName = presets.filter((section) => section.name === reuse.name);
    if (sameName.length > 1)
      return {
        ok: false,
        detail: `More than one export preset is named "${reuse.name}". Rename or remove the duplicate, then export Windows again; a name Godot resolves ambiguously cannot be exported safely.`,
      };
    return {
      ok: true,
      name: reuse.name,
      text: null,
      embeddedPck: reuse.options.get("binary_format/embed_pck") === "true",
    };
  }
  const used = new Set(presets.map((section) => section.name));
  const name = ["Windows", "Windows Desktop", "Windows Desktop 2", "Windows Desktop 3"].find(
    (candidate) => !used.has(candidate),
  );
  if (name === undefined)
    return {
      ok: false,
      detail:
        "Every conventional Windows preset name is already used by another platform. Rename one of those presets, then export Windows again.",
    };
  const usedIndices = new Set(
    sections.filter((section) => section.kind === "preset").map((section) => section.index),
  );
  // Godot stops reading presets at the first missing index (`editor_export.cpp`
  // walks preset.0, preset.1, ... until one is absent), so fill a gap rather
  // than append after it.
  let index = 0;
  while (usedIndices.has(index)) index++;
  if (sections.some((section) => section.kind === "options" && section.index === index))
    return {
      ok: false,
      detail: `export_presets.cfg has options for preset ${index} but no preset ${index}. Remove that [preset.${index}.options] block or restore the preset, then export Windows again.`,
    };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" ? "" : text.endsWith("\n") ? eol : eol + eol;
  return {
    ok: true,
    name,
    text: `${text}${separator}${presetText(index, name)}${eol}`,
    embeddedPck: true,
  };
};
