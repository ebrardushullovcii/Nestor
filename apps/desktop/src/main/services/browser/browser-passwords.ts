import { createHash, randomUUID } from "node:crypto";
import {
  app,
  safeStorage,
  type IpcMain,
  type IpcMainEvent,
  type WebContents,
  type WebFrameMain,
} from "electron";
import path from "node:path";
import {
  BrowserPasswordCaptureSchema,
  BrowserPasswordFilledSchema,
  BrowserPasswordFormsSchema,
  browserAgentPermissionsOf,
  type BrowserPasswordPrompt,
  type BrowserPasswordsList,
} from "@nestor/contracts";
import { createBrowserPasswordRepository } from "@nestor/db";
import { createPreferencesStore } from "@nestor/db/job-store";
import { getJobStore } from "../job-store";
import { resolveDesktopUserDataDirectory } from "../../setup/user-data-directory";
import { PasswordVault } from "./password-vault";
import { passwordOrigin, passwordOriginsMatch } from "./password-origin";
import { readPasswordForms } from "./password-form";

interface PasswordHost {
  pages(): readonly { id: string; contents: WebContents }[];
  changed(): void;
  chooseAccount?(tabId: string): void;
}
interface PendingPassword {
  metadata: BrowserPasswordPrompt;
  password: string;
  expires: number;
}
export class BrowserPasswords {
  private vaultInstance: PasswordVault | null = null;
  private readonly pending = new Map<string, PendingPassword>();
  private readonly fills = new Map<
    string,
    { tabId: string; frame: WebFrameMain; resolve(ok: boolean): void }
  >();
  private readonly dismissed = new Map<
    string,
    { digest: string; expires: number }
  >();
  private readonly expiryTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly host: PasswordHost,
    private readonly vaultFactory = () =>
      new PasswordVault(
        createBrowserPasswordRepository(
          path.join(
            resolveDesktopUserDataDirectory(app),
            "browser-passwords.sqlite",
          ),
        ),
        safeStorage,
      ),
    private readonly agentSignInAllowed = () =>
      browserAgentPermissionsOf(
        createPreferencesStore(getJobStore()).settings.read(),
      ).signIn,
  ) {
    this.expiryTimer = setInterval(() => {
      let changed = false;
      for (const [id, value] of this.pending)
        if (value.expires < Date.now()) {
          this.pending.delete(id);
          changed = true;
        }
      for (const [id, value] of this.dismissed)
        if (value.expires < Date.now()) this.dismissed.delete(id);
      if (changed) this.host.changed();
    }, 5000);
    this.expiryTimer.unref();
  }
  vault(): PasswordVault {
    return (this.vaultInstance ??= this.vaultFactory());
  }
  attach(ipc: IpcMain): void {
    ipc.on("browser-password:captured", (event, input: unknown) => {
      void this.capture(event, input).catch(() => undefined);
    });
    ipc.on("browser-password:filled", (event, input: unknown) => {
      const parsed = BrowserPasswordFilledSchema.safeParse(input);
      if (!parsed.success) return;
      const fill = this.fills.get(parsed.data.requestId);
      if (fill && fill.frame === event.senderFrame)
        fill.resolve(parsed.data.ok);
    });
  }
  private page(tabId: string) {
    return this.host
      .pages()
      .find((page) => page.id === tabId && !page.contents.isDestroyed());
  }
  async capture(
    event: Pick<IpcMainEvent, "sender" | "senderFrame">,
    input: unknown,
  ): Promise<void> {
    await Promise.resolve(this.captureNow(event, input));
  }
  private captureNow(
    event: Pick<IpcMainEvent, "sender" | "senderFrame">,
    input: unknown,
  ): void {
    // Do not throw a Zod error containing the rejected secret-bearing input.
    const parsed = BrowserPasswordCaptureSchema.safeParse(input);
    const frame = event.senderFrame;
    const page = this.host
      .pages()
      .find((page) => page.contents === event.sender);
    if (
      !parsed.success ||
      !frame ||
      !page ||
      !page.contents.mainFrame.framesInSubtree.includes(frame)
    )
      return;
    const value = parsed.data;
    if (
      !passwordOriginsMatch(
        page.contents.getURL(),
        frame.url,
        value.action,
        value.origin,
      ) ||
      !this.vault().available()
    )
      return;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          origin: value.origin,
          username: value.username,
          password: value.password,
        }),
      )
      .digest("hex");
    if (this.dismissed.get(page.id)?.digest === digest) return;
    const existing = this.vault()
      .list(value.origin)
      .find((row) => row.username === value.username);
    if (existing) {
      try {
        if (this.vault().read(existing.id)?.password === value.password) return;
      } catch {
        /* The person can replace an unreadable saved entry. */
      }
    }
    const old = this.pending.get(page.id);
    if (
      old &&
      old.metadata.origin === value.origin &&
      old.metadata.username === value.username &&
      old.password === value.password
    )
      return;
    this.pending.set(page.id, {
      metadata: {
        id: randomUUID(),
        tabId: page.id,
        origin: value.origin,
        username: value.username,
        update: !!existing,
      },
      password: value.password,
      expires: Date.now() + 120000,
    });
    this.host.changed();
  }
  prompt(tabId: string | null): BrowserPasswordPrompt | null {
    const pending = tabId ? this.pending.get(tabId) : null;
    if (!pending || pending.expires < Date.now()) return null;
    const page = this.page(tabId!);
    if (
      !page ||
      passwordOrigin(page.contents.getURL()) !== pending.metadata.origin
    )
      return null;
    return pending.metadata;
  }
  forget(tabId: string): void {
    this.pending.delete(tabId);
    this.dismissed.delete(tabId);
    for (const fill of this.fills.values())
      if (fill.tabId === tabId) fill.resolve(false);
  }
  navigation(tabId: string, url: string): void {
    const pending = this.pending.get(tabId);
    if (pending && pending.metadata.origin !== passwordOrigin(url))
      this.forget(tabId);
  }
  save(promptId: string): void {
    const entry = [...this.pending.entries()].find(
      ([, value]) => value.metadata.id === promptId,
    );
    if (!entry || !this.prompt(entry[0]))
      throw new Error(
        "This save offer expired. Enter the login on the site again.",
      );
    const [tabId, value] = entry;
    this.vault().save({
      origin: value.metadata.origin,
      username: value.metadata.username,
      password: value.password,
    });
    this.forget(tabId);
    this.host.changed();
  }
  dismiss(promptId: string): void {
    for (const [tabId, value] of this.pending)
      if (value.metadata.id === promptId) {
        // Suppress repeat offers for this login, without retaining the password.
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              origin: value.metadata.origin,
              username: value.metadata.username,
              password: value.password,
            }),
          )
          .digest("hex");
        this.dismissed.set(tabId, { digest, expires: Date.now() + 120000 });
        this.pending.delete(tabId);
      }
    this.host.changed();
  }
  clear(): void {
    for (const page of this.host.pages()) this.forget(page.id);
    this.pending.clear();
    this.dismissed.clear();
    this.vault().clear();
    this.host.changed();
  }
  list(tabId?: string): BrowserPasswordsList {
    const vault = this.vault();
    if (!vault.available())
      return {
        available: false,
        message:
          "Secure password storage is unavailable. Enable your operating system keychain and restart Nestor.",
        credentials: [],
      };
    const origin = tabId
      ? passwordOrigin(this.page(tabId)?.contents.getURL() ?? "")
      : undefined;
    return {
      available: true,
      message: null,
      credentials: origin === null ? [] : vault.list(origin),
    };
  }
  async autofill(
    tabId: string,
    credentialId: string,
    agent = false,
  ): Promise<boolean> {
    const page = this.page(tabId);
    const saved = this.vault()
      .list()
      .find((row) => row.id === credentialId);
    if (!page || !saved || (agent && !this.agentSignInAllowed())) return false;
    for (const frame of page.contents.mainFrame.framesInSubtree) {
      if (
        !passwordOriginsMatch(
          page.contents.getURL(),
          frame.url,
          saved.origin,
          saved.origin,
        )
      )
        continue;
      let forms: ReturnType<typeof readPasswordForms>;
      try {
        forms = BrowserPasswordFormsSchema.parse(
          await frame.executeJavaScript(`(${readPasswordForms.toString()})()`),
        );
      } catch {
        continue;
      }
      if (
        !forms.length ||
        (agent && (forms.length !== 1 || !forms[0]?.login)) ||
        forms.some(
          (form) =>
            !passwordOriginsMatch(
              page.contents.getURL(),
              frame.url,
              form.action,
              saved.origin,
            ),
        )
      )
        continue;
      // Recheck after awaiting the frame. The isolated preload checks once more
      // synchronously before writing; secret values never enter an evaluated script.
      if (
        !this.page(tabId) ||
        !passwordOriginsMatch(
          page.contents.getURL(),
          frame.url,
          saved.origin,
          saved.origin,
        ) ||
        (agent && !this.agentSignInAllowed())
      )
        return false;
      const value = this.vault().read(credentialId);
      if (!value || value.origin !== saved.origin) return false;
      const requestId = randomUUID();
      return new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          this.fills.delete(requestId);
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 2000);
        this.fills.set(requestId, { tabId, frame, resolve: finish });
        try {
          frame.send("browser-password:fill", { requestId, ...value, agent });
        } catch {
          finish(false);
        }
      });
    }
    return false;
  }
  async prepareAgentCredentials(tabId: string): Promise<boolean> {
    if (!this.agentSignInAllowed()) return false;
    try {
      const matches = this.list(tabId).credentials;
      if (matches.length > 1) {
        const page = this.page(tabId);
        if (!page) return false;
        const origin = matches[0]!.origin;
        for (const frame of page.contents.mainFrame.framesInSubtree) {
          if (
            !passwordOriginsMatch(
              page.contents.getURL(),
              frame.url,
              origin,
              origin,
            )
          )
            continue;
          const parsed = BrowserPasswordFormsSchema.safeParse(
            await frame.executeJavaScript(
              `(${readPasswordForms.toString()})()`,
            ),
          );
          if (
            parsed.success &&
            parsed.data.length === 1 &&
            parsed.data[0]?.login &&
            passwordOriginsMatch(
              page.contents.getURL(),
              frame.url,
              parsed.data[0].action,
              origin,
            )
          ) {
            this.host.chooseAccount?.(tabId);
            break;
          }
        }
        return false;
      }
      return matches.length === 1
        ? await this.autofill(tabId, matches[0]!.id, true)
        : false;
    } catch {
      return false;
    }
  }
}
