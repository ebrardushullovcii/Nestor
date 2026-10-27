import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "./application-submission-browser-hands";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
  openPrepareOnlyIntermediateMutationWindow,
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
    [
      resolvePath(
        import.meta.dirname,
        "../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
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

async function fillPage(slug: string, fieldSaves = false, host?: string) {
  const page = await (await browser!.newContext()).newPage();
  await ensurePrepareOnlyMutationGuard(page, fieldSaves);
  const origin = host ? base.replace("127.0.0.1", host) : base;
  const url = `${origin}/${slug}/apply/1`;
  allowPrepareOnlyRunNavigation(page, url);
  await page.goto(url);
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: fieldSaves,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  return { page, session };
}

/** Ashby's widget says when its upload ended, bound or failed. */
const uploadSettled = (page: Awaited<ReturnType<typeof fillPage>>["page"]) =>
  page.waitForFunction(
    () => (document.getElementById("chip") as HTMLElement).dataset.upload,
    undefined,
    { timeout: 20_000 },
  );

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
  await uploadSettled(page);
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

test("Ashby's no-type Submit is unchanged by a fenced Yes/No press", async () => {
  const { page, session } = await fillPage("ashby-shape");
  const finalState = () =>
    page.locator("#send").evaluate((element) => ({
      tag: element.tagName,
      typeAttribute: element.getAttribute("type"),
      type: (element as HTMLButtonElement).type,
      form: (element as HTMLButtonElement).form,
      forms: document.forms.length,
    }));
  const before = await finalState();
  expect(before).toEqual({
    tag: "BUTTON",
    typeAttribute: null,
    type: "submit",
    form: null,
    forms: 0,
  });
  expect((await observeApplicationForm(page)).controls).toHaveLength(0);
  const actions = (await session.readPage()).actions;
  const yes = actions.find(
    (action) => action.pressed !== undefined && action.label === "Yes",
  )!;
  const savedResponses: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("op=ApiSetFormValue"))
      savedResponses.push(response.status());
  });
  expect(
    await session.setToggle(yes.ref ?? `a${yes.index}`, true),
  ).toMatchObject({
    ok: true,
  });
  await page.waitForFunction(() =>
    document
      .getElementById("toast")
      ?.textContent?.includes("could not be saved"),
  );
  expect(savedResponses).toEqual([]);
  expect(await finalState()).toEqual(before);
  expect((await observeApplicationForm(page)).controls).toHaveLength(0);
  const send = (await session.readPage()).actions.find(
    (action) => action.label === "Submit Application",
  )!;
  const ready = await observeApplicationForm(page, {
    finalActionTargets: [
      { ref: send.ref ?? `a${send.index}`, label: send.label },
    ],
  });
  expect(ready.complete).toBe(true);
  expect(ready.controls).toHaveLength(1);
  expect(ready.controls[0]).toMatchObject({
    formIndex: -1,
    label: "Submit Application",
  });
  expect(
    posts().filter((post) => post.path === "/ashby-shape/apply/1"),
  ).toEqual([]);
});

test("Ashby with field saves: guarded Submit sends once after the Yes/No presses", async () => {
  const { page, session } = await fillPage("ashby-shape", true);
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  // As the executor does for every field: declare the value, open the short
  // save window, write.
  for (const [id, value] of [
    ["_systemfield_name", "Alex Vanguard"],
    ["_systemfield_email", "alex.vanguard@example.test"],
  ] as const) {
    await registerPrepareOnlyPreparedValue(page, value);
    await openPrepareOnlyIntermediateMutationWindow(page);
    await session.fillText(ref(id), value);
    await page.locator(`#${id}`).blur();
  }
  await session.uploadFile(ref("_systemfield_resume"), resume);
  // Ashby's Yes/No buttons are pressed by their own handles, through the
  // same toggle the answer path uses; pressing a chosen option again keeps it.
  const toggles = (await session.readPage()).actions.filter(
    (action) => action.pressed !== undefined,
  );
  expect(
    toggles.map((action) => [
      action.section,
      action.label,
      action.pressed,
      action.sectionRequired,
    ]),
  ).toEqual([
    ["Are you over the age of 18?", "Yes", false, true],
    ["Are you over the age of 18?", "No", false, true],
    ["Are you based in a EU or equivalent timezone?", "Yes", false, true],
    ["Are you based in a EU or equivalent timezone?", "No", false, true],
  ]);
  for (const [index, times] of [
    [0, 2],
    [3, 1],
  ] as const)
    for (let press = 0; press < times; press++) {
      await openPrepareOnlyIntermediateMutationWindow(page);
      expect(
        await session.setToggle(
          toggles[index]!.ref ?? `a${toggles[index]!.index}`,
          true,
        ),
      ).toMatchObject({ ok: true });
    }
  // The location picker is required only by its title's class.
  const location = (await session.readPage()).controls.find((control) =>
    control.label.startsWith("What country are you based in?"),
  )!;
  expect(location).toMatchObject({ role: "combobox", required: true });
  await registerPrepareOnlyPreparedValue(page, "United Kingdom");
  await openPrepareOnlyIntermediateMutationWindow(page);
  expect(
    await session.chooseOption(
      location.ref ?? `c${location.index}`,
      "United Kingdom",
    ),
  ).toMatchObject({ ok: true });
  await uploadSettled(page);
  await page.waitForTimeout(500);
  expect(await page.locator("#toast").textContent()).toBe("");
  // The same no-type, formless final button as the real page. Resolve its
  // exact action, then use the guarded one-shot boundary, never a direct POST.
  const send = (await session.readPage()).actions.find(
    (action) => action.label === "Submit Application",
  )!;
  const observation = await observeApplicationForm(page, {
    finalActionTargets: [
      { ref: send.ref ?? `a${send.index}`, label: send.label },
    ],
  });
  expect(observation.complete).toBe(true);
  expect(observation.controls).toHaveLength(1);
  const origin = new URL(page.url()).origin;
  const finalInput = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: origin,
    allowedOrigins: [origin],
    veto: () => true,
    confirmationTimeoutMs: 2_000,
  };
  const finalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("op=ApiSubmitSingleApplicationFormAction"))
      finalRequests.push(request.method());
  });
  expect(await executeExactlyOneFinalAction(page, finalInput)).toMatchObject({
    outcome: "submitted",
  });
  expect(await executeExactlyOneFinalAction(page, finalInput)).toMatchObject({
    outcome: "not_submitted",
  });
  expect(finalRequests).toEqual(["POST"]);
  const post = posts().find(
    (entry) =>
      entry.path === "/ashby-shape/apply/1" &&
      entry.fields._systemfield_name === "Alex Vanguard",
  );
  expect(post?.fields).toMatchObject({
    _systemfield_name: "Alex Vanguard",
    _systemfield_email: "alex.vanguard@example.test",
    adult: true,
    timezone: false,
    _systemfield_location: "United Kingdom",
    _systemfield_resume: {
      file: expect.stringContaining(resume.name) as unknown,
    },
  });
});

test("Ashby with field saves: a press right after the upload waits for the storage and the bind", async () => {
  const { page, session } = await fillPage("ashby-shape", true);
  const control = (await session.readPage()).controls.find(
    (entry) => entry.id === "_systemfield_resume",
  )!;
  await session.uploadFile(control.ref ?? `c${control.index}`, resume);
  // What the executor does before any press: the replica's presign takes
  // two seconds, as a real one can, so the storage POST starts late.
  await session.closeUploadWindow();
  await uploadSettled(page);
  expect(await page.locator("#chip").textContent()).toBe(resume.name);
  expect(await page.locator("#chip").getAttribute("data-upload")).toBe("bound");
});

test("Greenhouse with field saves: its email check on a sibling host runs, and the attached file shows", async () => {
  const { page, session } = await fillPage(
    "greenhouse-shape",
    true,
    "job-boards.gh.localhost",
  );
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await registerPrepareOnlyPreparedValue(page, "alex.vanguard@example.test");
  await openPrepareOnlyIntermediateMutationWindow(page);
  await session.fillText(ref("email"), "alex.vanguard@example.test");
  await page.locator("#email").dispatchEvent("change");
  await page.waitForFunction(() =>
    document.getElementById("email")?.getAttribute("aria-invalid"),
  );
  expect(await page.locator("#email").getAttribute("aria-invalid")).toBe(
    "false",
  );
  await session.uploadFile(ref("resume"), resume);
  await page.waitForFunction(
    () => (document.getElementById("resume_url") as HTMLInputElement).value,
  );
  // The page shows the name only after its own upload progress hit 100%:
  // the browser sent the file itself.
  expect(await page.locator("#chip").textContent()).toBe(resume.name);
  // The input is gone; the page read still reports the storage's word.
  const after = await session.readPage();
  expect(after.controls.some((control) => control.id === "resume")).toBe(false);
  expect(after.uploads).toEqual([
    { fileName: resume.name, network: "accepted" },
  ]);
});
