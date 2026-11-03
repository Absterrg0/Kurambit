import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, GameToolchainStatus } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { gameEnvironment } from "../../state/game";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function GameToolsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const query = useEnvironmentQuery(gameEnvironment.toolchain({ environmentId, input: {} }));
  const keysQuery = useEnvironmentQuery(
    gameEnvironment.secretsStatus({ environmentId, input: {} }),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const verify = useAtomCommand(gameEnvironment.verify, { reportFailure: false });
  const install = useAtomCommand(gameEnvironment.install, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canInstall = useAtomValue(gameEnvironment.install.permissionAtom(environmentId));
  const canVerify = useAtomValue(gameEnvironment.verify.permissionAtom(environmentId));
  const [blenderPath, setBlenderPath] = useState<string | null>(null);
  const [godotPath, setGodotPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<GameToolchainStatus | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const data = verified ?? query.data;
  const perform = async (operation: "save" | "verify" | "install" | "install-unity") => {
    if (busy) return;
    setBusy(operation);
    setError(null);
    setVerified(null);
    try {
      if (operation === "save") {
        const saved = await update({
          environmentId,
          input: {
            patch: {
              gameBlenderPath: blenderPath ?? settings.gameBlenderPath,
              gameGodotPath: godotPath ?? settings.gameGodotPath,
            },
          },
        });
        if (saved._tag === "Failure") {
          setError(String(squashAtomCommandFailure(saved)));
          return;
        }
        setBlenderPath(null);
        setGodotPath(null);
      }
      const result =
        operation === "install" || operation === "install-unity"
          ? await install({
              environmentId,
              input: operation === "install-unity" ? { unity: true } : {},
            })
          : await verify({ environmentId, input: {} });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else setVerified(result.value);
    } finally {
      setBusy(null);
      query.refresh();
    }
  };
  return (
    <SettingsSection id="game-tools" title="Game tools">
      <SettingsRow
        title="Blender executable"
        description="Leave blank to use the environment override, managed install, or PATH."
      >
        <Input
          aria-label="Blender executable"
          value={blenderPath ?? settings.gameBlenderPath}
          disabled={!canWrite || busy !== null}
          onChange={(event) => setBlenderPath(event.target.value)}
          placeholder="Automatic"
        />
      </SettingsRow>
      <SettingsRow
        title="Godot executable"
        description="Godot 4.7 with matching Web and Linux export templates is required."
      >
        <Input
          aria-label="Godot executable"
          value={godotPath ?? settings.gameGodotPath}
          disabled={!canWrite || busy !== null}
          onChange={(event) => setGodotPath(event.target.value)}
          placeholder="Automatic"
        />
      </SettingsRow>
      <div className="space-y-3 px-4 py-3 text-sm">
        {data?.tools.map((tool) => (
          <div key={tool.tool} className="space-y-1 break-words">
            <p className="font-medium">
              {TOOL_NAMES[tool.tool]} · {tool.version ?? "missing"} ·{" "}
              {tool.verified ? "verified" : tool.ready ? "verification needed" : "not ready"}
            </p>
            <p className="font-mono text-xs">{tool.path ?? "No executable resolved"}</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{tool.message}</p>
          </div>
        ))}
        {query.error ? <p role="alert">{query.error}</p> : null}
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-destructive">
            {error}
          </p>
        ) : null}
        {busy ? (
          <p role="status">
            {busy === "install"
              ? "Installing and verifying tools…"
              : busy === "install-unity"
                ? "Installing Unity (about 4.5 GB)…"
                : busy === "save"
                  ? "Saving paths and verifying tools…"
                  : "Verifying tools…"}
          </p>
        ) : null}
        {data ? (
          <p className="break-words text-xs text-muted-foreground">
            Managed tools: {data.toolsDirectory}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              !canWrite ||
              !canVerify ||
              busy !== null ||
              (blenderPath === null && godotPath === null)
            }
            onClick={() => void perform("save")}
          >
            Save and verify
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canVerify || busy !== null}
            onClick={() => void perform("verify")}
          >
            Verify
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canInstall || busy !== null || data?.installing}
            onClick={() => void perform("install")}
          >
            Install
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canInstall || busy !== null || data?.installing}
            onClick={() => void perform("install-unity")}
          >
            Install Unity
          </Button>
        </div>
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

const TOOL_NAMES = { blender: "Blender", godot: "Godot", uv: "uv", unity: "Unity" } as const;

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
