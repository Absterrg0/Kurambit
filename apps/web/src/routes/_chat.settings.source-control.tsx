import { createFileRoute } from "@tanstack/react-router";
import { SourceControlWritingSettingsSection } from "../components/settings/SourceControlWritingSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { ProjectDefaultsSettings } from "../components/settings/ProjectDefaultsSettings";

export const Route = createFileRoute("/_chat/settings/source-control")({
  component: () => (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="source-control" />
      <SourceControlWritingSettingsSection />
    </SettingsPageContainer>
  ),
});
