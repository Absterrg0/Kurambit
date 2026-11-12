import type { EnvironmentConnectionPhase } from "@kurambit/client-runtime/connection";

import { usePrimaryEnvironment } from "../../state/environments";
import { StatusLabel, type StatusDotTone } from "../ui/status-dot";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PHASE_STATUS: Record<EnvironmentConnectionPhase, { tone: StatusDotTone; label: string }> = {
  connected: { tone: "success", label: "Connected" },
  connecting: { tone: "neutral", label: "Connecting" },
  reconnecting: { tone: "warning", label: "Reconnecting" },
  available: { tone: "neutral", label: "Not connected" },
  offline: { tone: "danger", label: "Offline" },
  error: { tone: "danger", label: "Could not connect" },
  unsupported: { tone: "danger", label: "Needs an update" },
};

/** The one server Kurambit runs, as a row in General's About. */
export function LocalServerRow() {
  const environment = usePrimaryEnvironment();
  const status = PHASE_STATUS[environment?.connection.phase ?? "connecting"];
  return (
    <SettingsRow
      {...searchableSetting("connections-environment")}
      description={`Runs your agents and game tools on ${environment?.label ?? "this computer"}.`}
      status={<StatusLabel tone={status.tone}>{status.label}</StatusLabel>}
      inlineControl
    />
  );
}
