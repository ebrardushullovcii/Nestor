import { ipcRenderer } from "electron";
import type {
  WorkspaceQueryApi,
  WorkspaceChanges,
  WorkspaceReadRequest,
} from "@nestor/contracts";

/** Main validates IPC inputs. Trusted typed results are not parsed again. */
export function createWorkspaceQueryBridge(): WorkspaceQueryApi {
  const read = <T>(
    method: WorkspaceReadRequest["method"],
    input: unknown,
  ): Promise<T> =>
    ipcRenderer.invoke("workspace-query:read", { method, input }) as Promise<T>;
  return {
    getStartupContext: () => read("getStartupContext", {}),
    queryJobList: (input) => read("queryJobList", input),
    getJobDetail: (jobId, planId = null) =>
      read("getJobDetail", { jobId, planId }),
    getCompanyDetail: (companyId) => read("getCompanyDetail", { companyId }),
    getHomeSummary: (input = {}) => read("getHomeSummary", input),
    getListCounts: (input = {}) => read("getListCounts", input),
    queryCompanies: (input = {}) => read("queryCompanies", input),
    getChanges: (after, limit = 500) => read("getChanges", { after, limit }),
    onChanges(listener) {
      const handle = (
        _event: Electron.IpcRendererEvent,
        changes: WorkspaceChanges,
      ) => listener(changes);
      ipcRenderer.on("workspace-query:changes", handle);
      return () => {
        ipcRenderer.off("workspace-query:changes", handle);
      };
    },
  };
}
