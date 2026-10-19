import {
  ModelCapabilities,
  TrimmedNonEmptyString,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import bundledManifestJson from "./model-manifest.json";
import { ProviderCompatibilityPolicy } from "./providerCompatibility.ts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";

const ManifestModelStatus = Schema.Literals(["current", "legacy"]);

const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: ManifestModelStatus,
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(TrimmedNonEmptyString),
  adapter: Schema.optional(Schema.Unknown),
});

const ManifestProviderCatalog = Schema.Struct({
  defaults: Schema.optional(
    Schema.Struct({
      chat: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  profiles: Schema.Record(Schema.String, ManifestModelProfile),
  models: Schema.Array(ManifestProviderModel),
});

const ModelManifestEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * A release bundles its manifest, and a disk cache of an older edit must not
   * outrank it. Optional so older remote files still decode; they count as
   * older than any dated bundle.
   */
  updatedAt: Schema.optional(Schema.String),
  compatibility: Schema.optional(Schema.Array(ProviderCompatibilityPolicy)),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Record(Schema.String, ManifestProviderCatalog)),
});

const hasValidProviderCatalogReferences = (
  manifest: typeof ModelManifestEnvelopeSchema.Type,
): boolean =>
  Object.values(manifest.providers ?? {}).every((catalog) => {
    const slugs = new Set<string>();
    const modelsAreValid = catalog.models.every((model) => {
      if (slugs.has(model.slug)) return false;
      slugs.add(model.slug);
      return model.profile === undefined || catalog.profiles[model.profile] !== undefined;
    });
    return (
      modelsAreValid && (catalog.defaults?.chat === undefined || slugs.has(catalog.defaults.chat))
    );
  });

const ModelManifestSchema = ModelManifestEnvelopeSchema.pipe(
  Schema.check(
    Schema.makeFilter(hasValidProviderCatalogReferences, {
      expected: "unique model slugs and existing model and profile references",
    }),
    Schema.makeFilter(hasValidClaudeManifestAdapters, {
      expected: "valid Claude adapter metadata",
    }),
  ),
);
export type ModelManifestData = typeof ModelManifestSchema.Type;

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

export function resolveProviderCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ModelCatalog.ProviderCatalog | null {
  const catalog = manifest.providers?.[driverKind];
  if (!catalog) return null;

  const seen = new Set<string>();
  const models: Array<ModelCatalog.ProviderCatalogModel> = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);

    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    if (entry.profile && !profile) return null;

    models.push({
      slug: entry.slug,
      name: entry.name,
      ...(entry.shortName ? { shortName: entry.shortName } : {}),
      ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(entry.badge ? { badge: entry.badge } : {}),
      status: entry.status,
      capabilities: profile?.capabilities ?? null,
      adapter: entry.adapter,
      profileAdapter: profile?.adapter,
    });
  }

  if (catalog.defaults?.chat !== undefined && !seen.has(catalog.defaults.chat)) return null;

  return { models, defaultChatModel: catalog.defaults?.chat };
}

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /**  Snapshot classification reads this, so it never waits on the network. */
    readonly current: Effect.Effect<ModelManifestData>;
    readonly refresh: Effect.Effect<ModelManifestData>;
    readonly forceRefresh: Effect.Effect<ModelManifestData>;
    /** Drivers call this from
     * provider checks: the fetch is process-shared state, so it must survive
     * the teardown of whichever instance happened to trigger it. */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("t3/provider/ModelManifest") {}

const BundledOnlyModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  forceRefresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
};

const layerBundledOnly = Layer.succeed(ModelManifest, BundledOnlyModelManifest);

// Provider catalogs are shipped with the fork; startup never refreshes upstream.
export const make = Effect.succeed(BundledOnlyModelManifest);

export const layer = Layer.effect(ModelManifest, make);

export const layerTest = Layer.suspend(() =>
  layerModelCatalog.pipe(Layer.provideMerge(layerBundledOnly)),
);

export const layerModelCatalog = Layer.effect(
  ModelCatalog.ModelCatalog,
  Effect.gen(function* () {
    const manifest = yield* ModelManifest;
    return ModelCatalog.ModelCatalog.of({
      current: (driverKind) =>
        manifest.current.pipe(
          Effect.map((data) => resolveProviderCatalog(data, driverKind) ?? undefined),
        ),
      bundled: (driverKind) =>
        resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, driverKind) ?? undefined,
      refreshInBackground: manifest.refreshInBackground,
    });
  }),
);
