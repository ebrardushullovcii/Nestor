const queryWindows = new Set<number>();

/** Query routes refetch pages from the row feed; other routes keep legacy sync. */
export function setWorkspaceQueryUpdateMode(id: number, active: boolean): void {
  if (active) queryWindows.add(id);
  else queryWindows.delete(id);
}
export const usesWorkspaceQueryUpdates = (id: number): boolean =>
  queryWindows.has(id);
