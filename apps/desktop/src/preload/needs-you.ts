import {
  NEEDS_YOU_RUN_CHANNEL,
  type NeedsYouCommandName,
  type NeedsYouCommandInput,
  type NeedsYouCommandOutput,
} from "@nestor/contracts";

export interface DesktopNeedsYouBridge {
  run<K extends NeedsYouCommandName>(
    name: K,
    input: NeedsYouCommandInput<K>,
  ): Promise<NeedsYouCommandOutput<K>>;
}

export function createNeedsYouBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopNeedsYouBridge {
  return {
    run: (name, input) =>
      ipc.invoke(NEEDS_YOU_RUN_CHANNEL, { name, input }) as Promise<
        NeedsYouCommandOutput<typeof name>
      >,
  };
}
