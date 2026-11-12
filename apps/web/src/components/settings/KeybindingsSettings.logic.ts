import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@kurambit/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@kurambit/shared/keybindings";

import { shortcutKeyFromEvent } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../usage/usageShortcuts";

// Every usage.* command needs a rank. An unranked one falls back to the
// alphabetical compare, which makes the comparator inconsistent and the order
// depend on the input order.
const usageCommandOrder = new Map<KeybindingCommand, number>(
  [
    "usage.open" as const,
    ...[...METRIC_OPTIONS, ...WINDOW_OPTIONS].map((option) => option.command),
  ].map((command, index) => [command, index]),
);

const firstUsageCommand = METRIC_OPTIONS[0].command;

function compareCommands(
  left: KeybindingCommand,
  right: KeybindingCommand,
  key: (command: KeybindingCommand) => string,
): number {
  const leftRank = usageCommandOrder.get(left);
  const rightRank = usageCommandOrder.get(right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  return key(leftRank === undefined ? left : firstUsageCommand).localeCompare(
    key(rightRank === undefined ? right : firstUsageCommand),
  );
}

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "terminalFocus";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function whenNodeRemoveLabel(node: KeybindingWhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return "Remove condition";
  }
  return "Remove group and its conditions";
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    return "Project";
  }

  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = shortcutToKeybindingInput(binding.shortcut);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        shortcutToKeybindingInput(entry.shortcut) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function conflictsWithWhen(leftWhen: string, rightWhen: string): boolean {
  return leftWhen.length === 0 || rightWhen.length === 0 || leftWhen === rightWhen;
}

export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: { readonly rowId: string; readonly key: string; readonly when: string },
): ReadonlyArray<string> {
  if (input.key.trim().length === 0) return [];
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (
      candidate.id !== input.rowId &&
      candidate.key === input.key &&
      conflictsWithWhen(candidate.when, input.when)
    ) {
      conflicts.push(commandLabel(candidate.command));
    }
  }
  return [...new Set(conflicts)].toSorted();
}

export interface KeybindingGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KeybindingRow>;
}

// Game actions lead: they are what a game maker reaches for. The coding app's areas follow.
const KEYBINDING_GROUPS = [
  { id: "game", title: "Game", prefixes: ["game"], commands: ["chat.new", "chat.newLocal"] },
  {
    id: "navigation",
    title: "Navigation",
    prefixes: [
      "sidebar",
      "navigation",
      "rightPanel",
      "commandPalette",
      "filePicker",
      "projectSearch",
      "editor",
    ],
  },
  { id: "composer", title: "Composer", prefixes: ["composer", "modelPicker"] },
  { id: "threads", title: "Chats", prefixes: ["thread", "chat", "pullRequest"] },
  { id: "terminal", title: "Terminal", prefixes: ["terminal"] },
  { id: "preview", title: "Preview and diff", prefixes: ["preview", "diff"] },
  { id: "appearance", title: "Appearance", prefixes: ["theme", "appearance", "themeEditor"] },
  { id: "scripts", title: "Project scripts", prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = { id: "other", title: "Other" } as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: string } {
  const prefix = String(command).split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) =>
      (group as { commands?: ReadonlyArray<string> }).commands?.includes(command),
    ) ??
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

export function groupKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
): ReadonlyArray<KeybindingGroup> {
  const rowsByGroup = new Map<string, Array<KeybindingRow>>();
  for (const row of rows) {
    const group = keybindingGroupFor(row.command);
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingRow> {
  const rows = keybindings.map((binding, index) => {
    const defaultBinding = defaultBindingForBinding(binding);
    const key = shortcutToKeybindingInput(binding.shortcut);
    const when = whenAstToExpression(binding.whenAst);
    return {
      id: `${keybindingRowId(binding.command, key, when)}\u0000${index}`,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? shortcutToKeybindingInput(defaultBinding.shortcut) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      conflicts: [],
    } satisfies KeybindingRow;
  });

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(rows, {
      rowId: row.id,
      key: row.key,
      when: row.when,
    });
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare = compareCommands(left.command, right.command, (command) => command);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  return rowsWithConflicts;
}

// Filtering keeps the row objects so rows that stay visible while the query
// changes receive the same props and skip rendering.
export function filterKeybindingRows(
  rows: ReadonlyArray<KeybindingRow>,
  query: string,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return rows;
  return rows.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) => compareCommands(left, right, commandLabel));
}

// Sentence case and verb first, so a label reads on its own in search results and in
// conflict warnings, without its group heading beside it.
const COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "game.chat.toggle": "Show or hide the Inspector",
  "game.focus": "Focus the game",
  "game.freeze": "Freeze the game or play on",
  "game.playPrevious": "Play the previous build",
  "game.playNext": "Play the next build",
  "game.undoTurn": "Undo the last change",
  "game.redoTurn": "Redo the last change",
  "game.keepGoing.stop": "Stop Keep going",
  "chat.new": "New game",
  "chat.newLocal": "Start a fresh Log",
  "chat.newWithoutProject": "New chat without a game",
  "chat.find": "Find in the chat",
  "sidebar.toggle": "Show or hide the sidebar",
  "navigation.back": "Go back",
  "navigation.forward": "Go forward",
  "commandPalette.toggle": "Open the command palette",
  "filePicker.toggle": "Open the file picker",
  "projectSearch.toggle": "Search the project's files",
  "editor.openFavorite": "Open in your editor",
  "rightPanel.toggle": "Show or hide the right panel",
  "rightPanel.new": "New right panel tab",
  "rightPanel.toggleMaximized": "Maximise or restore the right panel",
  "rightPanel.close": "Close the right panel tab",
  "threadPanel.toggle": "Show or hide the chat panel",
  "view.reopenClosed": "Reopen the closed tab",
  "terminal.toggle": "Show or hide the terminal",
  "terminal.split": "Split the terminal",
  "terminal.splitVertical": "Split the terminal vertically",
  "terminal.new": "New terminal",
  "terminal.close": "Close the terminal",
  "diff.toggle": "Show or hide the diff",
  "preview.toggle": "Show or hide the preview",
  "preview.refresh": "Reload the preview",
  "preview.focusUrl": "Focus the preview's URL",
  "preview.zoomIn": "Zoom the preview in",
  "preview.zoomOut": "Zoom the preview out",
  "preview.resetZoom": "Reset the preview's zoom",
  "theme.select": "Choose a theme",
  "appearance.cycle": "Switch between light, dark and system",
  "themeEditor.toggle": "Show or hide the theme editor",
  "composer.stash": "Stash the draft",
  "composer.sendAlternate": "Send with the other of queue or steer",
  "composer.sendBackground": "Start in the background",
  "composer.sendAndNewThread": "Send and start a new chat",
  "composer.host": "Choose where the agent runs",
  "composer.cycleHost": "Cycle where the agent runs",
  "composer.effort": "Choose the effort",
  "composer.increaseEffort": "Raise the effort",
  "composer.decreaseEffort": "Lower the effort",
  "composer.mode": "Choose the mode",
  "composer.workspace": "Choose the workspace",
  "composer.previousWorktree": "Use the previous worktree",
  "composer.branch": "Choose the branch",
  "modelPicker.toggle": "Open the model picker",
  "modelPicker.previousProvider": "Previous provider in the model picker",
  "modelPicker.nextProvider": "Next provider in the model picker",
  "thread.stop": "Stop the agent",
  "thread.steerQueuedMessage": "Send the first queued message as a steer",
  "thread.editQueuedMessage": "Edit the last queued message",
  "thread.previous": "Previous chat",
  "thread.next": "Next chat",
  "thread.copyReference": "Copy link to the pull request, or the thread ID",
  "thread.settle": "Settle the chat",
  "thread.pin": "Pin the chat",
  "thread.undo": "Undo the last sidebar change",
  "pullRequest.copyNumber": "Copy the pull request number",
  "usage.open": "Open usage",
};

export function commandLabel(command: KeybindingCommand): string {
  const known = COMMAND_LABELS[command];
  if (known) return known;
  const usageMetric = METRIC_OPTIONS.find((option) => option.command === command);
  if (usageMetric) return `Show usage by ${usageMetric.label.toLowerCase()}`;
  const usagePeriod = WINDOW_OPTIONS.find((option) => option.command === command);
  if (usagePeriod) return `Show usage for ${usagePeriod.label.toLowerCase()}`;
  const raw = String(command);
  const jump = /^(thread|modelPicker)\.jump\.(\d)$/.exec(raw);
  if (jump) {
    return jump[1] === "thread"
      ? `Jump to chat ${jump[2]}`
      : `Pick model ${jump[2]} in the model picker`;
  }
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run script: ${raw.slice("script.".length, -".run".length)}`;
  }
  return sentenceCase(raw.split(".").join(" "));
}

function sentenceCase(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const sentence = words.join(" ");
  return sentence.slice(0, 1).toUpperCase() + sentence.slice(1);
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string,
): string | null {
  const keyToken = normalizeShortcutKeyToken(shortcutKeyFromEvent(event));
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(keyToken);
  return parts.join("+");
}
