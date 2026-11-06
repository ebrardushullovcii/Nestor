import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { BrowserAgentPermissionsSchema } from "@nestor/contracts";
import {
  buildApplyFormObservation,
  createApplyPageHands,
  describeObservation,
  withBrowserPermissions,
  browserStepReadyForAgent,
} from "@nestor/browser-agent";
import {
  readRawApplyPage,
  createPlaywrightApplyPageMechanics,
} from "./apply-page-mechanics";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("child-frame reader binds safe owners and disabled state across origins; policy stays generic", async () => {
  const child = createServer((_req, res) =>
    res.end(
      `<!doctype html><input aria-label="Child field"><button>Child button</button><a href="/next">Child link</a><div role="button">Continuer en tant que Jamie</div><div role="button" aria-disabled="true">Unavailable button</div><div role="option" onclick="this.dataset.pressed='yes'">Continue as Jamie</div><div role="option" aria-disabled="true" onclick="">Unavailable</div>`,
    ),
  );
  const childOrigin = await listen(child);
  const parent = createServer((_req, res) =>
    res.end(
      `<!doctype html><h1>Sign in</h1><form><input type="email" aria-label="Email"><input type="password" aria-label="Password"></form><a href="/provider">Continue with Google</a><button>Top button</button><div role="option" aria-disabled="true" onclick="">Top unavailable</div><iframe src="${childOrigin}/child-owned-path?token=synthetic-query#synthetic-fragment"></iframe><iframe srcdoc="<button>Opaque child</button>"></iframe>`,
    ),
  );
  const parentOrigin = await listen(parent);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(parentOrigin);
    const raw = await readRawApplyPage(page);
    const expected = { origin: childOrigin, pathname: "/child-owned-path" };
    for (const group of [
      raw.controls,
      raw.actions,
      raw.links,
      raw.clickables,
    ]) {
      expect(group.some((item) => item.frame?.origin === childOrigin)).toBe(
        true,
      );
      for (const item of group.filter(
        (item) => item.frame?.origin === childOrigin,
      ))
        expect(item.frame).toEqual(expected);
      for (const item of group.filter((item) => !item.ref?.startsWith("f")))
        expect(item.frame).toBeUndefined();
    }
    expect(
      raw.actions.find((item) => item.label === "Opaque child")?.frame,
    ).toEqual({ origin: "null", pathname: "" });
    const disabled = raw.clickables.find(
      (item) => item.label === "Unavailable",
    )!;
    expect(disabled.disabled).toBe(true);
    expect(
      raw.actions.find((item) => item.label === "Unavailable button")?.disabled,
    ).toBe(true);
    expect(
      raw.clickables.find((item) => item.label === "Top unavailable")?.disabled,
    ).toBe(true);
    const ordinary = raw.clickables.find(
      (item) => item.label === "Continue as Jamie",
    )!;
    expect(ordinary.disabled).toBe(false);
    const observed = buildApplyFormObservation(raw, "2026-11-03T06:00:00.000Z");
    expect(
      observed.clickables.find((item) => item.ref === disabled.ref),
    ).toMatchObject({ frame: expected, disabled: true });
    expect(
      observed.actions.find((item) => item.label === "Child button")?.frame,
    ).toEqual(expected);
    expect(
      observed.controls.find((item) => item.label === "Child field")?.frame,
    ).toEqual(expected);
    expect(
      observed.links.find((item) => item.label === "Child link")?.frame,
    ).toEqual(expected);
    const prompt = describeObservation(observed);
    expect(prompt).toContain(`frame: ${childOrigin}`);
    expect(prompt).not.toContain("child-owned-path");
    expect(JSON.stringify(raw.controls.map((item) => item.frame))).not.toMatch(
      /synthetic-query|synthetic-fragment|token=/u,
    );
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    // The non-Google owner is an ordinary click even when every opt-in is off.
    expect(
      await withBrowserPermissions(hands, {}).clickElement(ordinary.ref!),
    ).toMatchObject({ ok: true });
    const provider = observed.links.find(
      (item) => item.label === "Continue with Google",
    )!;
    expect(
      await withBrowserPermissions(hands, {}).followLink(provider.ref),
    ).toMatchObject({ ok: true });
    expect(
      browserStepReadyForAgent(
        observed,
        BrowserAgentPermissionsSchema.parse({ googleSignIn: true }),
      ),
    ).toBe(true);
  } finally {
    await browser?.close();
    await Promise.all([close(parent), close(child)]);
  }
}, 30_000);
