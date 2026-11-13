"use client";

import { showOpenGameDialog, useNewGame } from "./game/gameEntryStore";
import { useTurnUndo } from "./game/useBuildActions";
import { useKeepGoing } from "./game/useKeepGoing";
import {
  CHARACTER_ROUTES,
  useCharacterRoute,
  useCharacterRouteBlockers,
} from "./game/GameCharacterRoute";
import { keepGoingControlView } from "./game/keepGoing.logic";
import { scopeProjectRef, scopeThreadRef } from "@kurambit/client-runtime/environment";
import {
  canCreateProjectInEnvironment,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
  getCloneDirectoryName,
  getNewProjectPathPreview,
  normalizePastedCloneUrl,
  addProjectRemoteSourceLabel,
  addProjectRemoteSourcePathHint,
  addProjectRemoteSourceProvider,
  buildAddProjectRemoteSourceReadiness,
  sortAddProjectProviderSources,
  type AddProjectRemoteSource,
  type AddProjectRemoteSourceReadiness,
} from "@kurambit/client-runtime/operations/projects";
import { connectionStatusText } from "@kurambit/client-runtime/connection";
import { threadSearchMatchKey } from "@kurambit/client-runtime/state/thread-search";
import { resolveThreadReferenceCopyTarget } from "@kurambit/shared/threadReference";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@kurambit/client-runtime/state/filesystem";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@kurambit/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  type ClientSettings,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type FilesystemBrowseResult,
  type GameAction,
  GAME_ENGINES,
  type ProjectId,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  type ThreadId,
  resolveEnvironmentMachineKind,
} from "@kurambit/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CornerLeftUpIcon,
  FileSearchIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Gamepad2Icon,
  MaximizeIcon,
  ColumnsIcon,
  PersonStandingIcon,
  FastForwardIcon,
  HistoryIcon,
  MessageSquareDashedIcon,
  LinkIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PackageIcon,
  PlayIcon,
  Redo2Icon,
  PanelRightIcon,
  Undo2Icon,
  WrenchIcon,
  PaletteIcon,
  ImagesIcon,
  RotateCcwIcon,
  SettingsIcon,
  SkipForwardIcon,
  SquarePenIcon,
  ShapesIcon,
  SwatchBookIcon,
  StepForwardIcon,
  SquarePlusIcon,
  SearchCodeIcon,
  PauseIcon,
  HashIcon,
  HammerIcon,
  CrosshairIcon,
  CircleStopIcon,
  BrushIcon,
  SunIcon,
  TextSearchIcon,
} from "lucide-react";
import { requestThreadFindOpen } from "./chat/threadFindActionBus";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import {
  composerPromptLink,
  copyPromptLink,
  promptLinkRepositoryOf,
} from "./promptLinks/copyPromptLink";
import { useClientSettings } from "../hooks/useSettings";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { BUILT_IN_THEMES } from "@kurambit/shared/themePalettes";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { readLocalApi } from "../localApi";

import { filesystemEnvironment, useFilesystemReadAccess } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { gameEnvironment, stageAfterGameAction } from "../state/game";
import { useGameWorkspaceStore, type GameStageRequest } from "../gameWorkspaceStore";
import { useIsGameThread, useIsGameThreadStatus } from "../hooks/useIsGameThread";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useScratchProject } from "../hooks/useScratchProject";
import { useNewProject } from "../hooks/useNewProject";
import { isScratchProject } from "@kurambit/client-runtime/state/projects";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useProjects, useThreadShells, waitForProject } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "../lib/projectPaths";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject } from "../lib/threadSort";
import {
  cn,
  getLocalFileManagerName,
  isMacPlatform,
  isWindowsPlatform,
  newProjectId,
} from "../lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";

import {
  ADDON_ICON_CLASS,
  browseInputEndPaddingClass,
  buildBrowseGroups,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  filterPinnedBrowseEntries,
  getCommandPaletteInputPlaceholder,
  getCommandPaletteMode,
  ITEM_ICON_CLASS,
  RECENT_GAME_LIMIT,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import {
  orderItemsByPreferredIds,
  partitionGameChats,
  resolveGameSidebarStatus,
  sortLogicalProjectsForSidebar,
} from "./Sidebar.logic";
import { PaletteGameIcon, PaletteGameStatus } from "./CommandPaletteGameRow";
import { useGameLibrary } from "./game/useGameLibrary";
import { resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import {
  isAdvancedSetting,
  searchSettings,
  SETTINGS_SECTION_LABELS,
  settingsSearchLocation,
} from "./settings/settingsSearch";
import {
  COMMAND_PALETTE_META_ICON_CLASS,
  CommandPaletteMetaDot,
  ThreadCommandSubtitle,
} from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "./ui/command";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

function getEnvironmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") {
    return "Win32";
  }
  if (os === "darwin") {
    return "MacIntel";
  }
  if (os === "linux") {
    return "Linux";
  }
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

interface AddProjectEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly status: string;
}

type AddProjectCloneFlow =
  | {
      readonly step: "repository";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
    }
  | {
      readonly step: "confirm";
      readonly environmentId: EnvironmentId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: SourceControlRepositoryInfo | null;
      readonly remoteUrl: string;
    };

function remoteProjectSourceIcon(source: AddProjectRemoteSource, className: string): ReactNode {
  return <LinkIcon className={className} />;
}

function projectFaviconIcon(project: Project): ReactNode {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

function remoteProjectInputPlaceholder(flow: AddProjectCloneFlow | null): string | null {
  if (!flow) return null;
  if (flow.step === "confirm") return null;
  if (flow.source === "url") {
    return "Enter Git clone URL";
  }
  return `Enter ${addProjectRemoteSourceLabel(flow.source)} repository (${addProjectRemoteSourcePathHint(flow.source)})`;
}

function buildPaletteRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const readiness = buildAddProjectRemoteSourceReadiness(discovery);
  return (source) => {
    const entry = readiness(source);
    return entry.hint === null
      ? entry
      : {
          ...entry,
          hint: entry.hint.replace(
            "Open Source Control settings",
            "Open Settings -> Source Control",
          ),
        };
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "An error occurred.";
}

// What a permission reads as with no thread to ask about.
const NO_PERMISSION = Atom.make(false);

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
  "projectSearch.toggle": "content",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

// Each helper reads its own source hook so the compiler caches the derived value on that
// source. Taking the source as an argument instead leaves the helper hook-free, and the
// compiler then treats it as a plain function and caches nothing.
function useThemeCards() {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const seen = new Set<string>();
  return [
    ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
    ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
      .filter((definition) => {
        if (seen.has(definition.id)) return false;
        seen.add(definition.id);
        return true;
      })
      .map(getThemeCardDefinition),
  ];
}

function useThreadSearchWithContentMatches(
  environmentIds: ReadonlyArray<EnvironmentId>,
  query: string,
) {
  const threadSearch = useThreadSearch(environmentIds, query);
  const contentMatchByKey = new Map(
    threadSearch.matches.flatMap((match) =>
      match.source === "user" || match.source === "assistant"
        ? [[threadSearchMatchKey(match), match] as const]
        : [],
    ),
  );
  return { threadSearch, contentMatchByKey };
}

function useEnvironmentLookups() {
  const { environments } = useEnvironments();
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectEnvironmentLocationById = new Map(
    environments.map((environment) => {
      return [
        environment.environmentId,
        {
          kind: "local",
          label: "Local",
          machine: resolveEnvironmentMachineKind(environment.serverConfig),
        },
      ] as const;
    }),
  );
  return { environmentLabelById, projectEnvironmentLocationById };
}

function useProjectLookups() {
  const projects = useProjects();
  const projectCwdById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.workspaceRoot]),
  );
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const projectTitleById = new Map<ProjectId, string>(
    projects.map((project) => [project.id, project.title]),
  );
  return { projectCwdById, projectByKey, projectTitleById };
}

const selectCommandPaletteClientSettings = (settings: ClientSettings) => ({
  sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
  sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  sidebarProjectSortOrder: settings.sidebarProjectSortOrder,
  sidebarThreadSortOrder: settings.sidebarThreadSortOrder,
});

function useSortedProjectGroups(environmentLabelById: ReadonlyMap<EnvironmentId, string>) {
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = {
    sidebarProjectGroupingMode: clientSettings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: clientSettings.sidebarProjectGroupingOverrides,
  };
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const unsortedProjectGroups = buildSidebarProjectSnapshots({
    projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  return sortLogicalProjectsForSidebar(
    unsortedProjectGroups,
    threads,
    clientSettings.sidebarProjectSortOrder,
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = (open: boolean) => dispatch({ _tag: "SetOpen", open });
  const toggleMode = (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode });
  const openAddProject = () => dispatch({ _tag: "OpenAddProject" });
  const openNewThreadIn = () => dispatch({ _tag: "OpenNewThreadIn" });
  const clearOpenIntent = () => dispatch({ _tag: "ClearOpenIntent" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useThreadRouteTarget();
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.open === "new-thread-in") {
          openNewThreadIn();
        } else if (detail.open === "add-project") {
          openAddProject();
        } else if (detail.query !== undefined) {
          dispatch({
            _tag: "OpenSearch",
            query: detail.query,
            ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
          });
        } else {
          setOpen(true);
        }
      }),
    [openAddProject, openNewThreadIn, setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

// A game's bindings apply only on its screen ("when": gameThread); over that screen the
// palette shows their keys.
const GAME_SHORTCUT_CONTEXT = { gameThread: true } as const;

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const newGame = useNewGame();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { clearOpenIntent, openIntent, openOverlayMode, setOpen } = props;
  const [query, setQuery] = useState(openIntent?.kind === "search" ? openIntent.query : "");
  const [linkedThreadSearch, setLinkedThreadSearch] = useState(
    openIntent?.kind === "search" ? openIntent : null,
  );
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  const highlightClearedRef = useRef(false);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
  const createProject = useAtomCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const paletteRouteTarget = useThreadRouteTarget();
  const projects = useProjects();
  const activeThreadRef =
    activeThread === null ? null : scopeThreadRef(activeThread.environmentId, activeThread.id);
  // The same signal the game stage uses: the palette only leads with game
  // commands where the workspace has a game.
  const isGameThread = useIsGameThread(activeThreadRef);
  // The same status read the stage mounts: Play exists only for an engine that
  // makes a Web build, and Rebuild only where the Stage plays an export.
  // A parked engine's game builds and plays nothing, so it gets no play commands.
  const gameStatus = useIsGameThreadStatus(activeThreadRef).data;
  const gameEngineActive =
    gameStatus != null && GAME_ENGINES[gameStatus.manifest.engine.name].status === "active";
  const gameWebBuild = gameEngineActive && gameStatus?.exportTargets.includes("Web") === true;
  const gameStageKind =
    gameEngineActive && gameStatus != null
      ? GAME_ENGINES[gameStatus.manifest.engine.name].stage
      : null;
  // Running is the live serve, or an export's preview, as the Stage reads them: the palette
  // offers Play or Stop, whichever applies, never both.
  const gameRunning = gameStatus?.live === "serving" || gameStatus?.previewUrl != null;
  const gameStageBridge =
    gameStatus !== null &&
    gameStatus !== undefined &&
    GAME_ENGINES[gameStatus.manifest.engine.name].stageBridge;
  const gameAction = useAtomCommand(gameEnvironment.action, { reportFailure: false });
  const canRestore = useAtomValue(
    activeThreadRef === null
      ? NO_PERMISSION
      : gameEnvironment.buildRestore.permissionAtom(activeThreadRef.environmentId),
  );
  // Each game command shows only where its own command is permitted.
  const canGameAction = useAtomValue(
    activeThreadRef === null
      ? NO_PERMISSION
      : gameEnvironment.action.permissionAtom(activeThreadRef.environmentId),
  );
  // The game's latest turn build: the palette offers the Undo or Redo its strip does.
  const turnUndo = useTurnUndo(isGameThread ? activeThreadRef : null, null);
  const keepGoing = useKeepGoing(isGameThread ? activeThreadRef : null);
  const characterRoute = useCharacterRoute(isGameThread ? activeThreadRef : null);
  const characterRouteBlocker = useCharacterRouteBlockers(
    isGameThread && characterRoute.canSet ? (activeThreadRef?.environmentId ?? null) : null,
  );

  const activeThreadReferenceCopyTarget =
    activeThread === null
      ? null
      : resolveThreadReferenceCopyTarget({
          threadId: activeThread.id,
        });
  const copyActiveThreadReference = async () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    try {
      const didCopy = await writeTextToClipboard(target.value, target.clipboardTarget);
      if (!didCopy) return;
      toastManager.add({
        type: "success",
        title: target.successTitle,
        description: target.value,
      });
    } catch (error) {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: target.failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  const threads = useThreadShells();
  const { games } = useGameLibrary();
  const gameByProjectKey = new Map<string, (typeof games)[number]>(
    games.map((game) => [`${game.environmentId}:${game.projectId}`, game]),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const themeCards = useThemeCards();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  const providerEntryByEnvironmentAndInstanceId = new Map<string, ProviderInstanceEntry>(
    environments.flatMap((environment) => {
      const serverConfig = environment.serverConfig;
      const derived = deriveProviderInstanceEntries(
        providersByEnvironment.get(environment.environmentId) ??
          (environment.environmentId === primaryEnvironmentId ? providers : []),
      );
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      return entries.map(
        (entry) => [`${environment.environmentId}:${entry.instanceId}`, entry] as const,
      );
    }),
  );
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const { threadSearch, contentMatchByKey: threadContentMatchByKey } =
    useThreadSearchWithContentMatches(environmentIds, threadSearchQuery);
  const [browseGeneration, setBrowseGeneration] = useState(0);
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [addProjectEnvironmentId, setAddProjectEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [addProjectCloneFlow, setAddProjectCloneFlow] = useState<AddProjectCloneFlow | null>(null);
  const [newProjectFlow, setNewProjectFlow] = useState<{
    readonly environmentId: EnvironmentId;
    readonly sourcesEnvironmentId: EnvironmentId | null;
  } | null>(null);
  const [isCreatingNewProject, setIsCreatingNewProject] = useState(false);
  // State lags a render behind, so a repeated Enter could start a second create.
  const newProjectSubmittingRef = useRef(false);
  const createNewProject = useNewProject();
  const cloneLookupGeneration = useRef(0);
  const [isRemoteProjectLookingUp, setIsRemoteProjectLookingUp] = useState(false);
  const [isRemoteProjectCloning, setIsRemoteProjectCloning] = useState(false);
  const { environmentLabelById, projectEnvironmentLocationById } = useEnvironmentLookups();
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: projectGroups,
    preferredProjectRef: contextualProjectRef,
  });
  const pickerProjects = projectPickerEntries.map(({ group, targetProject }) => ({
    ...targetProject,
    displayName: group.displayName,
  }));
  const projectGroupByTargetKey = new Map(
    projectPickerEntries.map(({ group, targetProject }) => [
      `${targetProject.environmentId}:${targetProject.id}`,
      group,
    ]),
  );

  const addProjectEnvironmentOptions = (() => {
    const options = environments
      .filter((environment) => canCreateProjectInEnvironment(environment.connection.phase))
      .map((environment): AddProjectEnvironmentOption => {
        const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
        return {
          environmentId: environment.environmentId,
          label: resolveEnvironmentOptionLabel({
            isPrimary,
            environmentId: environment.environmentId,
            runtimeLabel: environment.label,
          }),
          isPrimary,
          machine: resolveEnvironmentMachineKind(environment.serverConfig),
          isConnected: canCreateProjectInEnvironment(environment.connection.phase),
          status: connectionStatusText(environment.connection),
        };
      });

    options.sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) {
        return left.isPrimary ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });

    return options;
  })();
  const defaultAddProjectEnvironmentId =
    addProjectEnvironmentOptions.find((option) => option.isConnected)?.environmentId ?? null;

  const browseEnvironmentId = addProjectEnvironmentId ?? defaultAddProjectEnvironmentId;
  const canCreateProject = useEnvironmentScope(browseEnvironmentId, AuthOrchestrationOperateScope);
  const browseEnvironment =
    environments.find((environment) => environment.environmentId === browseEnvironmentId) ?? null;
  const browseEnvironmentPlatform = getEnvironmentBrowsePlatform(
    browseEnvironment?.serverConfig?.environment.platform.os,
  );
  const isRemoteProjectCloneFlow = addProjectCloneFlow !== null;
  const isRemoteProjectRepositoryStep = addProjectCloneFlow?.step === "repository";
  const pinnedCloneDirectoryName =
    addProjectCloneFlow?.step === "confirm"
      ? getCloneDirectoryName(
          addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.remoteUrl,
        )
      : "";
  const browsePath = getFilesystemBrowsePath(
    query,
    browseEnvironmentPlatform,
    browseEnvironmentId !== null && !isRemoteProjectRepositoryStep && newProjectFlow === null,
  );
  const isBrowsing = browsePath.isBrowsing;
  const browseDirectoryPath = browsePath.directoryPath;
  const paletteMode = getCommandPaletteMode({ currentView, isBrowsing });
  const getAddProjectInitialQueryForEnvironment = (environmentId: EnvironmentId | null): string => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    const environmentSettings = environment?.serverConfig?.settings ?? null;
    const baseDirectory = environmentSettings?.addProjectBaseDirectory?.trim() ?? "";
    if (baseDirectory.length === 0) {
      return "~/";
    }
    return ensureBrowseDirectoryPath(baseDirectory);
  };

  const { projectCwdById, projectByKey, projectTitleById } = useProjectLookups();

  const activeThreadId = activeThread?.id;
  const supportsThreadFind =
    environments.find((environment) => environment.environmentId === activeThread?.environmentId)
      ?.serverConfig?.threadFind === true;
  const currentProjectEnvironmentId =
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? null;
  const currentProjectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    currentProjectEnvironmentId ?? primaryEnvironmentId,
  );
  const currentProjectCwd = currentProjectId
    ? (projectCwdById.get(currentProjectId) ?? null)
    : null;
  const currentProjectCwdForBrowse =
    browseEnvironmentId && currentProjectEnvironmentId === browseEnvironmentId
      ? currentProjectCwd
      : null;
  const getBrowseCwdForEnvironment = (environmentId: EnvironmentId | null): string | null =>
    environmentId && currentProjectEnvironmentId === environmentId ? currentProjectCwd : null;
  const relativePathNeedsActiveProject =
    isExplicitRelativeProjectPath(query.trim()) && currentProjectCwdForBrowse === null;
  const browseAccess = useFilesystemReadAccess(browseEnvironmentId);
  const hasBrowseTarget =
    isBrowsing &&
    browsePath.directoryPath.length > 0 &&
    browseEnvironmentId !== null &&
    !relativePathNeedsActiveProject;
  const browseQuery = useEnvironmentQuery(
    browseAccess.canReadFiles && hasBrowseTarget
      ? filesystemEnvironment.browse({
          environmentId: browseEnvironmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwdForBrowse ? { cwd: currentProjectCwdForBrowse } : {}),
          },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  const isBrowsePending = hasBrowseTarget && (browseAccess.isPending || browseQuery.isPending);
  const browseAccessError =
    hasBrowseTarget && !browseAccess.isPending && !browseAccess.canReadFiles
      ? (browseAccess.error ?? "This connection cannot browse host folders.")
      : null;
  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries: visibleBrowseEntries, exactEntry: exactBrowseEntry } =
    pinnedCloneDirectoryName
      ? filterPinnedBrowseEntries({
          browseEntries,
          filterQuery: browsePath.filterQuery,
          pinnedDirectoryName: pinnedCloneDirectoryName,
          caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
        })
      : filterFilesystemBrowseEntries(browseEntries, browsePath.filterQuery);

  const prefetchBrowsePath = async (
    partialPath: string,
    environmentId: EnvironmentId | null = browseEnvironmentId,
    cwd: string | null = currentProjectCwdForBrowse,
  ): Promise<void> => {
    if (!environmentId) {
      return;
    }
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope) ||
      !canPreloadBrowsePath(environment?.connection.phase)
    ) {
      return;
    }

    await loadBrowsePath({
      environmentId,
      input: {
        partialPath,
        ...(cwd ? { cwd } : {}),
      },
    });
  };

  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  const projectThreadItems = (() => {
    const isScratch = (project: CommandPaletteProject) =>
      isScratchProject(project, scratchWorkspaceRootFor(project.environmentId));
    const projectItems = enumerateCommandPaletteItems(
      buildProjectActionItems({
        projects: pickerProjects.filter((project) => !isScratch(project)),
        valuePrefix: "new-thread-in",
        searchTerms: (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const location = projectEnvironmentLocationById.get(project.environmentId);
          return [
            ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ??
              []),
            ...(location ? [location.label] : []),
          ];
        },
        renderDescription: (project) => {
          const location = projectEnvironmentLocationById.get(project.environmentId) ?? {
            kind: "remote",
            label: "Remote",
            machine: "server" as const,
          };
          return (
            <span className="flex min-w-0 items-center gap-1">
              <span className="inline-flex min-w-0 items-center gap-1">
                {location.kind === "remote" ? (
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={location.machine}
                    className={COMMAND_PALETTE_META_ICON_CLASS}
                  />
                ) : null}
                <span className="truncate">{location.label}</span>
              </span>
              <CommandPaletteMetaDot />
              <span className="truncate">{project.workspaceRoot}</span>
            </span>
          );
        },
        icon: projectFaviconIcon,
        runProject: async (project) => {
          const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
          const contextualRefBelongsToGroup =
            contextualProjectRef !== null &&
            group?.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === contextualProjectRef.environmentId &&
                projectRef.projectId === contextualProjectRef.projectId,
            );
          await handleNewThread(
            contextualRefBelongsToGroup
              ? contextualProjectRef
              : scopeProjectRef(project.environmentId, project.id),
          );
        },
      }),
    );
    if (scratchTargetEnvironmentId === null) return projectItems;

    const noProjectIndex = pickerProjects[0] !== undefined && isScratch(pickerProjects[0]) ? 0 : 1;
    return [
      ...projectItems.slice(0, noProjectIndex),
      {
        kind: "action" as const,
        value: "new-thread-in:no-project",
        searchTerms: ["no project", "without project", "none"],
        title: "No project",
        icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newWithoutProject" as const,
        run: () => startScratchThread(scratchTargetEnvironmentId),
      },
      ...projectItems.slice(noProjectIndex),
    ];
  })();

  const allThreadItems = buildThreadActionItems({
    threads,
    ...(activeThreadId ? { activeThreadId } : {}),
    projectTitleById,
    sortOrder: clientSettings.sidebarThreadSortOrder,
    icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
    renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
    renderTrailingContent: (thread) => (
      <>
        <ThreadRowTrailingStatus thread={thread} />
      </>
    ),
    renderDescription: (thread, { projectTitle }) => {
      const modelInstanceId =
        thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
      const providerEntry =
        providerEntryByEnvironmentAndInstanceId.get(`${thread.environmentId}:${modelInstanceId}`) ??
        null;
      return (
        <ThreadCommandSubtitle
          project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
          projectTitle={projectTitle ?? null}
          environmentLabel={
            projectEnvironmentLocationById.get(thread.environmentId)?.label ?? "Remote"
          }
          branch={thread.branch}
          worktreePath={thread.worktreePath}
          isCurrent={thread.id === activeThreadId}
          driverKind={providerEntry?.driverKind ?? null}
          providerDisplayName={
            thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
          }
          acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
        />
      );
    },
    getContentMatch: (thread) => {
      const match = threadContentMatchByKey.get(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      );
      return match && (match.source === "user" || match.source === "assistant")
        ? {
            source: match.source,
            snippet: match.snippet,
            query: threadSearch.query,
          }
        : undefined;
    },
    runThread: async (thread) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
  });
  // The palette's games are the sidebar's: one row per game, latest first, that opens its
  // main Log and reads like the sidebar's (still, name, latest status). Projects that are
  // not games, and their threads, stay out; the Developer view still reaches them.
  const threadShellById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const gameRowItems: CommandPaletteActionItem[] = [];
  {
    const threadById = threadShellById;
    const liveThreadIds = new Set<string>(
      threads.filter((thread) => thread.deletedAt === null).map((thread) => thread.id),
    );
    const seenGames = new Set<string>();
    for (const item of allThreadItems) {
      const thread = threadById.get(item.value.slice("thread:".length) as ThreadId);
      const gameKey = thread ? `${thread.environmentId}:${thread.projectId}` : null;
      const game = gameKey === null ? undefined : gameByProjectKey.get(gameKey);
      if (thread === undefined || gameKey === null || game === undefined) continue;
      if (seenGames.has(gameKey)) continue;
      seenGames.add(gameKey);
      const chats = partitionGameChats(
        threads.filter(
          (candidate) => `${candidate.environmentId}:${candidate.projectId}` === gameKey,
        ),
        liveThreadIds,
      );
      const main = chats.main ?? thread;
      const chatsStatus = resolveGameSidebarStatus(chats);
      gameRowItems.push({
        kind: "action",
        value: `game:${gameKey}`,
        searchTerms: [game.name, "game"],
        title: game.name,
        description: <PaletteGameStatus game={game} main={main} chats={chatsStatus} />,
        icon: <PaletteGameIcon game={game} main={main} chats={chatsStatus} />,
        ...(item.searchRecency === undefined ? {} : { searchRecency: item.searchRecency }),
        run: async () => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(main.environmentId, main.id)),
          });
        },
      });
    }
  }

  // An empty palette leads with where to go: the latest few games, not the one already open.
  const openGameValue =
    isGameThread && activeThread !== null
      ? `game:${activeThread.environmentId}:${activeThread.projectId}`
      : null;
  const recentThreadItems = gameRowItems
    .filter((item) => item.value !== openGameValue)
    .slice(0, RECENT_GAME_LIMIT);
  // Search finds the Logs of the sidebar's games only.
  const gameThreadItems = allThreadItems.filter((item) => {
    const thread = threadShellById.get(item.value.slice("thread:".length) as ThreadId);
    return (
      thread !== undefined && gameByProjectKey.has(`${thread.environmentId}:${thread.projectId}`)
    );
  });

  // Stable so the item builders that capture it during render never see the
  // highlight ref it writes.
  const pushPaletteView = useStableCallback((view: CommandPaletteView): void => {
    browseNavigation.invalidate();
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: view.addonIcon,
        groups: view.groups,
        ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
      },
    ]);
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  });

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    browseNavigation.invalidate();
    setAddProjectCloneFlow(null);
    setNewProjectFlow(null);
    if (viewStack.length <= 1) {
      setAddProjectEnvironmentId(null);
    } else if (newProjectFlow?.sourcesEnvironmentId) {
      setAddProjectEnvironmentId(newProjectFlow.sourcesEnvironmentId);
    }
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    browseNavigation.invalidate();
    clearTypedHighlight();
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  const startAddProjectBrowse = async (environmentId: EnvironmentId): Promise<void> => {
    const initialQuery = getAddProjectInitialQueryForEnvironment(environmentId);
    const initialBrowsePath = getBrowseDirectoryPath(initialQuery);
    const browseCwd = getBrowseCwdForEnvironment(environmentId);
    const view: CommandPaletteView = {
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [],
      initialQuery,
    };

    await browseNavigation.run(
      () =>
        initialBrowsePath.length > 0
          ? prefetchBrowsePath(initialBrowsePath, environmentId, browseCwd)
          : Promise.resolve(),
      () => {
        setAddProjectEnvironmentId(environmentId);
        setAddProjectCloneFlow(null);
        pushPaletteView(view);
      },
    );
  };

  const startAddProjectClone = (
    environmentId: EnvironmentId,
    source: AddProjectRemoteSource,
  ): void => {
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow({ step: "repository", environmentId, source });
    pushPaletteView({
      addonIcon: remoteProjectSourceIcon(source, ADDON_ICON_CLASS),
      groups: [],
      initialQuery: "",
    });
  };

  const newProjectsRootFor = (environmentId: EnvironmentId | null): string | null =>
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.newProjectsRoot ?? null;

  const startNewProject = (
    environmentId: EnvironmentId,
    sourcesEnvironmentId: EnvironmentId | null,
  ): void => {
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow(null);
    setNewProjectFlow({ environmentId, sourcesEnvironmentId });
    pushPaletteView({
      addonIcon: <FolderGit2Icon className={ADDON_ICON_CLASS} />,
      groups: [],
    });
  };

  const buildAddProjectSourceGroups = (
    environmentId: EnvironmentId,
    readinessBySource: AddProjectRemoteSourceReadiness,
  ): CommandPaletteView["groups"] => {
    const sourceItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
      {
        kind: "action",
        value: `action:add-project:${environmentId}:local`,
        searchTerms: ["local", "folder", "directory", "browse"],
        title: "Local folder",
        description: "Browse a folder on disk",
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          await startAddProjectBrowse(environmentId);
        },
      },
    ];

    if (newProjectsRootFor(environmentId) !== null) {
      sourceItems.unshift({
        kind: "action",
        value: `action:add-project:${environmentId}:new`,
        searchTerms: ["new project", "create", "empty", "repository", "git init"],
        title: "New project",
        description: "Start a new Git repository from a name",
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        run: async () => {
          startNewProject(environmentId, environmentId);
        },
      });
    }

    const orderedSources: ReadonlyArray<AddProjectRemoteSource> = [
      "url",
      ...sortAddProjectProviderSources(readinessBySource),
    ];

    for (const source of orderedSources) {
      const label = addProjectRemoteSourceLabel(source);
      const title = source === "url" ? "Git URL" : `${label} repository`;
      const description =
        source === "url"
          ? "Clone from a remote URL"
          : `Clone ${label} ${addProjectRemoteSourcePathHint(source)}`;
      const readiness = readinessBySource(source);

      const titleTrailingContent = undefined;

      if (!readiness.ready) {
        sourceItems.push({
          kind: "action",
          value: `action:add-project:${environmentId}:${source}:not-ready`,
          searchTerms: ["clone", "remote", "repository", "repo", "git", label, "setup required"],
          title,
          description,
          disabled: true,
          icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
          ...(titleTrailingContent ? { titleTrailingContent } : {}),
          run: async () => {},
        });
        continue;
      }

      sourceItems.push({
        kind: "action",
        value: `action:add-project:${environmentId}:${source}`,
        searchTerms: ["clone", "remote", "repository", "repo", "git", label],
        title,
        description,
        icon: remoteProjectSourceIcon(source, ITEM_ICON_CLASS),
        ...(titleTrailingContent ? { titleTrailingContent } : {}),
        keepOpen: true,
        run: async () => {
          startAddProjectClone(environmentId, source);
        },
      });
    }

    return [{ value: `sources:${environmentId}`, label: "Sources", items: sourceItems }];
  };

  const startAddProjectSourceSelection = (environmentId: EnvironmentId): void => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${environment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }
    setAddProjectEnvironmentId(environmentId);
    setAddProjectCloneFlow(null);
    pushPaletteView({
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: buildAddProjectSourceGroups(
        environmentId,
        buildPaletteRemoteSourceReadiness(browseEnvironmentId === environmentId ? null : null),
      ),
    });
  };

  const buildEnvironmentItem = (
    option: AddProjectEnvironmentOption,
    value: string,
    run: (environmentId: EnvironmentId) => void,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [option.label, option.environmentId, option.isPrimary ? "this device" : ""],
    title: option.label,
    description: option.isConnected
      ? option.isPrimary
        ? "This device"
        : option.environmentId
      : option.status,
    disabled: !option.isConnected,
    icon: <EnvironmentMachineIcon kind={option.machine} className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    run: async () => {
      run(option.environmentId);
    },
  });
  const addProjectEnvironmentItems = addProjectEnvironmentOptions.map((option) =>
    buildEnvironmentItem(
      option,
      `action:add-project:environment:${option.environmentId}`,
      startAddProjectSourceSelection,
    ),
  );
  const newProjectEnvironmentOptions = addProjectEnvironmentOptions.filter(
    (option) => option.isConnected && newProjectsRootFor(option.environmentId) !== null,
  );

  const addProjectEnvironmentGroups = [
    {
      value: "environments",
      label: "Environments",
      items: addProjectEnvironmentItems,
    },
  ];

  const openAddProjectFlow = () => {
    if (addProjectEnvironmentOptions.length === 0) {
      setOpen(false);
      void navigate({ to: "/settings/connections" });
      return;
    }

    if (addProjectEnvironmentOptions.length > 1 || defaultAddProjectEnvironmentId === null) {
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: addProjectEnvironmentGroups,
      });
      return;
    }

    void startAddProjectSourceSelection(defaultAddProjectEnvironmentId);
  };

  const openNewProjectFlow = () => {
    const firstOption = newProjectEnvironmentOptions[0];
    if (firstOption) startNewProject(firstOption.environmentId, null);
  };

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  if (isGameThread && activeThreadRef !== null) {
    const threadRef = activeThreadRef;
    const runGameAction = (action: GameAction) => async (): Promise<void> => {
      const result = await gameAction({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, action },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!result.value.success) throw new Error(result.value.message);
      stageAfterGameAction(threadRef, action);
    };
    if (canGameAction && gameWebBuild && !gameRunning)
      actionItems.push({
        kind: "action",
        value: "action:game-play",
        title: "Play game",
        searchTerms: ["play", "run", "preview", "game"],
        icon: <PlayIcon className={ITEM_ICON_CLASS} />,
        run: runGameAction("preview"),
      });
    if (canGameAction && gameWebBuild && gameStageKind === "export")
      actionItems.push({
        kind: "action",
        value: "action:game-rebuild",
        title: "Rebuild game",
        searchTerms: ["rebuild", "build", "export", "game"],
        icon: <HammerIcon className={ITEM_ICON_CLASS} />,
        run: runGameAction("rebuild"),
      });
    if (canGameAction && gameRunning)
      actionItems.push({
        kind: "action",
        value: "action:game-stop",
        title: "Stop game",
        searchTerms: ["stop", "close", "quit", "game"],
        icon: <CircleStopIcon className={ITEM_ICON_CLASS} />,
        run: runGameAction("stop"),
      });
    actionItems.push({
      kind: "action",
      value: "action:game-toggle-inspector",
      title: "Show or hide builds",
      searchTerms: ["builds", "inspector", "panel", "checks", "hide", "show", "game"],
      icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "game.chat.toggle",
      run: async () => {
        useGameWorkspaceStore.getState().toggleInspector();
      },
    });
    const requestStage = (request: GameStageRequest) => async () => {
      useGameWorkspaceStore.getState().requestStage(request);
    };
    actionItems.push({
      kind: "action",
      value: "action:game-focus",
      title: "Focus game",
      searchTerms: ["focus", "play", "keyboard", "stage", "game"],
      icon: <Gamepad2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "game.focus",
      run: requestStage({ kind: "focus" }),
    });
    if (gameStageBridge)
      actionItems.push({
        kind: "action",
        value: "action:game-freeze",
        title: "Freeze or resume game",
        searchTerms: ["freeze", "pause", "point", "select", "inspect", "stage", "game"],
        icon: <CrosshairIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "game.freeze",
        run: requestStage({ kind: "freeze" }),
      });
    actionItems.push({
      kind: "action",
      value: "action:game-fullscreen",
      title: "Play fullscreen",
      searchTerms: ["fullscreen", "full screen", "maximize", "stage", "game"],
      icon: <MaximizeIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "game.fullscreen",
      run: requestStage({ kind: "fullscreen" }),
    });
    actionItems.push({
      kind: "action",
      value: "action:game-look",
      title: "Look…",
      searchTerms: ["look", "style", "art", "characters", "palette", "game"],
      icon: <ShapesIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        useGameWorkspaceStore.getState().setLookOpen(true);
      },
    });
    // The game's latest turn build, the one the timeline selects by default.
    const latestBuild = turnUndo.view?.build ?? null;
    if (latestBuild !== null) {
      actionItems.push({
        kind: "action",
        value: "action:game-play-previous",
        title: "Play previous build",
        searchTerms: ["previous", "back", "older", "build", "turn", "timeline", "game"],
        icon: <ChevronLeftIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "game.playPrevious",
        run: requestStage({ kind: "step", by: -1 }),
      });
      actionItems.push({
        kind: "action",
        value: "action:game-play-next",
        title: "Play next build",
        searchTerms: ["next", "forward", "newer", "live", "build", "turn", "timeline", "game"],
        icon: <ChevronRightIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "game.playNext",
        run: requestStage({ kind: "step", by: 1 }),
      });
    }
    // The latest build's detail, where Go back picks any build on the timeline.
    if (canRestore && latestBuild !== null)
      actionItems.push({
        kind: "action",
        value: "action:game-build-restore",
        title: "Go back to a build…",
        searchTerms: ["restore", "undo", "back", "revert", "build", "version", "game"],
        icon: <HistoryIcon className={ITEM_ICON_CLASS} />,
        run: requestStage({ kind: "detail", build: { _tag: "build", build: latestBuild.id } }),
      });
    const turnRestore = turnUndo.action;
    if (
      turnRestore !== null &&
      turnRestore.kind !== "go-back" &&
      turnRestore.blocked === null &&
      turnUndo.canRestore &&
      !turnUndo.pending
    )
      actionItems.push({
        kind: "action",
        value: `action:game-turn-${turnRestore.kind}`,
        title: turnRestore.kind === "undo" ? "Undo last change" : "Redo last change",
        searchTerms: [turnRestore.kind, "turn", "change", "revert", "build", "game"],
        icon:
          turnRestore.kind === "undo" ? (
            <Undo2Icon className={ITEM_ICON_CLASS} />
          ) : (
            <Redo2Icon className={ITEM_ICON_CLASS} />
          ),
        shortcutCommand: turnRestore.kind === "undo" ? "game.undoTurn" : "game.redoTurn",
        // The Stage restores, so the palette, the keys and the strip share one path.
        run: requestStage({ kind: turnRestore.kind }),
      });
    actionItems.push({
      kind: "action",
      value: "action:game-build-compare",
      title: "Compare builds…",
      searchTerms: ["compare", "diff", "versions", "builds", "side by side", "game"],
      icon: <ColumnsIcon className={ITEM_ICON_CLASS} />,
      run: requestStage({ kind: "compare" }),
    });
    if (characterRoute.canSet)
      actionItems.push({
        kind: "submenu",
        value: "action:game-character-route",
        title: "Make characters with…",
        searchTerms: ["characters", "make", "library", "blender", "generated", "route", "game"],
        icon: <PersonStandingIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <PersonStandingIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "character-routes",
            label: "Make characters with",
            items: CHARACTER_ROUTES.map((option) => ({
              kind: "action",
              value: `game-character-route:${option.route}`,
              title: option.label,
              description: characterRouteBlocker(option.route) ?? option.description,
              disabled:
                characterRouteBlocker(option.route) !== null &&
                characterRoute.shown !== option.route,
              searchTerms: [option.label, "characters", "route"],
              icon: <PersonStandingIcon className={ITEM_ICON_CLASS} />,
              titleTrailingContent:
                characterRoute.shown === option.route ? (
                  <span className="text-xs text-muted-foreground/70">Current</span>
                ) : undefined,
              run: () => characterRoute.choose(option.route),
            })),
          },
        ],
      });
    // Keep going: on, off and resume, and the Guided proposal's answers. A
    // pause's reason rides on the items that resume it.
    const keepGoingStatus = keepGoing.status;
    if (keepGoingStatus !== null) {
      const control = keepGoingControlView({
        status: keepGoingStatus,
        error: keepGoing.error,
        threadId: threadRef.threadId,
        canOperate: keepGoing.canOperate,
        sending: keepGoing.sending,
        chosenBudget: keepGoing.chosenBudget,
      });
      const paused =
        keepGoingStatus.mode === "off" && keepGoingStatus.ending !== null
          ? keepGoingStatus.message
          : undefined;
      if (control.disabled === null && control.modesDisabled === null)
        for (const [mode, title] of [
          ["guided", "Keep going: Guided"],
          ["autopilot", "Keep going: Autopilot"],
        ] as const)
          if (!(control.pressed && control.value === mode))
            actionItems.push({
              kind: "action",
              value: `action:game-keep-going-${mode}`,
              title,
              ...(paused === undefined ? {} : { description: paused }),
              searchTerms: ["keep going", mode, "resume", "continue", "autonomous", "game"],
              icon: <FastForwardIcon className={ITEM_ICON_CLASS} />,
              run: () => keepGoing.choose(mode),
            });
      if (keepGoingStatus.mode !== "off" && keepGoing.canOperate)
        actionItems.push({
          kind: "action",
          value: "action:game-keep-going-stop",
          title: "Stop Keep going",
          searchTerms: ["keep going", "stop", "off", "pause", "game"],
          icon: <PauseIcon className={ITEM_ICON_CLASS} />,
          shortcutCommand: "game.keepGoing.stop",
          run: () => keepGoing.set({ mode: "off" }),
        });
      const proposal = keepGoingStatus.proposal;
      if (proposal !== null && keepGoingStatus.chat === threadRef.threadId && keepGoing.canDecide) {
        actionItems.push({
          kind: "action",
          value: "action:game-keep-going-start",
          title: "Start the proposed step now",
          description: proposal.text.split("\n")[0] ?? proposal.text,
          searchTerms: ["keep going", "start", "proposed", "step", "now", "game"],
          icon: <StepForwardIcon className={ITEM_ICON_CLASS} />,
          run: () => keepGoing.decide(proposal.stepId, "start"),
        });
        actionItems.push({
          kind: "action",
          value: "action:game-keep-going-skip",
          title: "Skip the proposed step",
          searchTerms: ["keep going", "skip", "proposed", "step", "game"],
          icon: <SkipForwardIcon className={ITEM_ICON_CLASS} />,
          run: () => keepGoing.decide(proposal.stepId, "skip"),
        });
      }
    }
    if (canGameAction && gameEngineActive)
      actionItems.push({
        kind: "action",
        value: "action:game-export",
        title: "Export game…",
        searchTerms: [
          "export",
          "release",
          "package",
          "download",
          "windows",
          "linux",
          "web",
          "game",
        ],
        icon: <PackageIcon className={ITEM_ICON_CLASS} />,
        run: requestStage({ kind: "export" }),
      });
    // Read-only for a run's role thread too: picking is guarded inside.
    actionItems.push({
      kind: "action",
      value: "action:game-generated-art",
      title: "Show generated art…",
      searchTerms: ["generated", "art", "assets", "images", "candidates", "pick", "cost", "game"],
      icon: <ImagesIcon className={ITEM_ICON_CLASS} />,
      run: requestStage({ kind: "generated-art" }),
    });
  }
  // Everything above is about the open game. Stopping it ends the group: it is reached by
  // name, not offered first to someone who opened the palette to go somewhere.
  const gameItems = actionItems.splice(0);
  const stopIndex = gameItems.findIndex((item) => item.value === "action:game-stop");
  if (stopIndex >= 0) gameItems.push(...gameItems.splice(stopIndex, 1));
  const developerItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];
  actionItems.push({
    kind: "action",
    value: "action:game-create",
    title: "New game",
    searchTerms: ["new game", "create", "start", "brief", "game studio"],
    icon: <SquarePlusIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      newGame();
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:game-open",
    title: "Open a game folder…",
    searchTerms: ["open game", "folder", "existing", "game.json"],
    icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      showOpenGameDialog();
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:game-tools",
    title: "Open game tools",
    searchTerms: ["game tools", "blender godot unity install download executable paths"],
    icon: <WrenchIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/game-tools" });
    },
  });
  actionItems.push({
    kind: "action",
    value: "action:game-art-providers",
    title: "Open art providers",
    searchTerms: [
      "art providers generated keys codex openai gemini tripo meshy elevenlabs daily limit",
    ],
    icon: <BrushIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings/art" });
    },
  });

  if (projects.length > 0) {
    const activeProjectTitle =
      projectPickerEntries.find((entry) => entry.isPreferred)?.group.displayName ??
      (currentProjectId ? (projectTitleById.get(currentProjectId) ?? null) : null);

    if (activeProjectTitle) {
      developerItems.push({
        kind: "action",
        value: "action:new-thread",
        searchTerms: ["new chat", "new thread", "create", "draft"],
        title: (
          <>
            New chat in <span className="font-semibold">{activeProjectTitle}</span>
          </>
        ),
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "chat.newLocal",
        run: async () => {
          await startNewThreadFromContext({
            activeDraftThread,
            activeThread: activeThread ?? undefined,
            defaultProjectRef,
            handleNewThread,
          });
        },
      });
    }

    developerItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new chat", "new thread", "project", "pick", "choose", "select"],
      title: "New chat in…",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
    });
  }

  if (scratchTargetEnvironmentId !== null && !isGameThread) {
    developerItems.push({
      kind: "action",
      value: "action:new-thread-without-project",
      searchTerms: ["new chat", "new thread", "no project", "without project", "none"],
      title: "New chat without a project",
      icon: <MessageSquareDashedIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newWithoutProject",
      run: () => startScratchThread(scratchTargetEnvironmentId),
    });
  }

  if (activeThreadId && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current thread",
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        requestThreadFindOpen();
      },
    });
  }

  const promptLinkTarget = paletteRouteTarget
    ? paletteRouteTarget.kind === "server"
      ? paletteRouteTarget.threadRef
      : paletteRouteTarget.draftId
    : null;
  const promptLinkProjectRef = activeThread ?? activeDraftThread;
  const promptLinkInput =
    promptLinkTarget === null
      ? null
      : {
          target: promptLinkTarget,
          project: projects.find(
            (project) =>
              project.environmentId === promptLinkProjectRef?.environmentId &&
              project.id === promptLinkProjectRef.projectId,
          ),
          providers:
            (promptLinkProjectRef
              ? providersByEnvironment.get(promptLinkProjectRef.environmentId)
              : undefined) ?? [],
          threadModelSelection: activeThread?.modelSelection ?? null,
        };
  const plainPromptLink = promptLinkInput
    ? composerPromptLink({ ...promptLinkInput, withContext: false })
    : null;
  if (promptLinkInput !== null && plainPromptLink !== null) {
    developerItems.push({
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: "Copy prompt link",
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plainPromptLink),
    });
    if (promptLinkRepositoryOf(promptLinkInput.project) !== null) {
      const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
      if (contextLink !== null) {
        developerItems.push({
          kind: "action",
          value: "action:copy-prompt-link-with-context",
          searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
          title: "Copy prompt link with repo and model",
          icon: <LinkIcon className={ITEM_ICON_CLASS} />,
          run: () => copyPromptLink(contextLink),
        });
      }
    }
  }

  if (activeThreadReferenceCopyTarget !== null && !isGameThread) {
    developerItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms: ["copy", "thread id", "reference"],
      title: "Copy chat ID",
      description: activeThreadReferenceCopyTarget.value,
      icon: <HashIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        toastManager.add({
          type: "success",
          title: "Agent session will restart",
          description: "Your next message starts a fresh session.",
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: thread.worktreePath ?? project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  developerItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openOverlayMode("files");
    },
  });

  developerItems.push({
    kind: "action",
    value: "action:search-project-contents",
    searchTerms: ["search project", "find in files", "grep", "content search", "text search"],
    title: "Search project contents",
    icon: <SearchCodeIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "projectSearch.toggle",
    run: async () => {
      openOverlayMode("content");
    },
  });

  if (!isGameThread && newProjectEnvironmentOptions.length > 0) {
    developerItems.push({
      kind: "action",
      value: "action:new-project",
      searchTerms: ["new project", "create project", "empty", "repository", "repo", "git init"],
      title: "New project",
      icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openNewProjectFlow();
      },
    });
  }

  if (!isGameThread) {
    developerItems.push({
      kind: "action",
      value: "action:add-project",
      searchTerms: [
        "add project",
        "folder",
        "directory",
        "browse",
        "clone",
        "remote",
        "repository",
        "repo",
        "git",
        "url",
        "environment",
      ],
      title: "Add project",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        openAddProjectFlow();
      },
    });
  }

  // Mode and theme are one decision about how the app looks, so the palette offers one entry
  // for both instead of two near-synonyms.
  const appearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:appearance",
    searchTerms: [
      "change theme",
      "change appearance",
      "appearance",
      "colors",
      "palette",
      "light",
      "dark",
      "system",
      "mode",
      "toggle",
    ],
    title: "Change appearance…",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "appearance",
        label: "Mode",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
      {
        value: "themes",
        label: "Theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(appearanceItem);

  // The parent pushes an intent into this mounted dialog; applying it clears the
  // parent's intent and may navigate, so it runs after commit but before paint.
  const projectThreadItemCount = projectThreadItems.length;
  const applyOpenIntent = useEffectEvent((intent: CommandPaletteOpenIntent) => {
    switch (intent.kind) {
      case "search":
        browseNavigation.invalidate();
        cloneLookupGeneration.current += 1;
        setIsRemoteProjectLookingUp(false);
        setAddProjectCloneFlow(null);
        setNewProjectFlow(null);
        setViewStack([]);
        setLinkedThreadSearch(intent);
        setQuery(intent.query);
        clearOpenIntent();
        return;
      case "add-project":
        clearOpenIntent();
        openAddProjectFlow();
        return;
      case "new-thread-in":
        clearOpenIntent();
        browseNavigation.invalidate();
        setAddProjectCloneFlow(null);
        setNewProjectFlow(null);
        setViewStack([]);
        setQuery("");
        pushPaletteView({
          addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
          groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],
        });
        return;
      case "change-theme":
        clearOpenIntent();
        browseNavigation.invalidate();
        cloneLookupGeneration.current += 1;
        setIsRemoteProjectLookingUp(false);
        setAddProjectCloneFlow(null);
        setNewProjectFlow(null);
        setViewStack([]);
        pushPaletteView({
          addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
          groups: [{ value: "themes", label: "Appearance", items: [] }],
        });
        return;
    }
  });
  useLayoutEffect(() => {
    if (openIntent === null) return;
    // A new-thread-in intent waits until the project items exist.
    if (openIntent.kind === "new-thread-in" && projectThreadItemCount === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- applying the intent dispatches to the parent reducer and can navigate, neither of which may run during render.
    applyOpenIntent(openIntent);
  }, [openIntent, projectThreadItemCount]);

  // A tool for making themes, not for choosing one: it sits with the other developer tools.
  developerItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <SwatchBookIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: "Open usage",
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  const contextualProjectGroup =
    (contextualProjectRef
      ? projectGroupByTargetKey.get(
          `${contextualProjectRef.environmentId}:${contextualProjectRef.projectId}`,
        )
      : null) ??
    projectGroups[0] ??
    null;
  if (contextualProjectGroup) {
    // On a game this is the game's own settings page, a studio action; elsewhere it is a
    // coding project's and waits under Developer.
    (isGameThread ? actionItems : developerItems).push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: [
        "project",
        "settings",
        "name",
        "icon",
        "scripts",
        "model",
        "workspace",
        "grouping",
        "checkout",
        "remove",
        "kurambit.json",
      ],
      title: "Open game settings",
      description: contextualProjectGroup.displayName,
      icon: <FolderIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualProjectGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({
    gameItems,
    actionItems,
    developerItems,
    recentThreadItems,
    // ">" alone lists commands, so it keeps coding commands behind the one Developer row.
    developerEntry:
      deferredQuery.replace(/^>/, "").trim().length === 0
        ? {
            kind: "submenu",
            value: "action:developer",
            searchTerms: ["developer"],
            title: "Developer…",
            icon: <CodeIcon className={ITEM_ICON_CLASS} />,
            addonIcon: <CodeIcon className={ADDON_ICON_CLASS} />,
            groups: [{ value: "developer", label: "Developer", items: developerItems }],
          }
        : undefined,
  });
  // A shortcut's settings row named exactly like an action listed here would only repeat
  // it; the action runs the thing and shows the keys.
  const actionTitles = new Set(
    [...gameItems, ...actionItems].flatMap((item) =>
      typeof item.title === "string" ? [item.title.toLowerCase()] : [],
    ),
  );
  const settingsSearchItems: CommandPaletteActionItem[] = searchSettings(
    deferredQuery,
    availableSettingsSearchItems,
  )
    .filter((item) => !(item.secondary && actionTitles.has(item.title.toLowerCase())))
    .map((item) => ({
      kind: "action",
      value: `setting:${item.id}`,
      searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
      title: item.title,
      description:
        settingsSearchLocation(item) === item.title
          ? "Settings"
          : `Settings · ${settingsSearchLocation(item)}`,
      ...(item.secondary || isAdvancedSetting(item) ? { secondary: true } : {}),
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: item.to,
          hash: item.targetId ?? item.id,
          replace: pathname === item.to,
          hashScrollIntoView: false,
        });
      },
    }));
  const sourceSelectionViewValue =
    addProjectEnvironmentId === null ? null : `sources:${addProjectEnvironmentId}`;
  const activeGroups =
    addProjectEnvironmentId !== null &&
    currentView !== null &&
    currentView.groups[0]?.value === sourceSelectionViewValue
      ? buildAddProjectSourceGroups(
          addProjectEnvironmentId,
          buildPaletteRemoteSourceReadiness(null),
        )
      : currentView?.groups[0]?.value === "themes" || currentView?.groups[0]?.value === "appearance"
        ? appearanceItem.groups
        : (currentView?.groups ?? rootGroups);

  const filteredGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    gameSearchItems: gameRowItems,
    settingsSearchItems,
    threadSearchItems:
      linkedThreadSearch?.linkedThreads && deferredQuery === linkedThreadSearch.query
        ? buildLinkedThreadActionItems({
            ...linkedThreadSearch.linkedThreads,
            query: linkedThreadSearch.query,
            icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
            runThread: async (thread) => {
              await navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              });
            },
          })
        : gameThreadItems,
  });

  const handleAddProjectForEnvironment = async (input: {
    readonly environmentId: EnvironmentId;
    readonly rawCwd: string;
    readonly platform: string;
    readonly currentProjectCwd: string | null;
  }) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === input.environmentId,
    );
    if (!canCreateProjectInEnvironment(environment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${environment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }
    const rawCwd = input.rawCwd;

    if (isUnsupportedWindowsProjectPath(rawCwd.trim(), input.platform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawCwd.trim()) && !input.currentProjectCwd) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const cwd = resolveProjectPathForDispatch(rawCwd, input.currentProjectCwd);
    if (cwd.length === 0) return;

    const existing = findProjectByPath(
      projects.filter((project) => project.environmentId === input.environmentId),
      cwd,
    );
    if (existing) {
      const latestThread = getLatestThreadForProject(
        threads.filter((thread) => thread.environmentId === existing.environmentId),
        existing.id,
        clientSettings.sidebarThreadSortOrder,
      );
      if (latestThread && latestThread.settledOverride !== "settled") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
      } else {
        const navigationResult = await settlePromise(() =>
          handleNewThread(scopeProjectRef(existing.environmentId, existing.id)),
        );
        if (navigationResult._tag === "Failure") {
          const error = squashAtomCommandFailure(navigationResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to open project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
      }
      setOpen(false);
      return;
    }

    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Cannot add project",
          description: "This connection cannot add projects.",
        }),
      );
      return;
    }
    const projectId = newProjectId();
    const createResult = await createProject({
      environmentId: input.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(cwd),
        workspaceRoot: cwd,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (createResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(createResult)) {
        const error = squashAtomCommandFailure(createResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to add project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return;
    }

    const navigationResult = await settlePromise(() =>
      handleNewThread(scopeProjectRef(input.environmentId, projectId)),
    );
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to add project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    setOpen(false);
  };

  const handleAddProject = async (rawCwd: string) => {
    if (!browseEnvironmentId) return;
    await handleAddProjectForEnvironment({
      environmentId: browseEnvironmentId,
      rawCwd,
      platform: browseEnvironmentPlatform,
      currentProjectCwd: currentProjectCwdForBrowse,
    });
  };
  const newProjectName = query.trim();
  const canSubmitNewProject =
    newProjectFlow !== null &&
    newProjectName.length > 0 &&
    !isCreatingNewProject &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);

  async function submitNewProject(): Promise<void> {
    if (newProjectFlow === null || !canSubmitNewProject || newProjectSubmittingRef.current) {
      return;
    }
    newProjectSubmittingRef.current = true;
    setIsCreatingNewProject(true);
    const created = await settlePromise(() =>
      createNewProject({
        environmentId: newProjectFlow.environmentId,
        name: newProjectName,
      }),
    );
    newProjectSubmittingRef.current = false;
    setIsCreatingNewProject(false);
    // Same outcome as the old try/finally: the rejection still surfaces to the caller.
    if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    if (created.value) setOpen(false);
  }

  function getDefaultCloneParentPath(environmentId: EnvironmentId): string {
    return getAddProjectInitialQueryForEnvironment(environmentId);
  }

  async function submitAddProjectCloneFlow(destinationPathInput?: string): Promise<void> {
    if (!addProjectCloneFlow) {
      return;
    }
    if (!canCreateProjectInEnvironment(browseEnvironment?.connection.phase)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Environment unavailable",
          description: `${browseEnvironment?.label ?? "The selected environment"} is not connected.`,
        }),
      );
      return;
    }

    if (addProjectCloneFlow.step === "repository") {
      const rawRepository = query.trim();
      if (rawRepository.length === 0 || isRemoteProjectLookingUp) {
        return;
      }

      const provider = addProjectRemoteSourceProvider(addProjectCloneFlow.source);
      if (!provider) {
        const destinationPath = getCloneDestinationPath(
          getDefaultCloneParentPath(addProjectCloneFlow.environmentId),
          getCloneDirectoryName(rawRepository),
        );
        setAddProjectCloneFlow({
          step: "confirm",
          environmentId: addProjectCloneFlow.environmentId,
          source: addProjectCloneFlow.source,
          repositoryInput: rawRepository,
          repository: null,
          remoteUrl: normalizePastedCloneUrl(rawRepository),
        });
        setHighlightedItemValue(null);
        setQuery(destinationPath);
        setBrowseGeneration((generation) => generation + 1);
        return;
      }
    }

    if (addProjectCloneFlow.step !== "confirm") return;
    const rawDestination = (destinationPathInput ?? query).trim();
    if (
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(addProjectCloneFlow.environmentId, AuthOrchestrationOperateScope)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone unavailable",
          description: "This connection needs permission to write source control and add projects.",
        }),
      );
      return;
    }
    if (rawDestination.length === 0 || isRemoteProjectCloning) return;

    if (isUnsupportedWindowsProjectPath(rawDestination, browseEnvironmentPlatform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Windows-style paths are only supported on Windows.",
        }),
      );
      return;
    }

    if (isExplicitRelativeProjectPath(rawDestination) && !currentProjectCwdForBrowse) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Clone failed",
          description: "Relative paths require an active project.",
        }),
      );
      return;
    }

    const destinationPath = resolveProjectPathForDispatch(
      rawDestination,
      currentProjectCwdForBrowse,
    );
    if (destinationPath.length === 0) {
      return;
    }

    const projectId = newProjectId();
    setIsRemoteProjectCloning(true);
    const startResult = await startProjectClone({
      environmentId: addProjectCloneFlow.environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(destinationPath),
        createdAt: new Date().toISOString(),
        remoteUrl: addProjectCloneFlow.remoteUrl,
        destinationPath,
      },
    });
    setIsRemoteProjectCloning(false);
    if (startResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(startResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Clone failed",
            description: errorMessage(squashAtomCommandFailure(startResult)),
          }),
        );
      }
      return;
    }
    setOpen(false);
    const projectRef = scopeProjectRef(addProjectCloneFlow.environmentId, projectId);
    await waitForProject(projectRef, 3_000).catch(() => null);
    const navigationResult = await settlePromise(() => handleNewThread(projectRef));
    if (navigationResult._tag === "Failure") {
      const error = squashAtomCommandFailure(navigationResult);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to open project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }

  const browseTo = async (name: string): Promise<void> => {
    const nextQuery = pinnedCloneDirectoryName
      ? getCloneDestinationBrowsePath({
          browseDirectoryPath: browsePath.directoryPath,
          selectedDirectoryName: name,
          cloneDirectoryName: pinnedCloneDirectoryName,
          caseSensitive: !isWindowsPlatform(browseEnvironmentPlatform),
        })
      : appendBrowsePathSegment(query, name);
    await browseNavigation.run(
      () => prefetchBrowsePath(getBrowseDirectoryPath(nextQuery)),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const browseUp = async (): Promise<void> => {
    const parentPath = browsePath.parentPath;
    if (parentPath === null) {
      return;
    }

    const nextQuery = getCloneDestinationPath(parentPath, pinnedCloneDirectoryName);
    await browseNavigation.run(
      () => prefetchBrowsePath(parentPath),
      () => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
        setBrowseGeneration((generation) => generation + 1);
      },
    );
  };

  const resolvedAddProjectPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? query.trim())
    : (exactBrowseEntry?.fullPath ?? query.trim());

  const canBrowseUp = !relativePathNeedsActiveProject && browsePath.canBrowseUp;

  const browseGroups = buildBrowseGroups({
    browseEntries: visibleBrowseEntries,
    browseQuery: query,
    canBrowseUp,
    upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
    directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
    browseUp,
    browseTo,
  });
  const cloneDestinationBrowseGroups = browseGroups.map((group) =>
    group.value === "directories" ? { ...group, label: "Select where to clone" } : group,
  );

  const remoteProjectContext = (() => {
    if (addProjectCloneFlow?.step !== "confirm") {
      return null;
    }

    return {
      title: addProjectCloneFlow.repository?.nameWithOwner ?? addProjectCloneFlow.repositoryInput,
      description: addProjectCloneFlow.repository?.url ?? addProjectCloneFlow.remoteUrl,
      icon: remoteProjectSourceIcon(addProjectCloneFlow.source, ITEM_ICON_CLASS),
    };
  })();

  const newProjectsRoot = newProjectFlow ? newProjectsRootFor(newProjectFlow.environmentId) : null;
  const newProjectPathPreview =
    newProjectsRoot === null ? null : getNewProjectPathPreview(newProjectsRoot, newProjectName);
  const showExistingProjectSources = (environmentId: EnvironmentId) => {
    const sourcesEnvironmentId = newProjectFlow?.sourcesEnvironmentId ?? null;
    if (sourcesEnvironmentId === environmentId) {
      popView();
      return;
    }
    if (sourcesEnvironmentId !== null) {
      setViewStack((previousViews) => previousViews.slice(0, -1));
    }
    popView();
    startAddProjectSourceSelection(environmentId);
  };
  const switchNewProjectEnvironment = (environmentId: EnvironmentId) => {
    setNewProjectFlow((flow) => (flow === null ? flow : { ...flow, environmentId }));
    setAddProjectEnvironmentId(environmentId);
  };
  const selectedNewProjectEnvironment =
    newProjectFlow === null
      ? undefined
      : newProjectEnvironmentOptions.find(
          (option) => option.environmentId === newProjectFlow.environmentId,
        );
  const showNewProjectMachines =
    newProjectFlow !== null &&
    (newProjectEnvironmentOptions.length > 1 ||
      (selectedNewProjectEnvironment === undefined && newProjectEnvironmentOptions.length > 0));
  const newProjectEnvironmentLabel = showNewProjectMachines
    ? (selectedNewProjectEnvironment?.label ??
      environmentLabelById.get(newProjectFlow.environmentId) ??
      null)
    : null;
  const newProjectMachineGroup: CommandPaletteView["groups"][number] | null =
    !showNewProjectMachines || newProjectFlow === null
      ? null
      : {
          value: "new-project-machines",
          label: "Environments",
          items: newProjectEnvironmentOptions.map((option) => ({
            ...buildEnvironmentItem(
              option,
              `new-project:environment:${option.environmentId}`,
              switchNewProjectEnvironment,
            ),
            ...(isCreatingNewProject ? { disabled: true } : {}),
            ...(option.environmentId === newProjectFlow.environmentId
              ? {
                  titleTrailingContent: (
                    <CheckIcon className="ms-auto size-4 shrink-0 text-muted-foreground/70" />
                  ),
                }
              : {}),
          })),
        };
  const newProjectExistingGroup: CommandPaletteView["groups"][number] | null =
    newProjectFlow === null
      ? null
      : {
          value: "new-project-existing",
          label: "",
          items: [
            {
              kind: "action",
              value: "new-project:existing",
              searchTerms: [],
              title: "Add existing project",
              description: "Open a folder or clone a repository",
              icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
              titleTrailingContent: (
                <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
              ),
              keepOpen: true,
              run: async () => {
                showExistingProjectSources(newProjectFlow.environmentId);
              },
            },
          ],
        };
  const newProjectOptionGroups: CommandPaletteView["groups"] = [];

  let displayedGroups: CommandPaletteView["groups"] = filteredGroups;
  if (newProjectFlow !== null) {
    displayedGroups = [
      ...(newProjectMachineGroup ? [newProjectMachineGroup] : []),
      ...newProjectOptionGroups,
      ...(newProjectExistingGroup ? [newProjectExistingGroup] : []),
    ];
  } else if (addProjectCloneFlow?.step === "repository") {
    displayedGroups = [];
  } else if (addProjectCloneFlow?.step === "confirm") {
    displayedGroups = relativePathNeedsActiveProject ? [] : cloneDestinationBrowseGroups;
  } else if (isBrowsing) {
    displayedGroups = relativePathNeedsActiveProject ? [] : browseGroups;
  }
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const autoHighlightsFirstRow =
    !isBrowsing && !isRemoteProjectCloneFlow && newProjectFlow === null;

  const inputPlaceholder =
    newProjectFlow !== null
      ? "Project name"
      : (remoteProjectInputPlaceholder(addProjectCloneFlow) ??
        getCommandPaletteInputPlaceholder(paletteMode));
  const isSubmenu = paletteMode === "submenu" || paletteMode === "submenu-browse";
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canWriteSourceControl = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canCreateClonedProject = useEnvironmentScope(
    addProjectCloneFlow?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canCloneProject = canWriteSourceControl && canCreateClonedProject;
  const isCloneDestinationStep = addProjectCloneFlow?.step === "confirm";
  const canSubmitBrowsePath =
    isBrowsing &&
    !relativePathNeedsActiveProject &&
    canCreateProject &&
    (!isCloneDestinationStep || canCloneProject) &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase);
  const willCreateProjectPath =
    canSubmitBrowsePath &&
    !isBrowsePending &&
    browseAccessError === null &&
    query.trim().length > 0 &&
    !hasHighlightedBrowseItem &&
    (hasTrailingPathSeparator(query) ? !browseResult : exactBrowseEntry === null);
  const useMetaForMod = isMacPlatform(navigator.platform);
  const submitModifierLabel = useMetaForMod ? "\u2318" : "Ctrl";
  const submitActionLabel = isCloneDestinationStep
    ? willCreateProjectPath
      ? "Create & Clone"
      : "Clone"
    : willCreateProjectPath
      ? "Create & Add"
      : "Add";
  const addShortcutLabel = hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter";
  const hasHighlightedNewProjectItem = newProjectFlow !== null && highlightedItemValue !== null;
  const createShortcutLabel = hasHighlightedNewProjectItem
    ? `${submitModifierLabel} Enter`
    : "Enter";
  const remoteProjectButtonLabel = addProjectCloneFlow
    ? addProjectCloneFlow.source === "url"
      ? "Continue"
      : "Lookup"
    : null;
  const isRemoteProjectPending = isRemoteProjectLookingUp || isRemoteProjectCloning;
  const canSubmitRemoteProjectFlow =
    addProjectCloneFlow?.step === "repository" &&
    query.trim().length > 0 &&
    canCreateProjectInEnvironment(browseEnvironment?.connection.phase) &&
    !isRemoteProjectPending;
  const fileManagerName = getLocalFileManagerName(navigator.platform);
  const canOpenProjectFromFileManager =
    isBrowsing &&
    browseEnvironmentId !== null &&
    browseEnvironmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;
  const fileManagerInitialPath = (() => {
    if (!canOpenProjectFromFileManager) {
      return undefined;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return undefined;
    }

    const initialPath = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? trimmedQuery)
      : browseDirectoryPath || trimmedQuery;

    const resolvedPath = resolveProjectPathForDispatch(initialPath, currentProjectCwdForBrowse);
    return resolvedPath.length > 0 ? resolvedPath : undefined;
  })();

  function isPrimaryModifierPressed(event: KeyboardEvent<HTMLInputElement>): boolean {
    return useMetaForMod ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      event.preventDefault();
      event.stopPropagation();
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }
    // ChatView ignores shortcuts while the palette is open, so handle find here
    // instead of letting the browser's own Find open.
    if (command === "chat.find" && activeThreadId && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      requestThreadFindOpen();
      return;
    }

    if (addProjectCloneFlow?.step === "repository" && event.key === "Enter") {
      event.preventDefault();
      void submitAddProjectCloneFlow();
      return;
    }

    if (
      newProjectFlow !== null &&
      event.key === "Enter" &&
      (!hasHighlightedNewProjectItem || isPrimaryModifierPressed(event)) &&
      // Enter that confirms an IME composition is part of typing the name.
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    ) {
      // Base UI would otherwise also click the highlighted row.
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      void submitNewProject();
      return;
    }

    const shouldSubmitBrowsePath =
      canSubmitBrowsePath &&
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || isPrimaryModifierPressed(event));

    if (shouldSubmitBrowsePath) {
      event.preventDefault();
      if (isCloneDestinationStep) {
        void submitAddProjectCloneFlow(resolvedAddProjectPath);
      } else {
        void handleAddProject(resolvedAddProjectPath);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    const firstItemValue = autoHighlightsFirstRow ? resultRows.itemValues[0] : undefined;

    // Base UI clicks the highlighted row on Enter, which does nothing once the
    // virtualized list has unmounted it, so run the tracked highlight directly.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  const handleOpenProjectFromFileManager = async () => {
    if (!canOpenProjectFromFileManager || isPickingProjectFolder) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }

    setIsPickingProjectFolder(true);
    let pickedPath: string | null = null;
    try {
      const pickerOptions = {
        ...(fileManagerInitialPath ? { initialPath: fileManagerInitialPath } : {}),
      };
      pickedPath = await api.dialogs.pickFolder(
        Object.keys(pickerOptions).length > 0 ? pickerOptions : undefined,
      );
    } catch {
      setIsPickingProjectFolder(false);
      return;
    }
    setIsPickingProjectFolder(false);
    if (!pickedPath) {
      return;
    }

    await handleAddProject(pickedPath);
  };

  const inputAccessory =
    newProjectFlow !== null ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`Create (${createShortcutLabel})`}
              disabled={!canSubmitNewProject}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitNewProject();
              }}
            />
          }
        >
          <span>{isCreatingNewProject ? "Creating" : "Create"}</span>
          <KbdGroup className="pointer-events-none -me-0.5">
            <Kbd>{createShortcutLabel}</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">{`Create (${createShortcutLabel})`}</TooltipPopup>
      </Tooltip>
    ) : addProjectCloneFlow?.step === "repository" ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`${remoteProjectButtonLabel ?? "Continue"} (Enter)`}
              disabled={!canSubmitRemoteProjectFlow}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                void submitAddProjectCloneFlow();
              }}
            />
          }
        >
          <span>{isRemoteProjectPending ? "Working" : remoteProjectButtonLabel}</span>
          <KbdGroup className="pointer-events-none -me-0.5">
            <Kbd>Enter</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">{remoteProjectButtonLabel ?? "Continue"} (Enter)</TooltipPopup>
      </Tooltip>
    ) : isBrowsing ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              tabIndex={-1}
              className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
              aria-label={`${submitActionLabel} (${addShortcutLabel})`}
              disabled={
                !canCreateProject ||
                !canCreateProjectInEnvironment(browseEnvironment?.connection.phase) ||
                relativePathNeedsActiveProject ||
                (isCloneDestinationStep && (!canCloneProject || isRemoteProjectPending))
              }
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                if (relativePathNeedsActiveProject) {
                  return;
                }
                if (isCloneDestinationStep) {
                  void submitAddProjectCloneFlow(resolvedAddProjectPath);
                } else {
                  void handleAddProject(resolvedAddProjectPath);
                }
              }}
            />
          }
        >
          <span>
            {isCloneDestinationStep && isRemoteProjectPending ? "Cloning" : submitActionLabel}
          </span>
          <KbdGroup className="pointer-events-none -me-0.5">
            <Kbd>{hasHighlightedBrowseItem ? `${submitModifierLabel} Enter` : "Enter"}</Kbd>
          </KbdGroup>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isCloneDestinationStep && !canCloneProject
            ? "This connection needs permission to write source control and add projects."
            : canCreateProject
              ? `${submitActionLabel} (${addShortcutLabel})`
              : "This connection cannot add projects."}
        </TooltipPopup>
      </Tooltip>
    ) : null;

  const footerActionLabel =
    newProjectFlow !== null
      ? highlightedItemValue === null
        ? "Create"
        : "Select"
      : addProjectCloneFlow?.step === "repository"
        ? (remoteProjectButtonLabel ?? "Continue")
        : !canSubmitBrowsePath || hasHighlightedBrowseItem
          ? "Select"
          : undefined;

  const footerTrailing = canOpenProjectFromFileManager ? (
    <CommandFooterAction
      disabled={isPickingProjectFolder}
      onClick={() => {
        void handleOpenProjectFromFileManager();
      }}
    >
      {`Open in ${fileManagerName}`}
    </CommandFooterAction>
  ) : null;

  return (
    <CommandPaletteContent
      key={`${viewStack.length}-${browseGeneration}-${isBrowsing}-${newProjectFlow ? "new-project" : (addProjectCloneFlow?.step ?? "none")}`}
      aria-label="Command palette"
      autoHighlight={autoHighlightsFirstRow ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        className: hasHighlightedNewProjectItem
          ? "*:data-[slot=autocomplete-input]:pe-38!"
          : addProjectCloneFlow?.step === "repository" || newProjectFlow !== null
            ? "*:data-[slot=autocomplete-input]:pe-32!"
            : isBrowsing
              ? browseInputEndPaddingClass({
                  willCreateProjectPath,
                  hasHighlightedBrowseItem,
                })
              : undefined,
        placeholder: inputPlaceholder,
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : isBrowsing
            ? { startAddon: <FolderPlusIcon /> }
            : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      {newProjectPathPreview !== null ? (
        <div className="p-2 pb-0">
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            <FolderGit2Icon className={ITEM_ICON_CLASS} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">
                {newProjectName.length > 0 ? newProjectName : "New project"}
              </span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {newProjectName.length > 0
                  ? `Creates ${newProjectPathPreview}`
                  : `Goes in ${newProjectsRoot}`}
                {newProjectEnvironmentLabel === null ? null : ` on ${newProjectEnvironmentLabel}`}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      {remoteProjectContext ? (
        <div className="p-2 pb-0">
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Repository</div>
          <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
            {remoteProjectContext.icon}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground text-sm">{remoteProjectContext.title}</span>
              <span className="truncate text-muted-foreground/85 text-xs">
                {remoteProjectContext.description}
              </span>
            </span>
          </div>
        </div>
      ) : null}
      {browseAccessError ? (
        <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          {browseAccessError}
        </div>
      ) : isBrowsePending && browseResult === null ? (
        <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
          Loading folders...
        </div>
      ) : null}
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        // Typing clears the tracked highlight, but Enter still runs the first row, so the
        // first row shows as active: what Enter will do is always visible.
        highlightedItemValue={
          highlightedItemValue ??
          (autoHighlightsFirstRow ? (resultRows.itemValues[0] ?? null) : null)
        }
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        shortcutContext={isGameThread ? GAME_SHORTCUT_CONTEXT : undefined}
        onExecuteItem={executeItem}
        {...(addProjectCloneFlow?.step === "repository"
          ? {
              emptyStateMessage:
                addProjectCloneFlow.source === "url"
                  ? "Enter a Git clone URL and press Enter to continue."
                  : "Enter a repository path and press Enter to look it up.",
            }
          : addProjectCloneFlow?.step === "confirm"
            ? { emptyStateMessage: "Choose a destination path and press Enter to clone." }
            : relativePathNeedsActiveProject
              ? { emptyStateMessage: "Relative paths require an active project." }
              : willCreateProjectPath
                ? {
                    emptyStateMessage: "Press Enter to create this folder and add it as a project.",
                  }
                : threadSearch.isPending
                  ? { emptyStateMessage: "Searching chats…" }
                  : {})}
      />
    </CommandPaletteContent>
  );
}
