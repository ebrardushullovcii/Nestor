import {
  JOBS_CHANGED_CHANNEL,
  JOBS_RUN_CHANNEL,
  JOBS_SEARCH_STATUS_CHANNEL,
  JOBS_SUBSCRIBE_CHANNEL,
  JobChangeSchema,
  JobSearchStatusSchema,
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
  const listen = <T>(
    channel: string,
    parse: (payload: unknown) => T,
    listener: (value: T) => void,
  ) => {
    subscribe();
    const handler: Listener = (_event, payload) => listener(parse(payload));
    ipc.on(channel, handler);
    return () => ipc.removeListener(channel, handler);
  };
  return {
    run: (name, input) =>
      ipc.invoke(JOBS_RUN_CHANNEL, { name, input }) as Promise<
        JobCommandOutput<typeof name>
      >,
    onChange: (listener) =>
      listen(JOBS_CHANGED_CHANNEL, (p) => JobChangeSchema.parse(p), listener),
    onSearchStatus: (listener) =>
      listen(
        JOBS_SEARCH_STATUS_CHANNEL,
        (p) => JobSearchStatusSchema.parse(p),
        listener,
      ),
  };
}
