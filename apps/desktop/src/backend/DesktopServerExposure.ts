import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@t3tools/desktop/backend/DesktopServerExposure") {}

const state: DesktopServerExposureState = {
  mode: "local-only",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

export const layer = Layer.effect(
  DesktopServerExposure,
  Effect.gen(function* () {
    const portRef = yield* Ref.make(0);
    return DesktopServerExposure.of({
      getState: Effect.succeed(state),
      configureFromSettings: ({ port }) => Ref.set(portRef, port).pipe(Effect.as(state)),
      backendConfig: Ref.get(portRef).pipe(
        Effect.map((port) => ({
          port,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        })),
      ),
      getAdvertisedEndpoints: Ref.get(portRef).pipe(
        Effect.map((port) => [
          createAdvertisedEndpoint({
            id: `desktop-loopback:${port}`,
            label: "This machine",
            httpBaseUrl: `http://127.0.0.1:${port}`,
            reachability: "loopback",
            status: "available",
            provider: { id: "desktop", label: "Desktop", kind: "core", isAddon: false },
            source: "desktop-core",
          }),
        ]),
      ),
    });
  }),
);
