/**
 * The page title face (styles/title-fonts.css) loads at startup, so the
 * first page title draws in it (the face is font-display: block) and
 * nothing repaints after.
 */
export const TITLE_FACE = '600 24px "Title Newsreader"';

export function loadTitleFaces(): void {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  void document.fonts.load(TITLE_FACE).catch(() => undefined);
}
