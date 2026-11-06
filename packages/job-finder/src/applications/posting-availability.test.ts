import { expect, test, vi } from "vitest";
import { JobPostingSchema } from "@nestor/contracts";
import { createSeed } from "../test-fixtures";
import { readPostingAvailability } from "./posting-availability";

const job = {
  url: "https://jobs.example.test/role/1",
  title: "Software Engineer",
};
const posting = JobPostingSchema.parse({
  ...createSeed().savedJobs[0],
  title: job.title,
  description: "Build software with the product team.",
});
function input(
  html = "<h1>Software Engineer</h1><p>Build software with the product team. Apply now.</p>",
  status = 200,
) {
  return {
    job,
    signal: new AbortController().signal,
    fetchHtml: vi.fn(() =>
      Promise.resolve({ html, status, finalUrl: job.url }),
    ),
    aiClient: { extractJobsFromPage: vi.fn(() => Promise.resolve([posting])) },
  };
}

test.each([404, 410])(
  "a removed posting is closed from its HTTP status (%s)",
  async (status) => {
    const args = input("", status);
    expect(await readPostingAvailability(args)).toMatchObject({
      state: "closed",
    });
    expect((await readPostingAvailability(args)).reason).toContain(
      String(status),
    );
    expect(args.aiClient.extractJobsFromPage).not.toHaveBeenCalled();
  },
);

test.each([
  "This job is no longer taking applications",
  "Job not found",
  "This posting is no longer available",
])("explicit removal evidence closes the posting: %s", async (text) => {
  expect(
    await readPostingAvailability(input(`<h1>${text}</h1>`)),
  ).toMatchObject({ state: "closed" });
});

test("open postings go through the existing model detail reader", async () => {
  const args = input();
  expect(await readPostingAvailability(args)).toMatchObject({ state: "open" });
  expect(args.aiClient.extractJobsFromPage).toHaveBeenCalledWith(
    expect.objectContaining({ pageType: "job_detail", maxJobs: 1 }),
  );
});

test("access failures, empty pages and network errors are unknown, never closed", async () => {
  expect(await readPostingAvailability(input("Forbidden", 403))).toMatchObject({
    state: "unknown",
  });
  const empty = input();
  empty.aiClient.extractJobsFromPage.mockResolvedValue([]);
  expect(await readPostingAvailability(empty)).toMatchObject({
    state: "unknown",
  });
  const failed = input();
  failed.fetchHtml.mockRejectedValue(new Error("Network unavailable"));
  expect(await readPostingAvailability(failed)).toMatchObject({
    state: "unknown",
  });
  expect((await readPostingAvailability(failed)).reason).toContain(
    "Network unavailable",
  );
});

test("an authenticated rendered detail can resolve an HTTP access wall", async () => {
  const args = input("Forbidden", 403);
  const readRenderedPage = vi.fn(() =>
    Promise.resolve({
      html: "<h1>Software Engineer</h1><p>Apply now</p>",
      finalUrl: job.url,
    }),
  );
  expect(
    await readPostingAvailability({ ...args, readRenderedPage }),
  ).toMatchObject({ state: "open" });
  expect(readRenderedPage).toHaveBeenCalledOnce();
});

test("a closed rendered page is closed without treating the sign-in wall as closure", async () => {
  const args = input("Forbidden", 403);
  expect(
    await readPostingAvailability({
      ...args,
      readRenderedPage: () =>
        Promise.resolve({
          html: "<h1>Job not found</h1>",
          finalUrl: job.url,
        }),
    }),
  ).toMatchObject({ state: "closed" });
});

test("a careers redirect showing another role is unknown rather than open", async () => {
  const args = input();
  args.aiClient.extractJobsFromPage.mockResolvedValue([
    { ...posting, title: "Accounting Director" },
  ]);
  expect((await readPostingAvailability(args)).state).toBe("unknown");
});
