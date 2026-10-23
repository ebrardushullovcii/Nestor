// Resolve one CPU continuation per event-loop turn. Resolving every waiting
// worker in the same check phase joins their individually bounded slices into
// one long stall before Electron can handle its next message.
const waiting: Array<() => void> = [];
let scheduled = false;

function scheduleNext(): void {
  scheduled = true;
  setImmediate(() => {
    const next = waiting.shift();
    scheduled = false;
    if (waiting.length > 0) scheduleNext();
    next?.();
  });
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    if (!scheduled) scheduleNext();
  });
}
