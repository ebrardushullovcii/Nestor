import {
  NEEDS_YOU_AI_ACCOUNT_CHANNEL,
  NEEDS_YOU_RUN_CHANNEL,
  type AiAccountNeed,
  type NeedsYouCommandName,
  type NeedsYouCommandInput,
  type NeedsYouCommandOutput,
} from "@nestor/contracts";

export interface DesktopNeedsYouBridge {
  run<K extends NeedsYouCommandName>(
    name: K,
    input: NeedsYouCommandInput<K>,
  ): Promise<NeedsYouCommandOutput<K>>;
  /** The AI account step only the person can take, while one is open. */
  aiAccount: {
    list(): Promise<AiAccountNeed[]>;
    /** Opens the AI service's own page for it in the person's browser. */
    open(id: string): Promise<boolean>;
    /** Checks again now that the person says it is done. */
    check(): Promise<boolean>;
  };
}

export function createNeedsYouBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopNeedsYouBridge {
  return {
    run: (name, input) =>
      ipc.invoke(NEEDS_YOU_RUN_CHANNEL, { name, input }) as Promise<
        NeedsYouCommandOutput<typeof name>
      >,
    aiAccount: {
      list: () =>
        ipc.invoke(NEEDS_YOU_AI_ACCOUNT_CHANNEL, {
          action: "list",
        }) as Promise<AiAccountNeed[]>,
      open: (id) =>
        ipc.invoke(NEEDS_YOU_AI_ACCOUNT_CHANNEL, {
          action: "open",
          id,
        }) as Promise<boolean>,
      check: () =>
        ipc.invoke(NEEDS_YOU_AI_ACCOUNT_CHANNEL, {
          action: "check",
        }) as Promise<boolean>,
    },
  };
}
