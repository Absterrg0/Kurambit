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
 * Whether an instance can answer now: on, installed, reachable and of a version Kurambit can use,
 * and then whether the person is signed in to it (`signed-in`) or it has not said (`maybe`: an
 * installed CLI signed in to nothing often reports no status at all).
 */
const readiness = (instance: ProviderInstance) =>
  instance.enabled
    ? instance.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) =>
          !snapshot.enabled ||
          !snapshot.installed ||
          snapshot.status === "error" ||
          snapshot.auth.status === "unauthenticated" ||
          snapshot.compatibilityAdvisory?.status === "unsupported" ||
          snapshot.compatibilityAdvisory?.status === "broken" ||
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
 * Where a request may go, in order: the instance it names while the person is signed in to it,
 * then each other one they are signed in to, then the named one and the others that only might
 * be, each other on its own default model. The setting defaults to one provider whether or not
 * the person ever signed into it, and an instance that says it is ready can still fail every call
 * (an installed OpenCode too old for its server failed 15 of 15 titles), so each is tried in turn.
 */
const candidates = <I extends { readonly modelSelection: ModelSelection }>(
  registry: Registry,
  input: I,
) =>
  Effect.gen(function* () {
    const named = yield* registry.getInstance(input.modelSelection.instanceId);
    const namedReady = named === undefined ? ("no" as const) : yield* readiness(named);
    const onDefault = (instance: ProviderInstance) => ({
      textGeneration: instance.textGeneration,
      input: {
        ...input,
        modelSelection: {
          instanceId: instance.instanceId,
          model:
            DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind] ??
            DEFAULT_MODEL_BY_PROVIDER[instance.driverKind] ??
            DEFAULT_TEXT_GENERATION_MODEL,
        },
      },
    });
    const signedIn: Array<{ textGeneration: ProviderInstance["textGeneration"]; input: I }> = [];
    const maybe: typeof signedIn = [];
    if (named !== undefined && namedReady === "signed-in")
      signedIn.push({ textGeneration: named.textGeneration, input });
    if (named !== undefined && namedReady === "maybe")
      maybe.push({ textGeneration: named.textGeneration, input });
    for (const instance of yield* registry.listInstances) {
      if (instance === named) continue;
      const ready = yield* readiness(instance);
      if (ready === "signed-in") signedIn.push(onDefault(instance));
      else if (ready === "maybe") maybe.push(onDefault(instance));
    }
    const all = [...signedIn, ...maybe];
    // With nothing ready, the named one says why it cannot answer.
    return all.length === 0 && named !== undefined
      ? [{ textGeneration: named.textGeneration, input }]
      : all;
  });

/** `call` on each candidate in turn until one answers; the last failure when none does. */
const route = <I extends { readonly modelSelection: ModelSelection }, A>(
  registry: Registry,
  operation: TextGenerationOp,
  input: I,
  call: (
    textGeneration: ProviderInstance["textGeneration"],
    input: I,
  ) => Effect.Effect<A, TextGenerationError>,
): Effect.Effect<A, TextGenerationError> =>
  Effect.gen(function* () {
    const tries = yield* candidates(registry, input);
    let failure: TextGenerationError = new TextGenerationError({
      operation,
      detail: `No provider instance registered for id '${input.modelSelection.instanceId}'.`,
    });
    for (const each of tries) {
      const answered = yield* Effect.result(call(each.textGeneration, each.input));
      if (answered._tag === "Success") return answered.success;
      failure = answered.failure;
    }
    return yield* failure;
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      route(registry, "generateCommitMessage", input, (textGeneration, routed) =>
        textGeneration.generateCommitMessage(routed),
      ),
    generatePrContent: (input) =>
      route(registry, "generatePrContent", input, (textGeneration, routed) =>
        textGeneration.generatePrContent(routed),
      ),
    generateBranchName: (input) =>
      route(registry, "generateBranchName", input, (textGeneration, routed) =>
        textGeneration.generateBranchName(routed),
      ),
    generateGameName: (input) =>
      route(registry, "generateGameName", input, (textGeneration, routed) =>
        textGeneration.generateGameName(routed),
      ),
    generateReviewGuide: (input) =>
      route(registry, "generateReviewGuide", input, (textGeneration, routed) =>
        textGeneration.generateReviewGuide(routed),
      ),
    generateThreadTitle: (input) =>
      route(registry, "generateThreadTitle", input, (textGeneration, routed) =>
        textGeneration.generateThreadTitle(routed),
      ),
    generateImageReview: (input) =>
      route(registry, "generateImageReview", input, (textGeneration, routed) =>
        textGeneration.generateImageReview(routed),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
