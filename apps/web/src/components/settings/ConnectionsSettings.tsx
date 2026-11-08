import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ConnectionsSettings() {
  const environment = usePrimaryEnvironment();
  const phase = environment?.connection.phase ?? "connecting";
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("connections-environment")}>
        <SettingsRow
          title={environment?.label ?? "Local server"}
          description="This machine's Kurambit server, which runs your agents and game tools."
          status={
            <Badge variant={phase === "connected" ? "success" : "outline"} size="sm">
              {phase === "connected" ? "Connected" : phase}
            </Badge>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
