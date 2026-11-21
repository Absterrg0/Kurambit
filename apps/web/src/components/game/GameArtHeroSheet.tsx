import type { EnvironmentId, GameHeroSheet } from "@kurambit/contracts";

import { useAssetUrlState } from "../../assets/assetUrls";
import { PropertySection } from "../ui/property-field";

/** A character's kept sheet (art/sheets/): its review picture, beside the model. */
export function GameArtHeroSheet({
  environmentId,
  root,
  sheet,
}: {
  environmentId: EnvironmentId;
  root: string;
  sheet: GameHeroSheet;
}) {
  const state = useAssetUrlState(environmentId, {
    _tag: "draft-workspace-file",
    cwd: root,
    path: sheet.image,
  });
  const url = state._tag === "Success" ? state.url : null;
  return (
    <PropertySection title="Sheet" collapsible>
      <div className="flex flex-col gap-2 px-3">
        {url === null ? null : (
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={`${sheet.name}'s sheet`} className="w-full rounded-sm" />
          </a>
        )}
      </div>
    </PropertySection>
  );
}
