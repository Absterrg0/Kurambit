import { useAtomValue } from "@effect/atom-react";
import { KurambitMark } from "../brand/KurambitBrand";
import { Text } from "../ui/text";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@kurambit/contracts";
import { scopeThreadRef } from "@kurambit/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ThreadId,
} from "@kurambit/contracts";
import * as Schema from "effect/Schema";
import { ArrowRightIcon, CheckIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";

import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { getProviderSummary } from "../settings/providerStatus";
import { providerClients } from "../settings/providerDriverMeta";
import { ChatGptWelcomeCoordinator } from "../settings/ChatGptWelcomeCoordinator";
import { AddManagedCodexAccountDialog, CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Button } from "../ui/button";

import { ScrollArea } from "../ui/scroll-area";
import { WizardPanel, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");

export function WelcomeWizard({
  onDone,
  resumeEnvironmentId,
}: {
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: () => void | Promise<void>;
}) {
  const completeOnboarding = useCompleteOnboarding();
  // Kurambit runs on this computer only, so first run is one page: the agents here.
  const primaryEnvironment = usePrimaryEnvironment();
  const setupId = resumeEnvironmentId ?? primaryEnvironment?.environmentId ?? null;
  const [isFinishing, setIsFinishing] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const finish = () => {
    if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
    if (completionErrorToastIdRef.current !== null) {
      toastManager.close(completionErrorToastIdRef.current);
      completionErrorToastIdRef.current = null;
    }

    setIsFinishing(true);
    const completion = completeOnboarding()
      .then(async () => {
        if (completionErrorToastIdRef.current !== null) {
          toastManager.close(completionErrorToastIdRef.current);
          completionErrorToastIdRef.current = null;
        }
        await onDone();
        return true;
      })
      .catch(() => {
        const errorToast = {
          type: "error",
          title: "Could not finish setup",
          description: "Your settings could not be saved. Try again.",
        } as const;
        if (completionErrorToastIdRef.current === null) {
          completionErrorToastIdRef.current = toastManager.add(errorToast);
        } else {
          toastManager.update(completionErrorToastIdRef.current, errorToast);
        }
        return false;
      })
      .finally(() => {
        if (finishingPromiseRef.current === completion) {
          finishingPromiseRef.current = null;
          setIsFinishing(false);
        }
      });
    finishingPromiseRef.current = completion;
    return completion;
  };

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        showCloseButton={false}
        // The panel takes focus, not its button, so no focus ring is drawn before any key.
        initialFocus={() =>
          document.getElementById("onboarding-pairing-url") ??
          document.querySelector<HTMLElement>("[data-welcome-popup]") ??
          true
        }
        data-welcome-popup=""
      >
        <WizardHeader
          title="Set up Kurambit"
          identity={
            // The same wordmark as the sidebar's: the mark and the name in plain type.
            <div className="flex items-center gap-2" role="img" aria-label="Kurambit">
              <KurambitMark className="size-6" />
              <Text variant="label" tone="strong">
                Kurambit
              </Text>
            </div>
          }
        ></WizardHeader>

        <WizardPanel>
          <AgentsStep
            environmentIds={setupId === null ? [] : [setupId]}
            isFinishing={isFinishing}
            onContinue={() => void finish()}
          />
        </WizardPanel>
      </WizardPopup>
      <ChatGptWelcomeCoordinator />
    </Dialog>
  );
}

const PRIMARY_AGENT_DRIVERS = ["codex", "claudeAgent"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

function AgentsStep({
  environmentIds,
  isFinishing,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly isFinishing: boolean;
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  return (
    <StepShell
      title="Connect your agents"
      description="Sign in to the agents that build your games; you pick one for each new game. Agents already installed here are listed; add another, such as Cursor, in Settings → Providers."
    >
      {/* The list gets what the dialog's header, title and button leave, so the
          button stays on screen on short windows. */}
      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,calc(100dvh-24rem))]">
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              // This computer goes without saying; only another one is named.
              machineLabel={
                environmentId === primaryEnvironmentId && environmentIds.length === 1
                  ? null
                  : (environments.find((environment) => environment.environmentId === environmentId)
                      ?.label ?? "Computer")
              }
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button disabled={isFinishing} onClick={onContinue}>
          {isFinishing ? "Finishing setup…" : "Start making games"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string | null;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<{
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null>(null);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);

  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const byDriver = selectOnboardingProvidersByDriver(providers);
  // Codex and Claude always show, to sign in or install; any other agent shows
  // once it is on (a fresh home turns on the ones already installed).
  const otherAgents = (providers ?? []).filter(
    (provider) =>
      provider.enabled &&
      !(PRIMARY_AGENT_DRIVERS as ReadonlyArray<string>).includes(provider.driver),
  );

  const primaryAgents = PRIMARY_AGENT_DRIVERS.flatMap((driver) => {
    const instances =
      driver === "codex" ? providers?.filter((provider) => provider.driver === driver) : undefined;
    return instances?.length
      ? instances.map((provider) => ({ driver, provider, instanceId: provider.instanceId }))
      : [{ driver, provider: byDriver.get(driver), instanceId: byDriver.get(driver)?.instanceId }];
  });
  if (createdAccount) {
    const index = primaryAgents.findIndex(
      (agent) => agent.instanceId === createdAccount.instanceId,
    );
    const [existing] = index >= 0 ? primaryAgents.splice(index, 1) : [];
    primaryAgents.unshift(
      existing ?? {
        driver: "codex",
        provider: undefined,
        instanceId: createdAccount.instanceId,
      },
    );
  }
  return (
    <section>
      {machineLabel === null ? null : <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>}
      {!canOperateTerminal ? (
        <p className="mb-2 text-sm text-muted-foreground">
          This connection cannot control terminals.
        </p>
      ) : null}
      <div className="space-y-1.5">
        {primaryAgents.map(({ driver, provider, instanceId }) =>
          driver === "codex" && serverConfig !== null ? (
            <OnboardingCodexSetup
              key={instanceId ?? driver}
              environmentId={environmentId}
              provider={provider}
              serverConfig={serverConfig}
              createdAccount={instanceId === createdAccount?.instanceId ? createdAccount : null}
              onAutoStartConsumed={() =>
                setCreatedAccount((account) => (account ? { ...account, autoStart: false } : null))
              }
              terminalOpen={terminalSession?.driver === driver}
              onOpenTerminal={() => {
                if (
                  provider === undefined ||
                  !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
                )
                  return;
                setTerminalSession({
                  environmentId,
                  driver,
                  providerInstanceId: provider.instanceId,
                  cwd: serverConfig.cwd,
                  command: provider.installed
                    ? resolveOnboardingProviderLoginCommand(
                        provider,
                        serverConfig.settings,
                        serverConfig.environment.platform.os,
                      )
                    : resolveOnboardingProviderInstallCommand(
                        driver,
                        serverConfig.environment.platform.os,
                      ),
                  keybindings: serverConfig.keybindings,
                });
              }}
            />
          ) : (
            <AgentCard
              key={driver}
              driver={driver}
              provider={provider}
              terminalOpen={terminalSession?.driver === driver}
              terminalAvailable={serverConfig !== null && canOperateTerminal}
              onOpenTerminal={() => {
                if (
                  provider === undefined ||
                  serverConfig === null ||
                  !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
                )
                  return;
                setTerminalSession({
                  environmentId,
                  driver,
                  providerInstanceId: provider.instanceId,
                  cwd: serverConfig.cwd,
                  command: provider.installed
                    ? resolveOnboardingProviderLoginCommand(
                        provider,
                        serverConfig.settings,
                        serverConfig.environment.platform.os,
                      )
                    : resolveOnboardingProviderInstallCommand(
                        driver,
                        serverConfig.environment.platform.os,
                      ),
                  keybindings: serverConfig.keybindings,
                });
              }}
            />
          ),
        )}
      </div>
      {otherAgents.length > 0 ? (
        <div className="mt-1.5 space-y-1.5">
          {otherAgents.map((provider) => (
            <OtherAgentCard key={provider.instanceId} provider={provider} />
          ))}
        </div>
      ) : null}
      {providers?.some(
        (provider) =>
          provider.driver === "codex" && getOnboardingProviderState(provider) === "ready",
      ) ? (
        <div className="mt-3">
          <Button size="xs" variant="ghost-muted" onClick={() => setAddingAccount(true)}>
            Connect another ChatGPT account
          </Button>
        </div>
      ) : null}
      {addingAccount ? (
        <AddManagedCodexAccountDialog
          environmentId={environmentId}
          onClose={() => setAddingAccount(false)}
          onAccountCreated={(instanceId, displayName) =>
            setCreatedAccount({ instanceId, displayName, autoStart: true })
          }
        />
      ) : null}
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onClose={() => {
            setTerminalSession(null);
            void refreshProviders({ environmentId, input: {} });
          }}
        />
      ) : null}
    </section>
  );
}

function OnboardingCodexSetup({
  createdAccount,
  onAutoStartConsumed,
  environmentId,
  provider,
  serverConfig,
  terminalOpen,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | undefined;
  readonly serverConfig: ServerConfig;
  readonly terminalOpen: boolean;
  readonly onOpenTerminal: () => void;
  readonly createdAccount: {
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null;
  readonly onAutoStartConsumed: () => void;
}) {
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, "Codex setup settings");
  const instanceId =
    createdAccount?.instanceId ??
    provider?.instanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
  const settings = serverConfig.settings;
  const instance = settings.providerInstances[instanceId] ?? {
    driver: ProviderDriverKind.make("codex"),
    config: createdAccount ? { enabled: true, setupMode: "managed" } : {},
  };
  const mode = readCodexSetupMode(instance.config);
  const existingChosen =
    mode === "existing" &&
    instance.config !== null &&
    typeof instance.config === "object" &&
    "setupMode" in instance.config &&
    instance.config.setupMode === "existing";
  const changeMode = (setupMode: "managed" | "existing") => {
    void update({
      environmentId,
      input: {
        patch: buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          instance: {
            ...instance,
            enabled: true,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              enabled: true,
              setupMode,
            },
          },
        }),
      },
    });
  };
  return existingChosen ? (
    <AgentCard
      driver="codex"
      provider={provider}
      terminalOpen={terminalOpen}
      terminalAvailable={canOperateTerminal}
      onOpenTerminal={onOpenTerminal}
    />
  ) : (
    <CodexSetupSection
      presentation="onboarding"
      autoStart={createdAccount?.autoStart === true}
      displayName={createdAccount?.displayName}
      onAutoStartConsumed={onAutoStartConsumed}
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={mode}
      enabled={provider?.enabled ?? true}
      onModeChange={changeMode}
    />
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = providerClients.get(ProviderDriverKind.make(driver));
  const displayName =
    provider?.displayName || (driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver));
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex min-h-14 items-center gap-3 rounded-lg border border-border bg-background px-4 py-2">
      <ProviderInstanceIcon
        tone="brand"
        driverKind={ProviderDriverKind.make(driver)}
        displayName={displayName}
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        {/* Ready needs no line: the badge says it. */}
        {providerState === "ready" ? null : (
          <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {summary.headline}
            {summary.detail ? ` · ${summary.detail}` : ""}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-muted-foreground">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** An agent with no sign-in flow here: its status, and where to fix it. */
function OtherAgentCard({ provider }: { readonly provider: ServerProvider }) {
  const meta = providerClients.get(provider.driver);
  const displayName = provider.displayName || (meta?.label ?? provider.driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-lg border border-border bg-background px-4 py-2">
      <ProviderInstanceIcon
        tone="brand"
        driverKind={provider.driver}
        displayName={displayName}
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        {providerState === "ready" ? null : (
          <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {providerState === "checking"
              ? "Checking..."
              : `${summary.headline}${summary.detail ? ` · ${summary.detail}` : ""} Fix it in Settings → Providers.`}
          </p>
        )}
      </div>
      {providerState === "ready" ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success-foreground">
          <CheckIcon className="size-3.5" />
          Ready
        </span>
      ) : null}
    </div>
  );
}

function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId } = session;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${driver}-${randomUUID()}`);
  const threadRef = scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID);
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // In Strict Mode, a canceled open can finish after the replacement setup
  // starts; it must not close or pre-type into the replacement session that
  // shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    // oxlint-disable-next-line react/set-state-in-effect -- A retry or a new command reopens the terminal, which shows as preparing until the open settles.
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // Close the PTY only while this connection still has terminal access;
    // revocation leaves it running.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry bumps setupAttempt to open the terminal again.
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal ? (
            "This connection cannot control terminals."
          ) : setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <Text variant="title" tone="strong" render={<h1 />}>
        {title}
      </Text>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}
