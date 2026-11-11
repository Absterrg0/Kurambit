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

/**
 * The agent and model a new or opened game starts with: the person's pick,
 * else the one their last game used while its provider is usable, else
 * Claude's own default, else the first ready provider's.
 */
export function useGameModelChoice(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [lastGameModel, setLastGameModel] = useLocalStorage(
    `game-entry-picked-model:${environmentId}`,
    null,
    lastGameModelSchema,
  );
  // A game's first turn starts the moment it is created, so only an agent that
  // can work now (installed and signed in) may make it.
  const isReady = (instanceId: string) =>
    entries.some(
      (entry) => entry.instanceId === instanceId && isProviderInstancePickerReady(entry),
    );
  const remembered =
    lastGameModel !== null && isReady(lastGameModel.instanceId) ? lastGameModel : null;
  // A game's first turn builds the whole game, so it gets the provider's own default (its
  // flagship) at the provider's default effort, never the cheap model the app summarises with.
  const firstChoice =
    entries.find(
      (entry) => entry.driverKind === "claudeAgent" && isProviderInstancePickerReady(entry),
    ) ?? entries.find(isProviderInstancePickerReady);
  const textDefault = resolveAppModelSelectionState(settings, providers);
  const freshInstanceId = firstChoice?.instanceId ?? textDefault.instanceId;
  const fresh: ModelSelection = {
    instanceId: freshInstanceId,
    model: getDefaultProviderInstanceModel(providers, freshInstanceId) ?? textDefault.model,
  };
  const model = selection ?? remembered ?? fresh;
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
