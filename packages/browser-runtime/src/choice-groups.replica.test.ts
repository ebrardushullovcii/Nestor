import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  CandidateProfileSchema,
  type CandidateProfile,
} from "@nestor/contracts";
import {
  createApplyPageHands,
  describeObservation,
  runApplyAgent,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

let replica: ChildProcess;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  replica = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
    { env: { ...process.env, PORT: "0" } },
  );
  origin = await new Promise<string>((resolve, reject) => {
    replica.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    replica.once("error", reject);
    replica.once("exit", () => reject(new Error("Replica server exited")));
  });
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  replica?.kill();
});

const rightToWork = "Do you have the right to work in the UK?";
const sponsorship =
  "Do you now or will you in the future require sponsorship to work legally in the UK? Please note: proof of eligibility may be required at the time of hire.";
const tools = "Which tools have you used?";

test("binds ARIA groups and adjacent option lists to their own questions in an iframe", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<iframe title="Application"></iframe>');
    const frame = page.locator("iframe").contentFrame();
    await frame.locator("body").evaluate((body) => {
      body.innerHTML = `<form>
        <fieldset><legend>Your preferences</legend>
          <h3 id="schedule">Which schedule works for you?</h3>
          <div role="radiogroup" aria-labelledby="schedule">
            <div role="radio" aria-checked="true">Morning</div>
            <div role="radio" aria-checked="false">Evening</div>
          </div>
          <label>Which days can you attend?</label>
          <ul><li><label><input type="checkbox" name="mon">Monday</label></li>
              <li><label><input type="checkbox" name="tue">Tuesday</label></li></ul>
          <label><input type="checkbox" name="updates">Send me updates</label>
        </fieldset>
      </form>`;
    });
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const { controls } = await hands.observe();
    expect(
      controls.map(({ label, options, sectionPath }) => [
        label,
        options,
        sectionPath?.at(-1),
      ]),
    ).toEqual([
      ["Morning", ["Morning", "Evening"], "Which schedule works for you?"],
      ["Evening", ["Morning", "Evening"], "Which schedule works for you?"],
      ["Monday", ["Monday", "Tuesday"], "Which days can you attend?"],
      ["Tuesday", ["Monday", "Tuesday"], "Which days can you attend?"],
      ["Send me updates", [], "Your preferences"],
    ]);
  } finally {
    await page.close();
  }
});

test("the apply model can tell apart and answer the questions in a Lever-shaped replica", async () => {
  const page = await browser.newPage();
  const url = origin + "/lever-questions/apply/1";
  try {
    await page.goto(url);
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    let turn = 0;
    let modelFailure: Error | undefined;
    const call = (name: string, args: object) =>
      Promise.resolve({
        toolCalls: [
          {
            id: `turn_${++turn}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
    const result = await runApplyAgent(
      {
        hands,
        application: {
          jobId: "synthetic",
          applicationId: "synthetic",
          startingUrl: url,
        },
        siteLabel: "Replica",
        authority: {
          mode: "prepare_only",
          submitAuthorized: false,
          allowedOrigins: [],
          preApprovedAttestationKinds: [],
          salaryDisclosure: "answer_from_profile",
        },
        sources: {
          profile: CandidateProfileSchema.parse({
            id: "synthetic",
            fullName: "Alex Synthetic",
            yearsExperience: 3,
            baseResume: {
              id: "resume",
              fileName: "resume.txt",
              uploadedAt: "2026-10-01T00:00:00Z",
            },
            skills: ["Git", "Linux"],
            workEligibility: {
              authorizedWorkCountries: ["United Kingdom"],
              requiresVisaSponsorship: false,
            },
          }),
          posting: {
            title: "Engineer",
            company: "Replica",
            location: "London, United Kingdom",
            description: "Synthetic listing",
          },
          resumeText: "",
          reusableAnswers: [
            {
              id: "gender",
              kind: "other",
              question: "Gender",
              label: "Gender",
              answer: "Female",
              roleFamilies: [],
              proofEntryIds: [],
            },
          ],
          documents: [],
        },
      },
      {
        chatWithTools: (messages) => {
          try {
            if (turn > 0)
              return call("finish", { reason: "The form is filled." });
            const inputs = messages.map((message) => message.content ?? "");
            const profile = inputs.find((input) =>
              input.startsWith("The person's facts "),
            )!;
            const facts = JSON.parse(
              profile.slice(profile.indexOf("\n") + 1),
            ) as Pick<CandidateProfile, "workEligibility" | "skills">;
            const library = inputs.find((input) =>
              input.startsWith("The person's saved answers "),
            )!;
            const savedAnswers = JSON.parse(
              library.slice(library.indexOf("\n") + 1),
            ) as { question: string; answer: string }[];
            const view = inputs.find((input) =>
              input.includes(`\nPage: ${url}\n`),
            )!;
            const fields = view.split("Fields:\n")[1]!.split("\n\n")[0]!;
            const groups = [
              ...fields.matchAll(
                /^- \[(radio|checkbox) group\] · ([^\n]+)\n((?: {2}- [^\n]+\n?)+)/gmu,
              ),
            ];
            expect(groups.map(([, , label]) => label!.split(" · ")[0])).toEqual(
              [rightToWork, sponsorship, "Gender", tools],
            );
            const wanted = new Map([
              [
                rightToWork,
                [
                  facts.workEligibility.authorizedWorkCountries.includes(
                    "United Kingdom",
                  )
                    ? "Yes"
                    : "No",
                ],
              ],
              [
                sponsorship,
                [facts.workEligibility.requiresVisaSponsorship ? "Yes" : "No"],
              ],
              [
                "Gender",
                [
                  savedAnswers.find((answer) => answer.question === "Gender")!
                    .answer,
                ],
              ],
              [tools, facts.skills],
            ]);
            const choices = groups.map(([, , , options]) =>
              [
                ...options!.matchAll(/^ {2}- (\S+) \[\w+\] · ([^·]+) · /gmu),
              ].map(([, ref, label]) => ({
                ref,
                label: label!.trim(),
              })),
            );
            expect(
              choices.map((group) => group.map((option) => option.label)),
            ).toEqual([
              ["Yes", "No"],
              ["Yes", "No"],
              ["Female", "Male"],
              ["Git", "Linux", "Excel"],
            ]);
            return call("fill_fields", {
              fields: choices.flatMap((group, index) => {
                const question = groups[index]![2]!.split(" · ")[0]!;
                return group
                  .filter((option) =>
                    wanted.get(question)?.includes(option.label),
                  )
                  .map(({ ref }) => ({
                    tool: "set_checkbox",
                    ref,
                    checked: true,
                  }));
              }),
            });
          } catch (error) {
            modelFailure =
              error instanceof Error ? error : new Error(String(error));
            return call("finish", { stuck: true, reason: String(error) });
          }
        },
      },
    );

    if (modelFailure) throw modelFailure;
    expect(result.outcome).toBe("prepared");
    expect(result.pauses).toEqual([]);
    expect(
      await page
        .locator("input:checked")
        .evaluateAll((fields) =>
          fields.map((element) => (element as HTMLInputElement).id),
        ),
    ).toEqual([
      "authorization-0",
      "sponsorship-1",
      "gender-0",
      "tools-0",
      "tools-1",
    ]);
    const observed = describeObservation(await hands.observe());
    expect(observed).toMatch(/\[radio\] · No · required · answered: "chosen"/u);
    expect(observed).toContain('Linux · optional · answered: "ticked"');
    expect(observed).toMatch(
      /^- \S+ \[checkbox\] · Email me future roles · optional · empty/mu,
    );
  } finally {
    await page.close();
  }
});

test.each([
  [
    "/greenhouse/apply/1",
    "radio",
    "Are you legally authorized to work in this country? *",
  ],
  ["/ashby-shape/apply/1", "radio", "Are you over the age of 18?"],
  [
    "/workday-prompts/apply/1",
    "radio",
    "Are you legally authorized to work in the country of this role?*",
  ],
  [
    "/contact-form-shape/apply/1",
    "checkbox",
    "The company can contact me about this role. I have read the privacy policy.",
  ],
])("keeps the existing choice labels on %s", async (path, kind, label) => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + path);
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const observation = await hands.observe();
    const choices = observation.controls.filter(
      (control) =>
        control.kind === kind &&
        (kind === "radio"
          ? control.groupLabel === label
          : control.label === label),
    );
    expect(choices).toHaveLength(kind === "radio" ? 2 : 1);
    if (kind === "radio") {
      expect(choices[0]!.options).toEqual(["Yes", "No"]);
      expect(choices[0]!.choiceGroupKey).toBe(choices[1]!.choiceGroupKey);
      expect(describeObservation(observation)).toContain(
        `[radio group] · ${label}`,
      );
    } else {
      expect(choices[0]!.options).toEqual([]);
      expect(describeObservation(observation)).toContain(
        `[checkbox] · ${label}`,
      );
    }
  } finally {
    await page.close();
  }
});
