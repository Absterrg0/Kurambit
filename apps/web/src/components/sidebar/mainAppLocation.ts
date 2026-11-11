import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/** Settings opens as a panel over the last main-app view instead of replacing it. */
export function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** Pages that take over the main pane; the sidebar offers Back from them. */
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") || pathname === "/usage" || pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;
let settingsReturnHref: string | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSettingsPage(location.pathname) ? null : location.href),
  });
  const utilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  useEffect(() => {
    if (href === null) return;
    settingsReturnHref = href;
    if (!utilityPage) mainAppHref = href;
  }, [href, utilityPage]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings for the page that opened it, which may be a utility page such as Usage. */
export function useCloseSettings() {
  const navigate = useNavigate();
  return () => navigate({ href: settingsReturnHref ?? mainAppHref ?? "/" });
}
