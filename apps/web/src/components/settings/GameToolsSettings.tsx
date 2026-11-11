import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  BoxIcon,
  FilmIcon,
  FolderIcon,
  Gamepad2Icon,
  KeyRoundIcon,
  PersonStandingIcon,
  TerminalIcon,
} from "lucide-react";
import {
  isEngineToolActive,
  type EnvironmentId,
  type GameToolchainChangeInput,
  type GameToolStatus,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { gameEnvironment } from "../../state/game";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { GAME_TOOL_NAMES, GameToolLink } from "../game/GameToolLink";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { Text } from "../ui/text";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TOOL_PURPOSE = {
  godot: "The engine for native games: Godot 4.7.x with its export templates.",
  unity:
    "The engine for Unity games: a Unity 6 editor from Unity Hub (6000.6.7f1 or later) with Windows Build Support (Mono), and a Unity licence.",
  blender: "Models, rigs and renders game art. Blender 4.2 or later.",
  uv: "Runs the live Blender view's helper. Kurambit fetches it itself when it is not installed.",
  mpfb: "MPFB2 2.0.18 makes human bodies for characters built in Blender. Its code is GPL-3.0 and is downloaded from extensions.blender.org (46 MB) into Kurambit's own Blender sessions, never your Blender settings; the bodies it makes are CC0. Without it, characters use library bodies.",
  ffmpeg:
    "Records each bot play. A build's play facts and Keep going are read from these recordings; without ffmpeg a build is only checked for booting.",
} as const satisfies Record<GameToolStatus["tool"], string>;

const TOOL_ICONS = {
  godot: Gamepad2Icon,
  unity: Gamepad2Icon,
  blender: BoxIcon,
  uv: TerminalIcon,
  mpfb: PersonStandingIcon,
  ffmpeg: FilmIcon,
} as const satisfies Record<GameToolStatus["tool"], unknown>;

const SOURCE_LABELS = {
  settings: "path set here",
  env: "environment variable",
  "unity-hub": "Unity Hub",
  kurambit: "Kurambit's tools folder",
  path: "PATH",
} as const satisfies Record<NonNullable<GameToolStatus["source"]>, string>;

const STATUS_BADGES = {
  ready: { variant: "success", label: "Ready" },
  warning: { variant: "warning", label: "Needs attention" },
  error: { variant: "error", label: "Not ready" },
} as const;

// The tools only the person installs and removes, here: the agent cannot.
const INSTALLABLE: ReadonlySet<GameToolStatus["tool"]> = new Set<GameToolchainChangeInput["tool"]>([
  "mpfb",
]);

// A parked engine's tool is not looked for, so its path is not asked for.
const PATH_ROWS = [
  { key: "gameGodotPath", title: "Godot executable", shown: isEngineToolActive("godot") },
  { key: "gameUnityPath", title: "Unity editor", shown: isEngineToolActive("unity") },
  { key: "gameBlenderPath", title: "Blender executable", shown: true },
] as const;
type PathKey = (typeof PATH_ROWS)[number]["key"];

export function GameToolsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const query = useEnvironmentQuery(gameEnvironment.toolchain({ environmentId, input: {} }));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [paths, setPaths] = useState<Partial<Record<PathKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savePaths = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    // A promise chain, not try/finally: React Compiler skips a component whose
    // handler has a finally clause.
    await update({ environmentId, input: { patch: paths } })
      .then((saved) => {
        if (saved._tag === "Failure") setError(String(squashAtomCommandFailure(saved)));
        else setPaths({});
      })
      .finally(() => {
        setSaving(false);
        query.refresh();
      });
  };
  return (
    <SettingsSection id="game-tools" title="Game tools">
      {query.data?.tools.map((tool) => {
        const badge = STATUS_BADGES[tool.status];
        const ToolIcon = TOOL_ICONS[tool.tool];
        return (
          <SettingsRow
            key={tool.tool}
            icon={<ToolIcon />}
            title={GAME_TOOL_NAMES[tool.tool]}
            description={TOOL_PURPOSE[tool.tool]}
            status={
              <Badge variant={badge.variant} size="sm">
                {badge.label}
              </Badge>
            }
          >
            <div className="flex min-w-0 flex-col gap-1 break-words ps-7">
              {tool.path === null ? null : (
                <Text variant="meta" mono render={<p />}>
                  {tool.path}
                  {tool.version === null ? "" : ` · ${tool.version}`}
                  {tool.source === null ? "" : ` · ${SOURCE_LABELS[tool.source]}`}
                </Text>
              )}
              {tool.installed || tool.status === "ready" ? (
                <Text variant="meta" tone="muted" render={<p className="whitespace-pre-wrap" />}>
                  {tool.message}
                </Text>
              ) : (
                <Text variant="meta" tone="muted" render={<details />}>
                  <summary className="cursor-pointer">Not installed · Details</summary>
                  <p className="mt-1 whitespace-pre-wrap">{tool.message}</p>
                </Text>
              )}
              {INSTALLABLE.has(tool.tool) ? (
                <GameToolChange
                  environmentId={environmentId}
                  tool={tool}
                  onChanged={() => query.refresh()}
                />
              ) : null}
              {tool.status === "ready" ? null : (
                <div>
                  <GameToolLink tool={tool} />
                </div>
              )}
            </div>
          </SettingsRow>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={query.isPending}
          onClick={() => query.refresh()}
        >
          Check again
        </Button>
        {/* A refetch cut off by the next one (a save, Check again) fails with no
            error of its own; with the last results on screen it says nothing. */}
        {query.error !== null && (query.failure !== null || query.data === null) ? (
          <Text variant="body" tone="destructive" render={<p role="alert" />}>
            {query.error}
          </Text>
        ) : null}
      </div>
      {PATH_ROWS.filter((row) => row.shown).map((row) => (
        <SettingsRow
          key={row.key}
          icon={<FolderIcon />}
          title={row.title}
          description="Leave blank to find it automatically."
        >
          <Input
            aria-label={row.title}
            value={paths[row.key] ?? settings[row.key]}
            disabled={!canWrite || saving}
            onChange={(event) => setPaths({ ...paths, [row.key]: event.target.value })}
            placeholder="Automatic"
          />
        </SettingsRow>
      ))}
      <div className="space-y-2 px-4 py-3">
        {error ? (
          <Text
            variant="body"
            tone="destructive"
            render={<p role="alert" className="whitespace-pre-wrap" />}
          >
            {error}
          </Text>
        ) : null}
        <Button
          size="sm"
          disabled={!canWrite || saving || Object.keys(paths).length === 0}
          onClick={() => void savePaths()}
        >
          {saving ? "Saving…" : "Save paths"}
        </Button>
      </div>
      <GameToolsKeysSection environmentId={environmentId} />
    </SettingsSection>
  );
}

/** Install or Remove for a tool Kurambit fetches itself; a failure stays on the row. */
function GameToolChange({
  environmentId,
  tool,
  onChanged,
}: {
  environmentId: EnvironmentId;
  tool: GameToolStatus;
  onChanged: () => void;
}) {
  const install = useAtomCommand(gameEnvironment.toolchainInstall, { reportFailure: false });
  const remove = useAtomCommand(gameEnvironment.toolchainRemove, { reportFailure: false });
  const canInstall = useAtomValue(gameEnvironment.toolchainInstall.permissionAtom(environmentId));
  const canRemove = useAtomValue(gameEnvironment.toolchainRemove.permissionAtom(environmentId));
  const [pending, setPending] = useState<"install" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: "install" | "remove") => {
    if (pending !== null || tool.tool !== "mpfb") return;
    setPending(kind);
    setError(null);
    const run = kind === "install" ? install : remove;
    const result = await run({ environmentId, input: { tool: tool.tool } });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setPending(null);
    onChanged();
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {tool.installed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canRemove || pending !== null}
            onClick={() => void change("remove")}
          >
            {pending === "remove" ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <Button
            size="sm"
            // Blender missing or too old: the message says what to fix first.
            disabled={!canInstall || pending !== null || tool.status === "error"}
            onClick={() => void change("install")}
          >
            {pending === "install" ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
      {error === null ? null : (
        <Text
          variant="meta"
          tone="destructive"
          render={<p role="alert" className="whitespace-pre-wrap" />}
        >
          {error}
        </Text>
      )}
    </div>
  );
}

const KEY_ROWS = [
  {
    key: "gameJevApiKey",
    title: "Jev key",
    description:
      "Optional playtest route: Jev picks exploration options at play speed. Unset means the policy fallback.",
  },
  {
    key: "gameSketchfabApiKey",
    title: "Sketchfab key",
    description: "Passed to the pinned Blender addon for Sketchfab search and import.",
  },
  {
    key: "gamePolyPizzaApiKey",
    title: "Poly Pizza key",
    description: "Passed to the pinned Blender addon for Poly Pizza search and import.",
  },
] as const;
type KeyField = (typeof KEY_ROWS)[number]["key"];

function GameToolsKeysSection({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [error, setError] = useState<string | null>(null);
  // Every commit is sent: each patch names one key, and a key pasted while another saves must not be dropped.
  const saveKey = async (key: KeyField, value: string) => {
    setError(null);
    const patch: Partial<Record<KeyField, string>> = { [key]: value };
    const saved = await update({ environmentId, input: { patch } });
    if (saved._tag === "Failure") setError(String(squashAtomCommandFailure(saved)));
  };
  return (
    <div className="space-y-3 px-4 py-3">
      <Text variant="label" render={<p />}>
        Keys
      </Text>
      <Text variant="meta" tone="muted" render={<p />}>
        Stored in this environment&apos;s secret store. Settings only show whether a key is set,
        never the value.
      </Text>
      {error ? (
        <Text
          variant="body"
          tone="destructive"
          render={<p role="alert" className="whitespace-pre-wrap" />}
        >
          {error}
        </Text>
      ) : null}
      {KEY_ROWS.map((row) => {
        const configured = settings[row.key].length > 0;
        return (
          <SettingsRow
            key={row.key}
            icon={<KeyRoundIcon />}
            title={row.title}
            description={row.description}
          >
            <div className="flex flex-wrap gap-2">
              <SecretInput
                aria-label={`${row.title} value`}
                configured={configured}
                value=""
                disabled={!canWrite}
                placeholder="Paste the key"
                onCommit={(next) => {
                  if (next !== "") void saveKey(row.key, next);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite || !configured}
                onClick={() => void saveKey(row.key, "")}
              >
                Clear
              </Button>
            </div>
          </SettingsRow>
        );
      })}
    </div>
  );
}
