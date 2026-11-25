// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Reads a game's Web export from disk and keeps what it published beside the game.
// Publishing a game to <slug>.kurambit.com. The person connects once, the device way (as
// `gh auth login` does): Connect asks kurambit.com for a sign-in and opens its Connect page with a
// short code; they sign in with GitHub there and approve the code, while this server polls for the
// publish key and keeps it in the secret store. Publish uploads the
// Web export Play serves (never a fresh export) straight to the play worker under a grant from
// kurambit.com's publish functions, then makes it live. What a game was published as is kept in
// its `.studio/published.json`, so Update reuses its address and Unpublish takes it down.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Mime from "effect/http/Mime";
import { HttpClient, HttpClientRequest } from "effect/http";
import { GameOperationError, type GamePublishStatus, type ThreadId } from "@kurambit/contracts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GameExport from "./GameExport.ts";
import * as GameProjectService from "./GameProjectService.ts";
import { hashWebBuild } from "./webBuild.ts";
import { PUBLISHED_FILE, readPublished } from "./publishedRecord.ts";

/** kurambit.com, where the Connect page and the publish functions live. */
const SITE = process.env["KURAMBIT_PUBLISH_SITE"] ?? "https://kurambit.com";
const KEY_SECRET = "game-publish-key";
const UPLOADS_AT_ONCE = 4;

const Connection = Schema.Struct({ key: Schema.String, login: Schema.NullOr(Schema.String) });
const decodeConnection = Schema.decodeUnknownOption(Schema.fromJsonString(Connection));
const DeviceStart = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verifyUrl: Schema.String,
  interval: Schema.Number,
  expiresIn: Schema.Number,
});
const decodeDeviceStart = Schema.decodeUnknownOption(DeviceStart);
const DevicePoll = Schema.Struct({
  status: Schema.Literals(["pending", "expired", "done"]),
  key: Schema.optional(Schema.String),
  login: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeDevicePoll = Schema.decodeUnknownOption(DevicePoll);

const failed = (operation: string, path: string, detail: string, cause?: unknown) =>
  new GameOperationError({
    operation,
    path,
    reason: "io",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const contentType = (path: string) =>
  Option.match(Mime.getType(path), {
    onNone: () => "application/octet-stream",
    onSome: (type) => (type.startsWith("text/") ? `${type}; charset=utf-8` : type),
  });

export class GamePublish extends Context.Service<
  GamePublish,
  {
    /** Whether this Kurambit is connected (as whom), and where the thread's game is published. */
    readonly status: (threadId: ThreadId) => Effect.Effect<GamePublishStatus, GameOperationError>;
    /**
     * Starts a sign-in (or returns the one still waiting): the Connect page to open and the code it
     * shows. This server polls kurambit.com until the person approves it there or it expires.
     */
    readonly connect: Effect.Effect<SigningIn, GameOperationError>;
    /** Forgets the key: this Kurambit publishes nothing until it connects again. */
    readonly disconnect: Effect.Effect<void, GameOperationError>;
    /** Publishes the Web export Play serves, as a new version of the game's address. */
    readonly publish: (threadId: ThreadId) => Effect.Effect<GamePublishStatus, GameOperationError>;
    /** Takes the game down from its address. */
    readonly unpublish: (
      threadId: ThreadId,
    ) => Effect.Effect<GamePublishStatus, GameOperationError>;
  }
>()("kurambit/game/GamePublish") {}

type SigningIn = { readonly url: string; readonly userCode: string };

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const projects = yield* GameProjectService.GameProjectService;
  const exporter = yield* GameExport.GameExport;
  /** The sign-in waiting for the person, with when it expires; one at a time. */
  const signingIn = yield* Ref.make<(SigningIn & { readonly expiresAt: number }) | null>(null);

  const connection = secrets.get(KEY_SECRET).pipe(
    Effect.map((value) =>
      Option.flatMap(value, (bytes) => decodeConnection(new TextDecoder().decode(bytes))),
    ),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );

  const publishedOf = readPublished;

  const statusOf = (root: string) =>
    Effect.gen(function* () {
      const connected = yield* connection;
      const waiting = yield* Ref.get(signingIn);
      const now = yield* Clock.currentTimeMillis;
      return {
        connected: connected !== null,
        login: connected?.login ?? null,
        signingIn:
          connected === null && waiting !== null && waiting.expiresAt > now
            ? { url: waiting.url, userCode: waiting.userCode }
            : null,
        published: yield* publishedOf(root),
      } satisfies GamePublishStatus;
    });

  /** One call to kurambit.com's publish function with the kept key. */
  const call = (operation: string, root: string, body: Record<string, unknown>) =>
    Effect.gen(function* () {
      const connected = yield* connection;
      if (connected === null)
        return yield* new GameOperationError({
          operation,
          path: root,
          reason: "invalid-input",
          detail: "Connect to kurambit.com first: Publish asks you to sign in with GitHub once.",
        });
      const reached = (cause: unknown) =>
        failed(operation, root, "kurambit.com could not be reached.", cause);
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${SITE}/api/publish`).pipe(
            HttpClientRequest.bearerToken(connected.key),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(Effect.mapError(reached));
      const answer = yield* response.json.pipe(
        Effect.map((value): Record<string, unknown> =>
          typeof value === "object" && value !== null ? { ...value } : {},
        ),
        Effect.orElseSucceed((): Record<string, unknown> => ({})),
      );
      if (response.status === 401) {
        // A key another connection replaced, or one revoked: connecting again makes a new one.
        yield* secrets.remove(KEY_SECRET).pipe(Effect.ignore);
        return yield* new GameOperationError({
          operation,
          path: root,
          reason: "invalid-input",
          detail: "This Kurambit is no longer connected to kurambit.com: connect again.",
        });
      }
      if (response.status < 200 || response.status >= 300)
        return yield* new GameOperationError({
          operation,
          path: root,
          reason: response.status >= 500 ? "io" : "invalid-input",
          detail:
            typeof answer["message"] === "string"
              ? answer["message"]
              : `kurambit.com refused it (${String(answer["error"] ?? response.status)}).`,
        });
      return answer;
    });

  const publish: GamePublish["Service"]["publish"] = (threadId) =>
    projects.exclusive(threadId, "Publish", (root) =>
      Effect.gen(function* () {
        const selected = yield* exporter.selected(root);
        if (selected === null)
          return yield* new GameOperationError({
            operation: "Publish",
            path: root,
            reason: "invalid-input",
            detail: "There is no Web export to publish yet: export Web first.",
          });
        const hashed = yield* Effect.promise(() => hashWebBuild(root, selected.directory));
        if (hashed === null || hashed.buildId !== selected.buildId)
          return yield* new GameOperationError({
            operation: "Publish",
            path: NodePath.join(root, selected.directory),
            reason: "invalid-input",
            detail: "The selected Web export changed or is missing: export Web again.",
          });
        // The address serves index.html; a game whose entry is elsewhere gets one that opens it.
        const opener =
          selected.entry === "index.html" || hashed.files.some((file) => file.path === "index.html")
            ? null
            : `<!doctype html><meta http-equiv="refresh" content="0; url=${selected.entry}">`;
        const bytes =
          hashed.files.reduce((sum, file) => sum + file.size, 0) + (opener?.length ?? 0);
        const manifest = yield* projects.read(root);
        const before = yield* publishedOf(root);
        const begun = yield* call("Publish", root, {
          step: "begin",
          name: manifest.name,
          bytes,
          ...(before === null ? {} : { slug: before.slug }),
        });
        const slug = String(begun["slug"]);
        const version = String(begun["version"]);
        const upload = String(begun["upload"]);
        const grant = String(begun["grant"]);
        const put = (path: string, body: Uint8Array) =>
          http
            .execute(
              HttpClientRequest.put(`${upload}${path}`).pipe(
                HttpClientRequest.bearerToken(grant),
                HttpClientRequest.bodyUint8Array(body, contentType(path)),
              ),
            )
            .pipe(
              Effect.filterOrFail(
                (response) => response.status >= 200 && response.status < 300,
                (response) => `${path}: ${response.status}`,
              ),
              Effect.mapError((cause) =>
                failed(
                  "Publish",
                  root,
                  `A file of the game could not be uploaded (${String(cause)}).`,
                ),
              ),
            );
        yield* Effect.forEach(
          hashed.files,
          (file) =>
            Effect.flatMap(
              Effect.tryPromise({
                try: () => NodeFSP.readFile(NodePath.join(root, selected.directory, file.path)),
                catch: (cause) => failed("Publish", root, `${file.path} could not be read.`, cause),
              }),
              (data) => put(file.path, data),
            ),
          { concurrency: UPLOADS_AT_ONCE, discard: true },
        );
        if (opener !== null) yield* put("index.html", new TextEncoder().encode(opener));
        const committed = yield* call("Publish", root, { step: "commit", slug, version });
        const published = { slug, url: String(committed["url"]) };
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.join(root, ".studio"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, PUBLISHED_FILE),
              `${JSON.stringify(published)}\n`,
            );
          },
          catch: (cause) =>
            failed("Publish", root, "The published address could not be kept.", cause),
        });
        return yield* statusOf(root);
      }),
    );

  const unpublish: GamePublish["Service"]["unpublish"] = (threadId) =>
    projects.exclusive(threadId, "Unpublish", (root) =>
      Effect.gen(function* () {
        const published = yield* publishedOf(root);
        if (published !== null) {
          yield* call("Unpublish", root, { step: "delete", slug: published.slug });
          yield* Effect.promise(() =>
            NodeFSP.rm(NodePath.join(root, PUBLISHED_FILE), { force: true }),
          );
        }
        return yield* statusOf(root);
      }),
    );

  /** One call to kurambit.com's device sign-in; null when it refused. */
  const device = (body: Record<string, unknown>) =>
    http
      .execute(
        HttpClientRequest.post(`${SITE}/api/publish-device`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300 ? response.json : Effect.succeed(null),
        ),
      );

  /** Polls until the person approves the code, or it expires; keeps the key it gets. */
  const awaitApproval = (deviceCode: string, interval: number, expiresAt: number) =>
    Effect.gen(function* () {
      while ((yield* Clock.currentTimeMillis) < expiresAt) {
        yield* Effect.sleep(Duration.seconds(interval));
        // A failed poll (offline for a moment) is tried again at the next interval.
        const answer = yield* device({ step: "poll", deviceCode }).pipe(
          Effect.map((value) => Option.getOrNull(decodeDevicePoll(value))),
          Effect.orElseSucceed(() => null),
        );
        if (answer?.status === "expired") return;
        if (answer?.status === "done" && answer.key?.startsWith("kpk_")) {
          yield* secrets.set(
            KEY_SECRET,
            new TextEncoder().encode(
              JSON.stringify({ key: answer.key, login: answer.login ?? null }),
            ),
          );
          return;
        }
      }
    }).pipe(Effect.ensuring(Ref.set(signingIn, null)), Effect.ignore);

  const connect = Effect.gen(function* () {
    const waiting = yield* Ref.get(signingIn);
    const now = yield* Clock.currentTimeMillis;
    if (waiting !== null && waiting.expiresAt > now)
      return { url: waiting.url, userCode: waiting.userCode };
    const started = yield* device({ step: "start" }).pipe(
      Effect.map((value) => Option.getOrNull(decodeDeviceStart(value))),
      Effect.mapError((cause) =>
        failed("Connect", "kurambit.com", "kurambit.com could not be reached.", cause),
      ),
    );
    if (started === null)
      return yield* failed(
        "Connect",
        "kurambit.com",
        "kurambit.com refused the sign-in. Try again.",
      );
    const expiresAt = now + started.expiresIn * 1000;
    const pending = { url: started.verifyUrl, userCode: started.userCode, expiresAt };
    yield* Ref.set(signingIn, pending);
    yield* Effect.forkIn(awaitApproval(started.deviceCode, started.interval, expiresAt), scope);
    return { url: pending.url, userCode: pending.userCode };
  });

  return GamePublish.of({
    status: (threadId) => Effect.flatMap(projects.resolve(threadId), statusOf),
    connect,
    disconnect: secrets
      .remove(KEY_SECRET)
      .pipe(
        Effect.mapError((cause) =>
          failed("Disconnect", "kurambit.com", "The publish key could not be removed.", cause),
        ),
      ),
    publish,
    unpublish,
  });
});

export const layer = Layer.effect(GamePublish, make);
