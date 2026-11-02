import { useAtomValue } from "@effect/atom-react";
import { useId } from "react";

import { APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

const STAGE_BACKDROP_VIEW_BOX = "0 0 8192 96";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  enabled = true,
): SidebarStageBackdropVariant | null {
  if (!enabled) return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(enabled = true): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), enabled);
}

export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

export function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt /> : <DevBlueprintArt />;
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return variant === "nightly" ? <NightlySkyArt compact /> : <DevBlueprintArt compact />;
}

const NIGHTLY_STARS: ReadonlyArray<{ cx: number; cy: number; r: number; opacity: number }> = [
  { cx: 22, cy: 14, r: 0.7, opacity: 0.8 },
  { cx: 61, cy: 30, r: 0.5, opacity: 0.5 },
  { cx: 97, cy: 11, r: 0.6, opacity: 0.7 },
  { cx: 142, cy: 24, r: 0.5, opacity: 0.55 },
  { cx: 214, cy: 9, r: 0.7, opacity: 0.8 },
  { cx: 251, cy: 33, r: 0.4, opacity: 0.45 },
  { cx: 292, cy: 16, r: 0.6, opacity: 0.65 },
];

/** Nightly: indigo night over the ink, a crescent like the icon's seal. */
function NightlySkyArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const skyId = `${idPrefix}-stage-night-sky`;
  const glowId = `${idPrefix}-stage-night-glow`;

  return (
    <svg
      data-stage-art="nightly"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "96 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-night-top)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-night-bottom)" }} />
        </linearGradient>
        <radialGradient id={glowId} cx="236" cy="22" r="70" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-night-highlight)", stopOpacity: 0.35 }} />
          <stop offset="1" style={{ stopColor: "var(--stage-night-highlight)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <rect width="100%" height="96" fill={`url(#${skyId})`} />
      <rect width="100%" height="96" fill={`url(#${glowId})`} />
      {NIGHTLY_STARS.map((star) => (
        <circle
          key={`${star.cx}-${star.cy}`}
          cx={star.cx}
          cy={star.cy}
          r={star.r}
          style={{ fill: "var(--stage-night-sparkle)" }}
          opacity={star.opacity}
        />
      ))}
      <path
        d="M236 10a12 12 0 1 0 9.5 19.3A10 10 0 1 1 236 10Z"
        style={{ fill: "var(--stage-night-line)" }}
        opacity="0.85"
      />
    </svg>
  );
}

/** Dev: a vermilion wash fading into sumi ink, the colors of the fox. */
function DevBlueprintArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const washId = `${idPrefix}-stage-wash`;
  const glowId = `${idPrefix}-stage-wash-glow`;

  return (
    <svg
      data-stage-art="blueprint"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "64 0 8192 96" : STAGE_BACKDROP_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={washId} x1="0" y1="0" x2="340" y2="96" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-art-top)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--stage-art-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--stage-art-bottom)" }} />
        </linearGradient>
        <radialGradient id={glowId} cx="40" cy="8" r="120" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "var(--stage-art-highlight)", stopOpacity: 0.35 }} />
          <stop offset="1" style={{ stopColor: "var(--stage-art-highlight)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <rect width="100%" height="96" fill={`url(#${washId})`} />
      <rect width="100%" height="96" fill={`url(#${glowId})`} />
    </svg>
  );
}
