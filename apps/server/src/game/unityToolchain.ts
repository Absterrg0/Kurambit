// @effect-diagnostics nodeBuiltinImport:off -- Pure path, environment and licence-file helpers for the Unity lane's native boundary.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { UNITY_PINNED_VERSION } from "@kurambit/contracts";
import { engineChildEnv } from "./GameProcesses.ts";

/** Unity's official CLI. Pinned by version and by the linux-x64 hash its manifest published. */
export const UNITY_CLI_VERSION = "1.0.0-beta.15";
export const UNITY_CLI_SHA256 = "cf3ddef260bba536332348bd5570fb80d90a8092784a893b30971f8ebf2a489e";
export const UNITY_CLI_URL = `https://public-cdn.cloud.unity3d.com/hub/prod/cli/${UNITY_CLI_VERSION}/unity-linux-x64`;
/** Windows players need this module; the Linux editor ships Linux Mono player support itself. */
export const UNITY_EXTRA_MODULES = ["windows-mono"] as const;

export const unityPaths = (toolsDirectory: string) => {
  const cliDir = NodePath.join(toolsDirectory, `unity-cli-${UNITY_CLI_VERSION}`);
  const editorRoot = NodePath.join(toolsDirectory, "unity-editor");
  const editorDir = NodePath.join(editorRoot, UNITY_PINNED_VERSION);
  return {
    cliDir,
    cli: NodePath.join(cliDir, "unity"),
    /** The CLI's own state while installing (download cache, hub-style config), off the user's Hub. */
    installHome: NodePath.join(cliDir, "home"),
    editorRoot,
    editorDir,
    editor: NodePath.join(editorDir, "Editor/Unity"),
    linuxPlayer: NodePath.join(editorDir, "Editor/Data/PlaybackEngines/LinuxStandaloneSupport"),
    windowsPlayer: NodePath.join(editorDir, "Editor/Data/PlaybackEngines/WindowsStandaloneSupport"),
  };
};

/** Where the Unity Licensing Client keeps the entitlement Unity Hub activated. */
export const unityLicenseFile = (): string =>
  NodePath.join(NodeOS.homedir(), ".config/unity3d/Unity/licenses/UnityEntitlementLicense.xml");

export type UnityLicense =
  | { readonly kind: "active"; readonly product: string; readonly refreshBy: string | null }
  | { readonly kind: "expired"; readonly product: string; readonly refreshBy: string }
  | { readonly kind: "missing" };

/**
 * Reads the entitlement the Hub wrote. Only the editor entitlement group and
 * its refresh date matter here; the signature is the Licensing Client's
 * business, and an editor that rejects the file still fails loudly at start.
 */
export const parseUnityLicense = (xml: string | null, nowMs: number): UnityLicense => {
  if (xml === null) return { kind: "missing" };
  const group = /<EntitlementGroup\b[^>]*\bType="EDITOR"[^>]*>([\s\S]*?)<\/EntitlementGroup>/.exec(
    xml,
  );
  if (group === null) return { kind: "missing" };
  const product = /\bProduct="([^"]{1,80})"/.exec(group[0])?.[1] ?? "Unity";
  const refreshBy = /<UpdateDate>([^<]{1,40})<\/UpdateDate>/.exec(group[1] ?? "")?.[1] ?? null;
  if (refreshBy !== null) {
    const at = Date.parse(refreshBy);
    if (Number.isFinite(at) && at < nowMs) return { kind: "expired", product, refreshBy };
  }
  return { kind: "active", product, refreshBy };
};

export const unityLicenseMessage = (license: UnityLicense): string =>
  license.kind === "missing"
    ? `No Unity licence is active on this machine (${unityLicenseFile()} is missing or holds no editor entitlement). Open Unity Hub, sign in, and add a Unity Personal licence under Preferences > Licenses.`
    : license.kind === "expired"
      ? `The ${license.product} licence needed a refresh by ${license.refreshBy}. Open Unity Hub and sign in so it renews the licence.`
      : `${license.product} licence active${license.refreshBy === null ? "" : ` (refresh due ${license.refreshBy.slice(0, 10)})`}.`;

/** Lines an editor log carries when the Licensing Client refused it. */
export const UNITY_LICENSE_FAILURE =
  /No valid Unity Editor license found|License is not active|Licensing initialization failed|com\.unity\.editor\.headless was not found|Unity Editor license is not valid/i;

/**
 * The environment every Unity CLI and editor child gets. It keeps the real
 * HOME so the editor reaches the user's Licensing Client and entitlement,
 * never a display variable (a private DISPLAY is added by the caller that
 * owns one), and turns off the CLI's pager, prompts, banners and telemetry.
 */
export const unityChildEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
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
