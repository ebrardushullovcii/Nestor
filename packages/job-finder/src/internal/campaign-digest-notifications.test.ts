import {
  CampaignNotificationSchema,
  type CampaignNotification,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  deriveCampaignNotifications,
  describeJobSourceWorkTitle,
  MAX_CAMPAIGN_NOTIFICATIONS,
  mergeCampaignNotifications,
} from "./campaign-digest-notifications";

function notification(
  id: string,
  createdAt: string,
  campaignId = "campaign-1",
): CampaignNotification {
  return CampaignNotificationSchema.parse({
    id,
    campaignId,
    kind: "digest_ready",
    title: `Notification ${id}`,
    body: null,
    createdAt,
    readAt: null,
    unread: true,
    jobId: null,
    sourceTargetId: null,
  });
}

describe("mergeCampaignNotifications", () => {
  test("merges lists and dedupes by id keeping the existing notification", () => {
    const existing = [
      notification("n-1", "2026-07-01T00:00:00.000Z"),
      notification("n-2", "2026-07-02T00:00:00.000Z"),
    ];
    const incoming = [
      notification("n-2", "2026-07-03T00:00:00.000Z"),
      notification("n-3", "2026-07-04T00:00:00.000Z"),
    ];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged.map((item) => item.id)).toEqual(["n-1", "n-2", "n-3"]);
    // Existing wins: the duplicate's original createdAt is preserved.
    expect(merged[1]?.createdAt).toBe("2026-07-02T00:00:00.000Z");
  });

  test("preserves read state of existing notifications across re-derivation", () => {
    const existing = [
      {
        ...notification("n-strong-1", "2026-07-01T00:00:00.000Z"),
        readAt: "2026-07-01T12:00:00.000Z",
        unread: false,
      },
    ];
    const incoming = [notification("n-strong-1", "2026-07-01T00:00:00.000Z")];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.unread).toBe(false);
    expect(merged[0]?.readAt).toBe("2026-07-01T12:00:00.000Z");
  });

  test("drops invalid notifications", () => {
    const merged = mergeCampaignNotifications({
      existing: [notification("n-1", "2026-07-01T00:00:00.000Z")],
      incoming: [
        { id: "n-broken" } as unknown as CampaignNotification,
        {
          ...notification("n-read-unread", "2026-07-02T00:00:00.000Z"),
          readAt: "2026-07-02T12:00:00.000Z",
          unread: true,
        },
      ],
    });

    expect(merged.map((item) => item.id)).toEqual(["n-1"]);
  });

  test("caps at 5000 keeping the newest notifications", () => {
    const existing = Array.from(
      { length: MAX_CAMPAIGN_NOTIFICATIONS },
      (_, index) =>
        notification(
          `existing-${index}`,
          new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
        ),
    );
    const incoming = [
      notification("incoming-newest", "2026-07-02T00:00:00.000Z"),
    ];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged).toHaveLength(MAX_CAMPAIGN_NOTIFICATIONS);
    expect(merged.some((item) => item.id === "incoming-newest")).toBe(true);
    // The oldest existing notification is dropped.
    expect(merged.some((item) => item.id === "existing-0")).toBe(false);
  });

  test("kept notifications retain their original relative order", () => {
    const existing = [
      notification("oldest", "2026-07-01T00:00:00.000Z"),
      notification("second", "2026-07-01T00:00:01.000Z"),
      notification("third", "2026-07-01T00:00:02.000Z"),
    ];
    const incoming = [notification("newest", "2026-07-02T00:00:00.000Z")];

    const merged = mergeCampaignNotifications({ existing, incoming });

    expect(merged.map((item) => item.id)).toEqual([
      "oldest",
      "second",
      "third",
      "newest",
    ]);
  });

  test("returns an empty list for empty inputs", () => {
    expect(mergeCampaignNotifications({ existing: [], incoming: [] })).toEqual(
      [],
    );
  });
});

describe("describeJobSourceWorkTitle", () => {
  const targets = [
    { id: "target_tzhl5nit", label: "RemoteOK" },
    { id: "target_blank", label: "   " },
  ];

  test("names a source by the label the user saved", () => {
    expect(describeJobSourceWorkTitle("target_tzhl5nit", targets)).toBe(
      "Job source RemoteOK",
    );
  });

  test("never shows the internal id when the label is gone", () => {
    expect(describeJobSourceWorkTitle("target_removed", targets)).toBe(
      "A job source",
    );
    expect(describeJobSourceWorkTitle("target_blank", targets)).toBe(
      "A job source",
    );
  });
});

describe("deriveCampaignNotifications", () => {
  test("derives blocked and failed work notifications with truthful details", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [
        {
          workId: "apply-run-1",
          jobId: "job-1",
          title: "Senior Engineer",
          reason: "Login required before applying.",
        },
        { jobId: "job-2" },
      ],
      failedWork: [
        {
          workId: "apply-run-2",
          jobId: "job-3",
          title: "Staff Engineer",
          reason: "The application form changed.",
        },
      ],
    });

    expect(notifications).toHaveLength(3);
    expect(notifications[0]).toMatchObject({
      kind: "blocked_work",
      id: "n_campaign-1_blocked_apply-run-1",
      jobId: "job-1",
      title: "Blocked: Senior Engineer",
      body: "Login required before applying.",
      unread: true,
      readAt: null,
    });
    expect(notifications[1]).toMatchObject({
      id: "n_campaign-1_blocked_job-2",
      jobId: "job-2",
      title: "Blocked: Campaign work",
      body: null,
    });
    expect(notifications[2]).toMatchObject({
      id: "n_campaign-1_failed_apply-run-2",
      jobId: "job-3",
      title: "Failed: Staff Engineer",
      body: "The application form changed.",
    });
  });

  test("skips work evidence without a work id or job id", () => {
    const notifications = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [{ title: "No ids" }, { title: "   ", workId: "" }],
      failedWork: [{}],
    });

    expect(notifications).toEqual([]);
  });

  test("uses source target identity and keeps blocked/failed identities distinct", () => {
    const blocked = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:00:00.000Z",
      blockedWork: [
        {
          sourceTargetId: "source-board",
          title: "Source check",
          reason: "Login required.",
        },
      ],
    });
    const failed = deriveCampaignNotifications({
      campaignId: "campaign-1",
      now: "2026-07-31T11:01:00.000Z",
      failedWork: [
        {
          sourceTargetId: "source-board",
          title: "Source check",
          reason: "Runtime failed.",
        },
      ],
    });

    expect(blocked[0]).toMatchObject({
      id: "n_campaign-1_blocked_source-board",
      sourceTargetId: "source-board",
    });
    expect(failed[0]).toMatchObject({
      id: "n_campaign-1_failed_source-board",
      sourceTargetId: "source-board",
    });
    expect(blocked[0]?.id).not.toBe(failed[0]?.id);
  });
});
