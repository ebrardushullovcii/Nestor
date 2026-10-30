import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createApplyPageHands,
  runApplyAgent,
  type LLMClient,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "./application-submission-browser-hands";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
  getLatestBlockedPrepareOnlyAttempt,
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

test.each([false, true])(
  "Greenhouse: the resume reaches storage, with a name filled in (binary: %s)",
  async (binary) => {
    const { page, session } = await fillPage("greenhouse-shape");
    const controls = (await session.readPage()).controls;
    const ref = (id: string) => {
      const control = controls.find((entry) => entry.id === id)!;
      return control.ref ?? `c${control.index}`;
    };
    await registerPrepareOnlyPreparedValue(page, "Alex");
    await session.fillText(ref("first_name"), "Alex");
    const selected = binary
      ? {
          ...resume,
          name: "synthetic-binary-resume.pdf",
          bytes: new Uint8Array([
            ...resume.bytes,
            ...Array.from({ length: 256 }, (_, value) => value),
          ]),
        }
      : resume;
    await session.uploadFile(ref("resume"), selected);
    await page.waitForFunction(
      () => (document.getElementById("resume_url") as HTMLInputElement).value,
    );
    expect(
      posts()
        .filter((post) => post.path === "/greenhouse-shape/storage")
        .map((post) => (post.fields.file as { filename: string }).filename),
    ).toContain(selected.name);
    expect(
      posts().filter((post) => post.path === "/greenhouse-shape/apply/1"),
    ).toEqual([]);
  },
);

test.each([
  [false, "127.0.0.1"],
  [true, "localhost"],
])(
  "Greenhouse: a last name that is also a word in the storage bucket's name still lets the resume through (field saves %s, on %s)",
  async (fieldSaves, host) => {
    // The replica's bucket is "synthetic-greenhouse-files"; the presign
    // hands out the policy that names it, and the page sends it back as is.
    const { page, session } = await fillPage(
      "greenhouse-shape",
      fieldSaves,
      host,
    );
    const controls = (await session.readPage()).controls;
    const ref = (id: string) => {
      const control = controls.find((entry) => entry.id === id)!;
      return control.ref ?? `c${control.index}`;
    };
    const stored = posts().filter(
      (post) => post.path === "/greenhouse-shape/storage",
    ).length;
    await registerPrepareOnlyPreparedValue(page, "Synthetic");
    await session.fillText(ref("last_name"), "Synthetic");
    await session.uploadFile(ref("resume"), resume);
    await page.waitForFunction(
      () => (document.getElementById("resume_url") as HTMLInputElement).value,
    );
    expect(
      posts().filter((post) => post.path === "/greenhouse-shape/storage"),
    ).toHaveLength(stored + 1);
    expect(
      posts().filter((post) => post.path === "/greenhouse-shape/apply/1"),
    ).toEqual([]);
  },
);

test("Workable: the resume reaches the storage its presign named, with an empty utf8 field", async () => {
  const { page, session } = await fillPage("workable-shape");
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await registerPrepareOnlyPreparedValue(page, "Alex");
  await session.fillText(ref("firstname"), "Alex");
  await session.uploadFile(ref("resume"), resume);
  await page.waitForFunction(
    () => (document.getElementById("resume_path") as HTMLInputElement).value,
    undefined,
    { timeout: 20_000 },
  );
  const stored = posts().filter(
    (post) => post.path === "/workable-shape/storage",
  );
  expect(
    stored.map((post) => (post.fields.file as { filename: string }).filename),
  ).toEqual([resume.name]);
  expect(stored[0]?.fields.utf8).toBe("");
  expect(await page.locator("#resume-error").textContent()).toBe("");
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
}, 15_000);

test("A JavaScript-sent form: its Apply submits it, and the guarded click sends the page's own POST once", async () => {
  const { page, session } = await fillPage("contact-form-shape");
  const read = await session.readPage();
  const ref = (id: string) => {
    const control = read.controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  for (const [id, value] of [
    ["name", "Alex Vanguard"],
    ["email", "alex.vanguard@example.test"],
    ["phone", "+44 20 0000 0000"],
  ] as const) {
    await registerPrepareOnlyPreparedValue(page, value);
    await session.fillText(ref(id), value);
  }
  await session.setToggle(ref("consent"), true);
  // The form names no method or action; its Apply button still submits it.
  const apply = (await session.readPage()).actions.find(
    (action) => action.label === "Apply",
  )!;
  expect(apply).toMatchObject({ submitsForm: true, formMethod: "GET" });
  // The button has one ref: no clickable alias without its form's action.
  expect(
    (await session.readPage()).clickables.filter(
      (entry) => entry.label === "Apply",
    ),
  ).toEqual([]);
  const sent = () =>
    posts().filter((post) => post.path === "/contact-form-shape/api/apply");
  expect(sent()).toEqual([]);
  const observation = await observeApplicationForm(page, {
    finalActionTargets: [
      { ref: apply.ref ?? `a${apply.index}`, label: apply.label },
    ],
  });
  expect(observation.complete).toBe(true);
  const origin = new URL(page.url()).origin;
  const finalInput = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: origin,
    allowedOrigins: [origin],
    veto: () => true,
    confirmationTimeoutMs: 2_000,
  };
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(origin))
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  expect(await executeExactlyOneFinalAction(page, finalInput)).toMatchObject({
    outcome: "submitted",
  });
  expect(sent().map((post) => post.fields)).toEqual([
    {
      role: "software-engineer",
      name: "Alex Vanguard",
      email: "alex.vanguard@example.test",
      phone: "+44 20 0000 0000",
    },
  ]);
  // The page's own POST went out; the form's GET to itself never did.
  expect(requests).toContain("POST /contact-form-shape/api/apply");
  expect(requests).not.toContain("GET /contact-form-shape/apply/1");
});

test("A JavaScript-sent form: Apply pressed without the guarded click sends nothing", async () => {
  const { page } = await fillPage("contact-form-shape");
  for (const [id, value] of [
    ["name", "Alex Vanguard"],
    ["email", "alex.vanguard@example.test"],
    ["phone", "+44 20 0000 0000"],
  ] as const) {
    await registerPrepareOnlyPreparedValue(page, value);
    await page.fill(`#${id}`, value);
  }
  await page.check("#consent");
  const sent = () =>
    posts().filter((post) => post.path === "/contact-form-shape/api/apply")
      .length;
  const before = sent();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/contact-form-shape/api/apply"))
      requests.push(request.method());
  });
  await page.click("button[type=submit]");
  await page.waitForTimeout(1_000);
  expect(sent()).toBe(before);
  expect(requests).toEqual([]);
  expect(page.url()).toContain("/contact-form-shape/apply/1");
  expect((await getLatestBlockedPrepareOnlyAttempt(page))?.kind).toContain(
    "submit",
  );
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

test("Lever: the renamed resume reaches its parser with the form's id, and typed answers stay", async () => {
  const { page, session } = await fillPage("lever-shape");
  const controls = (await session.readPage()).controls;
  const ref = (id: string) => {
    const control = controls.find((entry) => entry.id === id)!;
    return control.ref ?? `c${control.index}`;
  };
  await registerPrepareOnlyPreparedValue(page, "Alex Vanguard");
  await session.fillText(ref("name"), "Alex Vanguard");
  // A name with spaces: Lever sends it as Alex_Vanguard_CV.pdf.
  await session.uploadFile(ref("resume-upload-input"), {
    ...resume,
    name: "Alex Vanguard CV.pdf",
  });
  await page.waitForFunction(
    () =>
      !(document.querySelector(".resume-upload-working") as HTMLElement)
        .hidden ||
      !(document.querySelector(".resume-upload-success") as HTMLElement)
        .hidden ||
      !(document.querySelector(".resume-upload-failure") as HTMLElement).hidden,
  );
  await page.waitForFunction(
    () =>
      (document.querySelector(".resume-upload-working") as HTMLElement).hidden,
  );
  expect(await page.locator(".resume-upload-success").isVisible()).toBe(true);
  expect(
    posts()
      .filter((post) => post.path === "/lever-shape/parseResume")
      .map((post) => [
        (post.fields.resume as { filename: string }).filename,
        post.fields.accountId,
      ]),
  ).toEqual([["Alex_Vanguard_CV.pdf", "0a1b2c3d-4e5f-4789-8bcd-ef0123456789"]]);
  expect(await page.locator("#name").inputValue()).toBe("Alex Vanguard");
  expect(await page.locator("input[name=resumeStorageId]").inputValue()).toBe(
    "replica-resume-storage-1",
  );
  expect(
    posts().filter((post) => post.path === "/lever-shape/apply/1"),
  ).toEqual([]);
});

test("remote-search replica returns city and degree rows, commits exact retries and sends nothing", async () => {
  const { page, session } = await fillPage("remote-search");
  for (const [id, answer, offered] of [
    ["city", "Cloud Harbour", ["Cloud Harbor", "Cloud Hill"]],
    ["degree", "BSc Computer Science", ["Bachelor's Degree"]],
  ] as const) {
    const control = (await session.readPage()).controls.find(
      (entry) => entry.id === id,
    )!;
    const ref = control.ref ?? `c${control.index}`;
    await registerPrepareOnlyPreparedValue(page, answer);
    expect(await session.chooseOption(ref, answer)).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: [...offered],
    });
    expect(await page.locator(`#${id}`).inputValue()).toBe("");
    await registerPrepareOnlyPreparedValue(page, offered[0]);
    expect(await session.chooseOption(ref, offered[0])).toEqual({
      ok: true,
      observedValue: offered[0],
    });
    expect(
      (await session.readPage()).controls.find((entry) => entry.id === id)
        ?.value,
    ).toBe(offered[0]);
  }
  expect(
    posts().filter((post) => post.path === "/remote-search/apply/1"),
  ).toEqual([]);
}, 60_000);

test("Ashby: its location picker's search carries what was typed, and the choice reads back", async () => {
  const { page, session } = await fillPage("ashby-shape");
  const sent = () =>
    posts().filter((post) => post.path === "/ashby-shape/apply/1").length;
  const sentBefore = sent();
  const location = (await session.readPage()).controls.find((control) =>
    control.label.startsWith("What country are you based in?"),
  )!;
  // As the executor does: the answer is declared before it is chosen.
  await registerPrepareOnlyPreparedValue(page, "Kosovo");
  expect(
    await session.chooseOption(location.ref ?? `c${location.index}`, "Kosovo"),
  ).toMatchObject({ ok: true, observedValue: "Kosovo" });
  const after = (await session.readPage()).controls.find((control) =>
    control.label.startsWith("What country are you based in?"),
  );
  expect(after).toMatchObject({ role: "combobox", value: "Kosovo" });
  // Only the search left; nothing was submitted.
  expect(sent()).toBe(sentBefore);
}, 15_000);

test("Ashby: a location already picked stays picked when a continue chooses it again", async () => {
  const { page, session } = await fillPage("ashby-shape");
  const location = async () =>
    (await session.readPage()).controls.find((control) =>
      control.label.startsWith("What country are you based in?"),
    )!;
  // The person picked it on the page.
  await page.locator("#location-input").click();
  await page.locator("#location-input").pressSequentially("Kos");
  await page.getByRole("option", { name: "Kosovo" }).click();
  expect((await location()).value).toBe("Kosovo");
  // The continue (or a restore) chooses the same answer again.
  await registerPrepareOnlyPreparedValue(page, "Kosovo");
  const control = await location();
  expect(
    await session.chooseOption(control.ref ?? `c${control.index}`, "Kosovo"),
  ).toMatchObject({ ok: true });
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  expect((await location()).value).toBe("Kosovo");
});

test("Ashby: a date picker reads as a date, takes only a date, and its open calendar is not its question", async () => {
  const { page, session } = await fillPage("ashby-shape");
  const start = async () =>
    (await session.readPage()).controls.find((control) =>
      control.label.startsWith("When could you start?"),
    )!;
  // The calendar is open beside the box: its month and weekdays stay out.
  await page.locator("#start-input").click();
  expect(await start()).toMatchObject({
    inputType: "date",
    label: "When could you start?",
  });
  const ref = async () => {
    const control = await start();
    return control.ref ?? `c${control.index}`;
  };
  expect(await session.fillText(await ref(), "Immediately")).toMatchObject({
    ok: false,
  });
  expect((await start()).value).toBe("");
  // A date three months on: the calendar is moved to it and the day picked.
  await registerPrepareOnlyPreparedValue(page, "2027-01-15");
  expect(await session.fillText(await ref(), "2027-01-15")).toMatchObject({
    ok: true,
    observedValue: "01/15/2027",
  });
  expect((await start()).value).toBe("01/15/2027");
});

async function recoveryRun(
  shape: string,
  options: Partial<ApplyAgentConfig> = {},
) {
  const { page, session } = await fillPage(`upload-recovery/${shape}`, false);
  // fillPage ends in /apply/1, so these shapes share exactly the app's guard.
  const initial = (await session.readPage()).controls.find(
    (control) => control.id === "resume",
  )!;
  const config: ApplyAgentConfig = {
    hands: createApplyPageHands(session),
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Alex Example",
        yearsExperience: 5,
        baseResume: {
          id: "synthetic",
          fileName: "synthetic.pdf",
          uploadedAt: "2026-10-29T00:00:00.000Z",
          textContent: "Synthetic engineer",
          textUpdatedAt: "2026-10-29T00:00:00.000Z",
          extractionStatus: "ready",
        },
      }),
      resumeText: null,
      posting: {
        title: "Document Engineer",
        company: "Synthetic Workshop",
        location: "Remote",
        description: "Synthetic role",
      },
      reusableAnswers: [],
      documents: [
        {
          id: "resume",
          kind: "resume",
          label: "Synthetic CV",
          fileName: resume.name,
          mimeType: resume.mimeType,
          loadBytes: () => Promise.resolve(resume.bytes),
        },
      ],
    },
    application: {
      jobId: "synthetic",
      applicationId: `synthetic-${shape}`,
      startingUrl: page.url(),
    },
    siteLabel: "Synthetic Workshop",
    // Only a field with nothing pending waits the whole time (vanished); a
    // request still out is waited on until its answer settles, which on a
    // busy runner takes seconds.
    uploadWaitMs:
      shape === "slow" ? 20_000 : shape === "vanished" ? 1_500 : 10_000,
    ...options,
  };
  let calls = 0;
  const model: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: `upload-${calls}`,
            type: "function",
            function:
              calls++ === 0
                ? {
                    name: "upload",
                    arguments: JSON.stringify({
                      ref: initial.ref ?? `c${initial.index}`,
                      documentId: "resume",
                    }),
                  }
                : {
                    name: "finish",
                    arguments: JSON.stringify({ reason: "Checked the file." }),
                  },
          },
        ],
      }),
  };
  const result = await runApplyAgent(config, model);
  return { page, session, result, config, calls };
}

test.each([
  ["chooser", "chooser"],
  ["drop", "drop"],
  ["slow", "input"],
  ["transient", "chooser"],
  ["stale", "input"],
])(
  "upload recovery: %s attaches through %s without a send",
  async (shape, method) => {
    const { page, result } = await recoveryRun(shape);
    expect(result.outcome, result.notes.join("\n")).toBe("prepared");
    expect(await page.locator("#zone").getAttribute("data-attached")).toBe(
      method,
    );
    expect(result.reviewAttachments?.map((file) => file.fileName)).toContain(
      resume.name,
    );
    expect(result.pauses).toEqual([]);
    if (shape === "transient") {
      const log = result.notes.join("\n");
      expect(log, log).toContain("HTTP 503");
      expect(log, log).toContain("Document service unavailable");
      expect(log, log).not.toContain("signature=");
    }
    expect(
      posts().filter(
        (post) => post.path === `/upload-recovery/${shape}/apply/1`,
      ),
    ).toEqual([]);
    await page.context().close();
  },
  45_000,
);

test.each(["refused", "vanished"])(
  "upload recovery: %s records the cause after all methods",
  async (shape) => {
    const { page, result } = await recoveryRun(shape);
    expect(result.outcome).toBe("paused");
    const log = result.notes.join("\n");
    expect(log).toContain("using input");
    expect(log).toContain("using chooser");
    expect(log).toContain("using drop");
    expect(log).toContain(
      shape === "refused"
        ? "Document service unavailable"
        : "file gone from the field; never confirmed",
    );
    expect(log).toContain(
      shape === "refused" ? "HTTP 503" : "no upload request observed",
    );
    expect(log).not.toContain("signature=");
    expect(
      result.pauses
        .flatMap(
          (pause) =>
            pause.questions ?? (pause.question ? [pause.question] : []),
        )
        .some((question) => question.id === "upload_repair"),
    ).toBe(true);
    await page.context().close();
  },
  30_000,
);

test("upload recovery: a fresh attempt retries an old failure even when replay kept all other answers", async () => {
  const { page, config } = await recoveryRun("stale");
  // Restore the old failed display on the retained page as a real widget can.
  await page.locator("#feedback").evaluate((node) => {
    node.textContent = "Your file upload failed on the previous attempt";
  });
  const result = await runApplyAgent(
    {
      ...config,
      initialUnansweredPickerQuestions: [
        { prompt: "Resume — upload failed", options: [] },
      ],
      replay: { answers: [], attachments: [], path: [] },
    },
    {
      chatWithTools: () =>
        Promise.reject(new Error("Replay should settle without the model")),
    },
  );
  expect(result.outcome, result.notes.join("\n")).toBe("prepared");
  expect(result.notes.join("\n")).toContain("fresh attempt");
  expect(result.notes.join("\n")).toContain("try 1 of 3");
  expect(result.reviewAttachments?.map((file) => file.fileName)).toContain(
    resume.name,
  );
  await page.context().close();
}, 30_000);
