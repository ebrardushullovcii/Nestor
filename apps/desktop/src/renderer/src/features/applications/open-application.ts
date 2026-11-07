/**
 * Shows the retained form or its URL, without starting preparation or
 * changing the application's state or mode.
 */
export async function openPreparedApplication(
  id: number,
  showToast: (toast: { title: string; tone?: "warning" }) => void,
): Promise<boolean> {
  const target = { id };
  const done = await window.nestor.jobFinder.openApplication(target);
  if (!done.opened) return false;
  showToast({
    title: done.retained
      ? "Opened the application page"
      : "The earlier page is gone. Opened the application URL.",
  });
  return true;
}
