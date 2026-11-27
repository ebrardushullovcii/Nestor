import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createApplyPageHands,
  describeObservation,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

/**
 * Workday's prompts (R8 J.D. Power): after "Job Board" went into "How Did
 * You Hear About Us?", the lookup reported the phone code field's pill
 * "Kosovo (+386), press delete to clear value." as its options and the
 * field as answered "Job Board"; Skills reported its own pills as the
 * results for "Node.js" and "SQL". The lookup list is the one that opens
 * beside the field; a list of what a field holds is what it holds.
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "nestor-workday-prompts-"));
const resume = join(dir, "resume.pdf");
writeFileSync(resume, "%PDF-1.4 synthetic\n");

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
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: join(dir, "posts.log"),
      },
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
}, 30_000);

async function open(): Promise<{
  page: Page;
  raw: ReturnType<typeof createPlaywrightApplyPageMechanics>;
  hands: ReturnType<typeof createApplyPageHands>;
}> {
  const page = await browser!.newPage();
  await page.goto(`${base}/workday-prompts/apply/1`);
  const raw = createPlaywrightApplyPageMechanics(page);
  return { page, raw, hands: createApplyPageHands(raw) };
}

const field = async (
  hands: ReturnType<typeof createApplyPageHands>,
  label: string,
) => (await hands.observe()).controls.find((c) => c.label.startsWith(label))!;

test("a prompt's lookup is the list Enter opens, never a field's pills", async () => {
  const { page, raw, hands } = await open();
  try {
    const first = await hands.observe();
    expect(first.step).toMatchObject({ index: 1, total: 5 });
    const source = await field(hands, "How Did You Hear About Us?");
    const code = await field(hands, "Country Phone Code");
    expect(source.selectedItems).toEqual([]);
    expect(source.answered).toBe(false);
    expect(code.selectedItems).toEqual(["Kosovo (+383)"]);
    expect(code.answered).toBe(true);
    expect(describeObservation(first)).toContain(
      'Country Phone Code* · required · 1 selected: "Kosovo (+383)"',
    );

    // Typing alone runs no search on Workday: no list, and not the phone pill.
    const typed = await raw.typeKeys!(source.ref, "Job Board");
    expect(typed.ok).toBe(true);
    expect(JSON.stringify(typed.optionList ?? null)).not.toContain("Kosovo");
    const searching = await field(hands, "How Did You Hear About Us?");
    expect(searching.answered).toBe(false);
    expect(describeObservation(await hands.observe())).toContain(
      'How Did You Hear About Us?* · required · nothing selected · search text in the box: "Job Board"',
    );

    // Enter runs the search; its results come back with the key.
    const searched = await raw.pressKey(source.ref, "Enter");
    expect(searched.optionList).toMatchObject({
      open: true,
      options: ["Job Board not checked"],
    });

    // The result row is a clickable that ticks a box: set_checkbox reaches it.
    const row = (await raw.readPage()).clickables.find((c) =>
      c.label.startsWith("Job Board"),
    )!;
    expect(await raw.setToggle(row.ref!, true)).toMatchObject({ ok: true });
    const chosen = await field(hands, "How Did You Hear About Us?");
    expect(chosen.selectedItems).toEqual(["Job Board"]);
    expect(chosen.answered).toBe(true);

    // The picker offers the rows that opened, never the pills beside it.
    const offered = await raw.chooseOption(
      (await field(hands, "Country Phone Code")).ref,
      "Albania (+355)",
    );
    expect(offered).toMatchObject({ ok: false });
    expect(
      (offered as { offeredOptions?: string[] }).offeredOptions,
    ).toContain("Albania (+355) not checked");
    expect(JSON.stringify(offered)).not.toContain("press delete");
  } finally {
    await page.close();
  }
}, 60_000);

test("Skills reports its own results after Enter, its pills as selected, and the step it is on", async () => {
  const { page, raw, hands } = await open();
  try {
    // Step 1, filled the way a person would, to reach My Experience.
    await page.locator("#source-search").click();
    await page.getByRole("option", { name: /^Job Board/u }).click();
    await page.fill("#given", "Test");
    await page.fill("#family", "Applicant");
    await page.fill("#email", "synthetic@example.test");
    await page.fill("#phone", "44000000");
    await page.getByRole("button", { name: "Save and Continue" }).click();
    const second = await hands.observe();
    expect(second.step).toMatchObject({ index: 2, total: 5 });

    // Five "Add" buttons in one named section say which block each adds to.
    const text = describeObservation(second);
    for (const block of [
      "Work Experience",
      "Education",
      "Languages",
      "Websites",
    ])
      expect(text).toMatch(new RegExp(`: Add \\(in: ${block}\\)`, "u"));

    const skills = (await field(hands, "Skills")).ref;
    for (const [query, result] of [
      ["React", "React (Software)"],
      ["TypeScript", "TypeScript"],
      ["Node", "Node.js"],
      ["SQL", "PostgreSQL"],
      ["Docker", "Docker (Software)"],
    ] as const) {
      await raw.pressKey(skills, "ControlOrMeta+A");
      const typed = await raw.typeKeys!(skills, query);
      // Never the pills already chosen.
      expect(JSON.stringify(typed.optionList ?? null)).not.toContain(
        "press delete",
      );
      const searched = await raw.pressKey(skills, "Enter");
      expect(searched.optionList?.options).toContain(`${result} not checked`);
      const row = (await raw.readPage()).clickables.find(
        (c) => c.label === `${result} not checked`,
      )!;
      expect(await raw.clickElement(row.ref!)).toMatchObject({ ok: true });
    }
    const held = await field(hands, "Skills");
    expect(held.selectedItems).toEqual([
      "React (Software)",
      "TypeScript",
      "Node.js",
      "PostgreSQL",
      "Docker (Software)",
    ]);

    // An upload confirmed in an alert region is announced, not a problem.
    const upload = (await field(hands, "Resume/CV")).ref;
    await raw.uploadFile(upload, {
      name: "resume.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(Buffer.from("%PDF-1.4 synthetic\n")),
    });
    const announced = describeObservation(await hands.observe());
    expect(announced).toContain(
      "The page announces (its alert regions, word for word):\n- resume.pdf successfully uploaded",
    );
    expect(announced).not.toContain("showing problems");
  } finally {
    await page.close();
  }
}, 90_000);
