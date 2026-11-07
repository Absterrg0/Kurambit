import type { GameArtProviderId } from "@kurambit/contracts";
import type { ArtAdapter } from "./adapter.ts";
import { codex } from "./codex.ts";
import { elevenlabs } from "./elevenlabs.ts";
import { google } from "./google.ts";
import { meshy } from "./meshy.ts";
import { openai } from "./openai.ts";
import { tripo } from "./tripo.ts";
import { uthana } from "./uthana.ts";

/** Every built adapter; the Kurambit plan has none yet. */
export const ART_ADAPTERS: Readonly<Partial<Record<GameArtProviderId, ArtAdapter>>> = {
  codex,
  openai,
  google,
  tripo,
  meshy,
  elevenlabs,
  uthana,
};
