import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@kurambit/contracts";
import { acpRegistryClient } from "@kurambit/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@kurambit/provider-core/client";
import { cursorClient } from "@kurambit/provider-cursor/client";
import { grokClient } from "@kurambit/provider-grok/client";
import { museClient } from "@kurambit/provider-muse/client";
import { openCodeClient } from "@kurambit/provider-opencode/client";
import { piClient } from "@kurambit/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
