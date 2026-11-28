import {
  BrowserWindow,
  dialog,
  type IpcMain,
  type IpcMainInvokeEvent,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { traceEvent } from "@nestor/core/run-trace";
import {
  BrowserPasswordsListInputSchema,
  BrowserPasswordsListSchema,
  BrowserPasswordPromptInputSchema,
  BrowserPasswordDeleteInputSchema,
  BrowserPasswordAutofillInputSchema,
  BrowserPasswordImportResultSchema,
  DesktopBrowserImportInputSchema,
} from "@nestor/contracts";
import type { EmbeddedBrowser } from "../services/browser/embedded-browser";
import {
  importPasswordCsv,
  savePasswordValues,
} from "../services/browser/password-csv";

export function registerBrowserPasswordRoutes(
  ipc: IpcMain,
  owner: (event: IpcMainInvokeEvent) => Promise<EmbeddedBrowser>,
): void {
  ipc.handle("browser-passwords:list", async (event, input: unknown) => {
    const host = await owner(event);
    return BrowserPasswordsListSchema.parse(
      host.passwords().list(BrowserPasswordsListInputSchema.parse(input).tabId),
    );
  });
  ipc.handle("browser-passwords:save", async (event, input: unknown) => {
    const host = await owner(event);
    host
      .passwords()
      .save(BrowserPasswordPromptInputSchema.parse(input).promptId);
  });
  ipc.handle("browser-passwords:dismiss", async (event, input: unknown) => {
    const host = await owner(event);
    host
      .passwords()
      .dismiss(BrowserPasswordPromptInputSchema.parse(input).promptId);
  });
  ipc.handle("browser-passwords:delete", async (event, input: unknown) => {
    const host = await owner(event);
    host
      .passwords()
      .vault()
      .delete(BrowserPasswordDeleteInputSchema.parse(input).credentialId);
  });
  ipc.handle("browser-passwords:autofill", async (event, input: unknown) => {
    const host = await owner(event);
    const { tabId, credentialId } =
      BrowserPasswordAutofillInputSchema.parse(input);
    if (!(await host.passwords().autofill(tabId, credentialId)))
      throw new Error(
        "Open a matching login form on this site, then try again.",
      );
  });
  const failure = (
    status: "failed" | "cancelled" | "unsupported",
    message: string,
  ) =>
    BrowserPasswordImportResultSchema.parse({
      status,
      added: 0,
      updated: 0,
      skipped: 0,
      message,
    });
  ipc.handle("browser-passwords:import-csv", async (event) => {
    const host = await owner(event);
    try {
      const vault = host.passwords().vault();
      if (!vault.available())
        return failure(
          "unsupported",
          "Enable your operating system keychain and restart Nestor before importing passwords.",
        );
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return failure("failed", "The app window is unavailable.");
      const picked = await dialog.showOpenDialog(window, {
        title: "Import exported passwords",
        properties: ["openFile"],
        filters: [{ name: "Password CSV", extensions: ["csv"] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file)
        return failure("cancelled", "Password import cancelled.");
      if ((await stat(file)).size > 10 * 1024 * 1024)
        return failure("failed", "Password CSV is too large (maximum 10 MB).");
      return BrowserPasswordImportResultSchema.parse(
        importPasswordCsv(vault, await readFile(file, "utf8")),
      );
    } catch {
      // Native/file/parser/crypto errors can contain secret material or paths.
      return failure(
        "failed",
        "Could not import this password CSV. Export passwords from Chrome, Edge or Firefox and choose that CSV file.",
      );
    }
  });
  ipc.handle(
    "browser-passwords:import-browser",
    async (event, input: unknown) => {
      const host = await owner(event);
      const { sourceId } = DesktopBrowserImportInputSchema.parse(input);
      try {
        const vault = host.passwords().vault();
        if (!vault.available())
          return failure(
            "unsupported",
            "Enable your operating system keychain and restart Nestor before importing passwords.",
          );
        const { readBrowserPasswords } =
          await import("../services/browser/browser-profile-import");
        const result = await readBrowserPasswords(sourceId);
        try {
          const counts = {
            ...savePasswordValues(vault, result.values),
            ...result.counts,
          };
          const {
            added,
            updated,
            alreadySaved,
            locked,
            unsupportedEncryption,
            unreadable,
            invalid,
            couldNotSave,
          } = counts;
          const imported = added + updated + alreadySaved > 0;
          const status = imported
            ? "imported"
            : result.unsupported ||
                locked ||
                unsupportedEncryption ||
                unreadable
              ? "unsupported"
              : "failed";
          const receipt = BrowserPasswordImportResultSchema.parse({
            status,
            added,
            updated,
            skipped:
              alreadySaved +
              locked +
              unsupportedEncryption +
              unreadable +
              invalid +
              couldNotSave,
            counts,
            message: imported
              ? "Passwords do not bring over signed-in sessions. Sign in to the site in Nestor when needed."
              : "No logins were imported from this browser profile.",
          });
          traceEvent("browser_password_import_result", counts);
          return receipt;
        } finally {
          // JS strings cannot be zeroed; release references immediately after saving.
          for (const value of result.values) value.password = "";
          result.values.length = 0;
        }
      } catch {
        return failure(
          "failed",
          "Passwords could not be read from this browser. Close the browser and try importing again.",
        );
      }
    },
  );
}
