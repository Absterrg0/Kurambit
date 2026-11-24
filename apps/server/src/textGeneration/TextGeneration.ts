import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ModelSelection,
  TextGenerationError,
} from "@kurambit/contracts";
import type { ProviderTextGeneration } from "@kurambit/provider-core/server/textGeneration";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@kurambit/provider-core/server/driver";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  GameNameGenerationInput,
  GameNameGenerationResult,
} from "@kurambit/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "kurambit/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateGameName"
  | "generateReviewGuide"
  | "generateImageReview";

type Registry = ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];

/**
 * Whether an instance can answer now: on, installed and reachable, and then whether the person is
 * signed in to it (`signed-in`) or it has not said (`maybe`: an installed CLI signed in to nothing
 * often reports no status at all).
 */
const readiness = (instance: ProviderInstance) =>
  instance.enabled
    ? instance.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) =>
          !snapshot.enabled ||
          !snapshot.installed ||
          snapshot.auth.status === "unauthenticated" ||
          !isProviderAvailable(snapshot) ||
          !isProviderTextGenerationCapable(snapshot)
            ? ("no" as const)
            : snapshot.auth.status === "authenticated"
              ? ("signed-in" as const)
              : ("maybe" as const),
        ),
      )
    : Effect.succeed("no" as const);

/**
 * The instance a request goes to: the one it names while the person is signed in to it, else the
 * first they are signed in to, on its own default model. The setting defaults to one provider
 * whether or not the person ever signed into it, and a provider signed in to nothing fails every
 * title and game name (an installed OpenCode with no account answered "Model unavailable").
 */
const route = <I extends { readonly modelSelection: ModelSelection }>(
  registry: Registry,
  operation: TextGenerationOp,
  input: I,
): Effect.Effect<
  { readonly textGeneration: ProviderInstance["textGeneration"]; readonly input: I },
  TextGenerationError
> =>
  Effect.gen(function* () {
    const named = yield* registry.getInstance(input.modelSelection.instanceId);
    const namedReady = named === undefined ? ("no" as const) : yield* readiness(named);
    if (named !== undefined && namedReady === "signed-in")
      return { textGeneration: named.textGeneration, input };
    // One the person is signed in to first; one that only might be goes last, the named first.
    let signedIn: ProviderInstance | undefined;
    let maybe: ProviderInstance | undefined;
    for (const instance of yield* registry.listInstances) {
      if (instance === named) continue;
      const ready = yield* readiness(instance);
      if (ready === "signed-in") {
        signedIn = instance;
        break;
      }
      if (ready === "maybe") maybe ??= instance;
    }
    if (signedIn === undefined && named !== undefined && namedReady === "maybe")
      return { textGeneration: named.textGeneration, input };
    const fallback = signedIn ?? maybe;
    if (fallback !== undefined) {
      const model =
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback.driverKind] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback.driverKind] ??
        DEFAULT_TEXT_GENERATION_MODEL;
      return {
        textGeneration: fallback.textGeneration,
        input: { ...input, modelSelection: { instanceId: fallback.instanceId, model } },
      };
    }
    if (named !== undefined) return { textGeneration: named.textGeneration, input };
    return yield* new TextGenerationError({
      operation,
      detail: `No provider instance registered for id '${input.modelSelection.instanceId}'.`,
    });
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      route(registry, "generateCommitMessage", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateCommitMessage(routed.input)),
      ),
    generatePrContent: (input) =>
      route(registry, "generatePrContent", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generatePrContent(routed.input)),
      ),
    generateBranchName: (input) =>
      route(registry, "generateBranchName", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateBranchName(routed.input)),
      ),
    generateGameName: (input) =>
      route(registry, "generateGameName", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateGameName(routed.input)),
      ),
    generateReviewGuide: (input) =>
      route(registry, "generateReviewGuide", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateReviewGuide(routed.input)),
      ),
    generateThreadTitle: (input) =>
      route(registry, "generateThreadTitle", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateThreadTitle(routed.input)),
      ),
    generateImageReview: (input) =>
      route(registry, "generateImageReview", input).pipe(
        Effect.flatMap((routed) => routed.textGeneration.generateImageReview(routed.input)),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
