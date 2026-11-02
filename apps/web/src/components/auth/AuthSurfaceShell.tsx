import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";
import { KurambitMark, KurambitWordmark } from "../brand/KurambitBrand";
import { StandalonePage } from "../ui/standalone-page";

export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <StandalonePage
      tone="brand"
      masthead={
        <header className="relative h-24 overflow-hidden bg-sumi text-washi">
          {stageVariant ? (
            <div className="absolute inset-0 opacity-80" aria-hidden>
              <StageBackdropArt variant={stageVariant} />
            </div>
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgb(212_85_43/0.28),transparent_45%)]"
            />
          )}
          <div className="relative flex h-full items-center gap-3 p-5 sm:p-6">
            <KurambitMark className="size-10" tone="light" />
            <div className="flex flex-col gap-0.5">
              <KurambitWordmark className="text-xs" />
              {APP_DISPLAY_NAME === "Kurambit" ? null : (
                <span className="text-3xs tracking-widest text-washi/60 uppercase">
                  {APP_STAGE_LABEL}
                </span>
              )}
            </div>
          </div>
        </header>
      }
    >
      {children}
    </StandalonePage>
  );
}
