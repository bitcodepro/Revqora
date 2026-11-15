/** Lines of toast details shown before they need "Details" (the card is click-through then). */
export const TOAST_DETAIL_LINES = 3;
const TOAST_DETAIL_CHARS = 240;

/** Whether toast details are too long to read in the collapsed, click-through card. */
export function detailsNeedExpanding(detail: string | undefined | null): boolean {
  if (!detail) return false;
  return detail.split("\n").length > TOAST_DETAIL_LINES || detail.length > TOAST_DETAIL_CHARS;
}
