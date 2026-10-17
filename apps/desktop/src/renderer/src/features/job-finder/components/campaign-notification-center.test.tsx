// @vitest-environment jsdom

import type { CampaignNotification } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignNotificationCenter } from "./campaign-notification-center";

afterEach(cleanup);

function notification(
  id: string,
  overrides: Partial<CampaignNotification> = {},
): CampaignNotification {
  return {
    id,
    campaignId: "campaign-1",
    kind: "strong_match",
    title: `Notification ${id}`,
    body: null,
    createdAt: "2026-08-15T10:00:00.000Z",
    readAt: null,
    unread: true,
    jobId: null,
    sourceTargetId: null,
    ...overrides,
  };
}

function renderCenter(
  props: Partial<Parameters<typeof CampaignNotificationCenter>[0]> = {},
) {
  const defaults = {
    notifications: [],
    pendingMarkAll: false,
    pendingNotificationId: () => false,
    onMarkAllRead: vi.fn(),
    onMarkRead: vi.fn(),
  };
  const onMarkAllRead = defaults.onMarkAllRead;
  const onMarkRead = defaults.onMarkRead;
  render(
    <CampaignNotificationCenter
      {...defaults}
      onMarkAllRead={props.onMarkAllRead ?? onMarkAllRead}
      onMarkRead={props.onMarkRead ?? onMarkRead}
      {...props}
    />,
  );
  return { onMarkAllRead, onMarkRead };
}

describe("CampaignNotificationCenter", () => {
  it("shows an empty state when there are no notifications", () => {
    renderCenter();
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("shows a loading state without an empty-state claim", () => {
    renderCenter({ loading: true });
    expect(screen.getByText(/Loading notifications/)).toBeTruthy();
    expect(screen.queryByText(/Nothing here yet/)).toBeNull();
  });

  it("shows an error message with an alert role", () => {
    renderCenter({ errorMessage: "The workspace could not be loaded." });
    expect(screen.getByRole("alert").textContent).toContain(
      "The workspace could not be loaded.",
    );
  });

  it("reports the unread count and marks one notification read", () => {
    const { onMarkRead } = renderCenter({
      notifications: [
        notification("n-1"),
        notification("n-2", {
          unread: false,
          readAt: "2026-08-15T11:00:00.000Z",
        }),
      ],
    });

    expect(screen.getByText(/1 unread/)).toBeTruthy();
    const markReadButtons = screen.getAllByRole("button", {
      name: "Mark read",
    });
    expect(markReadButtons).toHaveLength(1);
    fireEvent.click(markReadButtons[0]!);
    expect(onMarkRead).toHaveBeenCalledWith("n-1");
  });

  it("marks all unread notifications read through the header action", () => {
    const { onMarkAllRead } = renderCenter({
      notifications: [notification("n-1"), notification("n-2")],
    });

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("disables mark-all-read while a mark-all action is pending", () => {
    renderCenter({
      notifications: [notification("n-1")],
      pendingMarkAll: true,
    });
    expect(
      screen
        .getByRole("button", { name: "Mark all read" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Mark all read" })
        .getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("sorts notifications newest first and marks read items as read", () => {
    renderCenter({
      notifications: [
        notification("older", {
          createdAt: "2026-08-14T10:00:00.000Z",
        }),
        notification("newer", {
          createdAt: "2026-08-16T10:00:00.000Z",
        }),
        notification("read-item", {
          createdAt: "2026-08-15T10:00:00.000Z",
          unread: false,
          readAt: "2026-08-15T12:00:00.000Z",
        }),
      ],
    });

    const titles = screen
      .getAllByText(/Notification (older|newer|read-item)/)
      .map((node) => node.textContent);
    expect(titles).toEqual([
      "Notification newer",
      "Notification read-item",
      "Notification older",
    ]);
    expect(screen.getAllByText("Read")).toHaveLength(1);
  });

  it("opens a failed application's actual recovery instead of an empty Needs you page", () => {
    const onNavigate = vi.fn();
    renderCenter({
      applicationRecoveryRecords: [
        { jobId: "job_failed", applicationRecordId: "application_failed" },
      ],
      notifications: [
        notification("failed", {
          kind: "blocked_work",
          jobId: "job_failed",
        }),
      ],
      onNavigate,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Applications" }));
    expect(onNavigate).toHaveBeenCalledWith(
      "/job-finder/applications?applicationRecordId=application_failed&jobId=job_failed",
    );
  });
});

it("explains a failed source without rendering a browser stack", () => {
  renderCenter({
    notifications: [
      notification("failed", {
        kind: "blocked_work",
        sourceTargetId: "midnite",
        title: "Midnite could not be opened",
        body: "page.goto: Timeout 30000ms exceeded\nCall log: \u001b",
      }),
    ],
  });
  expect(
    screen.getByText(/Your saved jobs and other sources are still available/),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("page.goto");
  expect(screen.getByText("Unread").className).toContain("text-foreground");
});
