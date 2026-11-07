import { useAtomValue } from "@effect/atom-react";
import { KurambitMark, KurambitWordmark } from "../brand/KurambitBrand";
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
import { resolveOnboardingSetup } from "../../onboarding/targetEnvironment.logic";
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
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";

type WizardStep = "connection" | "agents";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Agents"] as const;

export function WelcomeWizard({
  onDone,
  resumeEnvironmentId,
}: {
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: () => void | Promise<void>;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>(resumeEnvironmentId ? "agents" : "connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  // One registry for the wizard's lifetime, shared with the connect list, so a computer is
  // auto-selected once even after the user unchecks it.
  const [autoSelectedComputers] = useState(() => new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>(
    resumeEnvironmentId ? [resumeEnvironmentId] : [],
  );
  const [isFinishing, setIsFinishing] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.add(environment.environmentId);
    }
    const enabledComputers = newComputers.filter((environment) => environment.entry.enabled);
    if (enabledComputers.length === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The registry marks each computer once, and only after commit; render must not mutate it.
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...enabledComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [autoSelectedComputers, environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex = step === "agents" ? 1 : 0;
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
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title="Set up Kurambit"
          identity={
            <div className="flex items-center gap-2.5" role="img" aria-label="Kurambit">
              <KurambitMark className="size-9" />
              <KurambitWordmark className="text-sm" />
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) => isFinishing || index >= stageIndex}
            onStepChange={(index) => {
              if (isFinishing || index > stageIndex) return;
              setStep(index === 0 ? "connection" : "agents");
            }}
          />
        </WizardHeader>

        <WizardPanel>
          {step === "connection" ? (
            <ConnectionStep
              expandPairingInitially={false}
              selectedIds={selectedIds}
              autoSelectedComputers={autoSelectedComputers}
              onSelectionChange={setSelection}
              onToggleEnvironment={(environmentId, checked) =>
                setSelection((current) => {
                  const next = new Set(current ?? selectedIds);
                  if (checked) next.add(environmentId);
                  else next.delete(environmentId);
                  return next;
                })
              }
              onContinue={() =>
                startSetup(resolveOnboardingSetup(environments, selectedIds).environmentIds)
              }
              onPaired={(environmentId) => {
                setSelection(new Set([...selectedIds, environmentId]));
              }}
            />
          ) : (
            <AgentsStep
              environmentIds={setupIds}
              isFinishing={isFinishing}
              onContinue={() => void finish()}
            />
          )}
        </WizardPanel>
      </WizardPopup>
      <ChatGptWelcomeCoordinator />
    </Dialog>
  );
}

function ConnectionStep({
  onContinue,
}: {
  onContinue: () => void;
  autoSelectedComputers: Set<EnvironmentId>;
  expandPairingInitially: boolean;
  selectedIds: ReadonlySet<EnvironmentId>;
  onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  onPaired: (environmentId: EnvironmentId) => void;
}) {
  const primary = usePrimaryEnvironment();
  return (
    <StepShell
      title="Create games on this computer"
      description="Kurambit runs your agents and game tools locally."
    >
      <Button disabled={!primary || primary.connection.phase !== "connected"} onClick={onContinue}>
        Continue
      </Button>
    </StepShell>
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
  return (
    <StepShell
      title="Connect your agents"
      description="Choose the agent that builds your games. Using OpenCode, Cursor, Grok or another agent? Add it in Settings → Providers."
    >
      {/* The list gets what the dialog's header, title and button leave, so the
          button stays on screen on short windows. */}
      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,calc(100dvh-24rem))]">
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button autoFocus disabled={isFinishing} onClick={onContinue}>
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
  readonly machineLabel: string;
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
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
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
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make(driver)}
        displayName={displayName}
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {providerState === "ready" ? "Ready." : summary.headline}
          {providerState !== "ready" && summary.detail ? ` · ${summary.detail}` : ""}
        </p>
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
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}
