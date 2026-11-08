import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY = "kurambit:provider-update-dismissals:v1";

const ProviderUpdateDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type ProviderUpdateDismissals = typeof ProviderUpdateDismissalsSchema.Type;

function readProviderUpdateDismissals(): ProviderUpdateDismissals {
  try {
    return (
      getLocalStorageItem(
        PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
        ProviderUpdateDismissalsSchema,
      ) ?? {
        keys: [],
      }
    );
  } catch (error) {
    console.error("Could not read provider-update dismissals.", error);
    return { keys: [] };
  }
}

function writeProviderUpdateDismissals(document: ProviderUpdateDismissals): void {
  try {
    setLocalStorageItem(
      PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
      document,
      ProviderUpdateDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist provider-update dismissals.", error);
  }
}

export function isProviderUpdateNotificationDismissed(
  dismissalKey: string | null | undefined,
): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readProviderUpdateDismissals().keys.includes(dismissalKey);
}

export function dismissProviderUpdateNotification(dismissalKey: string | null | undefined): void {
  const trimmedKey = dismissalKey?.trim();
  if (!trimmedKey) {
    return;
  }
  const document = readProviderUpdateDismissals();
  if (document.keys.includes(trimmedKey)) {
    return;
  }
  writeProviderUpdateDismissals({
    keys: [...document.keys, trimmedKey],
  });
}
