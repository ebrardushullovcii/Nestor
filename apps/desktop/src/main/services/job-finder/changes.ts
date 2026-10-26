const listeners = new Set<() => void>();

/**
 * Main-process listeners told when profile work or the assistant changed
 * something the job store does not announce (the assistant watches its
 * background runs this way instead of polling).
 */
export function onJobFinderChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyJobFinderChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One listener never blocks another.
    }
  }
}
