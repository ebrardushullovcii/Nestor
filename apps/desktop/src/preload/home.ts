import {
  HOME_SUMMARY_CHANNEL,
  type HomeSummary,
  type HomeSummaryInput,
} from "@nestor/contracts";

/** The renderer's bridge to Home's numbers. */
export interface DesktopHomeBridge {
  summary(input: HomeSummaryInput): Promise<HomeSummary>;
}

export function createHomeBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}): DesktopHomeBridge {
  return {
    summary: (input) =>
      ipc.invoke(HOME_SUMMARY_CHANNEL, input) as Promise<HomeSummary>,
  };
}
