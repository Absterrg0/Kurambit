import type { GameLibraryItem } from "@kurambit/contracts";

export type LibraryKindFilter = "all" | "model" | "texture" | "audio" | "font" | "look";
export type LibrarySourceFilter = "yours" | "packs";

/**
 * PURE. The tiles the Library shows: Yours is the person's own (their games' files, saved models
 * and looks), Packs the open library's; the kind and the words narrow either. Saved models lead,
 * then the rest by name.
 */
export function libraryTiles(
  items: ReadonlyArray<GameLibraryItem>,
  filter: { readonly kind: LibraryKindFilter; readonly source: LibrarySourceFilter },
  search: string,
): ReadonlyArray<GameLibraryItem> {
  const words = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return items
    .filter((item) => (filter.source === "packs" ? item.source === "pack" : item.source !== "pack"))
    .filter((item) =>
      filter.kind === "all"
        ? true
        : item.kind === filter.kind ||
          // A pack offers kinds of its own: its models, its textures, its sounds.
          (item.pack !== undefined && packOffers(item.pack.kinds, filter.kind)),
    )
    .filter((item) => {
      if (words.length === 0) return true;
      const text = [
        item.name,
        item.from ?? "",
        item.pack?.author ?? "",
        item.pack?.description ?? "",
        item.look?.family ?? "",
        ...item.usedIn.map((use) => use.game),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .toSorted(
      (left, right) =>
        Number(right.source === "saved") - Number(left.source === "saved") ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }),
    );
}

const PACK_KINDS: Record<Exclude<LibraryKindFilter, "all" | "look">, ReadonlyArray<string>> = {
  model: ["character", "model", "animation"],
  texture: ["texture", "sprite", "tile", "ui", "icon", "hdri"],
  audio: ["sfx", "music"],
  font: ["font"],
};
const packOffers = (kinds: ReadonlyArray<string>, kind: LibraryKindFilter) =>
  kind !== "all" && kind !== "look" && kinds.some((each) => PACK_KINDS[kind].includes(each));

/** "Moonlit Pond, Lantern Grove": the games an item is in, by their current names. */
export const usedInWords = (
  item: GameLibraryItem,
  nameOf: (projectId: string, fallback: string) => string,
) => item.usedIn.map((use) => nameOf(use.projectId, use.game)).join(", ");
