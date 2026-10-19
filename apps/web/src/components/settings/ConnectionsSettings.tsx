import { usePrimaryEnvironment } from "../../state/environments";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function ConnectionsSettings() {
  const environment = usePrimaryEnvironment();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Local environment">
        <p className="text-sm text-muted-foreground">
          {environment?.label ?? "Local server"}: {environment?.connection.phase ?? "connecting"}
        </p>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
