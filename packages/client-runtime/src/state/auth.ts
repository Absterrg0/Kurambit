import type { AuthAccessSnapshot, AuthAccessStreamSnapshotEvent } from "@kurambit/contracts";

import type { EnvironmentRegistry } from "../connection/registry.ts";

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};
