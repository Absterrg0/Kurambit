import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Switch } from "../ui/switch";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerControl } from "./ComposerControl";

// A game's footer meter turns amber from here: near enough the limit to think about compacting.
const NEAR_LIMIT_PERCENT = 80;

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  /**
   * `footer`: a quiet footer control, "209k" beside its ring, muted until near the limit and
   * amber from there; a click opens it, where Compact is. It also holds whether the next send
   * compacts first, which the default look leaves to Send's own Compact pill.
   */
  variant?: "default" | "footer";
  compactBeforeSendTokens?: number | null | undefined;
  keepFullHistory?: boolean | undefined;
  onToggleKeepFullHistory?: (() => void) | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const footer = props.variant === "footer";
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const nearLimit = usage.maxTokens !== null && normalizedPercentage >= NEAR_LIMIT_PERCENT;
  const usageColor = footer
    ? nearLimit
      ? "var(--color-warning)"
      : "currentColor"
    : isOverloaded
      ? "var(--color-error)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const label =
    usage.maxTokens !== null && usedPercentage
      ? `Context window ${usedPercentage} used`
      : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`;
  const ring = (
    <svg
      viewBox="0 0 24 24"
      className={cn(
        "-rotate-90 transform-gpu mx-0!",
        footer ? "size-3.5" : "absolute inset-0 size-full",
      )}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        className={footer ? "stroke-current opacity-25" : "stroke-muted-foreground/24"}
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke={usageColor}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  );

  return (
    <Popover>
      {footer ? (
        <PopoverTrigger
          render={
            <ComposerControl
              size="xs"
              aria-label={label}
              data-context-window-meter="footer"
              className={cn("tabular-nums", nearLimit && "text-warning hover:text-warning")}
            />
          }
        >
          {ring}
          <span data-composer-control-label>{formatContextWindowTokens(usage.usedTokens)}</span>
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          openOnHover
          delay={150}
          closeDelay={onCompact ? 150 : 0}
          render={
            <Button size="icon-sm" variant="ghost-muted" className="size-7" aria-label={label}>
              <span className="relative flex size-5 items-center justify-center">{ring}</span>
            </Button>
          }
        />
      )}
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {footer &&
          props.compactBeforeSendTokens != null &&
          props.onToggleKeepFullHistory !== undefined ? (
            <label className="mt-1 flex cursor-pointer items-center justify-between gap-3 text-2xs text-secondary-label">
              Compact before the next send
              <Switch
                size="sm"
                checked={!props.keepFullHistory}
                onCheckedChange={props.onToggleKeepFullHistory}
              />
            </label>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
