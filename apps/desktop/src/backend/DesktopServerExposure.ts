import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

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
    readonly configureFromSettings: (input: { readonly port: number }) => Effect.Effect<void>;
  }
>()("@kurambit/desktop/backend/DesktopServerExposure") {}

export const layer = Layer.effect(
  DesktopServerExposure,
  Effect.gen(function* () {
    const portRef = yield* Ref.make(0);
    return DesktopServerExposure.of({
      configureFromSettings: ({ port }) => Ref.set(portRef, port),
      backendConfig: Ref.get(portRef).pipe(
        Effect.map((port) => ({
          port,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
        })),
      ),
    });
  }),
);
