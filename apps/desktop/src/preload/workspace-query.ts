import { ipcRenderer } from "electron";
import type {
  WorkspaceQueryApi,
  WorkspaceChanges,
  WorkspaceReadRequest,
  WorkspaceQueryPortMessage,
  WorkspaceQueryPortRequest,
} from "@nestor/contracts";

/** The validated read port is private to preload, never exposed by contextBridge. */
export function createWorkspaceQueryBridge(): WorkspaceQueryApi {
  let sequence = 0;
  let port: MessagePort | undefined;
  let failed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      packet: WorkspaceQueryPortRequest;
    }
  >();
  const listeners = new Set<(changes: WorkspaceChanges) => void>();
  function unavailable() {
    failed = true;
    port?.close();
    for (const request of pending.values())
      request.reject(new Error("Workspace read is unavailable."));
    pending.clear();
  }
  ipcRenderer.on("workspace-query:unavailable", unavailable);
  ipcRenderer.on("workspace-query:port", (event: Electron.IpcRendererEvent) => {
    port?.close();
    port = event.ports[0];
    if (!port) return unavailable();
    port.onmessage = (event: MessageEvent<WorkspaceQueryPortMessage>) => {
      const message = event.data;
      if (message.type === "changes") {
        for (const listener of listeners) listener(message.value);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error));
    };
    port.onmessageerror = unavailable;
    port.start();
    for (const request of pending.values()) port.postMessage(request.packet);
  });
  // Connect while the renderer bundle loads, before any screen asks for data.
  ipcRenderer.send("workspace-query:connect");
  const read = <T>(
    method: WorkspaceReadRequest["method"],
    input: unknown,
  ): Promise<T> => {
    if (failed)
      return Promise.reject(new Error("Workspace read is unavailable."));
    const id = ++sequence;
    // Main/reader validates the complete request at the trust boundary.
    const packet = {
      id,
      request: { method, input },
    } as WorkspaceQueryPortRequest;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        packet,
      });
      port?.postMessage(packet);
    });
  };
  return {
    setQueryUpdates: (active) =>
      ipcRenderer.invoke("workspace-query:read", {
        method: "setQueryUpdates",
        input: { active },
      }) as Promise<void>,
    getStartupContext: () => read("getStartupContext", {}),
    queryJobList: (input) => read("queryJobList", input),
    getJobDetail: (jobId, planId = null) =>
      read("getJobDetail", { jobId, planId }),
    getCompanyDetail: (companyId) => read("getCompanyDetail", { companyId }),
    getListCounts: (input = {}) => read("getListCounts", input),
    queryCompanies: (input = {}) => read("queryCompanies", input),
    getChanges: (after, limit = 500) => read("getChanges", { after, limit }),
    onChanges(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
