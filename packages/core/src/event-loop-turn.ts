// Resolve one CPU continuation per timer turn, so Electron can handle input
// between slices. setImmediate can keep chaining work in the check phase.
const waiting: Array<() => void> = [];
let scheduled = false;

function scheduleNext(): void {
  scheduled = true;
  setTimeout(() => {
    const next = waiting.shift();
    scheduled = false;
    if (waiting.length > 0) scheduleNext();
    next?.();
  }, 0);
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    if (!scheduled) scheduleNext();
  });
}
