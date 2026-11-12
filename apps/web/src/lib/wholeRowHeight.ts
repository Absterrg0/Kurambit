/**
 * The tallest height, at most a scrolling list's own, that ends on a whole row,
 * so an overflowing list never stops mid-glyph. Null when the list already ends
 * on one or no row has painted yet. `rows` selects the rows that may end the
 * list (not group headings, which would head nothing); `bottomPadding` is the
 * list's own padding, kept under the last row.
 */
export function wholeRowHeight(
  scrollElement: HTMLElement,
  rows: string,
  bottomPadding: number,
): number | null {
  const viewport = scrollElement.getBoundingClientRect();
  // Popups open from a slight scale: rects are scaled while clientHeight is not.
  const scale = scrollElement.offsetHeight > 0 ? viewport.height / scrollElement.offsetHeight : 1;
  const limit = scrollElement.clientHeight - bottomPadding;
  let lastWholeRowBottom = 0;
  for (const row of scrollElement.querySelectorAll(rows)) {
    const bottom = (row.getBoundingClientRect().bottom - viewport.top) / scale;
    if (bottom <= limit + 0.5) lastWholeRowBottom = Math.max(lastWholeRowBottom, bottom);
  }
  if (lastWholeRowBottom === 0) return null;
  const height = Math.ceil(lastWholeRowBottom + bottomPadding);
  return height < scrollElement.clientHeight ? height : null;
}
