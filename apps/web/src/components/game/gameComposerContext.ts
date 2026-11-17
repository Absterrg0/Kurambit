import { useEffect } from "react";
import {
  gameRunAskContext,
  gameStageAskContext,
  playOutcomeWords,
  type GamePlayOutcome,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@kurambit/contracts";
import { scopedThreadKey } from "@kurambit/client-runtime/environment";

import { useComposerDraftStore } from "../../composerDraftStore";
import { dispatchComposerFocus } from "../../lib/desktopSnapShot";
import { randomUUID } from "../../lib/utils";
import {
  captureStageFrame,
  clearStageSelection,
  portraitStageThing,
  type StageSelection,
  useStageBridge,
} from "./gameStageBridge";
import { stagePngAttachment } from "./gameStageFrame";

/**
 * What the person points at on the Stage goes into the composer the way T3's preview annotations
 * do (PreviewView's pick): a chip in the input, its frame as the annotation's screenshot, and the
 * context the agent needs as its comment. One chip system: the pointed thing and "Tell the agent
 * about this run" are both preview annotations, removable from the composer like any other.
 */
const STAGE_PAGE = "kurambit://stage";

const frameSize = async (png: string) => {
  const image = new Image();
  image.src = png;
  return image.decode().then(
    () => ({ width: image.naturalWidth, height: image.naturalHeight }),
    () => null,
  );
};

/** An annotation of the Stage named `label`, with the frame as its screenshot when there is one. */
const attach = async (
  threadRef: ScopedThreadRef,
  annotation: Omit<
    PreviewAnnotationPayload,
    "elements" | "regions" | "strokes" | "styleChanges" | "screenshot" | "createdAt" | "pageUrl"
  >,
  png: string | null,
  options: { readonly focus: boolean },
) => {
  const size = png === null ? null : await frameSize(png);
  const image = png === null ? null : await stagePngAttachment(png, annotation.label ?? "stage");
  const store = useComposerDraftStore.getState();
  store.addPreviewAnnotation(threadRef, {
    ...annotation,
    pageUrl: STAGE_PAGE,
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot:
      png === null || size === null || image === null
        ? null
        : { dataUrl: png, ...size, cropRect: { x: 0, y: 0, ...size } },
    createdAt: new Date().toISOString(),
  });
  // Bound to the annotation by id, as a picked element's crop is: the chip shows it.
  if (image !== null) store.addImage(threadRef, { ...image, id: annotation.id });
  if (options.focus) dispatchComposerFocus();
};

const detach = (threadRef: ScopedThreadRef, id: string) => {
  const store = useComposerDraftStore.getState();
  store.removePreviewAnnotation(threadRef, id);
  store.removeImage(threadRef, id);
};

const PICK_CHIP = "stage-thing-";

/**
 * Takes every Stage pick chip but `keep` out of the composer. The draft is the record, not this
 * page's memory: a pick chip left from before a reload, or made by another mount, is still the
 * one pick a new pick replaces. Chips the person asked for (Art's "Ask about this", a run) stay.
 */
const detachPicks = (threadRef: ScopedThreadRef, keep: string | null) => {
  const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
  for (const entry of draft?.previewAnnotations ?? [])
    if (entry.id.startsWith(PICK_CHIP) && entry.id !== keep) detach(threadRef, entry.id);
};

/** "Tell the agent about this run": the run as a chip in the composer, with its frame. */
export const attachRunToComposer = async (
  threadRef: ScopedThreadRef,
  run: { readonly kept: string; readonly outcome: GamePlayOutcome; readonly paused: boolean },
) => {
  const png = await captureStageFrame();
  await attach(
    threadRef,
    {
      id: `stage-run-${run.kept}`,
      pageTitle: "Stage",
      label: run.paused
        ? `Run paused at ${Math.round(run.outcome.seconds)} s`
        : `Run ${playOutcomeWords(run.outcome)}`,
      comment: gameRunAskContext(run),
    },
    png,
    { focus: true },
  );
};

/**
 * "Ask the agent about this asset": the Art tab's asset as a chip in the composer, with the
 * picture its viewer shows from the angle the person left it at. One chip per asset: asking again
 * replaces it.
 */
export const attachAssetToComposer = async (
  threadRef: ScopedThreadRef,
  asset: { readonly key: string; readonly label: string; readonly context: string },
  png: string | null,
) => {
  const id = `art-asset-${asset.key}`;
  detach(threadRef, id);
  await attach(
    threadRef,
    { id, pageTitle: "Art", label: asset.label, comment: asset.context },
    png,
    { focus: true },
  );
};

const thingLabel = (selection: StageSelection) => {
  const { thing } = selection;
  const name =
    thing.instance === undefined ? thing.name : `${thing.name} #${thing.instance.index + 1}`;
  // A part says what holds it: "Cabin (in Island)".
  const holder = thing.path?.split(" › ").at(-2);
  return holder === undefined ? name : `${name} (in ${holder})`;
};

/** A part's chip shows it alone, as Art does; a thing's shows the frame it was picked in. */
const pickedPicture = (selection: StageSelection) =>
  selection.thing.path === undefined || selection.thing.instance !== undefined
    ? captureStageFrame()
    : portraitStageThing(selection.thing.id, { size: 384, yaw: 0.7, pitch: 0.55 }).then(
        (portrait) => portrait?.png ?? captureStageFrame(),
      );

/** The chip each thread's pointed thing is, so a new pick replaces it and a cleared one goes. */
const pointed = new Map<
  string,
  {
    readonly id: string;
    readonly thing: string;
    /** Its tuned values as last said: a moved label (a resize, the free camera) says nothing new. */
    readonly values: string;
    readonly placed: boolean;
  }
>();
const valuesKey = (selection: StageSelection) => JSON.stringify(selection.thing.values ?? []);

/**
 * Keeps the thing pointed at on this thread's Stage as a chip in its composer: picking puts it in
 * (with the frame as it was picked), a new pick replaces it, a value tuned since updates its
 * words, and clearing the pick takes it out. Taking the chip out of the composer stops pointing.
 */
export function useStageSelectionChip(threadRef: ScopedThreadRef | null) {
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  useEffect(() => {
    if (threadRef === null || threadKey === null) return;
    const ownSelection = () => {
      const state = useStageBridge.getState();
      return state.owner?.startsWith(`${threadKey}\0`) === true ? state.selected : null;
    };
    const sync = (selection: StageSelection | null) => {
      const current = pointed.get(threadKey);
      if (selection === null) {
        if (current === undefined) return;
        pointed.delete(threadKey);
        detach(threadRef, current.id);
        return;
      }
      const words = { pageTitle: "Stage", label: thingLabel(selection) };
      if (current !== undefined && current.thing === selection.thing.id) {
        // Same thing with new values: its words follow, its frame stays as picked.
        const values = valuesKey(selection);
        if (values === current.values) return;
        pointed.set(threadKey, { ...current, values });
        const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
        const kept = draft?.previewAnnotations.find((entry) => entry.id === current.id);
        if (kept === undefined) return;
        useComposerDraftStore.getState().addPreviewAnnotation(threadRef, {
          ...kept,
          ...words,
          comment: gameStageAskContext(selection),
        });
        return;
      }
      const id = `${PICK_CHIP}${randomUUID()}`;
      // The new pick owns the chip before the old one goes, so its going is not the person's ×.
      pointed.set(threadKey, {
        id,
        thing: selection.thing.id,
        values: valuesKey(selection),
        placed: false,
      });
      detachPicks(threadRef, null);
      void pickedPicture(selection).then((png) => {
        // A newer pick (or none) since the frame was asked for owns the chip now.
        if (pointed.get(threadKey)?.id !== id) return;
        void attach(threadRef, { id, ...words, comment: gameStageAskContext(selection) }, png, {
          focus: false,
        }).then(() => {
          // Cleared or replaced while the chip was being made: it goes with its pick.
          if (pointed.get(threadKey)?.id !== id) detach(threadRef, id);
          // A pick chip that landed while this one was being made goes too: one pick, one chip.
          else detachPicks(threadRef, id);
        });
      });
    };
    sync(ownSelection());
    const stopBridge = useStageBridge.subscribe((state, before) => {
      if (state.selected === before.selected && state.owner === before.owner) return;
      sync(ownSelection());
    });
    // The chip taken out of the composer (its ×, a send) stops pointing at the thing.
    const stopDraft = useComposerDraftStore.subscribe((state) => {
      const current = pointed.get(threadKey);
      if (current === undefined) return;
      const has =
        state
          .getComposerDraft(threadRef)
          ?.previewAnnotations.some((entry) => entry.id === current.id) === true;
      if (has) {
        if (!current.placed) pointed.set(threadKey, { ...current, placed: true });
        return;
      }
      if (!current.placed) return;
      pointed.delete(threadKey);
      if (ownSelection() !== null) clearStageSelection();
    });
    return () => {
      stopBridge();
      stopDraft();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the thread's key names the ref.
  }, [threadKey]);
}
