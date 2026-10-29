import { ipcRenderer, webFrame } from "electron";
import { installPasswordPage } from "./password-page";
import type { BrowserPasswordFill } from "@nestor/contracts";
import { CHROME_IDENTITY_SCRIPT } from "../main/services/browser/browser-identity";

// Sandboxed page preload for the embedded browser. It exposes no bridge and
// no website-accessible IPC. Password messages stay in this isolated world.
void webFrame.executeJavaScript(CHROME_IDENTITY_SCRIPT);
installPasswordPage({
  capture: (value) => ipcRenderer.send("browser-password:captured", value),
  onFill: (listener) =>
    ipcRenderer.on(
      "browser-password:fill",
      (_event, value: BrowserPasswordFill) => listener(value),
    ),
  filled: (requestId, ok) =>
    ipcRenderer.send("browser-password:filled", { requestId, ok }),
});
