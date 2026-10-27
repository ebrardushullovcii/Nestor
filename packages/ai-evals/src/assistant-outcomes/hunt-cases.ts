import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import type { JobStore, ResumeStore } from "@nestor/db/job-store";
import type { ApplicationStore } from "@nestor/db/applications";
import type { JobFinderRepository } from "@nestor/db";
import type { ApplicationService } from "@nestor/job-finder/applications";
import type {
  DesktopJobsBridge,
  ResumeCommandName,
  ResumeCommandInput,
  ResumeCommandOutput,
  ApplicationRow,
  ApplicationDetails,
  NeedsYouTask,
  NeedsYouDetails,
  SavedFormAnswersPage,
  JobCommandOutput,
} from "@nestor/contracts";
import type { BuiltAppBatch } from "./built-app";
import { equalOutcome } from "./outcome";

interface HuntFixtures {
  fill: number;
  send: number;
  questions: number;
  skip: number;
  triage: number;
  questionIds: [number, number];
  skipApplication: number;
}
type HuntWindow = Window & {
  assistantOutcomeHunt?: HuntFixtures;
  nestor: {
    jobs: DesktopJobsBridge;
    resumes: {
      run<K extends ResumeCommandName>(
        name: K,
        input: ResumeCommandInput<K>,
      ): Promise<ResumeCommandOutput<K>>;
    };
    jobFinder: {
      applicationsForJobs(input: {
        jobIds: number[];
      }): Promise<ApplicationRow[]>;
      getApplicationDetails(input: {
        id: number;
      }): Promise<ApplicationDetails | null>;
    };
    needsYou: {
      run(
        name: "get_need",
        input: { id: number },
      ): Promise<NeedsYouDetails | null>;
      run(
        name: "list_form_answers",
        input: { limit: number },
      ): Promise<SavedFormAnswersPage>;
      run(
        name: "application_needs",
        input: { id: number },
      ): Promise<NeedsYouTask[]>;
    };
  };
};
const fixtures = (page: Page) =>
  page.evaluate(() => {
    const value = (window as unknown as HuntWindow).assistantOutcomeHunt;
    if (!value) throw Error("Synthetic hunt preconditions were not installed");
    return value;
  });

/** A small valid PDF containing only the same synthetic facts as Profile. */
function syntheticPdf() {
  const content =
    "BT /F1 16 Tf 72 740 Td (Alex Synthetic) Tj 0 -24 Td /F1 11 Tf (alex@example.test) Tj 0 -24 Td (Software engineer - TypeScript - Budapest, Hungary) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Preconditions only: real chat must perform every action judged below. */
export async function seedHuntFixtures(
  app: ElectronApplication,
  page: Page,
  userDataDir: string,
  replicaOrigin: string,
) {
  const pdf = syntheticPdf();
  const folder = path.join(userDataDir, "assistant-outcome-fixtures");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "alex-synthetic.pdf");
  await writeFile(file, pdf);
  const value = await app.evaluate(
    async ({ app }, input) => {
      if (!pathSafe(app.getPath("userData"), input.data))
        throw Error("Wrong isolated fixture target");
      function pathSafe(actual: string, expected: string) {
        return (
          actual.replaceAll("\\", "/") === expected.replaceAll("\\", "/") &&
          /nestor-verify-/u.test(actual)
        );
      }
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(process.execPath);
      const exports = Object.values(require.cache).flatMap((entry) =>
        Object.values((entry?.exports ?? {}) as Record<string, unknown>),
      );
      const find = (name: string) => {
        const fn = exports.find(
          (value) => typeof value === "function" && value.name === name,
        );
        if (!fn) throw Error(`Missing production fixture boundary ${name}`);
        return fn;
      };
      const runtime = await (
        find("startJobFinderRuntime") as () => Promise<{
          repository: JobFinderRepository;
        }>
      )();
      const profile = await runtime.repository.getProfile();
      await runtime.repository.saveProfile({
        ...profile,
        firstName: "Alex",
        lastName: "Synthetic",
        fullName: "Alex Synthetic",
        email: "alex@example.test",
        phone: "+36305550123",
        baseResume: {
          ...profile.baseResume,
          id: "assistant-outcome-synthetic",
          fileName: "alex-synthetic.pdf",
          storagePath: input.file,
          sha256: input.hash,
          uploadedAt: new Date().toISOString(),
          extractionStatus: "ready",
          textContent:
            "Alex Synthetic\nalex@example.test\nSoftware engineer. TypeScript. Budapest, Hungary.",
          textUpdatedAt: new Date().toISOString(),
          sourceIdentity: {
            fullName: "Alex Synthetic",
            email: "alex@example.test",
          },
        },
      });
      const store = (find("getJobStore") as () => JobStore)();
      const resumes = (
        find("createResumeStore") as (store: JobStore) => ResumeStore
      )(store);
      const applications = (
        find("getApplicationStore") as () => ApplicationStore
      )();
      // Keep the ordinary worker from claiming synthetic preconditions before
      // their waiting questions exist. It runs normally for every chat case.
      const service = await (
        find("getApplicationService") as () => Promise<ApplicationService>
      )();
      service.stop();
      const alternate = input.origin.replace("127.0.0.1", "localhost");
      const urls = [
        `${input.origin}/greenhouse-shape/apply/1`,
        `${alternate}/greenhouse-shape/apply/1`,
        `${input.origin}/remembered/apply/1`,
        `${input.origin}/remembered/apply/2`,
        `${input.origin}/outcome-triage/job/1`,
      ];
      const added = store.saveFoundJobs({
        searchId: "assistant-outcome-hunt",
        jobs: urls.map((url, index) => ({
          title: index < 2 ? "Platform Engineer" : `Outcome hunt ${index}`,
          company: index < 2 ? "Job Board Replica" : "Synthetic Hunt",
          // Identical title/company/place on different hosts is one job.
          // These copies represent distinct roles for the two mode checks.
          location: index === 0 ? "Remote, Europe" : "Remote, Worldwide",
          workModes: ["remote"],
          url,
          applyUrl: url,
          sourceId: "assistant-outcome-hunt",
          sourceLabel: "Synthetic replica precondition",
          sourceJobId: String(index),
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: "Synthetic software engineering role using TypeScript.",
        })),
      }).added;
      if (added.length !== 5) throw Error("Hunt fixtures must start absent");
      for (const id of added.slice(0, 4)) {
        store.setStage([id], "shortlisted");
        resumes.startWriting(id, "original");
        if (!resumes.finishWriting(id, null))
          throw Error("Could not seed ready original resume");
      }
      const questionIds: number[] = [];
      let skipApplication = 0;
      for (const [index, id] of added.slice(2, 4).entries()) {
        resumes.approve(id, null);
        applications.applyJobs(
          { selection: { ids: [id] } },
          "confirm_before_submit",
        );
        const claimed = applications.claimNext();
        if (claimed?.jobId !== id) throw Error("Unexpected fixture claim");
        const prompts =
          index === 0
            ? [
                "Outcome question: preferred work arrangement?",
                "Outcome question: notice period in days?",
              ]
            : ["Outcome question: unknown personal history?"];
        for (const [n, prompt] of prompts.entries()) {
          const result = applications.needsYou.request({
            applicationId: claimed.id,
            attempt: claimed.attempt,
            fieldKey: `outcome-${index}-${n}`,
            kind: "question",
            key: `assistant-outcome-${index}-${n}`,
            scope: { country: "", siteOrigin: input.origin },
            prompt,
            input: "text",
            options: [],
          });
          if (result.status !== "needs_you")
            throw Error("Missing seeded waiting question");
          if (index === 0) questionIds.push(result.task.id);
        }
        if (index === 1) skipApplication = claimed.id;
      }
      await service.start();
      return {
        fill: added[0]!,
        send: added[1]!,
        questions: added[2]!,
        skip: added[3]!,
        triage: added[4]!,
        questionIds: [questionIds[0]!, questionIds[1]!] as [number, number],
        skipApplication,
      };
    },
    {
      file,
      hash: createHash("sha256").update(pdf).digest("hex"),
      origin: new URL(replicaOrigin).origin,
      data: userDataDir,
    },
  );
  await page.evaluate((value) => {
    (window as unknown as HuntWindow).assistantOutcomeHunt = value;
  }, value);
}

const readJob = async (
  page: Page,
  key: keyof Pick<HuntFixtures, "fill" | "send" | "triage">,
) => {
  const id = (await fixtures(page))[key];
  return page.evaluate(
    (id) =>
      (window as unknown as HuntWindow).nestor.jobs.run("get_job", { id }),
    id,
  );
};
const work = async (page: Page, key: "fill" | "send" | "skip") => {
  const id = (await fixtures(page))[key];
  return (
    (
      await page.evaluate(
        (id) =>
          (
            window as unknown as HuntWindow
          ).nestor.jobFinder.applicationsForJobs({
            jobIds: [id],
          }),
        id,
      )
    )[0] ?? null
  );
};
export function huntOutcomeCases(origin: string): BuiltAppBatch[] {
  let beforeSpeed: JobCommandOutput<"get_settings"> | undefined;
  return [
    {
      id: "hunt-speed",
      prepare: async (page) => {
        beforeSpeed = await page.evaluate(() =>
          (window as unknown as HuntWindow).nestor.jobs.run("patch_settings", {
            fields: { speedLevel: "standard" },
          }),
        );
      },
      request:
        "Set Speed to Faster, then show Settings at Speed so I can see the saved choice. Leave all other settings alone.",
      actions: [
        {
          actionId: "settings.field.speedLevel",
          observe: async (page) => [
            equalOutcome(
              "unchanged",
              "Other Settings preserved",
              "jobs.get_settings before and after the Speed change",
              await page.evaluate(() =>
                (window as unknown as HuntWindow).nestor.jobs.run(
                  "get_settings",
                  {},
                ),
              ),
              { ...beforeSpeed, speedLevel: "faster" },
            ),
            equalOutcome(
              "data",
              "Speed saved",
              "jobs.get_settings.speedLevel",
              await page.evaluate(
                async () =>
                  (
                    await (window as unknown as HuntWindow).nestor.jobs.run(
                      "get_settings",
                      {},
                    )
                  ).speedLevel,
              ),
              "faster",
            ),
            equalOutcome(
              "visible_state",
              "Faster shown selected",
              "Settings Speed group",
              await page
                .getByRole("group", { name: "Speed", exact: true })
                .getByRole("button", { name: "Faster", exact: true })
                .getAttribute("aria-pressed"),
              "true",
            ),
          ],
        },
      ],
    },
    {
      id: "hunt-search",
      request: `Search only ${new URL("/board/", origin).href}, with Quick depth, Good matches, posting age Month, and note "Synthetic TypeScript engineering outcome check". Start it in the background and show Find jobs.`,
      actions: ["start", "depth", "pickiness", "age", "note", "sites"].map(
        (name) => ({
          actionId: `search.${name}`,
          observe: async (page) => {
            const status = await page.evaluate(() =>
              (window as unknown as HuntWindow).nestor.jobs.run(
                "search_status",
                {},
              ),
            );
            const sites = await page.evaluate(() =>
              (window as unknown as HuntWindow).nestor.jobs.run("list_sites", {
                limit: 100,
              }),
            );
            const selected = sites.rows.find(
              (site) =>
                site.url.replace(/\/$/u, "") ===
                new URL("/board/", origin).href.replace(/\/$/u, ""),
            );
            return [
              equalOutcome(
                "data",
                "A real background search exists",
                "jobs.search_status.search.id",
                Boolean(status.search?.id),
                true,
              ),
              equalOutcome(
                "data",
                "Search started successfully",
                "jobs.search_status.search.state",
                status.search !== null &&
                  ["running", "done"].includes(status.search.state),
                true,
              ),
              equalOutcome(
                "data",
                "Only the requested site was scheduled",
                "jobs.search_status.search.sourcesTotal",
                status.search?.sourcesTotal,
                1,
              ),
              equalOutcome(
                "data",
                "Exact search choices",
                "jobs.search_status.search.settings",
                status.search?.settings,
                {
                  depth: "quick",
                  picky: "balanced",
                  postedWithin: "month",
                  note: "Synthetic TypeScript engineering outcome check",
                  sites: { ids: selected ? [selected.id] : [] },
                },
              ),
            ];
          },
        }),
      ),
    },
    ...(["hide", "undo", "shortlist", "undo"] as const).map(
      (operation, index): BuiltAppBatch => ({
        id: `hunt-triage-${index}`,
        requires: index ? [`hunt-triage-${index - 1}`] : [],
        request:
          index === 0
            ? "Hide only the job titled Outcome hunt 4 at Synthetic Hunt. Do not apply to anything."
            : index === 1 || index === 3
              ? "Undo only the job move from your previous reply."
              : "Shortlist only Outcome hunt 4 at Synthetic Hunt. Do not approve or apply yet.",
        actions: [
          {
            actionId: `job.move.one.${operation}`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Exact job stage after this move",
                "jobs.get_job.stage",
                (await readJob(page, "triage"))?.stage,
                index === 0 ? "hidden" : index === 2 ? "shortlisted" : "found",
              ),
            ],
          },
        ],
      }),
    ),
    ...(["fill", "send"] as const).flatMap((mode): BuiltAppBatch[] => {
      let jobId = 0;
      return [
        {
          id: `hunt-approve-${mode}`,
          prepare: async (page) => {
            jobId = (await fixtures(page))[mode];
          },
          get request() {
            return `Read the written Original resume for job ${jobId}, Platform Engineer at Job Board Replica, then approve only that resume. Do not apply yet.`;
          },
          actions: [
            {
              actionId: "resume.approve",
              observe: async (page) => {
                const id = (await fixtures(page))[mode];
                const result = await page.evaluate(
                  (jobId) =>
                    (window as unknown as HuntWindow).nestor.resumes.run(
                      "get_resume",
                      {
                        jobId,
                      },
                    ),
                  id,
                );
                return [
                  equalOutcome(
                    "data",
                    "Resume explicitly approved",
                    "resumes.get_resume.approvedAt",
                    Boolean(result.resume?.approvedAt),
                    true,
                  ),
                  equalOutcome(
                    "data",
                    "Job is available to Apply",
                    "jobs.get_job.stage",
                    result.job.stage,
                    "resume",
                  ),
                ];
              },
            },
          ],
        },
        {
          id: `hunt-apply-${mode}`,
          requires: [`hunt-approve-${mode}`],
          prepare: async (page) => {
            jobId = (await fixtures(page))[mode];
            await page.evaluate(
              (mode) =>
                (window as unknown as HuntWindow).nestor.jobs.run(
                  "patch_settings",
                  {
                    fields: {
                      applicationAutomationMode:
                        mode === "fill"
                          ? "autonomous_submit"
                          : "confirm_before_submit",
                    },
                  },
                ),
              mode,
            );
          },
          get request() {
            return `Set my application mode to ${mode === "fill" ? "Fill in for me" : "Send for me"}. For only job ${jobId}, Platform Engineer at Job Board Replica, ${mode === "fill" ? "prepare it but never submit it" : "prepare and send it through Nestor's normal send guards"}. This is my explicit application instruction for this loopback replica only. Leave all other jobs alone.`;
          },
          actions: [
            {
              actionId: "apply.one",
              observe: async (page) => {
                const row = await work(page, mode);
                return [
                  equalOutcome(
                    "data",
                    "The exact approved job has application work",
                    "jobFinder.applicationsForJobs",
                    row?.jobId,
                    (await fixtures(page))[mode],
                  ),
                  equalOutcome(
                    "data",
                    "Requested application mode persisted",
                    "applications.mode",
                    row?.mode,
                    mode === "fill"
                      ? "confirm_before_submit"
                      : "autonomous_submit",
                  ),
                  equalOutcome(
                    "data",
                    "Worker accepted the application",
                    "applications.state",
                    row !== null &&
                      [
                        "queued",
                        "running",
                        "needs_you",
                        "ready",
                        "submitting",
                        "submitted",
                      ].includes(row.state),
                    true,
                  ),
                ];
              },
            },
            {
              actionId: "settings.field.applicationAutomationMode",
              observe: async (page) => [
                equalOutcome(
                  "data",
                  "Requested Apply setting saved",
                  "jobs.get_settings.applicationAutomationMode",
                  await page.evaluate(
                    async () =>
                      (
                        await (window as unknown as HuntWindow).nestor.jobs.run(
                          "get_settings",
                          {},
                        )
                      ).applicationAutomationMode,
                  ),
                  mode === "fill"
                    ? "confirm_before_submit"
                    : "autonomous_submit",
                ),
              ],
            },
          ],
        },
      ];
    }),
    {
      id: "hunt-answer-once",
      request:
        'For the waiting question "Outcome question: preferred work arrangement?", answer "Remote" once. Do not remember it for other applications, and leave the notice-period question unanswered.',
      actions: [
        {
          actionId: "needs_you.answer_once",
          observe: async (page, _reply, evidence) => {
            const f = await fixtures(page);
            const state = await page.evaluate(async (f) => {
              const b = (window as unknown as HuntWindow).nestor;
              return {
                answered: await b.needsYou.run("get_need", {
                  id: f.questionIds[0],
                }),
                other: await b.needsYou.run("get_need", {
                  id: f.questionIds[1],
                }),
                saved: await b.needsYou.run("list_form_answers", {
                  limit: 200,
                }),
              };
            }, f);
            return [
              equalOutcome(
                "data",
                "Exact one-time answer stored",
                "needs_you row read through verify-nestor",
                evidence.needAnswers?.find((row) => row.id === f.questionIds[0])
                  ?.answer,
                "Remote",
              ),
              equalOutcome(
                "data",
                "Answered question resolved",
                "needsYou.get_need",
                state.answered,
                null,
              ),
              equalOutcome(
                "unchanged",
                "Other question stays waiting",
                "needsYou.get_need",
                Boolean(state.other),
                true,
              ),
              equalOutcome(
                "unchanged",
                "One-time answer not remembered",
                "needsYou.list_form_answers",
                state.saved.rows.some(
                  (row) =>
                    row.prompt ===
                    "Outcome question: preferred work arrangement?",
                ),
                false,
              ),
            ];
          },
        },
      ],
    },
    {
      id: "hunt-remember-answer",
      requires: ["hunt-answer-once"],
      request:
        'Answer "Outcome question: notice period in days?" with "15", and remember this exact answer for future forms. Continue the waiting application.',
      actions: [
        {
          actionId: "needs_you.remember",
          observe: async (page, _reply, evidence) => {
            const f = await fixtures(page);
            const state = await page.evaluate(
              async (f) => ({
                need: await (
                  window as unknown as HuntWindow
                ).nestor.needsYou.run("get_need", { id: f.questionIds[1] }),
                saved: await (
                  window as unknown as HuntWindow
                ).nestor.needsYou.run("list_form_answers", { limit: 200 }),
              }),
              f,
            );
            return [
              equalOutcome(
                "data",
                "Exact remembered answer stored on waiting question",
                "needs_you row read through verify-nestor",
                evidence.needAnswers?.find((row) => row.id === f.questionIds[1])
                  ?.answer,
                "15",
              ),
              equalOutcome(
                "data",
                "Question resolved",
                "needsYou.get_need",
                state.need,
                null,
              ),
              equalOutcome(
                "data",
                "Answer remembered",
                "needsYou.list_form_answers",
                state.saved.rows.find(
                  (row) =>
                    row.prompt === "Outcome question: notice period in days?",
                )?.preview,
                "15",
              ),
            ];
          },
        },
      ],
    },
    {
      id: "hunt-skip-waiting-application",
      request:
        "Skip Outcome hunt 3 at Synthetic Hunt: stop that waiting application's work. Do not guess or answer its unknown personal-history question and do not send it.",
      actions: [
        {
          actionId: "apply.stop",
          observe: async (page) => [
            equalOutcome(
              "data",
              "Waiting application stopped",
              "applicationsForJobs.state",
              (await work(page, "skip"))?.state,
              "stopped",
            ),
            equalOutcome(
              "unchanged",
              "No send receipt",
              "jobFinder.getApplicationDetails.receipt",
              await page.evaluate(
                async (id) =>
                  (
                    await (
                      window as unknown as HuntWindow
                    ).nestor.jobFinder.getApplicationDetails({ id })
                  )?.receipt,
                (await fixtures(page)).skipApplication,
              ),
              null,
            ),
          ],
        },
      ],
    },
  ];
}
