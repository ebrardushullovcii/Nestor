import {
  JOBS_CHANGED_CHANNEL,
  JOBS_RUN_CHANNEL,
  JOBS_SUBSCRIBE_CHANNEL,
  JobChangeSchema,
  type DesktopJobsBridge,
  type JobCommandOutput,
} from "@nestor/contracts";

type Listener = (event: unknown, payload: unknown) => void;

/**
 * The renderer's bridge to the job commands. Main registers these channels
 * at startup, so unlike the older job-finder channels they never wait for
 * the workspace service.
 */
export function createJobsBridge(ipc: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: Listener) => void;
  removeListener: (channel: string, listener: Listener) => void;
}): DesktopJobsBridge {
  let subscribed: Promise<unknown> | null = null;
  const subscribe = () => {
    subscribed ??= ipc.invoke(JOBS_SUBSCRIBE_CHANNEL).catch(() => {
      subscribed = null;
    });
  };
  return {
    run: (name, input) =>
      ipc.invoke(JOBS_RUN_CHANNEL, { name, input }) as Promise<
        JobCommandOutput<typeof name>
      >,
    onChange: (listener) => {
      subscribe();
      const handler: Listener = (_event, payload) =>
        listener(JobChangeSchema.parse(payload));
      ipc.on(JOBS_CHANGED_CHANNEL, handler);
      return () => ipc.removeListener(JOBS_CHANGED_CHANNEL, handler);
    },
  };
}
