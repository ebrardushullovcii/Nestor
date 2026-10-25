let requested = false;

/** Finishing guided setup asks Find jobs to start the first search itself. */
export function requestFirstSearch(): void {
  requested = true;
}

/** True once per request. */
export function takeFirstSearchRequest(): boolean {
  const value = requested;
  requested = false;
  return value;
}
