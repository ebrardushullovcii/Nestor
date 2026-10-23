import type { WebContents } from "electron";

/** Serialize sleep/wake commands so an old freeze cannot overtake a new read. */
export class TabLifecycle {
  private readonly states = new Map<
    number,
    { frozen: boolean; requested: boolean; pending: Promise<void> }
  >();

  setFrozen(contents: WebContents, requested: boolean): Promise<void> {
    if (contents.isDestroyed()) return Promise.resolve();
    let state = this.states.get(contents.id);
    if (!state) {
      state = { frozen: false, requested: false, pending: Promise.resolve() };
      this.states.set(contents.id, state);
    }
    if (state.requested === requested) return state.pending;
    state.requested = requested;
    const current = state;
    current.pending = current.pending
      .catch(() => undefined)
      .then(async () => {
        if (contents.isDestroyed() || current.frozen === requested) return;
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        if (requested) {
          // Focus emulation holds a visible capture and prevents freezing.
          // Release it on this page before asking Chromium to freeze it.
          await contents.debugger.sendCommand(
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
          );
        }
        await contents.debugger.sendCommand("Page.setWebLifecycleState", {
          state: requested ? "frozen" : "active",
        });
        current.frozen = requested;
      });
    return current.pending;
  }

  forget(contentsId: number): void {
    this.states.delete(contentsId);
  }
}
