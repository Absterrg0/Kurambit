import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, GameToolStatus } from "@kurambit/contracts";
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
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TOOL_PURPOSE = {
  godot: "The engine for native games: Godot 4.7.x with its export templates.",
  unity:
    "The engine for Unity games: a Unity 6 editor from Unity Hub (6000.6.7f1 or later) with Windows Build Support (Mono), and a Unity licence.",
  blender: "Models, rigs and renders game art. Blender 4.2 or later.",
  uv: "Runs the live Blender view's helper. Kurambit fetches it itself when it is not installed.",
} as const satisfies Record<GameToolStatus["tool"], string>;

const SOURCE_LABELS = {
  settings: "path set here",
  env: "environment variable",
  "unity-hub": "Unity Hub",
  kurambit: "earlier Kurambit install",
  path: "PATH",
} as const satisfies Record<NonNullable<GameToolStatus["source"]>, string>;

const STATUS_BADGES = {
  ready: { variant: "success", label: "Ready" },
  warning: { variant: "warning", label: "Needs attention" },
  error: { variant: "error", label: "Not ready" },
} as const;

const PATH_ROWS = [
  { key: "gameGodotPath", title: "Godot executable" },
  { key: "gameUnityPath", title: "Unity editor" },
  { key: "gameBlenderPath", title: "Blender executable" },
] as const;
type PathKey = (typeof PATH_ROWS)[number]["key"];

export function GameToolsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const query = useEnvironmentQuery(gameEnvironment.toolchain({ environmentId, input: {} }));
  const keysQuery = useEnvironmentQuery(
    gameEnvironment.secretsStatus({ environmentId, input: {} }),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [paths, setPaths] = useState<Partial<Record<PathKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
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
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{tool.message}</p>
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
        {query.error ? <p role="alert">{query.error}</p> : null}
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
      <GameToolsKeysSection
        environmentId={environmentId}
        keys={keysQuery.data ?? null}
        keysError={keysQuery.error ? String(keysQuery.error) : null}
        drafts={keyDrafts}
        setDrafts={setKeyDrafts}
        keyBusy={keyBusy}
        setKeyBusy={setKeyBusy}
        keyError={keyError}
        setKeyError={setKeyError}
        refreshKeys={() => keysQuery.refresh()}
      />
    </SettingsSection>
  );
}

const KEY_ROWS = [
  {
    name: "jev",
    title: "Jev key",
    description:
      "Optional playtest route: Jev picks exploration options at play speed. Unset means the policy fallback.",
  },
  {
    name: "sketchfab",
    title: "Sketchfab key",
    description: "Passed to the pinned Blender addon for Sketchfab search and import.",
  },
  {
    name: "polypizza",
    title: "Poly Pizza key",
    description: "Passed to the pinned Blender addon for Poly Pizza search and import.",
  },
] as const;

function GameToolsKeysSection({
  environmentId,
  keys,
  keysError,
  drafts,
  setDrafts,
  keyBusy,
  setKeyBusy,
  keyError,
  setKeyError,
  refreshKeys,
}: {
  environmentId: EnvironmentId;
  keys: { jev: boolean; sketchfab: boolean; polypizza: boolean } | null;
  keysError: string | null;
  drafts: Record<string, string>;
  setDrafts: (drafts: Record<string, string>) => void;
  keyBusy: string | null;
  setKeyBusy: (busy: string | null) => void;
  keyError: string | null;
  setKeyError: (error: string | null) => void;
  refreshKeys: () => void;
}) {
  const setSecret = useAtomCommand(gameEnvironment.setSecret, { reportFailure: false });
  const canSetSecret = useAtomValue(gameEnvironment.setSecret.permissionAtom(environmentId));
  const saveKey = async (name: "jev" | "sketchfab" | "polypizza", clear: boolean) => {
    if (keyBusy) return;
    setKeyBusy(name);
    setKeyError(null);
    try {
      const result = await setSecret({
        environmentId,
        input: { name, secret: clear ? "" : (drafts[name] ?? "") },
      });
      if (result._tag === "Failure") {
        setKeyError(String(squashAtomCommandFailure(result)));
        return;
      }
      setDrafts({ ...drafts, [name]: "" });
      refreshKeys();
    } finally {
      setKeyBusy(null);
    }
  };
  return (
    <div className="space-y-3 px-4 py-3 text-sm">
      <p className="font-medium">Keys</p>
      <p className="text-xs text-muted-foreground">
        Stored in this environment&apos;s secret store. The UI only shows whether a key is set,
        never the value.
      </p>
      {keysError ? <p role="alert">{keysError}</p> : null}
      {keyError ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {keyError}
        </p>
      ) : null}
      {KEY_ROWS.map((row) => {
        const isSet = keys?.[row.name] ?? false;
        return (
          <SettingsRow key={row.name} title={row.title} description={row.description}>
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">{isSet ? "Set" : "Not set"}</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  aria-label={`${row.title} value`}
                  type="password"
                  value={drafts[row.name] ?? ""}
                  disabled={!canSetSecret || keyBusy !== null}
                  onChange={(event) => setDrafts({ ...drafts, [row.name]: event.target.value })}
                  placeholder={isSet ? "Enter a new value to replace" : "Paste the key"}
                />
                <Button
                  size="sm"
                  disabled={
                    !canSetSecret || keyBusy !== null || (drafts[row.name] ?? "").length === 0
                  }
                  onClick={() => void saveKey(row.name, false)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSetSecret || keyBusy !== null || !isSet}
                  onClick={() => void saveKey(row.name, true)}
                >
                  Clear
                </Button>
              </div>
            </div>
          </SettingsRow>
        );
      })}
    </div>
  );
}
