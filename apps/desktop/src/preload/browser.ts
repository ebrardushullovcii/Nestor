import { ipcRenderer } from "electron";
import {
  AddBrowserJobInputSchema,
  AddBrowserJobResultSchema,
  DesktopBrowserCommandSchema,
  DesktopBrowserImportInputSchema,
  DesktopBrowserImportResultSchema,
  DesktopBrowserImportSourcesSchema,
  DesktopBrowserSnapshotSchema,
  DesktopBrowserStateSchema,
  DesktopBrowserViewportSchema,
  type DesktopBrowserBridge,
} from "@nestor/contracts";

export const browserBridge: DesktopBrowserBridge = {
  addCurrentJob: async (input) =>
    AddBrowserJobResultSchema.parse(
      await ipcRenderer.invoke(
        "browser:add-job",
        AddBrowserJobInputSchema.parse(input),
      ),
    ),
  getState: async () =>
    DesktopBrowserStateSchema.parse(
      await ipcRenderer.invoke("browser:get-state"),
    ),
  command: async (command) =>
    DesktopBrowserStateSchema.parse(
      await ipcRenderer.invoke(
        "browser:command",
        DesktopBrowserCommandSchema.parse(command),
      ),
    ),
  setViewport: async (viewport) => {
    await ipcRenderer.invoke(
      "browser:set-viewport",
      DesktopBrowserViewportSchema.parse(viewport),
    );
  },
  captureActivePage: async () =>
    DesktopBrowserSnapshotSchema.parse(
      await ipcRenderer.invoke("browser:capture-page"),
    ),
  listImportSources: async () =>
    DesktopBrowserImportSourcesSchema.parse(
      await ipcRenderer.invoke("browser:list-import-sources"),
    ),
  importFromBrowser: async (input) =>
    DesktopBrowserImportResultSchema.parse(
      await ipcRenderer.invoke(
        "browser:import-from-browser",
        DesktopBrowserImportInputSchema.parse(input),
      ),
    ),
  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      const parsed = DesktopBrowserStateSchema.safeParse(state);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on("browser:state-changed", handler);
    return () => ipcRenderer.off("browser:state-changed", handler);
  },
  onFocusAddress: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("browser:focus-address", handler);
    return () => ipcRenderer.off("browser:focus-address", handler);
  },
};
