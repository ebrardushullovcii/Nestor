import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createActivityStore } from "./activity";
import { createApplicationStore } from "./applications";
import { createHomeStore } from "./home";
import { openJobStore } from "./job-store";

it("keeps stored notifications from retired resume gates out of current reads after reopening", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "nestor-retired-notifications-"),
  );
  const file = path.join(directory, "jobs.sqlite");
  const now = Date.parse("2026-10-29T10:00:00Z");
  const store = openJobStore(file);
  try {
    // The old collection used shared kinds such as blocked_work, not a
    // feature-specific kind for each removed gate.
    store.db.exec(
      "CREATE TABLE singleton_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    store.sql("INSERT INTO singleton_state VALUES (?, ?)").run(
      "campaign_state",
      JSON.stringify({
        activeCampaignId: "synthetic-campaign",
        campaigns: [],
        notifications: [
          "Lines to confirm: confirm this resume's claims",
          "This resume leaves out 2 roles that Job Finder wants you to confirm first",
          "The previous resume batch did not finish. Continue batch",
        ].map((body, index) => ({
          id: `retired_${index}`,
          campaignId: "synthetic-campaign",
          kind: "blocked_work",
          title: "Resume needs attention",
          body,
          unread: true,
          readAt: null,
          jobId: null,
          sourceTargetId: null,
          createdAt: new Date(now).toISOString(),
        })),
      }),
    );
  } finally {
    store.close();
  }
  const reopened = openJobStore(file);
  try {
    // Retained legacy bytes do not become current work or a request to the
    // person. No copy matching, deletion of history, or gate revival is needed.
    expect(
      String(
        reopened
          .sql("SELECT value FROM singleton_state WHERE key = ?")
          .get("campaign_state")!.value,
      ),
    ).toContain("confirm first");
    expect(
      createHomeStore(reopened).summary({ utcOffsetMinutes: 0 }, now),
    ).toMatchObject({
      needsYou: { questions: 0, signIns: 0, checks: 0 },
      resumes: { writing: 0, toReview: 0, failed: 0 },
    });
    expect(createApplicationStore(reopened).needsYou.list().rows).toEqual([]);
    expect(createActivityStore(reopened).feed(now)).toMatchObject({
      searches: [],
      resumes: [],
      applications: [],
      moves: [],
    });
    expect(reopened.stageCounts()).toEqual({
      found: 0,
      shortlisted: 0,
      resume: 0,
      applied: 0,
      hidden: 0,
    });
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
