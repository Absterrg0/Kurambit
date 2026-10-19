import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, GameToolchainStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
  const data = verified ?? query.data;
  const perform = async (operation: "save" | "verify" | "install") => {
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
      const result = await (operation === "install" ? install : verify)({
        environmentId,
        input: {},
      });
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
              {tool.tool === "blender" ? "Blender" : "Godot"} · {tool.version ?? "missing"} ·{" "}
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
        </div>
      </div>
    </SettingsSection>
  );
}
