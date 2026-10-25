/**
 * Background services register how to stop themselves when they start, so
 * shutdown can stop them without main importing them (and everything they
 * import) at launch.
 */
const stoppers = new Set<() => void>();

export function registerServiceStopper(stop: () => void): void {
  stoppers.add(stop);
}

export function stopRegisteredServices(): void {
  for (const stop of stoppers) stop();
}
