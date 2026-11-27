import { createServer } from "node:http";
import {
  createApplyPageHands,
  describeObservation,
  runApplyAgent,
} from "@nestor/browser-agent";
import { CandidateProfileSchema } from "@nestor/contracts";
import { chromium, type Browser } from "playwright";
import { expect, test } from "vitest";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

const resume = {
  name: "synthetic-resume.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4 synthetic resume"),
};
const confirmation = "Your application was received.";
const form = `<!doctype html><title>Replica application</title>
<form method="post" enctype="multipart/form-data">
  <div>
    <label for="resume">Resume</label>
    <input id="resume" name="resume" type="file" aria-describedby="filename">
    <p id="filename" role="status"></p>
  </div>
  <section aria-label="Portfolio upload">
    <button type="button">Replace portfolio</button>
    <p role="status">portfolio.pdf uploaded</p>
  </section>
  <button>Submit application</button>
</form>
<script>
  const file = document.querySelector('#resume');
  const filename = document.querySelector('#filename');
  filename.textContent = sessionStorage.getItem('filename') || '';
  file.addEventListener('change', () => {
    filename.textContent = file.files[0].name;
    sessionStorage.setItem('filename', filename.textContent);
  });
</script>`;

test("a continued application sees a stale filename and reattaches before submitting", async () => {
  const posts: Array<{ name: string; bytes: Buffer } | null> = [];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.method !== "POST") {
      response.end(form);
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const data = await new Request("http://replica/", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"]! },
        body: Buffer.concat(chunks),
      }).formData();
      const file = data.get("resume");
      if (file instanceof File && file.size > 0) {
        posts.push({
          name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        response.end(`<h1>${confirmation}</h1>`);
      } else {
        posts.push(null);
        response.statusCode = 422;
        response.end("<h1>Your resume failed to upload.</h1>");
      }
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No replica port");
    const url = `http://127.0.0.1:${address.port}/apply`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url);
    const raw = createPlaywrightApplyPageMechanics(page);
    const hands = createApplyPageHands(raw);
    const input = page.locator("#resume");
    await input.setInputFiles(resume);
    const attached = `native file input: 1 file ${JSON.stringify([{ name: resume.name, size: resume.buffer.length }])}`;
    const selected = describeObservation(await hands.observe());
    expect(selected).toMatch(
      /\[file\] · Resume · optional · already answered/u,
    );
    expect(selected).toContain(
      `"fileName":"${resume.name}","fileSize":${resume.buffer.length}`,
    );
    expect(selected).toContain("portfolio.pdf uploaded");
    expect(selected.match(/\[file\]/gu)).toHaveLength(1);

    await page.reload();
    expect(await page.locator("#filename").innerText()).toBe(resume.name);
    expect(
      await input.evaluate(
        (element: HTMLInputElement) => element.files?.length,
      ),
    ).toBe(0);

    const decisions: string[] = [];
    const modelViews: string[] = [];
    const result = await runApplyAgent(
      {
        hands,
        application: {
          jobId: "replica",
          applicationId: "replica",
          startingUrl: url,
          continuation: { sourceUrls: [url] },
        },
        siteLabel: "Replica",
        authority: {
          mode: "autonomous_submit",
          submitAuthorized: true,
          allowedOrigins: [new URL(url).origin],
          preApprovedAttestationKinds: [],
          salaryDisclosure: "answer_from_profile",
        },
        sources: {
          profile: CandidateProfileSchema.parse({
            id: "replica",
            fullName: "Alex Example",
            yearsExperience: 1,
            baseResume: {
              id: "resume",
              fileName: resume.name,
              uploadedAt: "2026-11-27T00:00:00Z",
            },
          }),
          posting: {
            title: "Engineer",
            company: "Replica",
            location: "Remote",
            description: "Synthetic listing",
          },
          resumeText: null,
          reusableAnswers: [],
          documents: [
            {
              id: "resume",
              kind: "resume",
              label: "Synthetic resume",
              fileName: resume.name,
              mimeType: resume.mimeType,
              loadBytes: () => Promise.resolve(resume.buffer),
            },
          ],
        },
        submitApplication: async ({ actionRef }) => {
          await raw.clickElement(actionRef);
          await page.getByRole("heading", { name: confirmation }).waitFor();
          return {
            outcome: "outcome_uncertain",
            content: confirmation,
          };
        },
        recordSendOutcome: ({ sendCallId, outcome, evidence }) => {
          const recorded =
            sendCallId === "replica-2" &&
            outcome === "confirmed" &&
            evidence === confirmation;
          return Promise.resolve({ recorded, content: evidence });
        },
      },
      {
        chatWithTools: (messages) => {
          const call = (name: string, args: object) => {
            decisions.push(name);
            return Promise.resolve({
              toolCalls: [
                {
                  id: `replica-${decisions.length}`,
                  type: "function" as const,
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            });
          };
          const view =
            messages
              .map(({ content }) => content ?? "")
              .findLast((content) => content.includes(`Page: ${url}`)) ?? "";
          const field = /^- (\w+) \[file\].*$/mu.exec(view);
          if (field) modelViews.push(field[0]);
          if (
            decisions.length === 0 &&
            field?.[1] &&
            field[0].includes("native file input: 0 files")
          ) {
            return call("upload", { ref: field[1], documentId: "resume" });
          }
          const submit = /^- (\w+): Submit application/mu.exec(view)?.[1];
          if (
            decisions.length === 1 &&
            submit &&
            field?.[0].includes(attached)
          ) {
            return call("submit_application", { ref: submit });
          }
          if (decisions.length === 2 && view.includes(confirmation)) {
            return call("record_send_outcome", {
              sendCallId: "replica-2",
              outcome: "confirmed",
              evidence: confirmation,
            });
          }
          return call("finish", {
            reason: view.includes(confirmation)
              ? confirmation
              : "Missing attachment observation.",
          });
        },
      },
    );
    expect(modelViews[0]).toContain(`"described":"${resume.name}"`);
    expect(modelViews[0]).toContain("native file input: 0 files");
    expect(selected).toContain(attached);
    expect(modelViews[1]).toContain(attached);
    expect(decisions).toEqual([
      "upload",
      "submit_application",
      "record_send_outcome",
      "finish",
    ]);
    expect(posts).toEqual([{ name: resume.name, bytes: resume.buffer }]);
    expect(result.outcome).toBe("submitted");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
