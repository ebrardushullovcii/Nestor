export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Below this a page cannot lay out a form, so the size is not used. */
const MIN_USABLE = 100;

export function isUsableViewRect(rect: ViewRect): boolean {
  return rect.width > MIN_USABLE && rect.height > MIN_USABLE;
}

/** Clip the renderer's CSS viewport to the window in native view coordinates. */
export function resolvePanelPageBounds(input: {
  viewport: ViewRect;
  zoom: number;
  windowWidth: number;
  windowHeight: number;
}): ViewRect | null {
  const { viewport, zoom, windowWidth, windowHeight } = input;
  const x = Math.max(0, Math.ceil(viewport.x * zoom));
  const y = Math.max(0, Math.ceil(viewport.y * zoom));
  const right = Math.min(
    windowWidth,
    Math.floor((viewport.x + viewport.width) * zoom),
  );
  const bottom = Math.min(
    windowHeight,
    Math.floor((viewport.y + viewport.height) * zoom),
  );
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
