import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
  registerPrepareOnlyPreparedValue,
} from "./playwright-application-flow";

/**
 * The Ashby and Greenhouse replicas, served as the app's replica gate serves
 * them, filled in Fill in for me: the selected resume reaches storage (and
 * Ashby binds it to its field), and no answer leaves before the person's
 * click.
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const log = join(mkdtempSync(join(tmpdir(), "nestor-replica-")), "posts.log");

beforeAll(async () => {
  server = spawn(
    process.execPath,
    ["../../apps/desktop/test-fixtures/job-sites/serve.mjs"],
    {
      env: { ...process.env, PORT: "0", NESTOR_FIXTURE_SUBMISSIONS_LOG: log },
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    server!.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    server!.once("exit", () => reject(new Error("The replica server exited.")));
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

const posts = (): Array<{ path: string; fields: Record<string, unknown> }> => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as never);
  } catch {
    return [];
  }
};

async function fillPage(slug: string) {
  const page = await (await browser!.newContext()).newPage();
  await ensurePrepareOnlyMutationGuard(page, false);
  const url = `${base}/${slug}/apply/1`;
  allowPrepareOnlyRunNavigation(page, url);
  await page.goto(url);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  return { page, session };
}

const resume = {
  name: "alex-vanguard-resume.pdf",
  mimeType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic replica resume"),
};

test("Greenhouse: the resume reaches storage, with a name filled in", async () => {
  const { page, session } = await fillPage("greenhouse-shape");
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await registerPrepareOnlyPreparedValue(page, "Alex");
  await session.fillText(ref("first_name"), "Alex");
  await session.uploadFile(ref("resume"), resume);
  await page.waitForFunction(
    () => (document.getElementById("resume_url") as HTMLInputElement).value,
  );
  expect(
    posts()
      .filter((post) => post.path === "/greenhouse-shape/storage")
      .map((post) => (post.fields.file as { filename: string }).filename),
  ).toEqual([resume.name]);
  expect(
    posts().filter((post) => post.path === "/greenhouse-shape/apply/1"),
  ).toEqual([]);
});

test("Ashby: the resume is stored and bound to its field; typed answers are not saved", async () => {
  const { page, session } = await fillPage("ashby-shape");
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await registerPrepareOnlyPreparedValue(page, "Alex Vanguard");
  await session.fillText(ref("_systemfield_name"), "Alex Vanguard");
  await page.locator("#_systemfield_name").blur();
  await session.uploadFile(ref("_systemfield_resume"), resume);
  await page.waitForTimeout(1_500);
  expect(await page.locator("#chip").textContent()).toBe(resume.name);
  expect(await page.locator("#toast").textContent()).not.toContain(
    "failed to upload",
  );
  expect(
    posts().filter((post) => post.path === "/ashby-shape/storage/"),
  ).toHaveLength(1);
  // The person's own Submit later sends only what Ashby saved: the file,
  // not the typed name, whose save the fence held back.
  expect(
    posts().filter((post) => post.path === "/ashby-shape/apply/1"),
  ).toEqual([]);
});
