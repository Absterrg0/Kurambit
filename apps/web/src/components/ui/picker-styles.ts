// A denser picker for chrome where a menu opens over work, such as the
// composer's model and effort pickers: 13px labels, 32px rows, one inset, and a
// hairline between rows so the highlight of one never touches the next.
export const RELAXED_PICKER_CLASS =
  "[--type-label:0.8125rem] [--type-meta:0.75rem] [--type-caption:0.6875rem] [&_[data-slot=menu-item]]:min-h-8 [&_[data-slot=menu-radio-item]]:min-h-8 [&_[data-slot=menu-checkbox-item]]:min-h-8 [&_[data-slot=menu-sub-trigger]]:min-h-8 [&_[data-slot=combobox-item]]:min-h-8 [&_[data-slot=menu-item]]:px-2.5 [&_[data-slot=menu-radio-item]]:px-2.5 [&_[data-slot=menu-sub-trigger]]:px-2.5 [&_[data-slot=combobox-item]]:px-2.5 [&_[data-slot=menu-label]]:px-2.5 [&_[data-slot=menu-label]]:pt-2 [&_[data-slot=menu-label]]:pb-1 [&_[data-slot=menu-label]]:text-caption [&_[data-slot=menu-radio-item]+[data-slot=menu-radio-item]]:mt-px [&_[data-slot=menu-item]+[data-slot=menu-item]]:mt-px";
