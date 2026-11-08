import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type GameCharacterRoute,
  type GameEngineId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@kurambit/contracts";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const ALL_MCP_CAPABILITIES = ["preview", "orchestration", "worktree"] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

/**
 * A read-only client never reaches a write (`McpToolAccess` refuses it first),
 * so it maps to the lowest mode rather than to nothing.
 */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/**
 * A thread caller's omitted target falls back to its own thread; a client
 * caller has no own thread, so tools that act as the caller (delegate_task,
 * preview, worktree handoff) need `thread`.
 */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  /** Threads the production run launched. They get play-level tools only. */
  readonly gameRunRole?: "run" | null;
  /** The engine of the calling thread's game; null when the thread works in no game. */
  readonly gameEngine?: GameEngineId | null;
  /** How the calling thread's game makes its characters (game.json `characters`); null outside a game. */
  readonly gameCharacters?: GameCharacterRoute | null;
  /** Why this machine has no Blender the game's tools can run, or null when it has one (or the engine uses none). */
  readonly blenderMissing?: string | null;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("kurambit/mcp/McpInvocationContext") {}

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

function missingCapability(
  invocation: McpInvocationScope,
  capability: "preview",
): PreviewAutomationUnavailableError;
function missingCapability(
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError;
function missingCapability(
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
}

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = (
  capability: "preview",
): Effect.Effect<
  McpThreadInvocationScope,
  PreviewAutomationUnavailableError,
  McpInvocationContext
> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability),
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling Kurambit thread, so it needs an agent running inside Kurambit. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);

/**
 * The invocation a tool listing or call runs in, read synchronously, as
 * `McpSchema.EnabledWhen` predicates must; undefined outside one.
 */
export const currentInvocation = (): McpInvocationScope | undefined => {
  const fiber = Fiber.getCurrent();
  return fiber === undefined
    ? undefined
    : Context.getOrUndefined(fiber.context, McpInvocationContext);
};

/** True inside a tool call from a thread the production run launched. */
const isGameRunThread = () => currentInvocation()?.gameRunRole === "run";

/**
 * A tool that says nothing about production-run threads hides from them. A
 * blind sample or comparator that could list threads, worktrees or projects
 * could read which build is which; the game tools choose for themselves.
 */
export const runThreadDefault = <I>(annotations: Context.Context<I>) =>
  Context.getOrUndefined(annotations, McpSchema.EnabledWhen) === undefined
    ? Context.add(annotations, McpSchema.EnabledWhen, () => !isGameRunThread())
    : annotations;
