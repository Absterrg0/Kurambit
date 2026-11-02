import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ScheduledTaskId, type EnvironmentId, type ScheduledTask } from "@kurambit/contracts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useProjects } from "../../state/entities";
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
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
} from "./scheduledTasksSettings.logic";

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
  return "On webhook (not available locally)";
}

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
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{task.title}</div>
          <div className="text-xs text-muted-foreground">
            {describeSchedule(task.schedule)}
            {task.nextRunAt ? ` · next ${task.nextRunAt}` : ""}
            {task.lastRunStatus ? ` · last ${task.lastRunStatus}` : ""}
            {task.enabled ? "" : " · paused"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
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
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void run("run", () => runNow({ environmentId, input: { id: task.id } }))}
          >
            Run now
          </Button>
          <Button size="xs" variant="outline" disabled={disabled} onClick={() => onEdit(task)}>
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void run("delete", () => remove({ environmentId, input: { id: task.id } }))
            }
          >
            Delete
          </Button>
        </div>
      </div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.prompt}</div>
    </div>
  );
}

function DraftForm({
  environmentId,
  projectId,
  canOperate,
  initial,
  onDone,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  canOperate: boolean;
  initial: DraftState | null;
  onDone: () => void;
}) {
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
        signatureEnabled: false,
        signatureHeader: "x-hub-signature-256",
        signatureEncoding: "hex",
        signaturePrefix: "sha256=",
        signatureSecret: "",
        maxDeliveryAgeMinutes: "",
      },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      setError("Pick a valid interval (minutes ≥ 1) or fixed time (HH:MM).");
      return;
    }
    const resolvedProjectId = draft.projectId || projectId;
    if (resolvedProjectId.trim().length === 0) {
      setError("No project available. Create a project first.");
      return;
    }
    if (draft.prompt.trim().length === 0) {
      setError("Prompt is required.");
      return;
    }
    if (draft.title.trim().length === 0 && draft.prompt.trim().length === 0) {
      setError("Title or prompt is required.");
      return;
    }
    const instanceEntries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        settings,
        resolvedProjectId as never,
      ),
    );
    const modelSelection = scheduledTaskDefaultModel(settings, null, instanceEntries);
    if (modelSelection === null) {
      setError("No available provider model. Connect a provider first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
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
          threadId: null,
          workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
          modelSelection,
          runtimeMode: draft.runtimeMode,
          interactionMode: draft.interactionMode,
          creationSource: "web",
        },
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the scheduled task.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <Input
        value={draft.title}
        placeholder="Title (optional)"
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <textarea
        className="min-h-20 w-full rounded-md border bg-transparent p-2 text-sm"
        value={draft.prompt}
        placeholder="Prompt run on schedule"
        onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
      />
      <div className="flex gap-2">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="radio"
            checked={draft.scheduleMode === "interval"}
            onChange={() => setDraft({ ...draft, scheduleMode: "interval" })}
          />
          Interval
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="radio"
            checked={draft.scheduleMode === "fixed"}
            onChange={() => setDraft({ ...draft, scheduleMode: "fixed" })}
          />
          Fixed time
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
      {draft.scheduleMode === "interval" ? (
        <Input
          value={draft.intervalMinutes}
          placeholder="Minutes (e.g. 60)"
          onChange={(event) => setDraft({ ...draft, intervalMinutes: event.target.value })}
        />
      ) : (
        <Input
          value={draft.timeOfDay}
          placeholder="HH:MM (e.g. 09:00)"
          onChange={(event) => setDraft({ ...draft, timeOfDay: event.target.value })}
        />
      )}
      <p className="text-xs text-muted-foreground">
        Local schedules only. Webhook schedules have no public URL on this desktop build; use an
        interval or fixed time.
      </p>
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="xs" disabled={saving || !canOperate} onClick={() => void save()}>
          {draft.editingId === null ? "Create" : "Save"}
        </Button>
        <Button size="xs" variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
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
      <p className="p-4 text-sm text-muted-foreground">
        Connect an environment to manage scheduled tasks.
      </p>
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

  if (query.isPending && query.data === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading scheduled tasks…</p>;
  }
  if (query.error !== null) {
    return <p className="p-4 text-sm text-destructive">{query.error}</p>;
  }
  const tasks = (query.data?.tasks ?? []).filter(
    (task) => projectFilter === "" || task.projectId === projectFilter,
  );
  const defaultProjectId = projects[0]?.id ?? tasks[0]?.projectId ?? "";

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Scheduled tasks (local)</h2>
        <Button
          size="xs"
          disabled={!canOperate}
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          New task
        </Button>
      </div>
      {canOperate ? null : (
        <p className="text-xs text-muted-foreground">
          Read-only access: task changes need an environment session with operate permission.
        </p>
      )}
      {projects.length > 1 ? (
        <select
          className="rounded-md border bg-transparent p-1 text-xs"
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      ) : null}
      {creating ? (
        <DraftForm
          environmentId={environmentId}
          projectId={defaultProjectId}
          canOperate={canOperate}
          initial={null}
          onDone={() => setCreating(false)}
        />
      ) : null}
      {editing !== null ? (
        <DraftForm
          environmentId={environmentId}
          projectId={editing.projectId}
          canOperate={canOperate}
          initial={taskToDraft(editing)}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scheduled tasks yet. Create one to run a prompt on an interval or at a fixed time.
        </p>
      ) : (
        tasks.map((task) => (
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
        ))
      )}
    </div>
  );
}
