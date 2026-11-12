import { useState } from "react";
import * as Schema from "effect/Schema";
import { ModelSelection, type EnvironmentId } from "@kurambit/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";

const lastGameModelSchema = Schema.NullOr(ModelSelection);

type ProviderEntries = ReturnType<typeof deriveProviderInstanceEntries>;

/** The model the person's last game started on, kept per environment. */
export const useLastGameModel = (environmentId: string) =>
  useLocalStorage(`game-entry-picked-model:${environmentId}`, null, lastGameModelSchema);

/**
 * PURE. What a new game starts on when Settings names no model for new games:
 * the one the person's last game used while its provider is usable, else
 * Claude's own default, else the first ready provider's. Settings shows this
 * same answer, so the setting and Home's box never disagree.
 */
export const newGameFallback = (
  entries: ProviderEntries,
  providers: Parameters<typeof getDefaultProviderInstanceModel>[0],
  settings: Parameters<typeof resolveAppModelSelectionState>[0],
  lastGameModel: ModelSelection | null,
): ModelSelection => {
  const isReady = (instanceId: string) =>
    entries.some(
      (entry) => entry.instanceId === instanceId && isProviderInstancePickerReady(entry),
    );
  if (lastGameModel !== null && isReady(lastGameModel.instanceId)) return lastGameModel;
  // A game's first turn builds the whole game, so it gets the provider's own default (its
  // flagship) at the provider's default effort, never the cheap model the app summarises with.
  const firstChoice =
    entries.find(
      (entry) => entry.driverKind === "claudeAgent" && isProviderInstancePickerReady(entry),
    ) ?? entries.find(isProviderInstancePickerReady);
  const textDefault = resolveAppModelSelectionState(settings, providers);
  const instanceId = firstChoice?.instanceId ?? textDefault.instanceId;
  return {
    instanceId,
    model: getDefaultProviderInstanceModel(providers, instanceId) ?? textDefault.model,
  };
};

/**
 * The agent and model a new or opened game starts with: the person's pick,
 * else Settings' "Model for new games" while its provider is usable, else
 * newGameFallback.
 */
export function useGameModelChoice(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [lastGameModel, setLastGameModel] = useLastGameModel(environmentId);
  // A game's first turn starts the moment it is created, so only an agent that
  // can work now (installed and signed in) may make it.
  const isReady = (instanceId: string) =>
    entries.some(
      (entry) => entry.instanceId === instanceId && isProviderInstancePickerReady(entry),
    );
  const configured =
    settings.defaultModelSelection !== null &&
    settings.defaultModelSelection !== undefined &&
    isReady(settings.defaultModelSelection.instanceId)
      ? settings.defaultModelSelection
      : null;
  const model =
    selection ?? configured ?? newGameFallback(entries, providers, settings, lastGameModel);
  const modelEntry = entries.find((entry) => entry.instanceId === model.instanceId);
  return {
    entries,
    model,
    modelEntry,
    options: getCustomModelOptionsByInstance(settings, providers, model.instanceId, model.model),
    ready: isReady(model.instanceId),
    /** Why the chosen agent cannot start a game now; null when it can. */
    notReadyReason: isReady(model.instanceId)
      ? null
      : modelEntry === undefined
        ? "No agent is ready. Sign in, or add one in Settings → Providers."
        : `${modelEntry.displayName} is not ready: ${modelEntry.snapshot.message ?? "it is not signed in."} Sign in, or pick another agent.`,
    choose: setSelection,
    /** Keeps the model for the person's next game. */
    remember: () => setLastGameModel(model),
  };
}
