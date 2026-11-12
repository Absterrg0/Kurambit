import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

/** A settings page's name, as its breadcrumb and its page title read it. */
export function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

/**
 * The panel's own name. Each page's title already names the section, so the
 * header no longer repeats it as a second breadcrumb step.
 */
export function SettingsBreadcrumb() {
  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      <WorkspaceBreadcrumbItem current>Settings</WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
