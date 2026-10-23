import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { WebContents } from "electron";
import type { WebSocket, WebSocketServer } from "ws";

/** `WebSocket.OPEN`, without loading ws before the bridge starts. */
const SOCKET_OPEN = 1;

type Params = Record<string, unknown>;
interface Request {
  id: number;
  method: string;
  params?: Params;
  sessionId?: string;
}
interface TargetInfo extends Params {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId: string;
}
export interface BrowserCdpPage {
  id: string;
  contents: WebContents;
  openerId?: string;
}
export interface BrowserCdpHost {
  pages(): readonly BrowserCdpPage[];
  createPage(url: string): Promise<BrowserCdpPage>;
  closePage(id: string): void;
  selectPage(id: string): void;
  onPageCreated(listener: (page: BrowserCdpPage) => void): () => void;
  userAgent(): string;
  emulateFocus?(pageId?: string): boolean;
  /**
   * Automation is about to send keyboard or pointer input to this page.
   * `pointerDown` is set for a pressed pointer button, which the page then
   * reports once as a mouse-down of its own. `keyDown` identifies the key
   * before the corresponding before-input-event arrives.
   */
  onAutomationInput?(
    pageId: string,
    input?: {
      pointerDown: boolean;
      keyDown?: { code: string; key: string } | null;
    },
  ): void;
  /** Keep hidden pages awake only while browser commands need them. */
  onAutomationCommand?(pageId: string, active: boolean): void | Promise<void>;
}
interface AttachedPage {
  page: BrowserCdpPage;
  info: TargetInfo;
  sessions: Set<string>;
  dispose: () => void;
}
interface SessionBinding {
  target: AttachedPage;
  nativeSessionId?: string;
  parentSessionId?: string;
  nativeTargetId?: string;
}

function record(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A single-client, authenticated CDP endpoint for app-owned browser pages only.
 * Electron's app-wide remote-debugging port is never enabled. Browser/Target
 * commands are implemented here; page commands use that page's Debugger API.
 * The app renderer is not a target and cannot be attached by guessing an id.
 */
export class BrowserCdpBridge {
  private readonly token = randomBytes(32).toString("hex");
  private readonly contextId = randomUUID();
  private readonly targets = new Map<string, AttachedPage>();
  private readonly sessions = new Map<string, SessionBinding>();
  private server: Server | null = null;
  private socketServer: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private autoAttach = false;
  private discover = false;
  private disposed = false;
  private removeCreatedListener: (() => void) | null = null;
  private readonly pendingAttachments = new Set<Promise<void>>();
  private readonly tokenWaiters = new Map<string, (tabId: string | null) => void>();

  constructor(private readonly host: BrowserCdpHost) {}

  /**
   * Resolves with the tab that the next page command carrying `token` is sent
   * to, or null after `timeoutMs`. A run evaluates the token in its own page;
   * the command passes through here on the way to exactly one tab, so this is
   * how the host learns which tab a run is working in without comparing URLs.
   */
  waitForToken(token: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.tokenWaiters.delete(token);
        resolve(null);
      }, timeoutMs);
      this.tokenWaiters.set(token, (tabId) => {
        clearTimeout(timer);
        this.tokenWaiters.delete(token);
        resolve(tabId);
      });
    });
  }

  /**
   * Takes one tab away from the automation client without closing it: the
   * client is told the page is gone, and the tab stays open for the person.
   * Used when the person steps into a tab, or a tab is parked for them.
   */
  releasePage(id: string): void {
    const target = this.targets.get(id);
    if (!target) return;
    for (const sessionId of target.sessions) {
      const binding = this.sessions.get(sessionId);
      this.emit(
        "Target.detachedFromTarget",
        {
          sessionId,
          targetId: binding?.nativeTargetId ?? target.info.targetId,
        },
        binding?.parentSessionId,
      );
      this.sessions.delete(sessionId);
    }
    target.sessions.clear();
    this.targets.delete(id);
    this.emit("Target.targetDestroyed", { targetId: target.info.targetId });
    target.dispose();
  }

  /** Hands a released tab back to the automation client. */
  reclaimPage(page: BrowserCdpPage): Promise<void> {
    if (this.disposed || this.targets.has(page.id)) return Promise.resolve();
    return this.attachPage(page).catch(() => undefined);
  }

  async start(): Promise<{
    endpoint: string;
    headers: Record<string, string>;
  }> {
    // Before the guard: the guard and the claim below must run in one turn.
    const { WebSocketServer } = await import("ws");
    if (this.server || this.disposed)
      throw new Error("Browser connection is not available.");
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const socketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024 * 1024,
    });
    this.server = server;
    this.socketServer = socketServer;
    server.on("upgrade", (request, socket, head) => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.token}`);
      const authorized =
        supplied.length === expected.length &&
        timingSafeEqual(supplied, expected);
      if (
        !authorized ||
        request.url !== "/browser" ||
        request.headers.origin ||
        this.socket
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      socketServer.handleUpgrade(request, socket, head, (connected) => {
        this.socket = connected;
        connected.on("message", (data, isBinary) => {
          if (isBinary) {
            connected.close(1003);
            return;
          }
          let parsed: unknown;
          try {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
            parsed = JSON.parse(buffer.toString("utf8"));
          } catch {
            connected.close(1003);
            return;
          }
          if (
            !record(parsed) ||
            !Number.isInteger(parsed.id) ||
            typeof parsed.method !== "string" ||
            (parsed.params !== undefined && !record(parsed.params)) ||
            (parsed.sessionId !== undefined &&
              typeof parsed.sessionId !== "string")
          ) {
            connected.close(1003);
            return;
          }
          const request = parsed as unknown as Request;
          void this.dispatch(request).then(
            (result) =>
              this.send({
                id: request.id,
                result,
                ...(request.sessionId ? { sessionId: request.sessionId } : {}),
              }),
            (error) =>
              this.send({
                id: request.id,
                error: {
                  code: -32000,
                  // Protocol errors are private to the runtime, never a renderer event.
                  message:
                    error instanceof Error
                      ? error.message
                      : "Browser operation failed.",
                },
                ...(request.sessionId ? { sessionId: request.sessionId } : {}),
              }),
          );
        });
        connected.on("error", () => connected.terminate());
        connected.on("close", () => this.detachAll());
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.removeCreatedListener = this.host.onPageCreated((page) => {
      const pending = this.attachPage(page).finally(() =>
        this.pendingAttachments.delete(pending),
      );
      this.pendingAttachments.add(pending);
      void pending.catch(() => undefined); // A page closed during attachment has no live target.
    });
    await Promise.all(this.host.pages().map((page) => this.attachPage(page)));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Browser transport did not start.");
    return {
      endpoint: `ws://127.0.0.1:${address.port}/browser`,
      headers: { Authorization: `Bearer ${this.token}` },
    };
  }

  private send(message: Params): void {
    if (this.socket?.readyState === SOCKET_OPEN)
      this.socket.send(JSON.stringify(message));
  }
  private emit(method: string, params: Params, sessionId?: string): void {
    this.send({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private async attachPage(page: BrowserCdpPage): Promise<void> {
    if (
      this.disposed ||
      page.contents.isDestroyed() ||
      this.targets.has(page.id)
    )
      return;
    const debuggerApi = page.contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: this.host.emulateFocus?.(page.id) ?? false,
    });
    const native: unknown = await debuggerApi.sendCommand(
      "Target.getTargetInfo",
    );
    if (this.disposed || page.contents.isDestroyed()) return;
    // A tab the host keeps away from automation (the person's own tab) is
    // never announced, even if it was created while a connection was open.
    if (!this.host.pages().some((candidate) => candidate.id === page.id))
      return;
    if (!record(native) || !record(native.targetInfo))
      throw new Error("Browser target identity is unavailable.");
    const targetId = string(native.targetInfo.targetId);
    const info: TargetInfo = {
      targetId,
      type: "page",
      title: page.contents.getTitle(),
      url: page.contents.getURL(),
      attached: true,
      browserContextId: this.contextId,
    };
    if (page.openerId) {
      const opener = this.targets.get(page.openerId);
      if (opener) info.openerId = opener.info.targetId;
    }
    const target: AttachedPage = {
      page,
      info,
      sessions: new Set(),
      dispose: () => undefined,
    };
    this.targets.set(page.id, target);
    const onMessage = (
      _event: Electron.Event,
      method: string,
      raw: unknown,
      nativeSessionId?: string,
    ) => {
      if (!record(raw)) return;
      // Never expose global discovery from the page's debugger connection.
      if (
        [
          "Target.targetCreated",
          "Target.targetInfoChanged",
          "Target.targetDestroyed",
        ].includes(method)
      )
        return;
      for (const logicalId of [...target.sessions]) {
        const binding = this.sessions.get(logicalId);
        if (
          !binding ||
          binding.nativeSessionId !== (nativeSessionId || undefined)
        )
          continue;
        const params = { ...raw };
        if (method === "Target.attachedToTarget" && record(params.targetInfo)) {
          // Auto-attach is restricted to descendants, never top-level windows.
          if (
            params.targetInfo.type === "page" ||
            params.targetInfo.type === "browser"
          ) {
            void debuggerApi
              .sendCommand(
                "Runtime.runIfWaitingForDebugger",
                {},
                string(params.sessionId),
              )
              .catch(() => undefined);
            continue;
          }
          const childId = `${logicalId}:${string(params.sessionId)}`;
          this.sessions.set(childId, {
            target,
            nativeSessionId: string(params.sessionId),
            parentSessionId: logicalId,
            nativeTargetId: string(params.targetInfo.targetId),
          });
          target.sessions.add(childId);
          params.sessionId = childId;
          params.targetInfo = {
            ...params.targetInfo,
            browserContextId: this.contextId,
          };
        }
        if (method === "Target.detachedFromTarget") {
          const childId = `${logicalId}:${string(params.sessionId)}`;
          this.sessions.delete(childId);
          target.sessions.delete(childId);
          params.sessionId = childId;
        }
        this.emit(method, params, logicalId);
      }
    };
    const onChange = () => {
      if (page.contents.isDestroyed()) return;
      info.url = page.contents.getURL();
      info.title = page.contents.getTitle();
      if (this.discover)
        this.emit("Target.targetInfoChanged", { targetInfo: info });
    };
    const onClose = () => {
      for (const sessionId of target.sessions) {
        const binding = this.sessions.get(sessionId);
        this.emit(
          "Target.detachedFromTarget",
          { sessionId, targetId: binding?.nativeTargetId ?? targetId },
          binding?.parentSessionId,
        );
        this.sessions.delete(sessionId);
      }
      target.sessions.clear();
      this.targets.delete(page.id);
      this.emit("Target.targetDestroyed", { targetId });
      target.dispose();
    };
    debuggerApi.on("message", onMessage);
    page.contents.on("did-navigate", onChange);
    page.contents.on("did-navigate-in-page", onChange);
    page.contents.on("page-title-updated", onChange);
    page.contents.once("destroyed", onClose);
    target.dispose = () => {
      debuggerApi.removeListener("message", onMessage);
      if (!page.contents.isDestroyed()) {
        page.contents.removeListener("did-navigate", onChange);
        page.contents.removeListener("did-navigate-in-page", onChange);
        page.contents.removeListener("page-title-updated", onChange);
        page.contents.removeListener("destroyed", onClose);
        if (debuggerApi.isAttached()) debuggerApi.detach();
      }
    };
    if (this.discover) this.emit("Target.targetCreated", { targetInfo: info });
    if (this.autoAttach) this.attachLogicalSession(target);
  }

  private attachLogicalSession(target: AttachedPage): string {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { target });
    target.sessions.add(sessionId);
    this.emit("Target.attachedToTarget", {
      sessionId,
      targetInfo: target.info,
      waitingForDebugger: false,
    });
    return sessionId;
  }

  private findTarget(targetId: unknown): AttachedPage {
    const target = [...this.targets.values()].find(
      (item) => item.info.targetId === targetId,
    );
    if (!target || target.page.contents.isDestroyed())
      throw new Error("Browser target is not owned by this connection.");
    return target;
  }

  private async dispatch(request: Request): Promise<Params> {
    if (this.disposed) throw new Error("Browser connection closed.");
    const p = request.params ?? {};
    const binding = request.sessionId
      ? this.sessions.get(request.sessionId)
      : undefined;
    if (request.sessionId && !binding)
      throw new Error("Browser session is no longer available.");
    if (request.method === "Browser.getVersion")
      return {
        protocolVersion: "1.3",
        product: `Chrome/${process.versions.chrome}`,
        revision: "",
        userAgent: this.host.userAgent(),
        jsVersion: process.versions.v8,
      };
    if (request.method === "Target.getBrowserContexts")
      return { browserContextIds: [] };
    if (request.method === "Target.getTargets")
      return { targetInfos: [...this.targets.values()].map((t) => t.info) };
    if (request.method === "Target.getTargetInfo")
      return {
        targetInfo: p.targetId
          ? this.findTarget(p.targetId).info
          : (binding?.target.info ?? {
              targetId: "embedded-browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
            }),
      };
    if (request.method === "Target.setDiscoverTargets") {
      this.discover = p.discover === true;
      if (this.discover)
        for (const target of this.targets.values())
          this.emit("Target.targetCreated", { targetInfo: target.info });
      return {};
    }
    if (request.method === "Target.setAutoAttach") {
      if (binding) {
        return this.forward(binding, request.method, {
          ...p,
          // Top-level popups are created by the host and attached after creation.
          // Pausing those synchronously inside Electron's createWindow deadlocks.
          filter: [
            { type: "page", exclude: true },
            { type: "browser", exclude: true },
            {},
          ],
        });
      }
      this.autoAttach = p.autoAttach === true;
      if (this.autoAttach)
        for (const target of this.targets.values()) {
          if (target.sessions.size === 0) this.attachLogicalSession(target);
        }
      return {};
    }
    if (request.method === "Target.attachToTarget")
      return {
        sessionId: this.attachLogicalSession(this.findTarget(p.targetId)),
      };
    if (request.method === "Target.detachFromTarget") {
      const id = string(p.sessionId);
      const attached = this.sessions.get(id);
      if (attached?.nativeSessionId) {
        const parent = attached.parentSessionId
          ? this.sessions.get(attached.parentSessionId)
          : undefined;
        if (!parent)
          throw new Error("The parent browser session is no longer available.");
        // Descendant detach belongs to its parent session. Emitting it at the
        // root with the page's target id makes Playwright close the whole page.
        return this.forward(parent, request.method, {
          sessionId: attached.nativeSessionId,
        });
      }
      if (attached) {
        this.sessions.delete(id);
        attached.target.sessions.delete(id);
        this.emit("Target.detachedFromTarget", {
          sessionId: id,
          targetId: attached.target.info.targetId,
        });
      }
      return {};
    }
    if (request.method === "Target.createTarget") {
      if (p.browserContextId && p.browserContextId !== this.contextId)
        throw new Error("Unknown browser context.");
      const page = await this.host.createPage(string(p.url) || "about:blank");
      await Promise.all([...this.pendingAttachments]);
      const target = this.targets.get(page.id);
      if (!target)
        throw new Error("The new browser page closed before it was ready.");
      return { targetId: target.info.targetId };
    }
    if (request.method === "Target.closeTarget") {
      this.host.closePage(this.findTarget(p.targetId).page.id);
      return { success: true };
    }
    if (request.method === "Target.activateTarget") {
      this.host.selectPage(this.findTarget(p.targetId).page.id);
      return {};
    }
    if (request.method.startsWith("Target."))
      throw new Error(`Unsupported scoped browser command: ${request.method}`);
    if (request.method === "Browser.getWindowForTarget") {
      if (p.targetId) this.findTarget(p.targetId);
      return {
        windowId: 1,
        bounds: {
          left: 0,
          top: 0,
          width: 1100,
          height: 720,
          windowState: "normal",
        },
      };
    }
    if (
      request.method === "Browser.setWindowBounds" ||
      request.method === "Browser.setDownloadBehavior"
    )
      return {};
    if (
      request.method === "Storage.getCookies" ||
      request.method === "Storage.setCookies"
    ) {
      if (
        p.browserContextId !== undefined &&
        p.browserContextId !== this.contextId
      )
        throw new Error("Unknown browser context.");
      const target = [...this.targets.values()].find(
        (candidate) => !candidate.page.contents.isDestroyed(),
      );
      if (!target)
        throw new Error("A browser page is required for session cookies.");
      // Playwright's APIRequestContext syncs cookies using browser-level Storage
      // commands. Native Storage defaults to Electron's app session, so use an
      // owned page's Network domain to keep reads and writes in its partition.
      return this.forward(
        { target },
        request.method === "Storage.getCookies"
          ? "Network.getAllCookies"
          : "Network.setCookies",
        request.method === "Storage.getCookies" ? {} : { cookies: p.cookies },
      );
    }
    // Other profile storage and browser-wide commands remain unavailable.
    if (
      request.method.startsWith("Browser.") ||
      request.method.startsWith("Storage.")
    ) {
      throw new Error(`Unsupported scoped browser command: ${request.method}`);
    }
    if (!binding) throw new Error("A browser page session is required.");
    if (
      request.method === "Page.captureScreenshot" &&
      !binding.nativeSessionId
    ) {
      return this.captureScreenshot(binding, p);
    }
    if (request.method === "Page.bringToFront") {
      this.host.selectPage(binding.target.page.id);
      return {};
    }
    if (request.method === "Page.close") {
      this.host.closePage(binding.target.page.id);
      return {};
    }
    // Native geometry stays host-owned. Focus emulation is decided by the
    // host (see syncFocusEmulation), never by the automation client.
    if (request.method === "Emulation.setFocusEmulationEnabled") {
      return this.forward(binding, request.method, {
        enabled: this.host.emulateFocus?.(binding.target.page.id) ?? false,
      });
    }
    if (
      [
        "Emulation.setDeviceMetricsOverride",
        "Emulation.clearDeviceMetricsOverride",
      ].includes(request.method)
    )
      return {};
    return this.forward(binding, request.method, p);
  }

  private async forward(
    binding: SessionBinding,
    method: string,
    params: Params,
  ): Promise<Params> {
    // The page reports automation input as input too; the host must be
    // able to tell it from the person's own clicks and keys.
    if (method.startsWith("Input."))
      this.host.onAutomationInput?.(binding.target.page.id, {
        pointerDown:
          method === "Input.dispatchMouseEvent" &&
          params.type === "mousePressed",
        keyDown:
          method === "Input.dispatchKeyEvent" &&
          (params.type === "keyDown" || params.type === "rawKeyDown")
            ? { code: string(params.code), key: string(params.key) }
            : null,
      });
    if (this.tokenWaiters.size > 0) {
      const text = JSON.stringify(params);
      for (const [token, resolve] of [...this.tokenWaiters]) {
        if (text.includes(token)) resolve(binding.target.page.id);
      }
    }
    const pageId = binding.target.page.id;
    try {
      await this.host.onAutomationCommand?.(pageId, true);
      const result: unknown =
        await binding.target.page.contents.debugger.sendCommand(
          method,
          params,
          binding.nativeSessionId,
        );
      return record(result) ? result : {};
    } finally {
      await this.host.onAutomationCommand?.(pageId, false);
    }
  }

  /**
   * Re-apply the host's focus-emulation decision to every attached page.
   * Emulated focus lets pages fire focus events and report document.hasFocus()
   * while automation drives a tab the user is not looking at.
   */
  async syncFocusEmulation(): Promise<void> {
    await Promise.all(
      [...this.targets.values()]
        .filter((target) => !target.page.contents.isDestroyed())
        .map((target) =>
          target.page.contents.debugger
            .sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: this.host.emulateFocus?.(target.page.id) ?? false,
            })
            .catch(() => undefined),
        ),
    );
  }

  private async captureScreenshot(
    binding: SessionBinding,
    params: Params,
  ): Promise<Params> {
    const metrics = await this.forward(binding, "Page.getLayoutMetrics", {});
    const viewport = record(metrics.cssLayoutViewport)
      ? metrics.cssLayoutViewport
      : metrics.layoutViewport;
    if (!record(viewport))
      throw new Error("The browser viewport is unavailable.");
    const width = Number(viewport.clientWidth);
    const height = Number(viewport.clientHeight);
    const clip = record(params.clip)
      ? params.clip
      : { x: viewport.pageX, y: viewport.pageY, width, height, scale: 1 };
    const x = Number(clip.x) - Number(viewport.pageX ?? 0);
    const y = Number(clip.y) - Number(viewport.pageY ?? 0);
    const captureWidth = Number(clip.width);
    const captureHeight = Number(clip.height);
    if (
      ![x, y, captureWidth, captureHeight].every(Number.isFinite) ||
      captureWidth <= 0 ||
      captureHeight <= 0
    ) {
      throw new Error("The screenshot bounds are invalid.");
    }
    // Full-document captures remain Chromium-owned. Agent snapshots use the
    // viewport; Electron explicitly wakes its compositor without showing it.
    if (
      x < 0 ||
      y < 0 ||
      x + captureWidth > width + 1 ||
      y + captureHeight > height + 1
    ) {
      return this.forward(binding, "Page.captureScreenshot", params);
    }
    const contents = binding.target.page.contents;
    const throttled = contents.getBackgroundThrottling();
    contents.setBackgroundThrottling(false);
    let snapshot;
    try {
      // A previously idle hidden view needs a compositor frame before capture.
      if (throttled)
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      snapshot = await contents.capturePage(
        {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(captureWidth),
          height: Math.round(captureHeight),
        },
        { stayHidden: true, stayAwake: true },
      );
    } finally {
      if (!contents.isDestroyed() && throttled)
        contents.setBackgroundThrottling(true);
    }
    if (snapshot.isEmpty())
      throw new Error("The browser page did not produce an image.");
    const scale =
      typeof clip.scale === "number" && clip.scale > 0 ? clip.scale : 1;
    const output =
      scale === 1
        ? snapshot
        : snapshot.resize({
            width: Math.round(snapshot.getSize().width * scale),
            height: Math.round(snapshot.getSize().height * scale),
          });
    const bytes =
      params.format === "jpeg"
        ? output.toJPEG(
            typeof params.quality === "number" ? params.quality : 80,
          )
        : output.toPNG();
    return { data: bytes.toString("base64") };
  }

  private detachAll(): void {
    for (const target of this.targets.values()) target.dispose();
    this.targets.clear();
    this.sessions.clear();
    this.autoAttach = false;
    this.discover = false;
  }
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of [...this.tokenWaiters.values()]) resolve(null);
    this.tokenWaiters.clear();
    this.removeCreatedListener?.();
    this.removeCreatedListener = null;
    this.socket?.terminate();
    this.socket = null;
    this.detachAll();
    this.socketServer?.close();
    this.socketServer = null;
    this.server?.close();
    this.server = null;
  }
}
