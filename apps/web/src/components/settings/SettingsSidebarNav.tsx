import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import {
  ArchiveIcon,
  BlocksIcon,
  BotIcon,
  CalendarClockIcon,
  createLucideIcon,
  GitBranchIcon,
  HardDriveIcon,
  PanelsTopLeftIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  SearchIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  searchSettings,
  isSettingsOverviewVisible,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";
import { validateSettingsScopeSearch } from "./settingsScope";

const SnapShotIcon = createLucideIcon("snap-shot", [
  [
    "path",
    {
      d: "M8 3H6a3 3 0 0 0-3 3v2M16 3h2a3 3 0 0 1 3 3v2M21 16v2a3 3 0 0 1-3 3h-2M8 21H6a3 3 0 0 1-3-3v-2",
      key: "capture-frame",
    },
  ],
  ["rect", { width: "10", height: "8", x: "7", y: "8", rx: "2", key: "window" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "lens" }],
]);

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/diagnostics": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/projects": PanelsTopLeftIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/snap-shot": SnapShotIcon,
  "/settings/providers": BotIcon,
  "/settings/integrations": BlocksIcon,
  "/settings/scheduled-tasks": CalendarClockIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/storage": HardDriveIcon,
  "/settings/connections": Link2Icon,
  "/settings/archived": ArchiveIcon,
};

// A game studio's order: what a game maker changes first, then the agents, then
// the coding and machine settings most never open.
const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  readonly heading: string;
  readonly paths: ReadonlyArray<SettingsPath>;
}> = [
  {
    heading: "Studio",
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/keybindings",
      "/settings/snap-shot",
    ],
  },
  { heading: "Agents", paths: ["/settings/providers", "/settings/integrations"] },
  {
    heading: "Advanced",
    paths: [
      "/settings/source-control",
      "/settings/storage",
      "/settings/scheduled-tasks",
      "/settings/connections",
      "/settings/archived",
      "/settings/projects",
    ],
  },
];

// Detail pages without a nav entry highlight the page that links to them.
const SETTINGS_DETAIL_PAGE_PARENTS: Readonly<Record<string, SettingsPath>> = {
  "/settings/diagnostics": "/settings/general",
  "/settings/open-source-licenses": "/settings/general",
};

// Attached only to the highlighted result, so it runs whenever the highlight lands on a row.
function scrollResultIntoView(row: HTMLElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}

function SettingsSectionIcon({ to }: { to: SettingsPath }) {
  const Icon = SETTINGS_SECTION_ICONS[to];
  return <Icon className="mt-0.5 size-3.5 shrink-0" />;
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const currentHash = useLocation({ select: (location) => location.hash });
  const currentSearch = useLocation({ select: (location) => location.search });
  const scopeSearch = validateSettingsScopeSearch(currentSearch);
  const projectPageVisible = isSettingsOverviewVisible(scopeSearch);
  const activePath = SETTINGS_DETAIL_PAGE_PARENTS[pathname] ?? pathname;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const searchableItems = useAvailableSettingsSearchItems(scopeSearch);
  const results = searchSettings(query, searchableItems);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;
  const maxResultIndex = Math.max(results.length - 1, 0);
  // Persist the clamp so a shrink-then-recover of results keeps the clamped highlight.
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      // The settings panel is itself a dialog; only layers opened inside it keep these keys.
      if (
        target instanceof HTMLElement &&
        ((isSlashShortcut &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)) ||
          target.closest(
            '[role="dialog"]:not([data-settings-dialog]), [aria-modal="true"]:not([data-settings-dialog]), [data-slot$="popup"]:not([data-settings-dialog]), [data-keybinding-capture]',
          ) !== null)
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSectionClick = (to: SettingsPath) => {
    void navigate({
      to,
      hash: "",
      replace: true,
      hashScrollIntoView: false,
    });
  };

  const clearSearch = () => {
    setQuery("");
    setActiveResultIndex(0);
  };
  const handleSearchResultClick = (item: SettingsSearchItem) => {
    clearSearch();
    const targetId = item.targetId ?? item.id;
    if (pathname === item.to && currentHash.replace(/^#/, "") === targetId) {
      scrollToSettingsTarget(targetId);
      return;
    }
    void navigate({
      to: item.to,
      hash: targetId,
      replace: true,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && isSearching) {
      // The first Escape clears the search; the next one closes the panel.
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) handleSearchResultClick(result);
    }
  };

  return (
    <nav
      aria-label="Settings sections"
      className="flex w-56 shrink-0 flex-col border-e max-md:w-48"
    >
      <SidebarContent
        className="overflow-x-hidden"
        fixedHeader={
          <div className="px-3 pt-3 pb-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchInputRef}
                nativeInput
                size="compact"
                // Not type="search": a native search field clears itself on Escape,
                // which would swallow the Escape that closes the panel.
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setActiveResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search settings"
                aria-label="Search settings"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={isSearching && hasResults}
                aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
                aria-activedescendant={
                  isSearching && results[activeResultIndex]
                    ? `settings-search-result-${results[activeResultIndex].id}`
                    : undefined
                }
              />
              <InputGroupAddon align="inline-end">
                {isSearching ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label="Clear settings search"
                    onClick={() => {
                      clearSearch();
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : (
                  <Kbd>/</Kbd>
                )}
              </InputGroupAddon>
            </InputGroup>
          </div>
        }
      >
        <SidebarGroup>
          {isSearching && results.length === 0 ? (
            <p role="status" className="px-2 py-6 text-center text-meta text-muted-foreground">
              No settings found
            </p>
          ) : null}
          {isSearching ? (
            <SidebarMenu
              id={hasResults ? "settings-search-results" : undefined}
              role={hasResults ? "listbox" : undefined}
              aria-label={hasResults ? "Settings search results" : undefined}
            >
              {results.map((item, index) => (
                <SidebarMenuItem
                  key={item.id}
                  role="presentation"
                  ref={index === activeResultIndex ? scrollResultIntoView : undefined}
                >
                  <SidebarMenuButton
                    id={`settings-search-result-${item.id}`}
                    role="option"
                    aria-selected={index === activeResultIndex}
                    tabIndex={-1}
                    isActive={index === activeResultIndex}
                    className="h-auto min-h-10 items-start"
                    onMouseMove={() => setActiveResultIndex(index)}
                    onClick={() => handleSearchResultClick(item)}
                  >
                    <SettingsSectionIcon to={item.to} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-label text-sidebar-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-micro text-sidebar-muted-foreground">
                        {SETTINGS_SECTION_LABELS[item.to]}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <div className="flex flex-col gap-3">
              {SETTINGS_NAV_GROUPS.map((group) => (
                <div
                  key={group.heading}
                  role="group"
                  aria-labelledby={`settings-nav-${group.heading}`}
                >
                  <h3
                    id={`settings-nav-${group.heading}`}
                    className="px-(--sidebar-row-content-inset) pb-1 text-meta text-muted-foreground"
                  >
                    {group.heading}
                  </h3>
                  <SidebarMenu>
                    {group.paths
                      .filter((to) => to !== "/settings/projects" || projectPageVisible)
                      .map((to) => {
                        const Icon = SETTINGS_SECTION_ICONS[to];
                        const isActive = activePath === to || activePath.startsWith(`${to}/`);
                        return (
                          <SidebarMenuItem key={to}>
                            <SidebarMenuButton
                              isActive={isActive}
                              aria-current={isActive ? "page" : undefined}
                              onClick={() => handleSectionClick(to)}
                            >
                              <Icon />
                              <span className="truncate">{SETTINGS_SECTION_LABELS[to]}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                  </SidebarMenu>
                </div>
              ))}
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}
