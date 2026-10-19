import { memo } from "react";
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { BotIcon, PencilRulerIcon } from "lucide-react";
import { runtimeModeConfig } from "./runtimeModeConfig";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerControlSeparator,
  ComposerSelectControl,
} from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

type RuntimeModeOption = { mode: RuntimeMode } & (typeof runtimeModeConfig)[RuntimeMode];
const supervisedRuntimeModeOption = {
  mode: "approval-required" as const,
  ...runtimeModeConfig["approval-required"],
};
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  size?: "sm" | "xs";
  hidden?: boolean;
  /** Game threads have no access level to pick. */
  showRuntimeMode?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const size = props.size ?? "sm";
  const showRuntimeMode = props.showRuntimeMode ?? true;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const runtimeModeOption =
    props.runtimeModeOptions.find((option) => option.mode === props.runtimeMode) ??
    supervisedRuntimeModeOption;
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <ComposerControlSeparator size={size} />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className="shrink-0 whitespace-nowrap"
              aria-pressed={props.interactionMode === "plan"}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon
              icon={PencilRulerIcon}
              size={size}
              className="text-current opacity-100"
            />
          ) : (
            <ComposerControlIcon
              icon={BotIcon}
              size={size}
              opticalSize={size === "xs" ? "default" : "large"}
            />
          )}
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  if (!showRuntimeMode) return interactionModeToggle;
  return (
    <>
      <ComposerControlSeparator size={size} />

      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                data-composer-shortcut="composer.mode"
                size={size}
                aria-label="Runtime mode"
              />
            }
          >
            <ComposerControlIcon icon={RuntimeModeIcon} size={size} />
            <SelectValue data-composer-control-label>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
            {props.runtimeModeOptions.map((option) => {
              const OptionIcon = option.icon;
              return (
                <SelectItem
                  key={option.mode}
                  value={option.mode}
                  hideIndicator
                  className="min-w-64"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});
