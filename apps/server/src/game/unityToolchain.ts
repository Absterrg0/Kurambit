// @effect-diagnostics nodeBuiltinImport:off -- Pure path, environment and licence-file helpers for the Unity lane's native boundary.
import * as NodePath from "node:path";
import { UNITY_MIN_VERSION } from "@kurambit/contracts";
import { engineChildEnv } from "./GameProcesses.ts";
import { HOST_OS } from "./processHost.ts";
import { UNITY_CLI_VERSION } from "./plumbingBuilds.ts";

export const UNITY_DOWNLOAD_URL = "https://unity.com/download";

/**
 * Where Unity's official CLI lives once Kurambit fetched it (see
 * plumbingBuilds): harness plumbing, the live editor's MCP bridge, not the editor.
 */
export const unityCliPaths = (toolsDirectory: string, platform: Platform) => {
  const cliDir = NodePath.join(toolsDirectory, `unity-cli-${UNITY_CLI_VERSION}`);
  return {
    cliDir,
    cli: NodePath.join(cliDir, platform === "win32" ? "unity.exe" : "unity"),
    /** The CLI's own HOME for every call (logs, hub-style config), off the user's Hub. */
    installHome: NodePath.join(cliDir, "home"),
  };
};

/** Where an earlier Kurambit installed editors itself; still detected so those installs keep working. */
export const legacyUnityEditorRoot = (toolsDirectory: string) =>
  NodePath.join(toolsDirectory, "unity-editor");

type Platform = "linux" | "darwin" | "win32";

/** The editor executable inside a Hub-style `<root>/<version>` folder. */
export const unityEditorExecutable = (versionDir: string, platform: Platform): string =>
  platform === "darwin"
    ? NodePath.join(versionDir, "Unity.app/Contents/MacOS/Unity")
    : NodePath.join(versionDir, "Editor", platform === "win32" ? "Unity.exe" : "Unity");

/** The version folder an editor executable lives in; its workers and Bee run from inside it. */
export const unityEditorDir = (editor: string): string =>
  /[\\/]Unity\.app[\\/]Contents[\\/]MacOS[\\/]Unity$/.test(editor)
    ? NodePath.resolve(editor, "../../../..")
    : NodePath.dirname(NodePath.dirname(editor));

/** The Windows Mono player a Windows build needs; the Hub's "Windows Build Support (Mono)" module. */
export const unityWindowsSupport = (editorDir: string, platform: Platform): string =>
  platform === "darwin"
    ? NodePath.join(editorDir, "PlaybackEngines/WindowsStandaloneSupport")
    : NodePath.join(editorDir, "Editor/Data/PlaybackEngines/WindowsStandaloneSupport");

/**
 * Unity Hub's default editor folder and the file naming the user's other
 * install folder (Hub > Preferences > Installs). Kurambit only reads these.
 */
export const unityHubLocations = (
  platform: Platform,
  home: string,
  appData: string | undefined,
): { readonly editors: string; readonly secondaryInstallPathFile: string } =>
  platform === "darwin"
    ? {
        editors: "/Applications/Unity/Hub/Editor",
        secondaryInstallPathFile: NodePath.join(
          home,
          "Library/Application Support/UnityHub/secondaryInstallPath.json",
        ),
      }
    : platform === "win32"
      ? {
          editors: "C:\\Program Files\\Unity\\Hub\\Editor",
          secondaryInstallPathFile: NodePath.join(
            appData ?? NodePath.join(home, "AppData/Roaming"),
            "UnityHub/secondaryInstallPath.json",
          ),
        }
      : {
          editors: NodePath.join(home, "Unity/Hub/Editor"),
          secondaryInstallPathFile: NodePath.join(
            home,
            ".config/UnityHub/secondaryInstallPath.json",
          ),
        };

/** Hub writes the folder as a JSON string, empty when the user never set one. */
export const parseSecondaryInstallPath = (text: string | null): string | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
};

export interface UnityVersion {
  readonly text: string;
  readonly parts: readonly [number, number, number, number, number];
}

const STREAMS = { a: 0, b: 1, f: 2, p: 3 } as const;

/** `6000.6.7f1` and the like; alpha, beta, final and patch streams order in that sequence. */
export const parseUnityVersion = (text: string): UnityVersion | null => {
  const match = /^(\d{4})\.(\d+)\.(\d+)([abfp])(\d+)/.exec(text.trim());
  if (match === null) return null;
  return {
    text: match[0],
    parts: [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      STREAMS[match[4] as keyof typeof STREAMS],
      Number(match[5]),
    ],
  };
};

export const compareUnityVersions = (a: UnityVersion, b: UnityVersion): number => {
  for (let index = 0; index < a.parts.length; index++) {
    const difference = a.parts[index]! - b.parts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
};

const MIN_VERSION = parseUnityVersion(UNITY_MIN_VERSION)!;

/** Unity 6 (6000.x) at or above the version the blank template was authored with. */
export const supportedUnityVersion = (version: UnityVersion): boolean =>
  version.parts[0] === MIN_VERSION.parts[0] && compareUnityVersions(version, MIN_VERSION) >= 0;

/**
 * An editor's version, read from the Hub-style folder it sits in: Kurambit
 * never starts Unity just to ask.
 */
export const unityVersionFromPath = (editor: string): UnityVersion | null => {
  const segments = unityEditorDir(editor).split(/[\\/]/).toReversed();
  for (const segment of segments) {
    const version = parseUnityVersion(segment);
    if (version !== null && version.text === segment) return version;
  }
  return null;
};

/** `m_EditorVersion` of a Unity project's ProjectSettings/ProjectVersion.txt. */
export const projectEditorVersion = (text: string | null): UnityVersion | null => {
  const line = text === null ? undefined : /^m_EditorVersion:\s*(\S+)/m.exec(text)?.[1];
  return line === undefined ? null : parseUnityVersion(line);
};

export interface UnityEditorCandidate<Source extends string = string> {
  readonly editor: string;
  readonly source: Source;
  readonly version: UnityVersion | null;
}

export type UnityEditorChoice<C extends UnityEditorCandidate> =
  | {
      readonly kind: "picked";
      readonly candidate: C;
      readonly upgradesProject: UnityVersion | null;
    }
  | { readonly kind: "unsupported"; readonly candidate: C }
  | { readonly kind: "unknown-version"; readonly candidate: C }
  /** Every usable editor is older than the project: opening would downgrade it. */
  | { readonly kind: "older-than-project"; readonly candidate: C; readonly project: UnityVersion }
  | { readonly kind: "none" };

/**
 * The editor a game opens with. The game's own editor version when that one
 * is installed, so a user's project is never upgraded behind their back;
 * otherwise the newest supported editor, reporting the upgrade it implies.
 * An explicit path (settings or env) is the only candidate when present.
 */
export const pickUnityEditor = <C extends UnityEditorCandidate>(
  candidates: ReadonlyArray<C>,
  project: UnityVersion | null,
): UnityEditorChoice<C> => {
  const explicit = candidates.find(
    (candidate) => candidate.source === "settings" || candidate.source === "env",
  );
  const pool = explicit === undefined ? candidates : [explicit];
  const supported = pool
    .filter((candidate) => candidate.version !== null && supportedUnityVersion(candidate.version))
    .toSorted((a, b) => compareUnityVersions(b.version!, a.version!));
  const exact =
    project === null
      ? undefined
      : supported.find((candidate) => compareUnityVersions(candidate.version!, project) === 0);
  const chosen = exact ?? supported[0];
  if (
    chosen !== undefined &&
    project !== null &&
    compareUnityVersions(chosen.version!, project) < 0
  )
    return { kind: "older-than-project", candidate: chosen, project };
  if (chosen !== undefined)
    return {
      kind: "picked",
      candidate: chosen,
      upgradesProject:
        project !== null && compareUnityVersions(chosen.version!, project) > 0 ? project : null,
    };
  const first = pool[0];
  if (first === undefined) return { kind: "none" };
  return first.version === null && pool.every((candidate) => candidate.version === null)
    ? { kind: "unknown-version", candidate: first }
    : { kind: "unsupported", candidate: pool.find((candidate) => candidate.version !== null)! };
};

/**
 * Where Unity keeps a licence, per OS, as Unity's activation FAQ lists them:
 * the named-user entitlement the Hub activates, and a serial licence file.
 */
export const unityLicenseFiles = (
  platform: NodeJS.Platform,
  env: { readonly LOCALAPPDATA?: string | undefined; readonly PROGRAMDATA?: string | undefined },
  home: string,
): { readonly entitlement: string; readonly serial: string } => {
  if (platform === "win32") {
    const join = NodePath.win32.join;
    return {
      entitlement: join(
        env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        "Unity",
        "licenses",
        "UnityEntitlementLicense.xml",
      ),
      serial: join(env.PROGRAMDATA ?? "C:\\ProgramData", "Unity", "Unity_lic.ulf"),
    };
  }
  const join = NodePath.posix.join;
  return platform === "darwin"
    ? {
        entitlement: join(home, "Library/Unity/licenses/UnityEntitlementLicense.xml"),
        serial: "/Library/Application Support/Unity/Unity_lic.ulf",
      }
    : {
        entitlement: join(home, ".config/unity3d/Unity/licenses/UnityEntitlementLicense.xml"),
        serial: join(home, ".local/share/unity3d/Unity/Unity_lic.ulf"),
      };
};

export type UnityLicense =
  | { readonly kind: "active"; readonly product: string; readonly refreshBy: string | null }
  | { readonly kind: "expired"; readonly product: string; readonly refreshBy: string }
  | { readonly kind: "missing" };

/**
 * Reads the entitlement the Hub wrote. Only the editor entitlement group and
 * its refresh date matter here; the signature is the Licensing Client's
 * business, and an editor that rejects the file still fails loudly at start.
 */
export const parseUnityLicense = (
  xml: string | null,
  nowMs: number,
  /** A serial licence file is there: the editor reads it itself, and fails loudly if it is bad. */
  serial = false,
): UnityLicense => {
  const missing: UnityLicense = serial
    ? { kind: "active", product: "Unity (serial licence)", refreshBy: null }
    : { kind: "missing" };
  if (xml === null) return missing;
  const group = /<EntitlementGroup\b[^>]*\bType="EDITOR"[^>]*>([\s\S]*?)<\/EntitlementGroup>/.exec(
    xml,
  );
  if (group === null) return missing;
  const product = /\bProduct="([^"]{1,80})"/.exec(group[0])?.[1] ?? "Unity";
  const refreshBy = /<UpdateDate>([^<]{1,40})<\/UpdateDate>/.exec(group[1] ?? "")?.[1] ?? null;
  if (refreshBy !== null) {
    const at = Date.parse(refreshBy);
    if (Number.isFinite(at) && at < nowMs) return { kind: "expired", product, refreshBy };
  }
  return { kind: "active", product, refreshBy };
};

export const unityLicenseMessage = (license: UnityLicense, file: string): string =>
  license.kind === "missing"
    ? `No Unity licence is active on this machine (${file} is missing or holds no editor entitlement). Open Unity Hub, sign in, and add a Unity Personal licence under Preferences > Licenses.`
    : license.kind === "expired"
      ? `The ${license.product} licence needed a refresh by ${license.refreshBy}. Open Unity Hub and sign in so it renews the licence.`
      : `${license.product} licence active${license.refreshBy === null ? "" : ` (refresh due ${license.refreshBy.slice(0, 10)})`}.`;

/** Lines an editor log carries when the Licensing Client refused it. */
export const UNITY_LICENSE_FAILURE =
  /No valid Unity Editor license found|License is not active|Licensing initialization failed|com\.unity\.editor\.headless was not found|Unity Editor license is not valid/i;

const unityBaseEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  engineChildEnv({
    TERM: "dumb",
    NO_COLOR: "1",
    UNITY_NO_PAGER: "1",
    UNITY_NO_BANNER: "1",
    UNITY_NON_INTERACTIVE: "1",
    UNITY_NO_CRASH_REPORT: "1",
    UNITY_NO_CLI_INVOKED_TELEMETRY: "1",
    UNITY_NO_UPDATE_CHECK: "1",
    UNITY_NO_AGENT_HINTS: "1",
    UNITY_NO_CONSENT_PROMPT: "1",
    UNITY_NO_CLOUD: "1",
    DO_NOT_TRACK: "1",
    ...extra,
  });

/**
 * The editor keeps the real HOME so it reaches the user's Licensing Client
 * and entitlement. Never a display variable: a private DISPLAY is added by
 * the caller that owns one.
 */
export const unityEditorEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => unityBaseEnv(extra);

/**
 * Every Unity CLI call runs under Kurambit's own HOME and XDG dirs: the CLI
 * logs each invocation with its full arguments (C# eval code, project paths)
 * to ~/.config/unityhub/logs/cli-log.json and keeps Hub-style config there.
 * It finds a live editor through the project's Library/Pipeline port file,
 * so the user's HOME is never needed to reach it.
 */
export const unityCliEnv = (home: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  unityBaseEnv({
    HOME: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_STATE_HOME: NodePath.join(home, ".local/state"),
    // Windows apps keep their config and logs under these, not HOME
    // (unverified for the CLI: it is Hub-style, so it likely logs there).
    ...(HOST_OS === "win32"
      ? {
          USERPROFILE: home,
          APPDATA: NodePath.join(home, "AppData", "Roaming"),
          LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
        }
      : {}),
    ...extra,
  });

/** Unity Licensing Client binaries, whoever started them, are never signalled. */
export const isUnityLicensingClient = (exe: string): boolean =>
  /(^|[\\/])Unity\.Licensing\.|[\\/]Licensing[\\/]Client[\\/]/i.test(exe);
