import { useAtomValue } from "@effect/atom-react";
import { useId, useState } from "react";
import {
  BoxIcon,
  CheckIcon,
  CopyIcon,
  RefreshCwIcon,
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
import { Button, InlineButton } from "../ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { StatusLabel } from "../ui/status-dot";
import { Text } from "../ui/text";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// One line each; requirements and where a tool comes from sit behind the row's About.
const TOOL_PURPOSE = {
  godot: "The engine for native games.",
  unity: "The engine for Unity games.",
  blender: "Models, rigs and renders game art.",
  uv: "Runs the live Blender view's helper.",
  mpfb: "Makes human bodies for characters built in Blender.",
  ffmpeg: "Records each bot play.",
} as const satisfies Record<GameToolStatus["tool"], string>;

const TOOL_ABOUT = {
  godot: "Godot 4.7.x with its export templates.",
  unity:
    "A Unity 6 editor from Unity Hub (6000.6.7f1 or later) with Windows Build Support (Mono), and a Unity licence.",
  blender: "Blender 4.2 or later.",
  uv: "Kurambit fetches it itself when it is not installed.",
  mpfb: "MPFB2 2.0.18. Its code is GPL-3.0 and is downloaded from extensions.blender.org (46 MB) into Kurambit's own Blender sessions, never your Blender settings; the bodies it makes are CC0. Without it, characters use library bodies.",
  ffmpeg:
    "A build's play facts and Keep going are read from these recordings; without ffmpeg a build is only checked for booting.",
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
  settings: "Path set below",
  env: "Set by an environment variable",
  "unity-hub": "From Unity Hub",
  kurambit: "Installed by Kurambit",
  path: "Found on this computer",
} as const satisfies Record<NonNullable<GameToolStatus["source"]>, string>;

const STATUS_LABELS = {
  ready: { tone: "success", label: "Ready" },
  warning: { tone: "warning", label: "Needs attention" },
  error: { tone: "danger", label: "Not ready" },
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
    <SettingsSection
      id="game-tools"
      title="Game tools"
      headerAction={
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isPending}
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon />
          Check again
        </Button>
      }
    >
      {query.data?.tools.map((tool) => (
        <GameToolRow
          key={tool.tool}
          environmentId={environmentId}
          tool={tool}
          onChanged={() => query.refresh()}
        />
      ))}
      {/* A refetch cut off by the next one (a save, Check again) fails with no
          error of its own; with the last results on screen it says nothing. */}
      {query.error !== null && (query.failure !== null || query.data === null) ? (
        <div className="px-4 py-3">
          <Text variant="body" tone="destructive" render={<p role="alert" />}>
            {query.error}
          </Text>
        </div>
      ) : null}
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

/**
 * One tool: what it is for, its version and where it came from, its status, and
 * Install or Remove for a tool Kurambit fetches itself. The path is copied, not shown:
 * a home directory in the middle of a row says nothing a person needs to read.
 */
function GameToolRow({
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
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [pending, setPending] = useState<"install" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const aboutId = useId();
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
  const status = STATUS_LABELS[tool.status];
  const ToolIcon = TOOL_ICONS[tool.tool];
  const found = [tool.version, tool.source === null ? null : SOURCE_LABELS[tool.source]]
    .filter((part) => part !== null)
    .join(" · ");
  // A ready tool's dot and its purpose already say it all; its message only repeats them.
  const showMessage = tool.status !== "ready";
  const changeButton = !INSTALLABLE.has(tool.tool) ? null : tool.installed ? (
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
  );
  const details = showMessage || error !== null || aboutOpen;
  return (
    <SettingsRow
      inlineControl
      icon={<ToolIcon />}
      title={GAME_TOOL_NAMES[tool.tool]}
      description={TOOL_PURPOSE[tool.tool]}
      status={
        <span className="flex flex-wrap items-center gap-x-1.5">
          {found === "" ? null : <span>{found} ·</span>}
          <InlineButton
            tone="muted"
            aria-expanded={aboutOpen}
            aria-controls={aboutId}
            onClick={() => setAboutOpen((open) => !open)}
          >
            {aboutOpen ? "Hide" : "About"}
          </InlineButton>
        </span>
      }
      control={
        <span className="flex items-center gap-3">
          <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
          {changeButton}
        </span>
      }
    >
      {details ? (
        <div className="flex min-w-0 flex-col gap-1 break-words ps-7 pb-2">
          {aboutOpen ? (
            <div id={aboutId} className="grid gap-1">
              <Text variant="meta" tone="muted" render={<p className="text-pretty" />}>
                {TOOL_ABOUT[tool.tool]}
              </Text>
              {/* The path lives with the About text, so the status line's only control is
                  About and no icon reads as part of it. */}
              {tool.path === null ? null : (
                <Text variant="meta" tone="muted" render={<p className="flex min-w-0 gap-2" />}>
                  <span className="min-w-0 break-all">{tool.path}</span>
                  <InlineButton
                    tone="muted"
                    aria-label={`Copy ${GAME_TOOL_NAMES[tool.tool]}'s path`}
                    onClick={() => {
                      if (tool.path !== null) copyToClipboard(tool.path);
                    }}
                  >
                    {isCopied ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      <CopyIcon className="size-3.5" />
                    )}
                    {isCopied ? "Copied" : "Copy path"}
                  </InlineButton>
                </Text>
              )}
            </div>
          ) : null}
          {/* The status in the control column already says a ready tool is ready. */}
          {!showMessage ? null : tool.installed ? (
            <Text variant="meta" tone="muted" render={<p className="whitespace-pre-wrap" />}>
              {tool.message}
            </Text>
          ) : (
            <Text variant="meta" tone="muted" render={<details />}>
              <summary className="cursor-pointer">Not installed · Details</summary>
              <p className="mt-1 whitespace-pre-wrap">{tool.message}</p>
            </Text>
          )}
          {error === null ? null : (
            <Text
              variant="meta"
              tone="destructive"
              render={<p role="alert" className="whitespace-pre-wrap" />}
            >
              {error}
            </Text>
          )}
          {tool.status === "ready" ? null : (
            <div>
              <GameToolLink tool={tool} />
            </div>
          )}
        </div>
      ) : null}
    </SettingsRow>
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
