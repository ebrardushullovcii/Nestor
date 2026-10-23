import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { WebSocket } from "ws";
import { afterEach, describe, expect, test } from "vitest";
import {
  BrowserCdpBridge,
  type BrowserCdpPage,
  type BrowserCdpHost,
} from "./browser-cdp-bridge";

type Message = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
};
const resources: Array<() => void> = [];
test("a stopped run does not wait for the page-claim timeout", async () => {
  const { bridge } = await fixture();
  const controller = new AbortController();
  const pending = bridge.waitForToken(
    "stopped-claim",
    60_000,
    controller.signal,
  );
  controller.abort();
  await expect(pending).resolves.toBeNull();
});
test("a routed request resumes without waiting on renderer focus", async () => {
  const { bridge, transport, calls } = await fixture({
    onAutomationCommand: () => {
      throw new Error("Renderer is waiting for the paused request");
    },
  });
  const client = await connect(transport);
  await client.send("Target.setAutoAttach", { autoAttach: true });
  const session = String(
    client.messages.find(
      (message) => message.method === "Target.attachedToTarget",
    )?.params?.sessionId,
  );
  for (const method of [
    "Fetch.continueRequest",
    "Fetch.fulfillRequest",
    "Fetch.failRequest",
    "Network.setCacheDisabled",
    "Fetch.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.handleJavaScriptDialog",
    "Runtime.runIfWaitingForDebugger",
  ]) {
    const reply = await client.send(method, {}, session);
    expect(reply.error).toBeUndefined();
    expect(calls.some((call) => call.method === method)).toBe(true);
  }
  bridge.close();
});
test("closing the bridge releases pending page claims immediately", async () => {
  const { bridge } = await fixture();
  const pending = bridge.waitForToken("synthetic-claim", 60_000);
  bridge.close();
  await expect(pending).resolves.toBeNull();
});
afterEach(() => {
  for (const dispose of resources.splice(0).reverse()) dispose();
});

async function fixture(
  hostOverrides: Pick<BrowserCdpHost, "onAutomationCommand"> = {},
) {
  const debuggerEvents = new EventEmitter();
  const calls: Array<{
    method: string;
    params: unknown;
    sessionId: string | undefined;
  }> = [];
  let attached = false;
  const debuggerApi = Object.assign(debuggerEvents, {
    isAttached: () => attached,
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
    sendCommand: (method: string, params: unknown, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargetInfo")
        return Promise.resolve({ targetInfo: { targetId: "owned-page" } });
      if (method === "Network.getAllCookies")
        return Promise.resolve({ cookies: [] });
      if (method === "Target.detachFromTarget")
        debuggerEvents.emit("message", {}, "Target.detachedFromTarget", {
          sessionId: "native-worker",
          targetId: "worker-target",
        });
      return Promise.resolve({});
    },
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getTitle: () => "Synthetic page",
    getURL: () => "https://example.test/",
  }) as unknown as WebContents;
  const page: BrowserCdpPage = { id: "owned-tab", contents };
  const closed: string[] = [];
  const automationInput: string[] = [];
  const pointerDowns: boolean[] = [];
  const keyDowns: Array<{ code: string; key: string } | null> = [];
  const bridge = new BrowserCdpBridge({
    pages: () => [page],
    createPage: () => Promise.reject(new Error("Not used")),
    closePage: (id) => {
      closed.push(id);
    },
    selectPage: () => undefined,
    onPageCreated: () => () => undefined,
    userAgent: () => "Synthetic browser",
    onAutomationInput: (id, input) => {
      automationInput.push(id);
      pointerDowns.push(input?.pointerDown ?? false);
      keyDowns.push(input?.keyDown ?? null);
    },
    ...hostOverrides,
  });
  const transport = await bridge.start();
  resources.push(() => bridge.close());
  return {
    bridge,
    transport,
    calls,
    debuggerEvents,
    page,
    closed,
    automationInput,
    pointerDowns,
    keyDowns,
  };
}

async function connect(transport: {
  endpoint: string;
  headers: Record<string, string>;
}) {
  const socket = new WebSocket(transport.endpoint, {
    headers: transport.headers,
  });
  resources.push(() => socket.terminate());
  const messages: Message[] = [];
  const pending = new Map<number, (value: Message) => void>();
  socket.on("message", (data) => {
    const message = JSON.parse(
      Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data as ArrayBuffer).toString("utf8"),
    ) as Message;
    messages.push(message);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) =>
    new Promise<Message>((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  return { socket, messages, send };
}

describe("scoped embedded browser transport", () => {
  test("rejects unauthenticated and browser-origin clients", async () => {
    const { transport } = await fixture();
    for (const headers of [
      {},
      { ...transport.headers, Origin: "https://example.test" },
    ]) {
      const socket = new WebSocket(transport.endpoint, { headers });
      resources.push(() => socket.terminate());
      const message = await new Promise<string>((resolve) =>
        socket.once("error", (error) => resolve(error.message)),
      );
      expect(message).toContain("403");
    }
    const client = await connect(transport);
    expect(
      (await client.send("Target.getTargets")).result?.targetInfos,
    ).toEqual([expect.objectContaining({ targetId: "owned-page" })]);
  });

  test("refuses unknown targets, root page commands, and other profile storage", async () => {
    const { transport, calls } = await fixture();
    const client = await connect(transport);
    expect(
      (await client.send("Target.attachToTarget", { targetId: "app-renderer" }))
        .error?.message,
    ).toContain("not owned");
    expect(
      (await client.send("Runtime.evaluate", { expression: "process.env" }))
        .error?.message,
    ).toContain("page session is required");
    expect(
      (await client.send("Storage.clearCookies")).error?.message,
    ).toContain("Unsupported scoped");
    expect(
      calls.some(
        (call) =>
          call.method === "Runtime.evaluate" ||
          call.method === "Storage.clearCookies",
      ),
    ).toBe(false);
  });

  test("maps Playwright cookie synchronization to an owned page's partition", async () => {
    const { transport, calls } = await fixture();
    const client = await connect(transport);
    const targets = (await client.send("Target.getTargets")).result
      ?.targetInfos as Array<{ browserContextId: string }>;
    const browserContextId = targets[0]!.browserContextId;
    const cookies = [
      { name: "synthetic", value: "fixture", url: "https://example.test/" },
    ];
    for (const scope of [{}, { browserContextId }]) {
      expect((await client.send("Storage.getCookies", scope)).result).toEqual({
        cookies: [],
      });
      expect(
        (await client.send("Storage.setCookies", { ...scope, cookies })).error,
      ).toBeUndefined();
    }
    expect(
      calls.filter((call) => call.method === "Network.getAllCookies"),
    ).toEqual([
      { method: "Network.getAllCookies", params: {}, sessionId: undefined },
      { method: "Network.getAllCookies", params: {}, sessionId: undefined },
    ]);
    expect(
      calls.filter((call) => call.method === "Network.setCookies"),
    ).toEqual([
      {
        method: "Network.setCookies",
        params: { cookies },
        sessionId: undefined,
      },
      {
        method: "Network.setCookies",
        params: { cookies },
        sessionId: undefined,
      },
    ]);
    expect(calls.some((call) => call.method.startsWith("Storage."))).toBe(
      false,
    );
  });

  test("refuses cookie access to unknown contexts or without an owned live page", async () => {
    const { bridge, transport, calls } = await fixture();
    const client = await connect(transport);
    for (const method of ["Storage.getCookies", "Storage.setCookies"]) {
      expect(
        (
          await client.send(method, {
            browserContextId: "app-renderer",
            cookies: [],
          })
        ).error?.message,
      ).toContain("Unknown browser context");
      bridge.releasePage("owned-tab");
      expect(
        (await client.send(method, { cookies: [] })).error?.message,
      ).toContain("browser page is required");
    }
    expect(calls.some((call) => call.method.startsWith("Network."))).toBe(
      false,
    );
  });

  test("detaches a service worker through its parent without closing the page", async () => {
    const { transport, debuggerEvents, calls } = await fixture();
    const client = await connect(transport);
    await client.send("Target.setAutoAttach", { autoAttach: true });
    const parent = String(
      client.messages.find(
        (message) => message.method === "Target.attachedToTarget",
      )?.params?.sessionId,
    );
    debuggerEvents.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "native-worker",
      targetInfo: {
        targetId: "worker-target",
        type: "service_worker",
        url: "https://example.test/sw.js",
      },
      waitingForDebugger: true,
    });
    // A request/response round trip drains the preceding event on the same socket.
    await client.send("Browser.getVersion");
    const childEvent = client.messages.find(
      (message) =>
        message.method === "Target.attachedToTarget" &&
        message.sessionId === parent,
    );
    const child = String(childEvent?.params?.sessionId);
    expect(child).not.toBe("undefined");
    await client.send("Target.detachFromTarget", { sessionId: child }, parent);
    expect(calls).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "native-worker" },
      sessionId: undefined,
    });
    const detached = client.messages.filter(
      (message) => message.method === "Target.detachedFromTarget",
    );
    expect(detached).toHaveLength(1);
    expect(detached[0]?.sessionId).toBe(parent);
    expect(detached[0]?.params).toMatchObject({
      sessionId: child,
      targetId: "worker-target",
    });
    expect(
      (await client.send("Runtime.enable", {}, parent)).error,
    ).toBeUndefined();
  });

  test("learns which tab a run works in from a token its page command carries", async () => {
    const { bridge, transport } = await fixture();
    const client = await connect(transport);
    await client.send("Target.setAutoAttach", { autoAttach: true });
    const session = String(
      client.messages.find(
        (message) => message.method === "Target.attachedToTarget",
      )?.params?.sessionId,
    );
    const found = bridge.waitForToken("claim-token-1", 1_000);
    await client.send(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: "(v) => v",
        arguments: [{ value: "claim-token-1" }],
      },
      session,
    );
    await expect(found).resolves.toBe("owned-tab");
    await expect(bridge.waitForToken("never-sent", 20)).resolves.toBeNull();
  });

  test("a released tab leaves automation without closing, and comes back when reclaimed", async () => {
    const { bridge, transport, page, closed } = await fixture();
    const client = await connect(transport);
    await client.send("Target.setAutoAttach", { autoAttach: true });
    const session = String(
      client.messages.find(
        (message) => message.method === "Target.attachedToTarget",
      )?.params?.sessionId,
    );
    bridge.releasePage("owned-tab");
    await client.send("Browser.getVersion");
    // The client is told the page went away; the tab itself was not closed.
    expect(
      client.messages.some(
        (message) =>
          message.method === "Target.detachedFromTarget" &&
          message.params?.sessionId === session,
      ),
    ).toBe(true);
    expect(closed).toEqual([]);
    expect(
      (await client.send("Target.getTargets")).result?.targetInfos,
    ).toEqual([]);
    // Its old session and a close aimed at it both fail; nothing is closed.
    expect(
      (await client.send("Runtime.enable", {}, session)).error?.message,
    ).toContain("no longer available");
    expect(
      (await client.send("Target.closeTarget", { targetId: "owned-page" }))
        .error?.message,
    ).toContain("not owned");
    expect(closed).toEqual([]);

    await bridge.reclaimPage(page);
    await client.send("Browser.getVersion");
    const reattached = client.messages.filter(
      (message) => message.method === "Target.attachedToTarget",
    );
    expect(reattached).toHaveLength(2);
    expect(
      (await client.send("Target.getTargets")).result?.targetInfos,
    ).toEqual([expect.objectContaining({ targetId: "owned-page" })]);
  });

  test("tells the host when automation sends input to a tab, so it is not mistaken for the person", async () => {
    const { transport, automationInput, pointerDowns, keyDowns } =
      await fixture();
    const client = await connect(transport);
    await client.send("Target.setAutoAttach", { autoAttach: true });
    const session = String(
      client.messages.find(
        (message) => message.method === "Target.attachedToTarget",
      )?.params?.sessionId,
    );
    await client.send("Runtime.enable", {}, session);
    expect(automationInput).toEqual([]);
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 1, y: 1 },
      session,
    );
    expect(automationInput).toEqual(["owned-tab"]);
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 1, y: 1 },
      session,
    );
    // Only the press is a mouse-down the page will report back.
    expect(pointerDowns).toEqual([true, false]);
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", code: "KeyA", key: "a" },
      session,
    );
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", code: "KeyA", key: "a" },
      session,
    );
    await client.send(
      "Input.dispatchKeyEvent",
      { type: "char", code: "KeyA", key: "a", text: "a" },
      session,
    );
    expect(keyDowns).toEqual([
      null,
      null,
      { code: "KeyA", key: "a" },
      null,
      null,
    ]);
  });
});
