import { ACTIVITY_FEED_CHANNEL, type ActivityFeed } from "@nestor/contracts";

/** The renderer's bridge to Activity's rows. */
export interface DesktopActivityBridge {
  feed(): Promise<ActivityFeed>;
}

export function createActivityBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopActivityBridge {
  return {
    feed: () => ipc.invoke(ACTIVITY_FEED_CHANNEL) as Promise<ActivityFeed>,
  };
}
