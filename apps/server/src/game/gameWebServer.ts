// @effect-diagnostics nodeBuiltinImport:off -- This module owns the loopback HTTP boundary for three.js sources.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpStaticServer from "effect/http/HttpStaticServer";
import * as Mime from "effect/http/Mime";
import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";
import { runtimeRequestFile } from "./gameRuntime.ts";
import { insideGame } from "./gamePath.ts";

export interface WebStaticServer {
  /** Loopback origin serving the directory, e.g. http://127.0.0.1:PORT/. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * The real file a request names inside `webRoot` (itself a realpath), or a status when there is
 * none. HttpStaticServer only checks the path lexically and follows links, so a link out of the
 * folder is refused here, before it is asked.
 */
const gameRequestFile = async (webRoot: string, url: string): Promise<string | 403 | 404> => {
  const raw = decodeURIComponent(url.split("?")[0] ?? "/");
  if (raw.includes("\0") || raw.includes("\\") || raw.split("/").includes("..")) return 403;
  const real = await NodeFSP.realpath(
    NodePath.resolve(webRoot, `.${raw === "/" ? "/index.html" : raw}`),
  ).catch(() => null);
  if (real === null) return 404;
  return real.startsWith(webRoot + NodePath.sep) ? real : 403;
};

/** Text types carry their charset so a page without a meta tag still decodes as UTF-8. */
const contentType = (path: string): string =>
  Option.match(Mime.getType(path), {
    onNone: () => "application/octet-stream",
    onSome: (type) => (type.startsWith("text/") ? `${type}; charset=utf-8` : type),
  });

/**
 * Answers the request with exactly `file`, already resolved and checked. HttpStaticServer
 * brings the content type, ranges, ETag and 304s; its own table lacks game formats (glb,
 * ktx2...), so the type comes from Mime.
 */
const serveFile = (file: string, cacheControl: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const extension = NodePath.extname(file).slice(1).toLowerCase();
    const serve = yield* HttpStaticServer.make({
      root: NodePath.dirname(file),
      index: undefined,
      cacheControl,
      mimeTypes: extension === "" ? {} : { [extension]: contentType(file) },
    });
    return yield* serve.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ url: `/${encodeURIComponent(NodePath.basename(file))}` }),
      ),
    );
  });

/**
 * Serves a game-relative directory over loopback, for Play and for
 * check/explore/bot runs. It is its own origin on purpose: the game is
 * agent-written JS and must never run on the app origin beside the session
 * cookie. With `runtimes`, `/_kurambit/runtime/...` is answered from
 * Kurambit's runtime (gameRuntime.ts) for a game that loads it; an export
 * holds its own copy and is served without.
 */
export const serveGameDirectory = async (
  root: string,
  directory: string,
  options: {
    /** Each file a GET is answered with, by its path inside the directory ("assets/hero.glb"). */
    readonly onServed?: (path: string) => void;
    /** The server's runtimes folder (gameRuntime's runtimesDirectory), for a folder that loads one. */
    readonly runtimes?: string | null;
  } = {},
): Promise<WebStaticServer> => {
  // The served folder itself must stay in the game: a link at it (or a selection naming
  // another folder) would serve whatever it points at to the game's page.
  const webRoot = await NodeFSP.realpath(insideGame(root, directory, { root: "allowed" }));
  await NodeFSP.access(NodePath.join(webRoot, "index.html"));
  const runtimes = options.runtimes ?? null;

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET" && request.method !== "HEAD")
      return HttpServerResponse.empty({ status: 405 });
    // The runtime's URL names only the major, so a minor update must reach the next load: the
    // browser keeps it and asks again each time (no-cache), and an unchanged file answers 304,
    // which keeps the compiled module in the browser's code cache across a live reload. Runtime
    // files are Kurambit's, not the game's, so asset use never counts them.
    const runtimeFile =
      runtimes === null
        ? null
        : yield* Effect.promise(() =>
            runtimeRequestFile(runtimes, decodeURIComponent(request.url.split("?")[0] ?? "/")),
          );
    if (runtimeFile !== null) return yield* serveFile(runtimeFile, "no-cache");
    const file = yield* Effect.promise(() => gameRequestFile(webRoot, request.url));
    if (typeof file === "number") return HttpServerResponse.empty({ status: file });
    const response = yield* serveFile(file, "no-store");
    if (request.method === "GET" && (response.status === 200 || response.status === 206))
      options.onServed?.(NodePath.relative(webRoot, file).split(NodePath.sep).join("/"));
    return response;
  }).pipe(
    Effect.catch((error) =>
      HttpServerRespondable.toResponseOrElse(error, HttpServerResponse.empty({ status: 500 })),
    ),
    // A malformed URL escape throws while decoding; it names no file.
    Effect.catchDefect(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
  );

  const nodeServer = guardHttpResponseWriteErrors(NodeHttp.createServer());
  const scope = Effect.runSync(Scope.make());
  const close = async () => {
    // The browser holds keep-alive connections open; a closed preview must not wait on them.
    nodeServer.closeAllConnections();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* NodeHttpServer.make(() => nodeServer, {
          host: "127.0.0.1",
          port: 0,
          disablePreemptiveShutdown: true,
        });
        yield* server.serve(app);
      }).pipe(Scope.provide(scope), Effect.provide(NodeHttpServer.layerHttpServices)),
    );
  } catch (cause) {
    await close();
    throw cause;
  }
  const address = nodeServer.address();
  if (address === null || typeof address === "string" || !NodeNet.isIPv4(address.address)) {
    await close();
    throw new Error("Preview did not bind TCP");
  }
  return { url: `http://127.0.0.1:${address.port}/`, close };
};
