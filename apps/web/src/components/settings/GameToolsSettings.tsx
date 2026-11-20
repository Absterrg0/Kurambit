import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  BoxIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshCwIcon,
  FilmIcon,
  FolderIcon,
  PersonStandingIcon,
  TerminalIcon,
} from "lucide-react";
import { type EnvironmentId, type GameToolStatus } from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { gameEnvironment } from "../../state/game";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { gameToolName, GameToolLink } from "../game/GameToolLink";
import { Button, InlineButton } from "../ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { SettingsKeyRow } from "./SettingsKeyRow";
import { StatusLabel } from "../ui/status-dot";
import { Text } from "../ui/text";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

// One line each; requirements and where a tool comes from sit behind the row's About. An
// add-on's words come from the add-ons list the server sends with its row.
const megabytes = (bytes: number) =>
  bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const toolPurpose = (tool: GameToolStatus): string =>
  tool.addon?.purpose ??
  {
    blender: "Models, rigs and renders game art.",
    uv: "Lets the agent work in a running Blender.",
    addon: "",
    ffmpeg: "Records each bot play.",
  }[tool.tool];

// Helpers that only matter through Blender sit under it, named by what they let a game do;
// the program's own name stays on the row's meta line for troubleshooting.
const helperTitle = (tool: GameToolStatus): string | null =>
  tool.addon?.makes ?? (tool.tool === "uv" ? "Live Blender" : null);

const toolAbout = (tool: GameToolStatus): string =>
  tool.addon !== undefined
    ? `${tool.addon.name} ${tool.addon.version}. ${tool.addon.licence}. Downloaded from ${tool.addon.source} (${megabytes(tool.addon.bytes)}) into Kurambit's own Blender sessions, never your Blender settings. ${tool.addon.asksFirst ? "The agent asks you before it adds it." : "The agent adds it when a game first needs it."} ${tool.addon.without}`
    : {
        blender: "Blender 4.2 or later.",
        uv: "Kurambit fetches it itself when it is not installed.",
        addon: "",
        ffmpeg:
          "A build's play checks and Keep going are read from its videos; without ffmpeg a build is only checked for starting.",
      }[tool.tool];

const TOOL_ICONS = {
  blender: BoxIcon,
  uv: TerminalIcon,
  addon: PersonStandingIcon,
  ffmpeg: FilmIcon,
} as const satisfies Record<GameToolStatus["tool"], unknown>;

const SOURCE_LABELS = {
  settings: "Path set below",
  env: "Set by an environment variable",
  kurambit: "Installed by Kurambit",
  path: "Found on this computer",
} as const satisfies Record<NonNullable<GameToolStatus["source"]>, string>;

const STATUS_LABELS = {
  ready: { tone: "success", label: "Ready" },
  warning: { tone: "warning", label: "Needs attention" },
  error: { tone: "danger", label: "Not ready" },
} as const;

const PATH_ROWS = [{ key: "gameBlenderPath", title: "Blender executable" }] as const;
type PathKey = (typeof PATH_ROWS)[number]["key"];

/** Settings → Game tools, for the one computer the settings are scoped to. */
export function GameToolsSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsPageContainer description="The programs this computer builds, renders and records your games with.">
      {environmentId === null ? (
        <Text variant="body" tone="muted" render={<p className="px-3 sm:px-4" />}>
          {scope.environmentIds.length <= 1
            ? "Connecting…"
            : "Game tools belong to one computer. Choose it above."}
        </Text>
      ) : (
        <>
          <GameToolsSettings key={environmentId} environmentId={environmentId} />
          <GameToolsKeys key={`keys:${environmentId}`} environmentId={environmentId} />
        </>
      )}
    </SettingsPageContainer>
  );
}

function GameToolsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const query = useEnvironmentQuery(gameEnvironment.toolchain({ environmentId, input: {} }));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const [error, setError] = useState<string | null>(null);
  // Each field saves itself when it is left, like every other settings field; a path
  // changes which tool is found, so the rows above are checked again after it.
  const savePath = async (key: PathKey, value: string) => {
    setError(null);
    const saved = await update({ environmentId, input: { patch: { [key]: value } } });
    if (saved._tag === "Failure") setError(String(squashAtomCommandFailure(saved)));
    query.refresh();
  };
  return (
    <SettingsSection
      id="game-tools"
      title="Programs"
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
      {orderTools(query.data?.tools ?? []).map((tool) => (
        <GameToolRow
          key={tool.addon?.id ?? tool.tool}
          environmentId={environmentId}
          tool={tool}
          blender={query.data?.tools.find((entry) => entry.tool === "blender") ?? null}
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
      {PATH_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          icon={<FolderIcon />}
          title={row.title}
          description="Leave blank to find it automatically."
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              aria-label={row.title}
              value={settings[row.key]}
              disabled={!canWrite}
              spellCheck={false}
              onCommit={(next) => void savePath(row.key, next.trim())}
              placeholder="Automatic"
            />
          }
        />
      ))}
      {error ? (
        <div className="px-4 py-3">
          <Text
            variant="body"
            tone="destructive"
            render={<p role="alert" className="whitespace-pre-wrap" />}
          >
            {error}
          </Text>
        </div>
      ) : null}
    </SettingsSection>
  );
}

// Blender's helpers follow Blender, whatever order the server lists them in.
function orderTools(tools: ReadonlyArray<GameToolStatus>): ReadonlyArray<GameToolStatus> {
  const helpers = tools.filter((tool) => helperTitle(tool) !== null);
  return tools.flatMap((tool) =>
    helperTitle(tool) !== null ? [] : tool.tool === "blender" ? [tool, ...helpers] : [tool],
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
  blender,
  onChanged,
}: {
  environmentId: EnvironmentId;
  tool: GameToolStatus;
  blender: GameToolStatus | null;
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
  const change = async (kind: "install" | "remove") => {
    const addon = tool.addon;
    if (pending !== null || addon === undefined) return;
    setPending(kind);
    setError(null);
    const run = kind === "install" ? install : remove;
    const result = await run({ environmentId, input: { tool: addon.id } });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setPending(null);
    onChanged();
  };
  const helper = helperTitle(tool);
  // A helper works only through Blender, so without a ready Blender it is not ready either,
  // even when its own program is in place.
  const needsBlender = helper !== null && blender !== null && blender.status !== "ready";
  // One that is not installed cannot be installed into a missing Blender: it waits instead
  // of offering a button that cannot work. An installed one can still be removed.
  const waitsOnBlender = needsBlender && !tool.installed;
  // An add-on is optional: not having one is a choice, not something to fix.
  const status = needsBlender
    ? ({ tone: "neutral", label: "Needs Blender" } as const)
    : tool.tool === "addon" && !tool.installed && tool.status === "warning"
      ? ({ tone: "neutral", label: "Not installed" } as const)
      : STATUS_LABELS[tool.status];
  const ToolIcon = TOOL_ICONS[tool.tool];
  const where =
    [tool.version, tool.source === null ? null : SOURCE_LABELS[tool.source]]
      .filter((part) => part !== null)
      .join(" · ") || (tool.installed ? "" : "Not installed");
  const found = [helper !== null ? gameToolName(tool) : "", where]
    .filter((part) => part !== "")
    .join(" · ");
  // Installed but not ready: the message is the fix, so it stays in view. A missing
  // tool's message is the long story of where it was looked for, so it waits in About.
  const showMessage = tool.status !== "ready" && tool.installed;
  // One action per row, in one style: Install or Remove for what Kurambit fetches,
  // otherwise the vendor's page while the tool is not ready.
  const action = waitsOnBlender ? null : tool.addon !== undefined ? (
    tool.installed ? (
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
        variant="outline"
        // Blender missing or too old: the message says what to fix first.
        disabled={!canInstall || pending !== null || tool.status === "error"}
        onClick={() => void change("install")}
      >
        {pending === "install" ? "Installing…" : "Install"}
      </Button>
    )
  ) : tool.status === "ready" ? null : (
    <GameToolLink tool={tool} />
  );
  return (
    <Collapsible open={aboutOpen} onOpenChange={setAboutOpen}>
      <SettingsRow
        inlineControl
        controlAlign="title"
        className={helper !== null ? "ps-10 sm:ps-11" : undefined}
        icon={<ToolIcon />}
        title={helper ?? gameToolName(tool)}
        description={toolPurpose(tool)}
        status={
          <span className="flex flex-wrap items-center gap-x-1.5">
            {found === "" ? null : <span>{found} ·</span>}
            <CollapsibleTrigger className="group" render={<InlineButton tone="muted" />}>
              About
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
              />
            </CollapsibleTrigger>
          </span>
        }
        control={
          <span className="flex items-center gap-3">
            <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
            {action}
          </span>
        }
      >
        <div className="flex min-w-0 flex-col break-words ps-7">
          {showMessage ? (
            <Text variant="meta" tone="muted" render={<p className="whitespace-pre-wrap pb-2" />}>
              {tool.message}
            </Text>
          ) : null}
          {error === null ? null : (
            <Text
              variant="meta"
              tone="destructive"
              render={<p role="alert" className="whitespace-pre-wrap pb-2" />}
            >
              {error}
            </Text>
          )}
          <CollapsiblePanel>
            <div className="grid gap-1 pb-2">
              <Text variant="meta" tone="muted" render={<p className="text-pretty" />}>
                {toolAbout(tool)}
              </Text>
              {tool.installed || tool.status === "ready" ? null : (
                <Text variant="meta" tone="muted" render={<p className="whitespace-pre-wrap" />}>
                  {tool.message}
                </Text>
              )}
              {tool.path === null ? null : (
                <Text variant="meta" tone="muted" render={<p className="flex min-w-0 gap-2" />}>
                  <span className="min-w-0 break-all">{tool.path}</span>
                  <InlineButton
                    tone="muted"
                    aria-label={`Copy ${gameToolName(tool)}'s path`}
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
          </CollapsiblePanel>
        </div>
      </SettingsRow>
    </Collapsible>
  );
}

// Plain words first: what each key changes in a game, not the service's name.
const KEY_ROWS = [
  {
    key: "gameSketchfabApiKey",
    title: "Sketchfab models",
    description: "Lets Blender search and import Sketchfab models for your games.",
  },
  {
    key: "gamePolyPizzaApiKey",
    title: "Poly Pizza models",
    description: "Lets Blender search and import Poly Pizza models for your games.",
  },
] as const;
type KeyField = (typeof KEY_ROWS)[number]["key"];

function GameToolsKeys({ environmentId }: { environmentId: EnvironmentId }) {
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
    <SettingsSection id="game-tool-keys" title="Optional services">
      {KEY_ROWS.map((row) => {
        const configured = settings[row.key].length > 0;
        return (
          <SettingsKeyRow
            key={row.key}
            title={row.title}
            description={row.description}
            status={
              configured
                ? { tone: "success", label: "Key saved" }
                : { tone: "neutral", label: "No key" }
            }
            configured={configured}
            canWrite={canWrite}
            onSave={(next) => void saveKey(row.key, next)}
            onClear={() => void saveKey(row.key, "")}
          />
        );
      })}
      {error ? (
        <div className="px-4 py-3">
          <Text
            variant="body"
            tone="destructive"
            render={<p role="alert" className="whitespace-pre-wrap" />}
          >
            {error}
          </Text>
        </div>
      ) : null}
    </SettingsSection>
  );
}
