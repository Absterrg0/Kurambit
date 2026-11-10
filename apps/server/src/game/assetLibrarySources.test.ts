import { describe, expect, it } from "@effect/vitest";
import { LIBRARY_CATALOG } from "./assetLibraryCatalog.ts";
import {
  awaitsMirror,
  creditLine,
  entryLicenceProblem,
  pinProblem,
  shippableLicence,
} from "./assetLibraryFiles.ts";
import {
  LIBRARY_ASSETS,
  polyPizzaEntry,
  polyPizzaEntryId,
  polyPizzaModelId,
} from "./assetLibrarySources.ts";

describe("licences a sold game may ship under", () => {
  it("names the shippable licences in the words sources use", () => {
    expect(shippableLicence("CC0")).toBe("CC0-1.0");
    expect(shippableLicence("CC0 1.0")).toBe("CC0-1.0");
    expect(shippableLicence("CC-BY 3.0")).toBe("CC-BY-3.0");
    expect(shippableLicence("CC BY 4.0")).toBe("CC-BY-4.0");
    expect(shippableLicence("Creative Commons Attribution 4.0 International")).toBe("CC-BY-4.0");
    expect(shippableLicence("MIT")).toBe("MIT");
    expect(shippableLicence("Apache License 2.0")).toBe("Apache-2.0");
    expect(shippableLicence("SIL Open Font License 1.1")).toBe("OFL-1.1");
  });

  it("refuses non-commercial, no-derivatives, share-alike, editorial and unversioned licences", () => {
    for (const text of [
      "CC-BY-NC 4.0",
      "CC BY-NC-SA 3.0",
      "CC BY-ND 4.0",
      "CC-BY-SA 3.0",
      "CC-BY",
      "Editorial",
      "GPL 3.0",
      "Royalty free",
      "",
    ])
      expect(shippableLicence(text), text).toBeNull();
  });

  it("refuses an attribution licence with no credit line, and the OFL on anything but fonts", () => {
    expect(entryLicenceProblem({ id: "x", licence: "CC-BY-4.0", kinds: ["model"] })).not.toBeNull();
    expect(
      entryLicenceProblem({ id: "x", licence: "CC-BY-4.0", credit: "  ", kinds: ["model"] }),
    ).not.toBeNull();
    expect(
      entryLicenceProblem({ id: "x", licence: "OFL-1.1", credit: "A font", kinds: ["model"] }),
    ).not.toBeNull();
    expect(entryLicenceProblem({ id: "x", licence: "CC0-1.0", kinds: ["model"] })).toBeNull();
  });

  it("indexes no shipped entry whose licence or id fails", () => {
    const ids = new Set<string>();
    for (const entry of [...LIBRARY_CATALOG, ...LIBRARY_ASSETS]) {
      expect(entryLicenceProblem(entry), entry.id).toBeNull();
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
    }
  });
});

describe("Poly Pizza models", () => {
  const model = {
    ID: "y4wdQpg767",
    Title: "Shiba Inu",
    Attribution:
      '"Shiba Inu" by Quaternius, https://poly.pizza/m/y4wdQpg767. Licence at https://creativecommons.org/licenses/by/3.0/',
    Download: "https://static.poly.pizza/ba6d0ee3-bcc0-4ef0-9d3c-a3e245b41c77.glb",
    Creator: { Username: "Quaternius" },
    Licence: "CC-BY 3.0",
    Animated: true,
  };

  it("keeps a CC BY model with its credit, which the game's credits then carry", () => {
    const entry = polyPizzaEntry(model);
    expect(entry?.licence).toBe("CC-BY-3.0");
    expect(entry?.credit).toBe(model.Attribution);
    expect(entry === null ? "" : creditLine(entry)).toBe(`${model.Attribution} · CC BY 3.0`);
    expect(entry?.animated).toBe(1);
  });

  it("drops a model whose licence a sold game may not ship, or a CC BY one with no credit", () => {
    expect(polyPizzaEntry({ ...model, Licence: "CC-BY-NC 4.0" })).toBeNull();
    expect(polyPizzaEntry({ ...model, Attribution: "" })).toBeNull();
    expect(polyPizzaEntry({ ...model, Download: "https://elsewhere.example/x.glb" })).toBeNull();
  });

  it("round-trips a case-sensitive model id through a lower-case library id", () => {
    const id = polyPizzaEntryId("y4wdQpg767");
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
    expect(polyPizzaModelId(id)).toBe("y4wdQpg767");
    expect(polyPizzaModelId("kenney-nature-kit")).toBeNull();
  });
});

describe("pins", () => {
  const got = { sha256: "a".repeat(64), md5: "b".repeat(32), bytes: 10 };
  it("checks the source's MD5 and size where that is all it publishes", () => {
    expect(pinProblem({ md5: "b".repeat(32), bytes: 10 }, got)).toBeNull();
    expect(pinProblem({ md5: "c".repeat(32), bytes: 10 }, got)).not.toBeNull();
    expect(pinProblem({ bytes: 11 }, got)).not.toBeNull();
  });
  it("treats a size the source does not publish as a ceiling only", () => {
    expect(pinProblem({ bytes: 64, capped: true }, got)).toBeNull();
    expect(pinProblem({ bytes: 9, capped: true }, got)).not.toBeNull();
  });
});

describe("entries waiting for a mirror", () => {
  it("holds back an entry with any byte on Google Drive, and offers it once re-pinned elsewhere", () => {
    const drive = {
      download: "https://drive.usercontent.google.com/download?id=abc&export=download&confirm=t",
      files: [
        {
          path: "glTF/Fox.gltf",
          url: "https://drive.usercontent.google.com/download?id=abc&export=download&confirm=t",
          bytes: 1,
        },
      ],
    };
    expect(awaitsMirror(drive)).toBe(true);
    expect(
      awaitsMirror({
        download: "https://github.com/Absterrg0/Kurambit/releases/download/library-mirror/x.zip",
      }),
    ).toBe(false);
  });

  it("keeps the OpenGameArt-hosted Quaternius animals offered", () => {
    const animals = LIBRARY_CATALOG.find(
      (pack) => pack.id === "quaternius-animated-animales-low-poly",
    );
    expect(animals).toBeDefined();
    expect(animals === undefined ? true : awaitsMirror(animals)).toBe(false);
  });
});
