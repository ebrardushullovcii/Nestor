import { ipcRenderer } from "electron";
import type {
  AddBrowserJobResult,
  DesktopBrowserBridge,
  DesktopBrowserImportResult,
  DesktopBrowserImportSources,
  DesktopBrowserSnapshot,
  DesktopBrowserState,
} from "@nestor/contracts";

// Main checks every input and result against its schema; the bridge passes
// them through, so the preload builds no schema when the window opens.
export const browserBridge: DesktopBrowserBridge = {
  addCurrentJob: (input) =>
    ipcRenderer.invoke(
      "browser:add-job",
      input,
    ) as Promise<AddBrowserJobResult>,
  getState: () =>
    ipcRenderer.invoke("browser:get-state") as Promise<DesktopBrowserState>,
  command: (command) =>
    ipcRenderer.invoke(
      "browser:command",
      command,
    ) as Promise<DesktopBrowserState>,
  setViewport: async (viewport) => {
    await ipcRenderer.invoke("browser:set-viewport", viewport);
  },
  captureActivePage: () =>
    ipcRenderer.invoke(
      "browser:capture-page",
    ) as Promise<DesktopBrowserSnapshot>,
  listImportSources: () =>
    ipcRenderer.invoke(
      "browser:list-import-sources",
    ) as Promise<DesktopBrowserImportSources>,
  importFromBrowser: (input) =>
    ipcRenderer.invoke(
      "browser:import-from-browser",
      input,
    ) as Promise<DesktopBrowserImportResult>,
  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) =>
      listener(state as DesktopBrowserState);
    ipcRenderer.on("browser:state-changed", handler);
    return () => ipcRenderer.off("browser:state-changed", handler);
  },
  onFocusAddress: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("browser:focus-address", handler);
    return () => ipcRenderer.off("browser:focus-address", handler);
  },
};
