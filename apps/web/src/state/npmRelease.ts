import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

export const npmReleasePublishedAtom = Atom.family((_version: string) =>
  Atom.make(AsyncResult.success(false)),
);
export function useNpmReleasePublished(version: string | null): boolean {
  return AsyncResult.getOrElse(useAtomValue(npmReleasePublishedAtom(version ?? "")), () => false);
}
