import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPlaywrightApplyPageMechanics,
  createPlaywrightApplyPageSession,
} from "./apply-page-mechanics";
import { withAccountWindowSession } from "./account-window-session";
import { configureTraceCapture } from "./trace-page";

let browser: Browser;
let base = "";
const requests: string[] = [];
const server = createServer((request, response) => {
  const path = request.url ?? "/";
  if (request.method === "POST") requests.push(path);
  response.setHeader("Content-Type", "text/html");
  if (path === "/login")
    response.end(
      `<h1>Account</h1><form method="POST" action="/session"><input aria-label="Email" name="email"><button>Sign in</button></form>`,
    );
  else if (path === "/session") {
    response.writeHead(303, {
      "Set-Cookie": "synthetic_session=known; Path=/; SameSite=Lax",
      Location: "/signed-in",
    });
    response.end();
  } else if (path === "/signed-in")
    response.end(
      `<h1>Signed in</h1><button onclick="window.opener?.postMessage('signed-in','*');window.close()">Return</button>`,
    );
  else if (path === "/same-tab")
    response.end(`<a href="/login">Continue to account</a>`);
  else
    response.end(
      `<h1>Application</h1><input aria-label="Name" value="Alex Example"><button onclick="window.open('/login')">Continue to account</button>`,
    );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function accountSession(page: Page, signal?: AbortSignal) {
  return withAccountWindowSession({
    page,
    session: createPlaywrightApplyPageSession({ page }),
    mechanics: createPlaywrightApplyPageMechanics,
    locate: () => null,
    click: (locator) => locator.click(),
    ...(signal ? { signal } : {}),
  });
}
async function open(context: BrowserContext, path = "/") {
  const page = await context.newPage();
  await page.goto(base + path);
  const session = accountSession(page);
  const action = [
    ...(await session.readPage()).actions,
    ...(await session.readPage()).links,
  ].find((action) => action.label === "Continue to account")!;
  return {
    page,
    session,
    ref: action.ref ?? `${path === "/same-tab" ? "l" : "a"}${action.index}`,
  };
}
test("an ordinary account popup posts once, keeps its session and returns to the original filled page", async () => {
  const context = await browser.newContext();
  try {
    const { page, session, ref } = await open(context);
    const popupPromise = page.waitForEvent("popup");
    await session.clickOpeningAccountWindow!({
      ref,
      frame: null,
      writeOrigins: [],
    });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    const account = await session.readPage();
    expect(account.bodyText).toContain("Account");
    const email = account.controls.find(
      (control) => control.label === "Email",
    )!;
    for (let index = 0; index < 6; index++)
      expect(
        await session.fillText(
          email.ref ?? `c${email.index}`,
          `alex${index}@example.test`,
        ),
      ).toMatchObject({ ok: true });
    const sign = [
      ...(await session.readPage()).actions,
      ...(await session.readPage()).links,
    ].find((action) => action.label === "Sign in")!;
    const before = requests.length;
    await session.clickElement(sign.ref ?? `a${sign.index}`);
    await popup.waitForURL(base + "/signed-in");
    expect(requests.slice(before)).toEqual(["/session"]);
    expect(
      (await context.cookies(base)).some(
        (cookie) => cookie.name === "synthetic_session",
      ),
    ).toBe(true);
    expect(page.url()).toBe(base + "/");
    expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe(
      "Alex Example",
    );
    const back = [
      ...(await session.readPage()).actions,
      ...(await session.readPage()).links,
    ].find((action) => action.label === "Return")!;
    await session.clickElement(back.ref ?? `a${back.index}`);
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect((await session.readPage()).bodyText).toContain("Application");
    await session.closeAccountWindow();
    expect(page.isClosed()).toBe(false);
  } finally {
    await context.close();
  }
});
test("same-tab account navigation completes without waiting for a popup", async () => {
  const context = await browser.newContext();
  try {
    const { page, session, ref } = await open(context, "/same-tab");
    await expect(
      session.clickOpeningAccountWindow!({
        ref,
        frame: null,
        writeOrigins: [],
      }),
    ).resolves.toMatchObject({ kind: "no_window" });
    await page.waitForURL(base + "/login");
    expect((await session.readPage()).accountWindow).toMatchObject({
      surface: "same_tab",
      origin: base,
    });
    await session.closeAccountWindow();
    expect(page.isClosed()).toBe(false);
  } finally {
    await context.close();
  }
});

test("images and pointer input follow the account popup and its auxiliary tab while the application stays bound", async () => {
  const context = await browser.newContext();
  try {
    const { page, session, ref } = await open(context);
    const popupPromise = page.waitForEvent("popup");
    await session.clickOpeningAccountWindow!({
      ref,
      frame: null,
      writeOrigins: [],
    });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    const captured: Page[] = [];
    configureTraceCapture(context, (target) => {
      captured.push(target);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    });
    const pressTarget = async (target: Page) => {
      await target.evaluate(() => {
        const button = document.createElement("button");
        button.textContent = "Image target";
        button.onclick = () => {
          document.body.dataset.pressed = "yes";
        };
        document.body.append(button);
      });
      await session.screenshot!();
      expect(captured.at(-1)).toBe(target);
      const box = await target
        .getByRole("button", { name: "Image target" })
        .boundingBox();
      expect(
        await session.pointer!({
          action: "click",
          x: box!.x + box!.width / 2,
          y: box!.y + box!.height / 2,
        }),
      ).toMatchObject({ ok: true });
      expect(await target.locator("body").getAttribute("data-pressed")).toBe(
        "yes",
      );
    };
    await pressTarget(popup);
    const email = (await session.readPage()).controls.find(
      (c) => c.label === "Email",
    )!;
    expect(
      await session.typeKeys!(email.ref!, "synthetic@example.test"),
    ).toMatchObject({ ok: true });
    expect(await popup.getByLabel("Email").inputValue()).toBe(
      "synthetic@example.test",
    );
    await session.openTab!(base + "/signed-in");
    const auxiliary = context
      .pages()
      .find((candidate) => candidate !== page && candidate !== popup)!;
    await pressTarget(auxiliary);
    await auxiliary.evaluate(() => {
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Search mailbox");
      document.body.append(field);
    });
    const search = (await session.readPage()).controls.find(
      (c) => c.label === "Search mailbox",
    )!;
    expect(await session.typeKeys!(search.ref!, "Replica")).toMatchObject({
      ok: true,
    });
    expect(await auxiliary.getByLabel("Search mailbox").inputValue()).toBe(
      "Replica",
    );
    await session.switchTab!("form");
    await session.screenshot!();
    expect(captured.at(-1)).toBe(popup);
    await session.closeAuxiliaryTabs!();
    expect(auxiliary.isClosed()).toBe(true);
    expect(page.isClosed()).toBe(false);
    expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe(
      "Alex Example",
    );
    await session.closeAccountWindow();
  } finally {
    await context.close();
  }
}, 30_000);
test("Stop rejects another account action and cleanup leaves unrelated tabs alone", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(base + "/same-tab");
    const unrelated = await context.newPage();
    const controller = new AbortController();
    const session = accountSession(page, controller.signal);
    const action = (await session.readPage()).links[0]!;
    controller.abort();
    await expect(
      session.clickOpeningAccountWindow!({
        ref: action.ref ?? `l${action.index}`,
        frame: null,
        writeOrigins: [],
      }),
    ).rejects.toThrow();
    await session.closeAccountWindow();
    expect(unrelated.isClosed()).toBe(false);
    expect(page.url()).toBe(base + "/same-tab");
  } finally {
    await context.close();
  }
});
