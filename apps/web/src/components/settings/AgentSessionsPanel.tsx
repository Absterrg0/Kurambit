import { useState } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentSessionImport } from "../../state/agentSessions";
import { useProjectScans } from "../../onboarding/useProjectScans";

/**
 * Local agent-session import. Lists foreign sessions found on this machine and
 * imports them as new threads without executing anything: the importer copies
 * history into a fresh thread, never resumes the live session.
 */
export function AgentSessionsPanel({
  environmentId: override,
  projectId: fixedProjectId,
  canOperate = true,
}: {
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
  canOperate?: boolean;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = override ?? primaryId;
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const importRecent = useAtomCommand(agentSessionImport, { reportFailure: true });

  const scans = useProjectScans(environmentId === null ? [] : [environmentId]);
  const scan = environmentId === null ? null : (scans[0] ?? null);

  if (environmentId === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Connect an environment to scan agent sessions.
      </p>
    );
  }

  const targetProjectId = fixedProjectId ?? (projectId.trim() as ProjectId);
  const candidates = scan?.data?.candidates ?? [];

  const doImport = async () => {
    if (targetProjectId.trim().length === 0) {
      setStatus("Pick the project id that owns the imported history.");
      return;
    }
    setStatus("Importing…");
    try {
      await importRecent({
        environmentId,
        input: { projectId: targetProjectId },
      });
      setStatus("Imported. New threads hold the copied history; nothing was executed.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Import failed.");
    }
  };

  return (
    <div className="space-y-3 p-4">
      <h2 className="text-sm font-semibold">Agent sessions (local import)</h2>
      <p className="text-xs text-muted-foreground">
        Found {candidates.length} project candidates on this machine. Import copies history into a
        new thread and never runs the foreign session.
      </p>
      {scan?.isPending ? <p className="text-xs text-muted-foreground">Scanning…</p> : null}
      {scan?.error ? <p className="text-xs text-destructive">{scan.error}</p> : null}
      <div className="space-y-1">
        {candidates.map((candidate) => (
          <div key={candidate.path} className="rounded-md border p-2 text-xs">
            <div className="font-medium">{candidate.title}</div>
            <div className="text-muted-foreground">{candidate.path}</div>
          </div>
        ))}
      </div>
      {fixedProjectId ? (
        <p className="text-xs text-muted-foreground">
          Imports land in this project as new threads.
        </p>
      ) : (
        <input
          className="w-full rounded-md border bg-transparent p-2 text-sm"
          value={projectId}
          placeholder="Project id to import into"
          onChange={(event) => setProjectId(event.target.value)}
        />
      )}
      <Button size="xs" disabled={!canOperate} onClick={() => void doImport()}>
        Import recent threads
      </Button>
      {!canOperate ? (
        <p className="text-xs text-muted-foreground">
          Read-only access: importing needs an environment session with operate permission.
        </p>
      ) : null}
      {status !== null ? <p className="text-xs text-muted-foreground">{status}</p> : null}
    </div>
  );
}
