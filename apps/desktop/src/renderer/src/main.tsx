// First: it must run before React loads.
import "./lib/react-dev-timing-setup";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/app";
import { migrateLegacyStorageKeys } from "./lib/legacy-storage-keys";
import {
  applyAppearancePreference,
  getSystemPrefersDark,
  readStoredAppearanceTheme,
} from "./lib/theme";
import "./styles/globals.css";

try {
  migrateLegacyStorageKeys(window.localStorage);
} catch {
  // Unavailable storage only costs the old preferences.
}

applyAppearancePreference(
  readStoredAppearanceTheme() ?? "system",
  getSystemPrefersDark(),
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
