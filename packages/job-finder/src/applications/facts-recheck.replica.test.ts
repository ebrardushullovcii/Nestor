import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import { createApplyPageHands } from "@nestor/browser-agent";
import {
  createBrowserAgentRuntime,
  createPlaywrightApplyPageMechanics,
} from "@nestor/browser-runtime";
import { createApplicationStore } from "@nestor/db/applications";
import {
  approveOriginalResumesForTests,
  createProfileStore,
  createSendGuards,
  openJobStore,
} from "@nestor/db/job-store";
import { createSeed } from "../test-fixtures";
import { createApplicationService } from "./application-service";

test("the scripted model resumes a parked replica form after Profile and Saved answers edits", async () => {
  let formLoads = 0;
  let sends = 0;
  const replica = createServer((request, response) => {
    if (request.method === "POST") sends++;
    if (request.url === "/apply") formLoads++;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><h1>Apply for Engineer</h1>
      <form method="post">
        <label>ZIP or postcode <input name="postal" required></label>
        <label>When can we call? <input name="contact" required></label>
        <button>Send application</button>
      </form>`);
  });
  const directory = await mkdtemp(join(tmpdir(), "nestor-recheck-replica-"));
  const jobs = openJobStore(":memory:");
  const profile = createProfileStore(jobs);
  const applications = createApplicationStore(jobs);
  const seed = createSeed();
  const clock = vi.spyOn(Date, "now");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let service: ReturnType<typeof createApplicationService> | undefined;
  try {
    await new Promise<void>((resolve) =>
      replica.listen(0, "127.0.0.1", resolve),
    );
    const address = replica.address();
    if (!address || typeof address === "string")
      throw new Error("Replica needs a port");
    const url = `http://127.0.0.1:${address.port}/apply`;
    const fileName = "synthetic-resume.pdf";
    const filePath = join(directory, fileName);
    const resume = "%PDF-1.4 Synthetic resume for this replica.";
    await writeFile(filePath, resume);
    seed.profile.postalCode = null;
    seed.profile.baseResume.fileName = fileName;
    seed.profile.baseResume.storagePath = filePath;
    seed.profile.baseResume.sha256 = createHash("sha256")
      .update(resume)
      .digest("hex");
    profile.replace(seed.profile);
    const ids = jobs.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: "Engineer",
          company: "Replica",
          location: "Remote",
          workModes: ["remote"],
          url,
          applyUrl: url,
          sourceId: "replica",
          sourceLabel: "Replica",
          sourceJobId: "job",
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: "Synthetic posting",
        },
      ],
    }).added;
    approveOriginalResumesForTests(jobs, ids);
    const chromiumBrowser = await chromium.launch({ headless: true });
    browser = chromiumBrowser;
    const context = await browser.newContext();
    const runtime = createBrowserAgentRuntime({
      userDataDir: directory,
      browserHost: {
        connect: () => Promise.resolve(chromiumBrowser),
        getOpenBrowser: () => Promise.resolve(chromiumBrowser),
        close: () => chromiumBrowser.close(),
        assertAutomationSafe: () => undefined,
      },
    });
    const onError = vi.fn();
    let calls = 0;
    let postalId = 0;
    let contactId = 0;
    const page = () => context.pages().find((page) => page.url() === url)!;
    service = createApplicationService({
      jobs,
      applications,
      browser: runtime,
      aiClient: {
        ...createDeterministicJobFinderAiClient(),
        chatWithTools: async (messages) => {
          const turn = ++calls;
          const facts = JSON.stringify(messages);
          const observation = await createApplyPageHands(
            createPlaywrightApplyPageMechanics(page()),
          ).observe();
          const field = (label: string) =>
            observation.controls.find((control) => control.label === label)!
              .ref;
          const postal = () => field("ZIP or postcode");
          const contact = () => field("When can we call?");
          const call = (name: string, args: object) => ({
            toolCalls: [
              {
                id: `decision_${turn}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
          switch (turn) {
            case 1:
              return call("finish", {
                reason: "I need the postal code and a contact time.",
                forPerson: [postal(), contact()],
              });
            case 2:
              expect(facts).toContain("01234");
              expect(facts).toContain("pendingQuestions");
              return call("type", { ref: postal(), text: "01234" });
            case 3:
              expect(await page().locator("[name=postal]").inputValue()).toBe(
                "01234",
              );
              return call("finish", {
                reason:
                  "The profile supplied the postal code. I still need a contact time.",
                settledQuestionIds: [postalId],
                forPerson: [contact()],
              });
            case 4:
              expect(facts).toContain("Weekdays after 2 PM");
              expect(await page().locator("[name=postal]").inputValue()).toBe(
                "01234",
              );
              return call("type", {
                ref: contact(),
                text: "Weekdays after 2 PM",
              });
            case 5:
              return call("finish", {
                reason: "The form is ready for review.",
                settledQuestionIds: [contactId],
              });
            default:
              throw new Error(`Unexpected model turn ${turn}`);
          }
        },
      },
      documentManager: {
        listResumeTemplates: () => [],
        renderResumePreview: () =>
          Promise.reject(Error("Original resume needs no preview")),
        renderResumeArtifact: () =>
          Promise.reject(Error("Original resume needs no rendering")),
      },
      authorityRepository: createSendGuards(jobs),
      readInputs: () =>
        Promise.resolve({
          profile: profile.read(),
          settings: seed.settings,
          searchPreferences: seed.searchPreferences,
        }),
      isPaused: () => Promise.resolve(false),
      isHoldingCurrent: () => Promise.resolve(false),
      authorizeSending: () => Promise.resolve(null),
      onError,
    });
    await service.start();
    applications.applyJobs({ selection: { ids } }, "confirm_before_submit");
    await vi.waitFor(
      () => {
        const row = applications.listApplications().rows[0];
        expect(row?.error).toBeNull();
        expect(row?.state).toBe("needs_you");
      },
      { timeout: 5_000 },
    );
    expect(applications.needsYou.list().total).toBe(2);
    const first = applications.listApplications().rows[0]!;
    const cards = applications.needsYou.list().rows;
    postalId = cards.find(({ prompt }) => prompt === "ZIP or postcode")!.id;
    contactId = cards.find(({ prompt }) => prompt === "When can we call?")!.id;
    const editAt = Date.now();
    clock.mockReturnValue(editAt);
    profile.patch({ fields: { postalCode: "01234" } });
    clock.mockReturnValue(editAt + 10_000);
    await vi.waitFor(
      () =>
        expect(applications.needsYou.list().rows.map(({ id }) => id)).toEqual([
          contactId,
        ]),
      { timeout: 5_000 },
    );
    expect(applications.getApplication(first.id)).toMatchObject({
      state: "needs_you",
      attempt: 2,
    });
    expect(await page().locator("[name=postal]").inputValue()).toBe("01234");
    const savedAt = Date.now();
    applications.needsYou.remember({
      key: "contact_hours",
      scope: {},
      prompt: "Good contact hours",
      input: "text",
      options: [],
      answer: "Weekdays after 2 PM",
    });
    clock.mockReturnValue(savedAt + 10_000);
    await vi.waitFor(
      () =>
        expect(applications.getApplication(first.id)).toMatchObject({
          state: "ready",
          attempt: 3,
        }),
      { timeout: 5_000 },
    );
    expect(applications.needsYou.list().total).toBe(0);
    expect(applications.getWork(first.id)?.reviewCard?.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ answer: "Weekdays after 2 PM" }),
      ]),
    );
    expect(calls).toBe(5);
    expect(formLoads).toBe(1);
    expect(sends).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    service?.stop();
    await browser?.close();
    await new Promise<void>((resolve) => replica.close(() => resolve()));
    jobs.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
