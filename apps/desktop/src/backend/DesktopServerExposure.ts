import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as NetService from "@kurambit/shared/Net";

import * as DesktopObservability from "../app/DesktopObservability.ts";

const { logInfo } = DesktopObservability.makeComponentLogger("desktop-server-exposure");

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  {
    startPort: Schema.Int,
    maxPort: Schema.Int,
    hosts: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No desktop backend port is available on hosts ${this.hosts.join(", ")} between ${this.startPort} and ${this.maxPort}.`;
  }
}

export const findFreeBackendPort = Effect.fn("desktop.serverExposure.findFreeBackendPort")(
  function* (startPort: number) {
    const net = yield* NetService.NetService;
    for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
      let availableOnEveryHost = true;
      for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
        if (!(yield* net.canListenOnHost(port, host))) {
          availableOnEveryHost = false;
          break;
        }
      }
      if (availableOnEveryHost) return port;
    }
    return yield* new DesktopBackendPortUnavailableError({
      startPort,
      maxPort: MAX_TCP_PORT,
      hosts: DESKTOP_BACKEND_PORT_PROBE_HOSTS,
    });
  },
);

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
}

/** The backend listens on loopback only; the desktop app never exposes it to the network. */
export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
      readonly scanned: boolean;
    }) => Effect.Effect<void>;
    // Two apps starting together can both scan the same free port; the loser
    // must move on before it restarts rather than retry the taken one forever.
    readonly moveScannedPortIfTaken: Effect.Effect<void>;
  }
>()("@kurambit/desktop/backend/DesktopServerExposure") {}

export const layer = Layer.effect(
  DesktopServerExposure,
  Effect.gen(function* () {
    const net = yield* NetService.NetService;
    const portRef = yield* Ref.make({ port: 0, scanned: false });
    return DesktopServerExposure.of({
      configureFromSettings: (input) => Ref.set(portRef, input),
      moveScannedPortIfTaken: Effect.gen(function* () {
        const { port, scanned } = yield* Ref.get(portRef);
        if (!scanned) return;
        const free = yield* findFreeBackendPort(port).pipe(Effect.orElseSucceed(() => port));
        if (free === port) return;
        yield* logInfo("backend port was taken; moved to the next free one", { port, free });
        yield* Ref.set(portRef, { port: free, scanned });
      }).pipe(Effect.provideService(NetService.NetService, net)),
      backendConfig: Ref.get(portRef).pipe(
        Effect.map(({ port }) => ({
          port,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
        })),
      ),
    });
  }),
);
