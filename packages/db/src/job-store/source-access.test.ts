import { afterEach, expect, test } from "vitest";
import { createApplicationStore } from "./applications";
import { createJobSitesStore } from "./job-sites";
import { approveOriginalResumesForTests, openJobStore } from "./job-store";
import { createSourceAccessStore } from "./source-access";

const store = openJobStore(":memory:");
afterEach(() => store.db.exec("DELETE FROM job_sites; DELETE FROM needs_you;"));
test("one access item per site survives repeated searches and failed retries; only verified success closes it", () => {
  const sites = createJobSitesStore(store),
    access = createSourceAccessStore(store),
    inbox = createApplicationStore(store).needsYou;
  const a = sites.add({
    text: "https://jobs.example.test/team-a",
  }).firstAddedId!;
  const b = sites.add({
    text: "https://jobs.example.test/team-b",
  }).firstAddedId!;
  const id = access.request(a, "Open the site and sign in, then Retry.");
  for (let i = 0; i < 10; i++)
    expect(access.request(a, "Open the site and sign in, then Retry.")).toBe(
      id,
    );
  access.request(b, "Check access, then Retry.");
  expect(inbox.list().rows).toHaveLength(2);
  expect(inbox.list().rows[0]).toMatchObject({
    id,
    kind: "sign_in",
    source: { id: a, url: "https://jobs.example.test/team-a" },
  });
  expect(access.pending(a)).toBe(true);
  expect(access.complete(a)).toBe(true);
  expect(inbox.list().rows).toHaveLength(1);
  expect(access.request(a, "Your session expired. Sign in again.")).toBe(id);
  expect(inbox.list().rows).toHaveLength(2);
});
test("editing a URL or removing a site retires its old access item without touching application tickets", () => {
  const sites = createJobSitesStore(store),
    access = createSourceAccessStore(store),
    inbox = createApplicationStore(store).needsYou;
  const id = sites.add({ text: "https://jobs.example.test/old" }).firstAddedId!;
  access.request(id, "Sign in.");
  sites.update({ id, url: "https://jobs.example.test/new" });
  expect(access.pending(id)).toBe(false);
  expect(inbox.list().rows).toHaveLength(0);
  access.request(id, "Check new site.");
  expect(inbox.list().rows[0]?.source?.url).toBe(
    "https://jobs.example.test/new",
  );
  sites.remove(id);
  expect(inbox.list().rows).toHaveLength(0);
});
test("Needs you lists application items and site sign-ins as separate groups", () => {
  const sites = createJobSitesStore(store),
    access = createSourceAccessStore(store),
    inbox = createApplicationStore(store).needsYou;
  const site = sites.add({
    text: "https://jobs.example.test/gated",
  }).firstAddedId!;
  const sign = access.request(site, "Sign in.")!;
  const { added } = store.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Engineer",
        company: "Employer",
        location: "Remote",
        workModes: ["remote"],
        url: "https://apply.example.test/1",
        applyUrl: null,
        sourceId: "board",
        sourceLabel: "Board",
        sourceJobId: "1",
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Synthetic job",
      },
    ],
  });
  approveOriginalResumesForTests(store, added);
  const applications = createApplicationStore(store);
  applications.applyJobs({ selection: { ids: added } });
  const running = applications.claimNext()!;
  const blocked = inbox.request({
    applicationId: running.id,
    attempt: running.attempt,
    fieldKey: "login",
    key: "login",
    scope: { siteOrigin: "https://apply.example.test" },
    prompt: "Sign in to continue",
    kind: "sign_in",
    input: "text",
    options: [],
  });
  if (blocked.status !== "needs_you") throw new Error("Missing item");
  expect(inbox.list({ group: "sites" })).toMatchObject({
    rows: [{ id: sign, source: { id: site } }],
    total: 1,
  });
  expect(inbox.list({ group: "applications" })).toMatchObject({
    rows: [{ id: blocked.task.id }],
    total: 1,
  });
  expect(inbox.list().rows).toHaveLength(2);
});
