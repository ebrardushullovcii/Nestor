/**
 * Opens the form Apply prepared. A page that was closed to save memory, or
 * by a restart, comes back from what Apply filled; while it does, the
 * person reads that it is on its way and will not be sent.
 */
export async function openPreparedApplication(
  id: number,
  showToast: (toast: { title: string; tone?: "warning" }) => void,
): Promise<boolean> {
  const target = { id };
  const done = await window.nestor.jobFinder.openApplication(target);
  if (!done) return false;
  const restoring = ["queued", "running"].includes(
    (await window.nestor.jobFinder.getApplicationDetails(target))?.application
      .state ?? "",
  );
  showToast({
    title: restoring
      ? "Restoring the form for your review. Restoring it won't send it."
      : "Opened the application page",
  });
  return true;
}
