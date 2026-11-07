import { useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ArrowUpIcon, XIcon } from "lucide-react";
import {
  GAME_ENGINES,
  gameStageAskContext,
  type GameThing,
  type GameThingValue,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { squashAtomCommandFailure } from "@kurambit/client-runtime/state/runtime";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useGameStageAccess } from "../../hooks/useGameStageAccess";
import { useIsGameThreadStatus } from "../../hooks/useIsGameThread";
import { type GameDockTab, useGameWorkspaceStore } from "../../gameWorkspaceStore";
import { cn, newMessageId, randomUUID } from "../../lib/utils";
import { readThreadShell } from "../../state/entities";
import { gameEnvironment } from "../../state/game";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { GameBuildDetail, refOf } from "./GameBuildDetail";
import { GameGeneratedArt } from "./GameGeneratedArt";
import {
  GameGenerationBody,
  GenerationHeading,
  useChoosingCount,
  useGameGenerations,
  useGenerationActions,
} from "./GameGenerationCard";
import { GameFileActions } from "./GameSavedMedia";
import {
  captureStageFrame,
  clearStageSelection,
  forgetStageTuning,
  resetStageValues,
  hoverStageThing,
  selectStageThing,
  tuneStageValue,
  useThreadStageBridge,
  type StageSelection,
} from "./gameStageBridge";

const TABS: ReadonlyArray<{ readonly tab: GameDockTab; readonly label: string }> = [
  { tab: "chat", label: "Chat" },
  { tab: "inspector", label: "Inspector" },
  { tab: "things", label: "Things" },
  { tab: "art", label: "Art" },
  { tab: "facts", label: "Facts" },
];

/**
 * The dock's tabs, in the docked chat column's header. The chat stays mounted
 * under every other tab, so its draft, scroll and running turn never reset.
 */
export function GameDockTabs({ threadRef }: { threadRef: ScopedThreadRef }) {
  const tab = useGameWorkspaceStore((state) => state.dockTab);
  const showDockTab = useGameWorkspaceStore((state) => state.showDockTab);
  // A generation waiting on the person's pick is never missed behind another tab.
  const choosing = useChoosingCount(threadRef);
  return (
    <div role="tablist" aria-label="Dock" className="flex h-full min-w-0 items-stretch gap-0.5">
      {TABS.map((entry) => (
        <button
          key={entry.tab}
          type="button"
          role="tab"
          aria-selected={tab === entry.tab}
          onClick={() => showDockTab(entry.tab)}
          className={cn(
            "relative flex shrink-0 items-center gap-1.5 px-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground",
            "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full",
            tab === entry.tab && "font-medium text-foreground after:bg-foreground",
          )}
        >
          {entry.label}
          {entry.tab === "chat" && choosing > 0 ? (
            <span className="size-1.5 rounded-full bg-warning" aria-label="A pick is waiting" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** The open tab's panel, over the chat's body; nothing while the chat is open. */
export function GameDockPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const tab = useGameWorkspaceStore((state) => state.dockTab);
  if (tab === "chat") return null;
  return (
    <div
      role="tabpanel"
      aria-label={TABS.find((entry) => entry.tab === tab)?.label}
      className="absolute inset-x-0 bottom-0 top-(--workspace-topbar-height) z-30 flex min-h-0 flex-col overflow-y-auto bg-background"
    >
      {tab === "inspector" ? <InspectorPanel threadRef={threadRef} /> : null}
      {tab === "things" ? <ThingsPanel threadRef={threadRef} /> : null}
      {tab === "art" ? (
        <div className="p-4">
          <GameGeneratedArt threadRef={threadRef} />
        </div>
      ) : null}
      {tab === "facts" ? <FactsPanel threadRef={threadRef} /> : null}
    </div>
  );
}

/** Why there is nothing to select, in this engine or this game's shell; null when selecting works. */
function useSelectNotice(threadRef: ScopedThreadRef): string | null {
  const engine = useIsGameThreadStatus(threadRef).data?.manifest.engine.name ?? null;
  const status = useThreadStageBridge(scopedThreadKey(threadRef), (state) => state.status, null);
  if (engine !== null && !GAME_ENGINES[engine].stageBridge)
    return `Selecting things in the running game is not in ${GAME_ENGINES[engine].name} yet.`;
  if (status === "none")
    return "Selecting needs the newer game shell. Your agent can update it: ask it to update the three.js shell.";
  if (status === null) return "Play the game on the Stage to see its things.";
  return null;
}

function Notice({ children }: { children: string }) {
  return <p className="p-5 text-sm text-muted-foreground">{children}</p>;
}

function InspectorPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const selected = useThreadStageBridge(threadKey, (state) => state.selected, null);
  const notice = useSelectNotice(threadRef);
  if (notice !== null) return <Notice>{notice}</Notice>;
  if (selected === null)
    return (
      <Notice>
        Freeze the game (Tab, or Freeze above it) and click a thing, or choose one in Things.
      </Notice>
    );
  const { thing } = selected;
  return (
    <div className="flex flex-col gap-5 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-3xl leading-none">{thing.name}</h2>
          <p className="mt-1.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 capitalize">{thing.kind}</span>·
            <span className="shrink-0">{thing.onScreen ? "on screen" : "off screen"}</span>·
            <code className="truncate">{thing.id}</code>
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Clear the selection (Esc)"
          onClick={clearStageSelection}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <LookSection threadRef={threadRef} thing={thing} />
      <ValuesSection threadRef={threadRef} thing={thing} />
      <AskSection threadRef={threadRef} selection={selected} />
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-border pt-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside === undefined ? null : (
          <span className="ml-auto text-xs text-muted-foreground">{aside}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/** Its model or sprite and where it comes from: a generation's own card, or the file. */
function LookSection({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  const root = useIsGameThreadStatus(threadRef).data?.root ?? null;
  const generations = useGameGenerations(threadRef).data;
  const actions = useGenerationActions(threadRef);
  const asset = thing.asset;
  if (asset === undefined)
    return (
      <Section title="Look">
        <p className="text-xs text-muted-foreground">
          Made in the game's code; it has no asset file. Ask about it below.
        </p>
      </Section>
    );
  const generation =
    generations?.generations.find(
      (entry) =>
        entry.files.includes(asset.path) ||
        (asset.sidecar !== undefined && entry.files.includes(asset.sidecar)),
    ) ?? null;
  if (generation !== null)
    return (
      <Section title="Look" aside="Generated">
        <GenerationHeading generation={generation} />
        <GameGenerationBody
          threadRef={threadRef}
          root={root}
          generation={generation}
          actions={actions}
        />
      </Section>
    );
  return (
    <Section title="Look" aside={asset.path.includes("/library/") ? "Library pack" : "Game file"}>
      <code className="text-xs break-all text-muted-foreground">{asset.path}</code>
      {asset.sidecar === undefined ? null : (
        <code className="text-xs break-all text-muted-foreground">{asset.sidecar}</code>
      )}
      {root === null ? null : (
        <div className="-ms-2 flex flex-wrap items-center gap-1">
          <GameFileActions
            threadRef={threadRef}
            path={`${root}/${asset.path}`}
            relativePath={asset.path}
          />
        </div>
      )}
    </Section>
  );
}

const valueLabel = (value: GameThingValue) => value.label ?? value.key;
const shown = (value: number | boolean) =>
  typeof value === "number" ? String(Math.round(value * 1000) / 1000) : value ? "on" : "off";

/** Live sliders for its tuned values, kept as a build or put back. */
function ValuesSection({ threadRef, thing }: { threadRef: ScopedThreadRef; thing: GameThing }) {
  const threadKey = scopedThreadKey(threadRef);
  const tunable = useThreadStageBridge(
    threadKey,
    (state) => state.capabilities.includes("tune"),
    false,
  );
  const before = useThreadStageBridge(threadKey, (state) => state.tunedFrom[thing.id], undefined);
  const canKeep = useAtomValue(gameEnvironment.keepValues.permissionAtom(threadRef.environmentId));
  const writer = useGameStageAccess(threadRef) === "writer";
  const keep = useAtomCommand(gameEnvironment.keepValues, { reportFailure: false });
  const [keeping, setKeeping] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const values = thing.values ?? [];
  if (values.length === 0)
    return (
      <Section title="Values">
        <p className="text-xs text-muted-foreground">
          The game tunes no values on this thing. Ask your agent to expose some with ctx.tune.
        </p>
      </Section>
    );
  const changed = values.filter(
    (value) => before !== undefined && value.key in before && before[value.key] !== value.value,
  );
  const keepAsBuild = async () => {
    setKeeping(true);
    setSaid(null);
    const result = await keep({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        things: [{ id: thing.id, values: changed }],
        commandId: randomUUID(),
      },
    });
    setKeeping(false);
    if (result._tag === "Failure")
      setSaid({ text: String(squashAtomCommandFailure(result)), failed: true });
    else {
      forgetStageTuning(thing.id);
      setSaid({ text: result.value.message, failed: false });
    }
  };
  return (
    <Section title="Values" aside={tunable ? "Live in the running game" : undefined}>
      <div className="flex flex-col gap-3">
        {values.map((value) => {
          const was = before?.[value.key];
          const edited = was !== undefined && was !== value.value;
          return (
            <ValueRow
              key={value.key}
              value={value}
              was={edited ? was : undefined}
              disabled={!tunable}
              onChange={(next) => tuneStageValue(thing.id, value.key, next, value.value)}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={changed.length === 0 || keeping || !canKeep || !writer}
          onClick={() => void keepAsBuild()}
        >
          {keeping ? "Keeping…" : "Keep as a build"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={before === undefined}
          onClick={() => resetStageValues(thing.id)}
        >
          Reset
        </Button>
      </div>
      <p
        role={said?.failed === true ? "alert" : undefined}
        className={cn(
          "text-xs",
          said?.failed === true ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {said !== null
          ? said.text
          : changed.length > 0
            ? `${changed.length === 1 ? "One value" : `${changed.length} values`} changed and the game is using ${changed.length === 1 ? "it" : "them"}. Keep makes a build; Undo takes it back.`
            : "Changes play at once and last until the game reloads, unless you keep them."}
      </p>
    </Section>
  );
}

function ValueRow({
  value,
  was,
  disabled,
  onChange,
}: {
  value: GameThingValue;
  was: number | boolean | undefined;
  disabled: boolean;
  onChange: (next: number | boolean) => void;
}) {
  const label = valueLabel(value);
  const reading = (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        was !== undefined ? "text-primary" : "text-foreground",
      )}
    >
      {was === undefined ? null : (
        <span className="me-1.5 text-muted-foreground">was {shown(was)}</span>
      )}
      {shown(value.value)}
    </span>
  );
  if (typeof value.value === "boolean")
    return (
      <label className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {reading}
        <Switch
          checked={value.value}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
          aria-label={label}
        />
      </label>
    );
  const ranged = value.min !== undefined && value.max !== undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {reading}
      </div>
      {ranged ? (
        <input
          type="range"
          aria-label={label}
          min={value.min}
          max={value.max}
          step={value.step ?? ((value.max ?? 1) - (value.min ?? 0)) / 100}
          value={value.value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className={cn(
            "h-4 w-full cursor-pointer disabled:cursor-default disabled:opacity-50",
            was !== undefined ? "accent-primary" : "accent-foreground",
          )}
        />
      ) : (
        <p className="text-xs text-muted-foreground">No range set, so it has no slider.</p>
      )}
    </div>
  );
}

/** Base64 bytes of a data URL. */
const dataUrlBytes = (dataUrl: string) => {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return (
    Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0)
  );
};

/**
 * A line to the agent about this thing, sent as the person's own queued
 * message (the way a pick is): the frame as an image, then what the thing is.
 */
function AskSection({
  threadRef,
  selection,
}: {
  threadRef: ScopedThreadRef;
  selection: StageSelection;
}) {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const writer = useGameStageAccess(threadRef) === "writer";
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showDockTab = useGameWorkspaceStore((state) => state.showDockTab);
  const send = async () => {
    const line = text.trim();
    const shell = readThreadShell(threadRef);
    if (line === "" || shell === null) return;
    setSending(true);
    setError(null);
    const png = await captureStageFrame();
    const sent = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: `${line}\n\n${gameStageAskContext(selection)}`,
          attachments:
            png === null
              ? []
              : [
                  {
                    type: "image",
                    name: `${selection.thing.name.replace(/[^\w.-]+/g, "-")}-frame.png`,
                    mimeType: "image/png",
                    sizeBytes: dataUrlBytes(png),
                    dataUrl: png,
                  },
                ],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "queue",
      },
    });
    setSending(false);
    if (sent._tag === "Failure") {
      setError(String(squashAtomCommandFailure(sent)));
      return;
    }
    setText("");
    showDockTab("chat");
  };
  return (
    <Section title="Ask" aside={`About the ${selection.thing.name.toLowerCase()}`}>
      <Textarea
        size="sm"
        value={text}
        placeholder={`What should change about the ${selection.thing.name.toLowerCase()}?`}
        disabled={!writer || sending}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          Sends this frame, the {selection.thing.name.toLowerCase()}, its values and its last 10
          seconds of path.
        </span>
        <Button
          size="icon-sm"
          aria-label="Send to the agent"
          disabled={!writer || sending || text.trim() === ""}
          onClick={() => void send()}
        >
          <ArrowUpIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </Section>
  );
}

const KIND_GROUPS: ReadonlyArray<{ readonly kind: GameThing["kind"]; readonly label: string }> = [
  { kind: "character", label: "Characters" },
  { kind: "creature", label: "Creatures" },
  { kind: "prop", label: "Props" },
  { kind: "level", label: "Level" },
  { kind: "effect", label: "Effects" },
  { kind: "ui", label: "Interface" },
  { kind: "rule", label: "Rules" },
  { kind: "sound", label: "Sound" },
  { kind: "other", label: "Other" },
];

/** Everything the game registered, on screen or not; choosing one opens its Inspector. */
function ThingsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const threadKey = scopedThreadKey(threadRef);
  const things = useThreadStageBridge(threadKey, (state) => state.things, NO_THINGS);
  const selectedId = useThreadStageBridge(
    threadKey,
    (state) => state.selected?.thing.id ?? null,
    null,
  );
  const notice = useSelectNotice(threadRef);
  const [query, setQuery] = useState("");
  if (notice !== null) return <Notice>{notice}</Notice>;
  const words = query.trim().toLowerCase();
  const shownThings =
    words === ""
      ? things
      : things.filter(
          (thing) =>
            thing.name.toLowerCase().includes(words) || thing.id.toLowerCase().includes(words),
        );
  return (
    <div className="flex flex-col gap-1 p-3">
      <Input
        size="sm"
        type="search"
        value={query}
        placeholder="Find a thing"
        aria-label="Find a thing"
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {things.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          The game has registered no things yet. Ask your agent to name them with ctx.thing.
        </p>
      ) : null}
      {KIND_GROUPS.map((group) => {
        const rows = shownThings.filter((thing) => thing.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <section key={group.kind} aria-label={group.label} className="flex flex-col">
            <h4 className="flex gap-1.5 px-2 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
              {group.label}
              <span className="font-normal text-muted-foreground/70">{rows.length}</span>
            </h4>
            {rows.map((thing) => {
              const hasBody = thing.kind !== "rule" && thing.kind !== "sound";
              return (
                <button
                  key={thing.id}
                  type="button"
                  aria-current={selectedId === thing.id ? "true" : undefined}
                  onClick={() => selectStageThing(thing.id)}
                  onPointerEnter={() => hoverStageThing(thing.id)}
                  onPointerLeave={() => hoverStageThing(null)}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
                    selectedId === thing.id && "bg-accent",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      !hasBody
                        ? "invisible"
                        : thing.onScreen
                          ? "bg-success"
                          : "border border-muted-foreground/60",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{thing.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {thing.values !== undefined && thing.values.length > 0
                      ? `${thing.values.length} ${thing.values.length === 1 ? "value" : "values"}`
                      : hasBody
                        ? thing.onScreen
                          ? "on screen"
                          : "off screen"
                        : ""}
                  </span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

const NO_THINGS: ReadonlyArray<GameThing> = [];

/** The newest build's facts, as the build strip's detail shows them. */
function FactsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const list = useEnvironmentQuery(
    gameEnvironment.builds({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  ).data;
  const writer = useGameStageAccess(threadRef) === "writer";
  const requestStage = useGameWorkspaceStore((state) => state.requestStage);
  const build =
    list === null
      ? null
      : (list.builds.find((entry) => entry.id === list.current) ?? list.builds[0] ?? null);
  if (list === null) return <Notice>Reading the builds…</Notice>;
  if (build === null)
    return <Notice>No builds yet. Each turn that changes the game becomes one.</Notice>;
  return (
    <div className="p-4">
      <GameBuildDetail
        threadRef={threadRef}
        build={build}
        list={list}
        loaded={list.builds}
        writer={writer}
        turnRunning={false}
        runActive={false}
        onCompare={(other) =>
          requestStage(
            other === null ? { kind: "compare" } : { kind: "compare", pair: [refOf(build), other] },
          )
        }
        onPlay={(target) => requestStage({ kind: "play", build: refOf(target) })}
      />
    </div>
  );
}
