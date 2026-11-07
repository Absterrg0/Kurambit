import { expect, it } from "@effect/vitest";
import type { GameAssetPart } from "@kurambit/contracts";
import { ledgerParts } from "./blenderPipeline.ts";

const part = (from: string, licence: string, what: GameAssetPart["what"] = "mesh") =>
  ({ what, from, licence, ai: false, credits: null }) satisfies GameAssetPart;

const kept = (result: ReturnType<typeof ledgerParts>) => {
  if ("refusal" in result) throw new Error(result.refusal);
  return result.parts;
};

it("keeps two imports from one source when their credits differ", () => {
  const a = part("sketchfab", "CC-BY-4.0, credit: A");
  const b = part("sketchfab", "CC-BY-4.0, credit: B");
  expect(kept(ledgerParts([a, b, a]))).toEqual([a, b]);
});

it("merges past the sidecar's limit without losing a licence", () => {
  const body = part("mpfb2", "CC0 1.0", "body");
  const parts = [
    body,
    ...Array.from({ length: 12 }, (_, index) => part(`pack-${index}`, "CC0 1.0")),
    ...Array.from({ length: 8 }, (_, index) => part("polypizza", `CC-BY 3.0, credit: ${index}`)),
  ];
  const merged = kept(ledgerParts(parts));
  expect(merged.length).toBeLessThanOrEqual(16);
  expect(merged[0]).toEqual(body);
  expect(new Set(merged.map((entry) => entry.licence))).toEqual(
    new Set(parts.map((entry) => entry.licence)),
  );
  expect(merged.every((entry) => entry.from.length <= 64)).toBe(true);
});

it("refuses a ledger that cannot fit, never cuts it", () => {
  const parts = Array.from({ length: 17 }, (_, index) =>
    part("sketchfab", `CC-BY, credit: ${index}`),
  );
  expect("refusal" in ledgerParts(parts)).toBe(true);
});
