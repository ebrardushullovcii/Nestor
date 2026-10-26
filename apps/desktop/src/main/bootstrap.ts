import { app } from "electron";
import { hasSingleInstanceLock } from "./setup/desktop-startup";

if (hasSingleInstanceLock) {
  void import("./index").catch((error: unknown) => {
    console.error("Could not start the desktop application.", error);
    app.quit();
  });
} else {
  app.quit();
}
