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

/** An instance that can answer now: on, installed, reachable and not signed out. */
const canAnswer = (instance: ProviderInstance) =>
  instance.enabled
    ? instance.snapshot.getSnapshot.pipe(
        Effect.map(
          (snapshot) =>
            snapshot.enabled &&
            snapshot.installed &&
            snapshot.auth.status !== "unauthenticated" &&
            isProviderAvailable(snapshot) &&
            isProviderTextGenerationCapable(snapshot),
        ),
      )
    : Effect.succeed(false);

/**
 * The instance a request goes to: the one it names while that one can answer, else the first
 * that can, on its own default model. The setting defaults to one provider whether or not the
 * person ever signed into it, and a signed-out provider fails every title and game name.
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
    if (named !== undefined && (yield* canAnswer(named)))
      return { textGeneration: named.textGeneration, input };
    for (const instance of yield* registry.listInstances) {
      if (instance === named || !(yield* canAnswer(instance))) continue;
      const model =
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind] ??
        DEFAULT_MODEL_BY_PROVIDER[instance.driverKind] ??
        DEFAULT_TEXT_GENERATION_MODEL;
      return {
        textGeneration: instance.textGeneration,
        input: { ...input, modelSelection: { instanceId: instance.instanceId, model } },
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
