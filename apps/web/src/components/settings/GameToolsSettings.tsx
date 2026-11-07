import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, GameToolchainChangeInput, GameToolStatus } from "@kurambit/contracts";
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
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TOOL_PURPOSE = {
  godot: "The engine for native games: Godot 4.7.x with its export templates.",
  unity:
    "The engine for Unity games: a Unity 6 editor from Unity Hub (6000.6.7f1 or later) with Windows Build Support (Mono), and a Unity licence.",
  blender: "Models, rigs and renders game art. Blender 4.2 or later.",
  uv: "Runs the live Blender view's helper. Kurambit fetches it itself when it is not installed.",
  mpfb: "MPFB2 2.0.18 makes human bodies for characters built in Blender. Its code is GPL-3.0 and is downloaded from extensions.blender.org (46 MB) into Kurambit's own Blender sessions, never your Blender settings; the bodies it makes are CC0. Without it, characters use library bodies.",
} as const satisfies Record<GameToolStatus["tool"], string>;

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

const PATH_ROWS = [
  { key: "gameGodotPath", title: "Godot executable" },
  { key: "gameUnityPath", title: "Unity editor" },
  { key: "gameBlenderPath", title: "Blender executable" },
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
    try {
      const saved = await update({ environmentId, input: { patch: paths } });
      if (saved._tag === "Failure") {
        setError(String(squashAtomCommandFailure(saved)));
        return;
      }
      setPaths({});
    } finally {
      setSaving(false);
      query.refresh();
    }
  };
  return (
    <SettingsSection id="game-tools" title="Game tools">
      {query.data?.tools.map((tool) => {
        const badge = STATUS_BADGES[tool.status];
        return (
          <SettingsRow
            key={tool.tool}
            title={GAME_TOOL_NAMES[tool.tool]}
            description={TOOL_PURPOSE[tool.tool]}
            status={
              <Badge variant={badge.variant} size="sm">
                {badge.label}
              </Badge>
            }
          >
            <div className="flex min-w-0 flex-col gap-1 text-sm break-words">
              {tool.path === null ? null : (
                <p className="font-mono text-xs">
                  {tool.path}
                  {tool.version === null ? "" : ` · ${tool.version}`}
                  {tool.source === null ? "" : ` · ${SOURCE_LABELS[tool.source]}`}
                </p>
              )}
              {tool.installed || tool.status === "ready" ? (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{tool.message}</p>
              ) : (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Not installed · Details</summary>
                  <p className="mt-1 whitespace-pre-wrap">{tool.message}</p>
                </details>
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
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
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
          <p role="alert">{query.error}</p>
        ) : null}
      </div>
      {PATH_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
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
      <div className="space-y-2 px-4 py-3 text-sm">
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-destructive">
            {error}
          </p>
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
        <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
          {error}
        </p>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveKey = async (key: KeyField, value: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Partial<Record<KeyField, string>> = { [key]: value };
      const saved = await update({ environmentId, input: { patch } });
      if (saved._tag === "Failure") setError(String(squashAtomCommandFailure(saved)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 px-4 py-3 text-sm">
      <p className="font-medium">Keys</p>
      <p className="text-xs text-muted-foreground">
        Stored in this environment&apos;s secret store. Settings only show whether a key is set,
        never the value.
      </p>
      {error ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}
      {KEY_ROWS.map((row) => {
        const configured = settings[row.key].length > 0;
        return (
          <SettingsRow key={row.key} title={row.title} description={row.description}>
            <div className="flex flex-wrap gap-2">
              <SecretInput
                aria-label={`${row.title} value`}
                configured={configured}
                value=""
                disabled={!canWrite || busy}
                placeholder="Paste the key"
                onCommit={(next) => {
                  if (next !== "") void saveKey(row.key, next);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite || busy || !configured}
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
