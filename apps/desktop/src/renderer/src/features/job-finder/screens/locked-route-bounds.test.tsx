// @vitest-environment jsdom

/**
 * PKG-01 guard — "primary action in reach".
 *
 * Two structural rules the four locked routes must keep, plus the one reveal
 * mechanism the three list/detail routes must share:
 *
 * 1. A locked route owns its own scrolling, so it must bound itself to the
 *    route viewport by passing `lockContentHeight` and/or `bottomContent` to
 *    `LockedScreenLayout`. Without either, the layout grid's `1fr` row resolves
 *    to max-content, every pane grows past the fold, and the route's primary
 *    action leaves the screen.
 * 2. It follows that no `data-locked-pane-scroll-region` pane may live inside
 *    an unbounded locked layout: such a pane advertises a scroll owner that can
 *    never get a scroll range.
 * 3. Find jobs, Shortlisted and Applications all stack list over detail below
 *    the `xl` (1280px) breakpoint, so all three must reveal the stacked detail
 *    region on selection. Anything else means a click that changes nothing the
 *    user can see.
 *
 * `LOCKED_LAYOUT_SCREENS` is a module-level `const` in `job-finder-shell.tsx`
 * with no `export` (`job-finder-page.tsx` re-declares it for the same reason),
 * so rule 1 derives the list from that source rather than adding a production
 * export just for a test.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationRecord,
  BrowserSessionState,
  ResumeSourceDocument,
  ReviewQueueItem,
} from "@nestor/contracts";
import { ApplicationRecordSchema } from "@nestor/contracts";
import { ApplicationsScreen } from "./applications/applications-screen";
import { ReviewQueueScreen } from "./review-queue/review-queue-screen";
import {
  DISCOVERY_DETAIL_REGION_ID,
  revealDiscoveryDetailAfterPointerSelection,
} from "./discovery/discovery-accessibility";
import type { TailoredDraftPreparationViewState } from "./review-queue/review-queue-status";

const SCREENS_DIR = dirname(fileURLToPath(import.meta.url));
const FEATURE_DIR = join(SCREENS_DIR, "..");
const SCROLL_REGION_MARKER = "data-locked-pane-scroll-region";

/** Route id -> the screen file that renders that route's LockedScreenLayout. */
const LOCKED_SCREEN_FILES: Readonly<Record<string, string>> = {
  profile: "screens/profile-screen.tsx",
  discovery: "screens/discovery/discovery-screen.tsx",
  "review-queue": "screens/review-queue/review-queue-screen.tsx",
  applications: "screens/applications/applications-screen.tsx",
};

/** Feature-relative path prefix -> the locked route that owns those files. */
const ROUTE_OWNERSHIP: readonly (readonly [string, string])[] = [
  ["screens/profile-screen.tsx", "profile"],
  ["components/profile/", "profile"],
  ["screens/discovery/", "discovery"],
  ["screens/review-queue/", "review-queue"],
  ["screens/applications/", "applications"],
];

function readFeatureSource(relativePath: string): string {
  return readFileSync(join(FEATURE_DIR, relativePath), "utf8");
}

function listFeatureSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listFeatureSourceFiles(absolute));
      continue;
    }

    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }

    files.push(relative(FEATURE_DIR, absolute).split(sep).join("/"));
  }

  return files;
}

/**
 * The locked routes exactly as the shell declares them. Parsed from source on
 * purpose: a route added to the shell list without a mapping here fails the
 * guard instead of silently escaping it.
 */
function readLockedLayoutScreens(): readonly string[] {
  const source = readFeatureSource("components/job-finder-shell.tsx");
  const declaration = /const LOCKED_LAYOUT_SCREENS[^=]*=\s*\[([\s\S]*?)\]/.exec(
    source,
  );

  if (!declaration?.[1]) {
    throw new Error(
      "LOCKED_LAYOUT_SCREENS declaration not found in job-finder-shell.tsx",
    );
  }

  return Array.from(declaration[1].matchAll(/"([^"]+)"/g)).map(
    (match) => match[1] as string,
  );
}

/**
 * The props text of a file's `<LockedScreenLayout` opening tag. Brace depth is
 * tracked so a `>` inside an expression prop (an arrow function, for instance)
 * is not mistaken for the end of the tag.
 */
function readLockedScreenLayoutProps(source: string, label: string): string {
  const start = source.indexOf("<LockedScreenLayout");

  if (start < 0) {
    throw new Error(`${label} does not render a LockedScreenLayout`);
  }

  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    } else if (character === ">" && depth === 0) {
      return source.slice(start, index);
    }
  }

  throw new Error(`${label} has an unterminated LockedScreenLayout tag`);
}

function isBoundedLayout(props: string): boolean {
  return /\blockContentHeight\b/.test(props) || /\bbottomContent\b/.test(props);
}

function ownerRouteForFile(relativePath: string): string | null {
  return (
    ROUTE_OWNERSHIP.find(([prefix]) => relativePath.startsWith(prefix))?.[1] ??
    null
  );
}

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

/**
 * One stub for all three routes: below 1280px / 80rem. Find jobs asks
 * `(width < 80rem)` and Applications and Shortlisted ask
 * `(min-width: 1280px)`, so answering both correctly from one viewport is
 * itself part of the parity claim.
 */
function stubStackedViewport(): void {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: /width\s*<\s*80rem/.test(query),
      media: query,
    })),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
}

function spyOnScrollIntoView(elementId: string): ReturnType<typeof vi.fn> {
  const element = document.getElementById(elementId);

  if (!element) {
    throw new Error(`No element with id "${elementId}" was rendered`);
  }

  const scrollIntoView = vi.fn();
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });

  return scrollIntoView;
}

function createTrackedApplication(): ApplicationRecord {
  return ApplicationRecordSchema.parse({
    id: "application_beta",
    jobId: "job_beta",
    title: "Backend Engineer",
    company: "Beta",
    status: "approved",
    lastActionLabel: "Prepared",
    nextActionLabel: "Review",
    lastUpdatedAt: "2026-08-15T10:00:00.000Z",
    crm: {
      stage: "ready_for_approval",
      stageChangedAt: "2026-08-15T10:00:00.000Z",
    },
  });
}

function renderApplicationsScreen(
  onSelectRecord: (recordId: string) => void,
): ApplicationRecord {
  const record = createTrackedApplication();

  render(
    <MemoryRouter>
      <ApplicationsScreen
        applicationAttempts={[]}
        applicationRecords={[record]}
        applyRuns={[]}
        applyJobResults={[]}
        discoveryJobs={[]}
        isApplyPending={false}
        isApplyRequestPending={() => false}
        isApplyRunPending={() => false}
        onApproveApplyRun={vi.fn()}
        onCancelApplyRun={vi.fn()}
        onClearApplicationAnswer={vi.fn(() =>
          Promise.reject(new Error("unused in this scenario")),
        )}
        onExportApplicationPacket={vi.fn()}
        onGetApplyRunDetails={vi.fn()}
        onResolveApplyConsentRequest={vi.fn()}
        onRevokeApplyRunApproval={vi.fn()}
        onSaveApplicationAnswer={vi.fn(() =>
          Promise.reject(new Error("unused in this scenario")),
        )}
        onSelectRecord={onSelectRecord}
        onStartApplyCopilot={vi.fn()}
        onStartAutoApplyQueue={vi.fn()}
        selectedApplyRunId={null}
        selectedAttempt={null}
        selectedRecord={record}
      />
    </MemoryRouter>,
  );

  return record;
}

function createQueueItem(jobId: string): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function createIdleDraftPreparation(): TailoredDraftPreparationViewState {
  return {
    attemptedCount: 0,
    completedCount: 0,
    currentIndex: null,
    eligibleRemainingCount: 0,
    failedCount: 0,
    status: "idle",
    totalCount: 0,
  };
}

function renderReviewQueueScreen(
  onSelectItem: (jobId: string) => void,
): readonly ReviewQueueItem[] {
  const queue = [createQueueItem("job_a"), createQueueItem("job_b")];

  render(
    <MemoryRouter>
      <ReviewQueueScreen
        actionState={{ message: null }}
        applicationRecords={[]}
        browserSession={
          {
            source: "user",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser",
            detail: null,
            lastCheckedAt: "2026-08-20T00:00:00.000Z",
          } as unknown as BrowserSessionState
        }
        campaignId="campaign_1"
        draftPreparation={createIdleDraftPreparation()}
        isApplyPending={false}
        isJobPending={() => false}
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={vi.fn(() => Promise.resolve(true))}
        onOpenBrowserSession={vi.fn()}
        onOpenJobDetails={vi.fn()}
        onOpenProfile={vi.fn()}
        onPrepareTailoredDrafts={vi.fn()}
        onRemoveReviewJob={vi.fn()}
        onSelectItem={onSelectItem}
        onSetJobResumeApplicationMode={vi.fn()}
        onStartApplyCopilot={vi.fn()}
        onStartAutoApplyQueue={vi.fn(() =>
          Promise.resolve({ status: "confirmed" as const }),
        )}
        onStopTailoredDraftPreparation={vi.fn()}
        originalResume={
          {
            id: "resume_base",
            fileName: "base-resume.pdf",
            uploadedAt: "2026-08-20T00:00:00.000Z",
          } as unknown as ResumeSourceDocument
        }
        queue={queue}
        selectedAsset={null}
        selectedItem={queue[0] ?? null}
        selectedJob={null}
      />
    </MemoryRouter>,
  );

  return queue;
}

describe("locked route bounds", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("bounds every locked route's LockedScreenLayout to the route viewport", () => {
    const lockedScreens = readLockedLayoutScreens();

    expect(lockedScreens.length).toBeGreaterThan(0);

    for (const screenId of lockedScreens) {
      const file = LOCKED_SCREEN_FILES[screenId];

      expect(
        file,
        `${screenId} is a locked route with no screen file mapped in this guard`,
      ).toBeTruthy();

      const props = readLockedScreenLayoutProps(
        readFeatureSource(file as string),
        file as string,
      );

      expect(
        isBoundedLayout(props),
        `${file} must pass lockContentHeight and/or bottomContent; a locked route with neither has no viewport bound and its primary action leaves the screen`,
      ).toBe(true);
    }
  });

  it("keeps every data-locked-pane-scroll-region inside a bounded locked layout", () => {
    const markedFiles = listFeatureSourceFiles(FEATURE_DIR).filter(
      (file) =>
        // The layout itself only queries the marker; it never declares a pane.
        file !== "components/locked-screen-layout.tsx" &&
        readFeatureSource(file).includes(SCROLL_REGION_MARKER),
    );

    expect(markedFiles.length).toBeGreaterThan(0);

    for (const file of markedFiles) {
      const route = ownerRouteForFile(file);

      expect(
        route,
        `${file} declares ${SCROLL_REGION_MARKER} but belongs to no locked route known to this guard`,
      ).toBeTruthy();

      const screenFile = LOCKED_SCREEN_FILES[route as string] as string;
      const props = readLockedScreenLayoutProps(
        readFeatureSource(screenFile),
        screenFile,
      );

      expect(
        isBoundedLayout(props),
        `${file} advertises a pane scroll owner, but ${screenFile} renders an unbounded LockedScreenLayout, so that pane can never get a scroll range`,
      ).toBe(true);
    }
  });

  it("marks the Applications layout as height-locked in the DOM", () => {
    stubStackedViewport();
    renderApplicationsScreen(vi.fn());

    const lockedContent = document.querySelector(
      '[data-locked-screen-content-height="locked"]',
    );

    expect(lockedContent).toBeTruthy();

    const regions = Array.from(
      document.querySelectorAll(`[${SCROLL_REGION_MARKER}]`),
    );

    expect(regions.length).toBeGreaterThan(0);

    for (const region of regions) {
      expect(lockedContent?.contains(region)).toBe(true);
    }
  });

  it("reveals the stacked detail region on selection for Find jobs, Shortlisted and Applications", async () => {
    // Find jobs — the shared helper its result rows call on pointer selection.
    stubStackedViewport();
    const discoveryRegion = document.createElement("div");
    discoveryRegion.id = DISCOVERY_DETAIL_REGION_ID;
    document.body.append(discoveryRegion);
    const discoveryScrollIntoView = spyOnScrollIntoView(
      DISCOVERY_DETAIL_REGION_ID,
    );

    revealDiscoveryDetailAfterPointerSelection();
    await Promise.resolve();

    expect(discoveryScrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(
      readFeatureSource("screens/discovery/discovery-results-panel.tsx"),
    ).toContain("revealDiscoveryDetailAfterPointerSelection()");
    discoveryRegion.remove();

    // Applications.
    const onSelectRecord = vi.fn();
    const record = renderApplicationsScreen(onSelectRecord);
    const applicationsScrollIntoView = spyOnScrollIntoView(
      "applications-detail-content",
    );

    fireEvent.click(
      document.querySelector(
        `[data-collection-item-id="${record.id}"]`,
      ) as HTMLElement,
    );

    expect(onSelectRecord).toHaveBeenCalledWith(record.id);
    expect(applicationsScrollIntoView).toHaveBeenCalledWith({
      block: "start",
    });
    cleanup();

    // Shortlisted.
    const onSelectItem = vi.fn();
    const queue = renderReviewQueueScreen(onSelectItem);
    const reviewQueueScrollIntoView = spyOnScrollIntoView(
      "review-queue-workspace-panel",
    );

    fireEvent.click(
      document.querySelector(
        `[data-collection-item-id="${queue[1]?.jobId}"]`,
      ) as HTMLElement,
    );

    expect(onSelectItem).toHaveBeenCalledWith(queue[1]?.jobId);
    expect(reviewQueueScrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("does not reveal the stacked detail region at two-pane widths", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: /min-width:\s*1280px/.test(query),
        media: query,
      })),
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );

    const queue = renderReviewQueueScreen(vi.fn());
    const scrollIntoView = spyOnScrollIntoView("review-queue-workspace-panel");

    fireEvent.click(
      document.querySelector(
        `[data-collection-item-id="${queue[1]?.jobId}"]`,
      ) as HTMLElement,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
