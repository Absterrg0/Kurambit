import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  ScheduledTaskId,
  type EnvironmentId,
  type ModelSelection,
  type ScheduledTask,
} from "@kurambit/contracts";

import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useGameLibrary } from "../game/useGameLibrary";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  scheduledTaskDelete,
  scheduledTaskListQuery,
  scheduledTaskRunNow,
  scheduledTaskSetEnabled,
  scheduledTaskUpsert,
} from "../../state/scheduledTasks";
import {
  gameAgentModel,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
} from "./scheduledTasksSettings.logic";

const PAGE_DESCRIPTION = "Messages your agent runs on a timer, each in its game's Log.";

function describeSchedule(schedule: ScheduledTask["schedule"]): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    if (Number.isInteger(minutes)) {
      return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
    }
    return `Every ${Math.round(schedule.everyMs / 1000)} seconds`;
  }
  if (schedule.type === "fixed_time") {
    const days =
      schedule.weekdays === undefined || schedule.weekdays.length === 0
        ? "day"
        : schedule.weekdays.length === 5 && schedule.weekdays.every((day) => day >= 1 && day <= 5)
          ? "weekday"
          : "selected day";
    return `At ${schedule.timeOfDay} every ${days}`;
  }
  return "Webhook (no longer supported; edit to give it a time)";
}

/**
 * A run's status is its sending: a sent prompt's turn can still fail in its
 * chat (a usage limit), so "sent" never claims the turn went well.
 */
const RUN_STATUS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: " · not run yet",
  running: " · sending now",
  succeeded: " · last sent to its Log",
  failed: " · last could not be sent",
};

const localTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

function TaskRow({
  environmentId,
  task,
  canOperate,
  onEdit,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  canOperate: boolean;
  onEdit: (task: ScheduledTask) => void;
}) {
  const setEnabled = useAtomCommand(scheduledTaskSetEnabled, { reportFailure: true });
  const remove = useAtomCommand(scheduledTaskDelete, { reportFailure: true });
  const runNow = useAtomCommand(scheduledTaskRunNow, { reportFailure: true });
  const [busy, setBusy] = useState<string | null>(null);
  const disabled = busy !== null || !canOperate;

  const run = async (action: string, fn: () => Promise<unknown>) => {
    setBusy(action);
    // A promise chain, not try/finally, which React Compiler cannot compile.
    await fn().finally(() => setBusy(null));
  };

  const confirmDelete = async () => {
    const question = `Delete the scheduled task "${task.title}"?\nIt stops running, and it cannot be brought back.`;
    const confirmed =
      (await requestConfirmDialog(question, { variant: "destructive" })) ??
      window.confirm(question);
    if (confirmed) await remove({ environmentId, input: { id: task.id } });
  };

  return (
    <SettingsRow
      title={task.title}
      description={
        <>
          <span className="block">
            {describeSchedule(task.schedule)}
            {task.nextRunAt && task.enabled ? ` · next ${localTime(task.nextRunAt)}` : ""}
            {RUN_STATUS[task.lastRunStatus]}
            {task.enabled ? "" : " · paused"}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-muted-foreground">{task.prompt}</span>
        </>
      }
      control={
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || task.schedule.type === "webhook"}
            onClick={() => void run("run", () => runNow({ environmentId, input: { id: task.id } }))}
          >
            Run now
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void run("toggle", () =>
                setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } }),
              )
            }
          >
            {task.enabled ? "Pause" : "Resume"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`More actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => onEdit(task)}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void run("delete", confirmDelete)}>
                <Trash2Icon />
                Delete…
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function DraftForm({
  environmentId,
  projectId,
  canOperate,
  editing,
  onDone,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  canOperate: boolean;
  /** The task being edited: what the form cannot change (its chat, folder) stays its own. */
  editing: ScheduledTask | null;
  onDone: () => void;
}) {
  const isGame = useGameLibrary().games.some(
    (game) => game.environmentId === environmentId && game.projectId === projectId,
  );
  const threads = useThreadShells();
  const initial = editing === null ? null : taskToDraft(editing);
  const upsert = useAtomCommand(scheduledTaskUpsert, { reportFailure: true });
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [draft, setDraft] = useState<DraftState>(
    () =>
      initial ?? {
        editingId: null,
        title: "",
        prompt: "",
        enabled: true,
        scheduleMode: "interval",
        intervalMinutes: "60",
        timeOfDay: "09:00",
        weekdays: new Set([1, 2, 3, 4, 5]),
        projectId,
        threadId: "",
        workspaceMode: "worktree",
        baseRef: "main",
        startFromOrigin: true,
        existingWorktreePath: "",
        modelKey: "",
        runtimeMode: "full-access",
        interactionMode: "default",
        baseModelSelection: null,
      },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      (draft.projectId || projectId) as never,
    ),
  );
  // A task in a game uses the game's agent unless the person picks another.
  const model =
    picked ??
    editing?.modelSelection ??
    scheduledTaskDefaultModel(
      settings,
      null,
      instanceEntries,
      isGame
        ? gameAgentModel(
            threads.filter((thread) => thread.environmentId === environmentId),
            projectId,
          )
        : null,
    );

  const save = async () => {
    const schedule = scheduleFromDraft(draft);
    const resolvedProjectId = draft.projectId || projectId;
    if (resolvedProjectId.trim().length === 0) {
      setError("No game to run it in. Make a game first.");
      return;
    }
    if (draft.prompt.trim().length === 0) {
      setError("Write the message the agent gets.");
      return;
    }
    if (draft.title.trim().length === 0 && draft.prompt.trim().length === 0) {
      setError("Give the task a name or a message.");
      return;
    }
    const modelSelection = model;
    if (modelSelection === null) {
      setError("No available provider model. Connect a provider first.");
      return;
    }
    setSaving(true);
    setError(null);
    // A promise chain, not try/finally, which React Compiler cannot compile.
    await upsert({
      environmentId,
      input: {
        ...(draft.editingId === null
          ? {}
          : { id: ScheduledTaskId.make(draft.editingId), requireExisting: true }),
        title:
          draft.title.trim() ||
          draft.prompt.split("\n")[0]?.trim().slice(0, 80) ||
          "Scheduled task",
        prompt: draft.prompt.trim(),
        enabled: draft.enabled,
        schedule,
        projectId: resolvedProjectId as never,
        threadId: editing?.threadId ?? null,
        // Kurambit never commits a game's work, so a worktree of its branch
        // would hold only the scaffold: a game's task runs in its own folder.
        workspaceStrategy: isGame
          ? { type: "root" }
          : (editing?.workspaceStrategy ?? {
              type: "worktree",
              baseRef: "main",
              startFromOrigin: true,
            }),
        modelSelection,
        runtimeMode: draft.runtimeMode,
        interactionMode: draft.interactionMode,
        creationSource: "web",
      },
    })
      .then(() => onDone())
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not save the scheduled task.");
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsSection title={editing === null ? "New task" : "Edit task"}>
      <div className="space-y-3 p-4">
        <Input
          value={draft.title}
          placeholder="Title (optional)"
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <Textarea
          value={draft.prompt}
          placeholder="The message your agent gets each time it runs"
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-4">
          <RadioGroup
            aria-label="Schedule"
            className="flex-row"
            value={draft.scheduleMode}
            onValueChange={(value) =>
              setDraft({ ...draft, scheduleMode: value === "fixed" ? "fixed" : "interval" })
            }
          >
            <label className="flex items-center gap-2 text-meta">
              <Radio value="interval" />
              Interval
            </label>
            <label className="flex items-center gap-2 text-meta">
              <Radio value="fixed" />
              Fixed time
            </label>
          </RadioGroup>
          <label className="flex items-center gap-2 text-meta">
            <Checkbox
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })}
            />
            Enabled
          </label>
        </div>
        {draft.scheduleMode === "interval" ? (
          <label className="flex items-center gap-2 text-meta">
            Every
            <Input
              value={draft.intervalMinutes}
              placeholder="60"
              onChange={(event) => setDraft({ ...draft, intervalMinutes: event.target.value })}
            />
            minutes
          </label>
        ) : (
          <Input
            value={draft.timeOfDay}
            placeholder="HH:MM (e.g. 09:00)"
            onChange={(event) => setDraft({ ...draft, timeOfDay: event.target.value })}
          />
        )}
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          Agent
          {model === null ? (
            "none available"
          ) : (
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={model.instanceId}
              model={model.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                model.instanceId,
                model.model,
              )}
              disabled={saving}
              onInstanceModelChange={(instanceId, selectedModel) =>
                setPicked(
                  model.instanceId === instanceId && model.model === selectedModel
                    ? model
                    : { instanceId, model: selectedModel },
                )
              }
            />
          )}
          {isGame ? (
            <span>
              {editing?.threadId ? "· runs in its Log" : "· runs in a new Log in the game's folder"}
            </span>
          ) : null}
        </div>
        {error !== null ? (
          <Text variant="meta" tone="destructive" render={<p />}>
            {error}
          </Text>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={saving} onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving || !canOperate} onClick={() => void save()}>
            {draft.editingId === null ? "Create task" : "Save"}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

export function ScheduledTasksSettings(props: {
  environmentId?: EnvironmentId;
  taskId?: ScheduledTaskId;
}) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryId ?? environments[0]?.environmentId ?? null;
  if (environmentId === null) {
    return (
      <SettingsPageContainer description={PAGE_DESCRIPTION}>
        <Text variant="body" tone="muted" render={<p className="px-3 sm:px-4" />}>
          Kurambit's server isn't connected yet.
        </Text>
      </SettingsPageContainer>
    );
  }
  return <ScheduledTasksPanel key={environmentId} environmentId={environmentId} />;
}

function ScheduledTasksPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const canOperate = useAtomValue(scheduledTaskUpsert.permissionAtom(environmentId));
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useEnvironmentQuery(scheduledTaskListQuery({ environmentId, input: {} }));
  const allTasks = query.data?.tasks ?? [];
  const tasks = allTasks.filter((task) => projectFilter === "" || task.projectId === projectFilter);
  const defaultProjectId = projectFilter || (projects[0]?.id ?? tasks[0]?.projectId ?? "");
  const loading = query.isPending && query.data === null;
  const projectTitle = (id: string) =>
    id === "" ? "All games" : (projects.find((project) => project.id === id)?.title ?? "A game");

  return (
    <SettingsPageContainer
      description={PAGE_DESCRIPTION}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate || creating}
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          <PlusIcon />
          New task
        </Button>
      }
    >
      {canOperate ? null : (
        <Text variant="meta" tone="muted" render={<p className="px-3 sm:px-4" />}>
          This window can see scheduled tasks but not change them.
        </Text>
      )}
      {creating ? (
        <DraftForm
          environmentId={environmentId}
          projectId={defaultProjectId}
          canOperate={canOperate}
          editing={null}
          onDone={() => setCreating(false)}
        />
      ) : null}
      {editing !== null ? (
        <DraftForm
          environmentId={environmentId}
          projectId={editing.projectId}
          canOperate={canOperate}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {query.error !== null ? (
        <Empty variant="well">
          <EmptyHeader>
            <EmptyTitle>Could not load scheduled tasks</EmptyTitle>
            <EmptyDescription>{query.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? null : allTasks.length === 0 ? (
        <Empty variant="well">
          <EmptyHeader>
            <EmptyTitle>No scheduled tasks</EmptyTitle>
            <EmptyDescription>
              A task sends the message you write on its schedule, such as a morning check that the
              game still plays. Keep going differs: it picks each next step from the build&apos;s
              evidence.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SettingsSection
          title="Tasks"
          headerAction={
            projects.length > 1 ? (
              <Select
                value={projectFilter}
                onValueChange={(value) => setProjectFilter(value ?? "")}
              >
                <SelectTrigger size="sm" className="w-44" aria-label="Show tasks for">
                  <SelectValue>{projectTitle(projectFilter)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="">All games</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null
          }
        >
          {tasks.length === 0 ? (
            <Text variant="meta" tone="muted" render={<p className="px-3 py-3 sm:px-4" />}>
              Nothing is scheduled in {projectTitle(projectFilter)}.
            </Text>
          ) : null}
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              environmentId={environmentId}
              task={task}
              canOperate={canOperate}
              onEdit={(next) => {
                setCreating(false);
                setEditing(next);
              }}
            />
          ))}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
