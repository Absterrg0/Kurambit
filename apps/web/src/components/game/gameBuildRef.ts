import type { GameBuild, GameBuildRef } from "@kurambit/contracts";

export const refOf = (build: GameBuild): GameBuildRef => ({ _tag: "build", build: build.id });
