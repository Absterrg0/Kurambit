import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@kurambit/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { captureStageFrame } from "./gameStageBridge";

/** A PNG data URL as an image attachment named after `subject`; null when too large to send. */
export const stagePngAttachment = async (
  png: string,
  subject: string,
): Promise<ComposerImageAttachment | null> => {
  const blob = await fetch(png).then(
    (response) => response.blob(),
    () => null,
  );
  if (blob === null || blob.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return null;
  const name = `${subject.replace(/[^\w.-]+/g, "-")}-frame.png`;
  const file = new File([blob], name, { type: "image/png" });
  return {
    type: "image",
    id: randomUUID(),
    name,
    mimeType: "image/png",
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
};

/**
 * The Stage's canvas as an image attachment for a message about a thing on
 * it, or null when the game gives no frame or it is too large to send.
 */
export const stageFrameAttachment = async (
  thingName: string,
): Promise<ComposerImageAttachment | null> => {
  const png = await captureStageFrame();
  return png === null ? null : stagePngAttachment(png, thingName);
};
