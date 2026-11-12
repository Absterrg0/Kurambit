const DIALOG_BACKDROP_BASE_CLASS =
  "fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";

const DIALOG_BACKDROP_CLASS = `dialog-backdrop ${DIALOG_BACKDROP_BASE_CLASS}`;
const DIALOG_MEDIA_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/75 backdrop-blur-none`;
// A plain dim with no blur: the app panel sits over a running game, and a blur
// would be recomputed on every frame the game paints.
const DIALOG_APP_PANEL_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/35 dark:bg-black/65`;

const DIALOG_POPUP_BASE_CLASS =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]";

const DIALOG_POPUP_CLASS = `dialog-glass ${DIALOG_POPUP_BASE_CLASS} rounded-2xl border`;
const DIALOG_MEDIA_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} max-h-[92vh] w-auto max-w-[92vw] overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none`;

// A large panel over the live app, such as Settings: the app's own fill, so the
// cards inside read as they do on a page, with the popover rim and shadow. A dialog
// opened from it does not shrink it into a second floating layer: the panel stays
// put, whole and opaque, and the child dialog's backdrop dims it.
const DIALOG_APP_PANEL_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} data-nested-dialog-open:translate-y-0 data-nested-dialog-open:scale-100 data-nested-dialog-open:opacity-100 size-full max-h-[60rem] max-w-[75rem] overflow-hidden surface-app-panel rounded-2xl text-body text-foreground duration-150 ease-out data-ending-style:scale-[0.985] data-starting-style:scale-[0.985] max-sm:rounded-none max-sm:pt-(--app-modal-titlebar-height)`;

const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4";

export {
  DIALOG_APP_PANEL_BACKDROP_CLASS,
  DIALOG_APP_PANEL_POPUP_CLASS,
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
};
