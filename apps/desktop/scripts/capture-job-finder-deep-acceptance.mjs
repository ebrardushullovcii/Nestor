import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const baselineWorkspacePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);
const runLabel =
  process.env.UI_CAPTURE_LABEL ?? "job-finder-deep-acceptance-20260810";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

const routeHeadings = {
  "/job-finder/profile": "Your profile",
  "/job-finder/discovery": "Find jobs",
  "/job-finder/review-queue": "Shortlisted jobs",
  "/job-finder/applications": "Applications",
  "/job-finder/actions": "Action inbox",
  "/job-finder/settings": "Settings",
};

const routeLabels = {
  "/job-finder/profile": "Profile",
  "/job-finder/discovery": "Find jobs",
  "/job-finder/review-queue": "Shortlisted",
  "/job-finder/applications": "Applications",
  "/job-finder/actions": "Needs you",
  "/job-finder/settings": "Settings",
};

const viewportMatrix = [
  { slug: "desktop", width: 1440, height: 900, zoomFactor: 1 },
  { slug: "compact-height", width: 1280, height: 720, zoomFactor: 1 },
  { slug: "minimum", width: 1024, height: 720, zoomFactor: 1 },
  { slug: "zoom-125", width: 1440, height: 900, zoomFactor: 1.25 },
  { slug: "zoom-150", width: 1440, height: 900, zoomFactor: 1.5 },
  { slug: "zoom-200", width: 1440, height: 900, zoomFactor: 2 },
  { slug: "zoom-400", width: 1280, height: 900, zoomFactor: 4 },
];

// Mirrors DISCOVERY_STACKED_LAYOUT_MEDIA_QUERY in discovery-accessibility.ts:
// below 80rem the results list and the job inspector share one page scroller,
// so pointer selection owes a block:start reveal. The literal is pinned to the
// renderer source at probe time via getStackedMediaQueryConsistency().
const DISCOVERY_STACKED_MEDIA_QUERY = "(width < 80rem)";
const DISCOVERY_ACCESSIBILITY_SOURCE_PATH = path.join(
  desktopDir,
  "src",
  "renderer",
  "src",
  "features",
  "job-finder",
  "screens",
  "discovery",
  "discovery-accessibility.ts",
);
const DISCOVERY_RESULTS_SECTION_SELECTOR =
  'section[aria-labelledby="discovery-job-results-heading"]';
const DISCOVERY_RESULT_ROW_SELECTOR =
  'section[aria-labelledby="discovery-job-results-heading"] button[data-job-result-id]';
const DISCOVERY_DETAIL_REGION_SELECTOR = "#discovery-selected-job-detail";
const DISCOVERY_DETAIL_HEADING_SELECTOR = "#discovery-selected-job-heading";
const DISCOVERY_DETAIL_ACTIONS_SELECTOR =
  '[data-testid="discovery-detail-actions"]';
const DISCOVERY_EXCLUDED_ACTION_TEST_ID = "discovery-detail-open-shortlisted";
const DISCOVERY_PRIMARY_ACTION_NAMES = [
  "Shortlist job",
  "Shortlist anyway",
  "Not interested",
];
const DISCOVERY_REVEAL_THRESHOLDS = {
  minIntersectionPx: 16,
  meaningfulShare: 0.5,
  blockStartTolerancePx: 8,
};

const discoveryRevealMeasurementPayload = {
  resultsSectionSelector: DISCOVERY_RESULTS_SECTION_SELECTOR,
  rowSelector: "button[data-job-result-id]",
  regionSelector: DISCOVERY_DETAIL_REGION_SELECTOR,
  headingId: DISCOVERY_DETAIL_HEADING_SELECTOR.slice(1),
  actionsRegionSelector: DISCOVERY_DETAIL_ACTIONS_SELECTOR,
  excludedActionTestId: DISCOVERY_EXCLUDED_ACTION_TEST_ID,
  primaryActionNames: DISCOVERY_PRIMARY_ACTION_NAMES,
  thresholds: DISCOVERY_REVEAL_THRESHOLDS,
};

let stackedMediaQueryConsistency = null;
function getStackedMediaQueryConsistency() {
  if (!stackedMediaQueryConsistency) {
    try {
      const source = readFileSync(DISCOVERY_ACCESSIBILITY_SOURCE_PATH, "utf8");
      const observed = source.match(
        /DISCOVERY_STACKED_LAYOUT_MEDIA_QUERY\s*=\s*"([^"]+)"/,
      )?.[1];
      stackedMediaQueryConsistency = {
        matched: observed === DISCOVERY_STACKED_MEDIA_QUERY,
        observedQuery: observed ?? null,
      };
    } catch (error) {
      stackedMediaQueryConsistency = {
        matched: false,
        observedQuery: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return stackedMediaQueryConsistency;
}

const report = {
  capturedAt: new Date().toISOString(),
  outputDir,
  safety: {
    syntheticCandidateDataOnly: true,
    browserAgentEnabled: false,
    applicationActionsExecuted: false,
    finalSubmissionClicked: false,
    submitAuthorized: false,
    accountCreationAuthorized: false,
  },
  runtimeErrors: [],
  captures: [],
  scenarios: {},
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function waitForCondition(
  check,
  description,
  timeoutMs = 30_000,
  intervalMs = 150,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function getWorkspace(page) {
  return page.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function completeProfileSetup(page) {
  const snapshot = await getWorkspace(page);
  const completedAt = new Date().toISOString();
  await page.evaluate(
    async ({ profileSetupState, completedAt: completionTime }) =>
      window.nestor.jobFinder.saveProfileSetupState({
        ...profileSetupState,
        status: "completed",
        currentStep: "ready_check",
        completedAt: completionTime,
        lastResumedAt: completionTime,
      }),
    {
      profileSetupState: snapshot.profileSetupState,
      completedAt,
    },
  );
}

async function navigate(page, route) {
  await page.evaluate((nextRoute) => {
    window.location.hash = `#${nextRoute}`;
  }, route);
  const heading = routeHeadings[route];
  if (heading) {
    await page
      .getByRole("heading", { level: 1, name: heading })
      .waitFor({ state: "visible", timeout: 20_000 });
    const label = routeLabels[route];
    await page.waitForFunction(
      (expectedLabel) => {
        const main = document.querySelector("main");
        return (
          document.activeElement === main &&
          document.title === `${expectedLabel} | Job Finder | Nestor`
        );
      },
      label,
      { timeout: 10_000 },
    );
    report.scenarios.routeContext ??= [];
    report.scenarios.routeContext.push({
      route,
      label,
      mainFocused: true,
      titleUpdated: true,
    });
  }
  await page.waitForTimeout(180);
}

async function setViewport(page, browserWindow, viewport) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await browserWindow.evaluate((window, factor) => {
    window.webContents.setZoomFactor(factor);
  }, viewport.zoomFactor);
  await page.waitForTimeout(240);
}

async function resetScroll(page) {
  await page.evaluate(() => {
    const main = document.querySelector("main");
    main?.scrollTo({ top: 0, left: 0 });
    for (const element of document.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const style = getComputedStyle(element);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 2
      ) {
        element.scrollTo({ top: 0, left: 0 });
      }
    }
  });
}

async function setPrimaryScrollerPosition(page, index, ratio) {
  return page.evaluate(
    ({ targetIndex, targetRatio }) => {
      function isVisible(element) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        );
      }

      function describe(element) {
        const id = element.id ? `#${element.id}` : "";
        const testId = element.getAttribute("data-testid");
        const aria = element.getAttribute("aria-label");
        const classes = Array.from(element.classList).slice(0, 3).join(".");
        return [
          element.tagName.toLowerCase() + id,
          testId ? `[data-testid=${testId}]` : "",
          aria ? `[aria-label=${aria}]` : "",
          classes ? `.${classes}` : "",
        ]
          .filter(Boolean)
          .join("");
      }

      const scrollables = Array.from(document.querySelectorAll("*"))
        .filter((element) => {
          if (!(element instanceof HTMLElement) || !isVisible(element)) {
            return false;
          }
          const style = getComputedStyle(element);
          return (
            /(auto|scroll)/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 2
          );
        })
        .sort((left, right) => {
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          const leftScore =
            leftRect.width * leftRect.height +
            (left.scrollHeight - left.clientHeight) * 10;
          const rightScore =
            rightRect.width * rightRect.height +
            (right.scrollHeight - right.clientHeight) * 10;
          return rightScore - leftScore;
        });

      const target = scrollables[targetIndex];
      if (!target) {
        return null;
      }
      const maximum = Math.max(0, target.scrollHeight - target.clientHeight);
      target.scrollTop = Math.round(maximum * targetRatio);
      return {
        selector: describe(target),
        index: targetIndex,
        ratio: targetRatio,
        maximum,
        scrollTop: target.scrollTop,
      };
    },
    { targetIndex: index, targetRatio: ratio },
  );
}

async function scanLayout(page) {
  return page.evaluate(() => {
    function isRendered(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function label(element) {
      return (
        element.getAttribute("aria-label") ??
        element.getAttribute("title") ??
        element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
        element.tagName.toLowerCase()
      );
    }

    function descriptor(element) {
      const id = element.id ? `#${element.id}` : "";
      const testId = element.getAttribute("data-testid");
      const aria = element.getAttribute("aria-label");
      return `${element.tagName.toLowerCase()}${id}${
        testId ? `[data-testid=${testId}]` : ""
      }${aria ? `[aria-label=${aria}]` : ""}`;
    }

    const interactionSelector =
      "button,a,input,select,textarea,summary,[role=button],[role=checkbox],[role=radio],[tabindex]";
    const interactiveElements = Array.from(
      document.querySelectorAll(interactionSelector),
    ).filter(
      (element) => element instanceof HTMLElement && isRendered(element),
    );
    const clippedInteractive = interactiveElements
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const intersectsViewport =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        const clipped =
          intersectsViewport &&
          (rect.left < -1 ||
            rect.right > window.innerWidth + 1 ||
            rect.top < -1 ||
            rect.bottom > window.innerHeight + 1);
        return clipped
          ? [
              {
                label: label(element),
                selector: descriptor(element),
                rect: {
                  left: Math.round(rect.left),
                  top: Math.round(rect.top),
                  right: Math.round(rect.right),
                  bottom: Math.round(rect.bottom),
                },
              },
            ]
          : [];
      })
      .slice(0, 40);

    const scrollables = Array.from(document.querySelectorAll("*"))
      .flatMap((element) => {
        if (!(element instanceof HTMLElement) || !isRendered(element)) {
          return [];
        }
        const style = getComputedStyle(element);
        if (
          !/(auto|scroll)/.test(style.overflowY) ||
          element.scrollHeight <= element.clientHeight + 2
        ) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        if (
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= window.innerHeight ||
          rect.left >= window.innerWidth
        ) {
          return [];
        }
        return [
          {
            selector: descriptor(element),
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            horizontalOverflow: Math.max(
              0,
              element.scrollWidth - element.clientWidth,
            ),
            verticalRange: Math.max(
              0,
              element.scrollHeight - element.clientHeight,
            ),
            viewportArea: Math.round(rect.width * rect.height),
          },
        ];
      })
      .sort(
        (left, right) =>
          right.viewportArea +
          right.verticalRange * 10 -
          (left.viewportArea + left.verticalRange * 10),
      )
      .slice(0, 12);

    const shell = document.querySelector("[data-job-finder-shell]");
    const shellRect =
      shell instanceof HTMLElement ? shell.getBoundingClientRect() : null;
    const shellStyle =
      shell instanceof HTMLElement ? getComputedStyle(shell) : null;
    const shellCanScrollVertically =
      shell instanceof HTMLElement &&
      Boolean(shellStyle && /(auto|scroll)/.test(shellStyle.overflowY)) &&
      shell.scrollHeight > shell.clientHeight + 2;
    const shellDestinations = Array.from(
      document.querySelectorAll(
        'nav[aria-label="Job Finder sections"] button, [aria-label="Notifications and actions"] button, [aria-label="Notifications and actions"] summary',
      ),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      const horizontallyReachable =
        rect.left >= -1 && rect.right <= window.innerWidth + 1;
      const verticallyVisible =
        rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      const topWithinShell = shellRect
        ? rect.top -
          shellRect.top +
          (shell instanceof HTMLElement ? shell.scrollTop : 0)
        : null;
      const verticallyReachableThroughShell =
        shellCanScrollVertically &&
        topWithinShell !== null &&
        topWithinShell >= -1 &&
        topWithinShell + rect.height <=
          (shell instanceof HTMLElement ? shell.scrollHeight + 1 : 0);
      return {
        label: label(element),
        visible:
          isRendered(element) && horizontallyReachable && verticallyVisible,
        reachable:
          isRendered(element) &&
          horizontallyReachable &&
          (verticallyVisible || verticallyReachableThroughShell),
      };
    });

    const main = document.querySelector("main");
    const header = document.querySelector("[data-job-finder-shell-header]");
    const active = document.activeElement;

    return {
      route: window.location.hash,
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        visualScale: window.visualViewport?.scale ?? null,
        documentZoom: getComputedStyle(document.documentElement).zoom,
        bodyZoom: getComputedStyle(document.body).zoom,
      },
      documentHorizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      mainHorizontalOverflow:
        main instanceof HTMLElement
          ? Math.max(0, main.scrollWidth - main.clientWidth)
          : null,
      headerBottom:
        header instanceof HTMLElement
          ? Math.round(header.getBoundingClientRect().bottom)
          : null,
      mainTop:
        main instanceof HTMLElement
          ? Math.round(main.getBoundingClientRect().top)
          : null,
      activeElement:
        active instanceof HTMLElement
          ? { selector: descriptor(active), label: label(active) }
          : null,
      shellReflow:
        shell instanceof HTMLElement && header instanceof HTMLElement
          ? {
              headerPosition: getComputedStyle(header).position,
              headerHeight: Math.round(header.getBoundingClientRect().height),
              shellOverflowY: shellStyle?.overflowY ?? null,
              shellScrollable: shellCanScrollVertically,
              shellScrollHeight: shell.scrollHeight,
              shellClientHeight: shell.clientHeight,
              mainClientHeight:
                main instanceof HTMLElement ? main.clientHeight : null,
            }
          : null,
      clippedInteractive,
      scrollables,
      shellDestinations,
      hiddenShellDestinations: shellDestinations
        .filter((entry) => !entry.visible)
        .map((entry) => entry.label),
      unreachableShellDestinations: shellDestinations
        .filter((entry) => !entry.reachable)
        .map((entry) => entry.label),
    };
  });
}

async function capture(page, label, extra = {}) {
  const fileName = `${String(report.captures.length + 1).padStart(3, "0")}-${slugify(label)}.png`;
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, fileName),
  });
  const layout = await scanLayout(page);
  const entry = {
    id: report.captures.length + 1,
    label,
    fileName,
    ...extra,
    layout,
  };
  report.captures.push(entry);
  await writeJson("capture-report.json", report);
  return entry;
}

function createLongDiscoveryState(snapshot) {
  const state = structuredClone(snapshot);
  const templates = state.discoveryJobs.slice(0, 2);
  if (templates.length === 0) {
    throw new Error("The discovery demo did not expose any discovery jobs.");
  }
  state.savedJobs = Array.from({ length: 62 }, (_, index) => {
    const template = structuredClone(templates[index % templates.length]);
    const ordinal = index + 1;
    return {
      ...template,
      id: `deep_discovery_job_${ordinal}`,
      sourceJobId: `deep_discovery_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/deep-discovery/${ordinal}`,
      applicationUrl: `https://jobs.example.test/deep-discovery/${ordinal}/apply`,
      title:
        ordinal % 5 === 0
          ? `Senior Frontend Platform Engineer for International Accessibility and Workflow Systems ${ordinal}`
          : `${template.title} ${ordinal}`,
      company: `${template.company} ${ordinal}`,
      location:
        ordinal % 4 === 0
          ? "New York, NY or Remote across the United States and Canada"
          : template.location,
      summary: `${template.summary ?? ""} This deliberately long summary verifies wrapping, dense result lists, and stable actions without changing the underlying synthetic fit evidence.`,
      description: `${template.description ?? ""}\n\n${Array.from(
        { length: 8 },
        (_, paragraphIndex) =>
          `Responsibility ${paragraphIndex + 1}: collaborate across product, engineering, operations, accessibility, and customer teams while keeping decisions traceable.`,
      ).join("\n")}`,
      responsibilities: Array.from(
        { length: 10 },
        (_, responsibilityIndex) =>
          `Own workflow responsibility ${responsibilityIndex + 1} for synthetic job ${ordinal}.`,
      ),
      minimumQualifications: Array.from(
        { length: 8 },
        (_, qualificationIndex) =>
          `Required qualification ${qualificationIndex + 1} for synthetic job ${ordinal}.`,
      ),
      preferredQualifications: Array.from(
        { length: 6 },
        (_, qualificationIndex) =>
          `Preferred qualification ${qualificationIndex + 1} for synthetic job ${ordinal}.`,
      ),
      benefits: Array.from(
        { length: 8 },
        (_, benefitIndex) => `Synthetic benefit ${benefitIndex + 1}`,
      ),
      status: "discovered",
    };
  });
  state.tailoredAssets = [];
  state.resumeDrafts = [];
  state.resumeDraftRevisions = [];
  state.resumeExportArtifacts = [];
  state.resumeValidationResults = [];
  state.applicationRecords = [];
  state.applicationAttempts = [];
  return state;
}

function createLongProfileState(snapshot) {
  const state = structuredClone(snapshot);
  const templates = state.profile.experiences;
  state.profile.experiences = Array.from({ length: 18 }, (_, index) => {
    const template = structuredClone(templates[index % templates.length]);
    const ordinal = index + 1;
    return {
      ...template,
      id: `deep_experience_${ordinal}`,
      companyName: `${template.companyName} ${ordinal}`,
      title: `${template.title} ${ordinal}`,
      isCurrent: ordinal === 1,
      startDate: `${String(2005 + index).padStart(4, "0")}-01`,
      endDate:
        ordinal === 1 ? null : `${String(2006 + index).padStart(4, "0")}-12`,
      summary: `${template.summary ?? ""} Synthetic long-form history entry used only for layout and scroll acceptance.`,
      achievements: Array.from(
        { length: 5 },
        (_, achievementIndex) =>
          `Grounded synthetic acceptance achievement ${achievementIndex + 1} for role ${ordinal}.`,
      ),
    };
  });
  state.profile.skills = Array.from(
    { length: 45 },
    (_, index) => `Synthetic skill ${index + 1}`,
  );
  return state;
}

function createUserActionRequests() {
  const createdAt = new Date().toISOString();
  const kinds = [
    "login",
    "captcha",
    "manual_answer",
    "manual_upload",
    "legal_consent",
  ];
  return Array.from({ length: 12 }, (_, index) => {
    const kind = kinds[index % kinds.length];
    const id = `deep_user_action_${index + 1}`;
    const isDiscovery = index % 3 === 0;
    return {
      schemaVersion: 1,
      id,
      dedupeKey: `deep:${id}`,
      revision: 1,
      kind,
      state: "pending",
      requirement: "required",
      scope: isDiscovery
        ? {
            type: "discovery_source",
            targetId: "target_linkedin_default",
            source: "target_site",
            sourceDebugRunId: `deep_source_debug_run_${index}`,
            sourceDebugAttemptId: `deep_source_debug_attempt_${index}`,
          }
        : {
            type: "application",
            runId: `deep_apply_run_${index}`,
            jobId: "job_ready",
            resultId: `deep_apply_result_${index}`,
            replayCheckpointId: `deep_checkpoint_${index}`,
            source: "target_site",
          },
      verification: isDiscovery
        ? {
            type: "source_access",
            targetId: "target_linkedin_default",
            blockerFingerprint: `deep_source_blocker_${index}`,
            expectedOrigin: "https://www.linkedin.com/",
          }
        : {
            type: "page_blocker_absent",
            blockerFingerprint: `deep_application_blocker_${index}`,
            expectedPageFingerprint: `deep_application_page_${index}`,
          },
      title: `${kind.replaceAll("_", " ")} for synthetic workflow ${index + 1}`,
      summary:
        "This intentionally long synthetic handoff explains the exact user-owned action, the affected job or source, and what Job Finder will verify after the user returns.",
      instructions: [
        "Complete only the named step in the managed browser without sharing credentials.",
        "Do not submit an application or create an account. Return and choose Done only after the exact step is complete.",
      ],
      actionUrl: "https://jobs.example.test/user-action",
      displayOrigin: "https://jobs.example.test/",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt,
      updatedAt: createdAt,
      openedAt: null,
      resolvedAt: null,
      expiresAt: null,
    };
  });
}

async function captureRouteScrollerMatrix(page, route, labelPrefix) {
  await navigate(page, route);
  await resetScroll(page);
  await capture(page, `${labelPrefix}-top`, { route, scroll: "top" });
  for (const scrollerIndex of [0, 1]) {
    for (const ratio of [0.5, 1]) {
      const scroller = await setPrimaryScrollerPosition(
        page,
        scrollerIndex,
        ratio,
      );
      if (!scroller) {
        continue;
      }
      await page.waitForTimeout(120);
      await capture(
        page,
        `${labelPrefix}-scroller-${scrollerIndex}-${ratio === 0.5 ? "middle" : "bottom"}`,
        { route, scroller },
      );
      await resetScroll(page);
    }
  }
}

async function measureDiscoveryRevealSurface(page) {
  return page.evaluate(async (payload) => {
    const primaryNames = new Set(payload.primaryActionNames);
    const normText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    function describeEl(element) {
      const testId = element.getAttribute("data-testid");
      const resultId = element.getAttribute("data-job-result-id");
      return `${element.tagName.toLowerCase()}${
        element.id ? `#${element.id}` : ""
      }${testId ? `[data-testid=${testId}]` : ""}${
        resultId ? `[data-job-result-id=${resultId}]` : ""
      }`;
    }
    // Playwright `visible` accepts a one-pixel clipped sliver, so meaningful
    // viewport intersection is derived from DOM geometry instead: a majority
    // of the smaller of (element, viewport) per axis must intersect.
    function meaningfullyIntersects(rect) {
      const height =
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const width =
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const requiredHeight = Math.max(
        payload.thresholds.minIntersectionPx,
        payload.thresholds.meaningfulShare *
          Math.min(rect.height, window.innerHeight),
      );
      const requiredWidth = Math.max(
        payload.thresholds.minIntersectionPx,
        payload.thresholds.meaningfulShare *
          Math.min(rect.width, window.innerWidth),
      );
      return {
        intersection: {
          top: Math.round(Math.max(rect.top, 0)),
          left: Math.round(Math.max(rect.left, 0)),
          height: Math.round(Math.max(0, height)),
          width: Math.round(Math.max(0, width)),
        },
        pass: height >= requiredHeight && width >= requiredWidth,
      };
    }
    function clippedVisibleBox(element) {
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(window.innerWidth, rect.right);
      let bottom = Math.min(window.innerHeight, rect.bottom);
      const clippingValues = new Set(["auto", "scroll", "hidden", "clip"]);
      for (
        let ancestor = element.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (clippingValues.has(style.overflowX)) {
          left = Math.max(left, ancestorRect.left);
          right = Math.min(right, ancestorRect.right);
        }
        if (clippingValues.has(style.overflowY)) {
          top = Math.max(top, ancestorRect.top);
          bottom = Math.min(bottom, ancestorRect.bottom);
        }
      }
      return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    }
    function clickableCenterPoint(element) {
      const box = clippedVisibleBox(element);
      if (box.width < 2 || box.height < 2) {
        return null;
      }
      const candidatePoints = [
        [box.left + box.width / 2, box.top + box.height / 2],
        [
          box.left + Math.min(4, box.width / 2),
          box.top + Math.min(4, box.height / 2),
        ],
        [
          box.right - Math.min(4, box.width / 2),
          box.bottom - Math.min(4, box.height / 2),
        ],
      ];
      for (const [x, y] of candidatePoints) {
        const owner = document.elementFromPoint(x, y);
        if (
          owner === element ||
          (owner instanceof Node && element.contains(owner))
        ) {
          return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
        }
      }
      return null;
    }

    const section = document.querySelector(payload.resultsSectionSelector);
    const rows = section
      ? Array.from(section.querySelectorAll("button[data-job-result-id]")).map(
          (element) => ({
            jobId: element.getAttribute("data-job-result-id"),
            title:
              normText(element.querySelector("strong")?.textContent) || null,
            isSelected: element.getAttribute("aria-current") === "true",
            meaningfullyVisible: meaningfullyIntersects(
              element.getBoundingClientRect(),
            ).pass,
            clickablePoint: clickableCenterPoint(element),
          }),
        )
      : [];

    // scrollIntoView({ block: "start" }) aligns the region top with the top
    // of the nearest owning scrollport (its client-box top, below any fixed
    // chrome outside it).
    const region = document.querySelector(payload.regionSelector);
    let detail = null;
    if (region) {
      const regionRect = region.getBoundingClientRect();
      const detailMetrics = meaningfullyIntersects(regionRect);
      let scroller = null;
      for (
        let node = region.parentElement;
        node && !scroller;
        node = node.parentElement
      ) {
        if (
          node instanceof HTMLElement &&
          /(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
          node.scrollHeight > node.clientHeight + 2
        ) {
          scroller = node;
        }
      }
      let alignment = {
        scroller: null,
        deltaPx: null,
        aligned: false,
        clampedAtMaximum: false,
        reason: "no-scrollable-ancestor",
      };
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const scrollPortTop = scrollerRect.top + scroller.clientTop;
        const maximumScrollTop = Math.max(
          0,
          scroller.scrollHeight - scroller.clientHeight,
        );
        const deltaPx = Math.round((regionRect.top - scrollPortTop) * 10) / 10;
        alignment = {
          scroller: {
            selector: describeEl(scroller),
            clientRectTop: Math.round(scrollerRect.top),
            scrollPortTop: Math.round(scrollPortTop),
            scrollTop: Math.round(scroller.scrollTop),
            maximumScrollTop: Math.round(maximumScrollTop),
          },
          regionViewportTop: Math.round(regionRect.top * 10) / 10,
          deltaPx,
          tolerancePx: payload.thresholds.blockStartTolerancePx,
          aligned:
            Math.abs(deltaPx) <= payload.thresholds.blockStartTolerancePx,
          clampedAtMaximum: scroller.scrollTop >= maximumScrollTop - 1,
          reason: null,
        };
      }
      detail = {
        exists: true,
        rect: {
          left: Math.round(regionRect.left),
          top: Math.round(regionRect.top),
          right: Math.round(regionRect.right),
          bottom: Math.round(regionRect.bottom),
          width: Math.round(regionRect.width),
          height: Math.round(regionRect.height),
        },
        viewportIntersection: detailMetrics.intersection,
        meaningfullyVisible: detailMetrics.pass,
        blockStart: alignment,
      };
    } else {
      detail = { exists: false };
    }

    const actionsRegion = document.querySelector(payload.actionsRegionSelector);
    let actionControlCount = 0;
    let excludedNavigationLinkPresent = false;
    const matchedPrimaryActions = [];
    if (actionsRegion) {
      for (const element of actionsRegion.querySelectorAll(
        'button:not([disabled]), button:not([aria-disabled="true"]), a[href]',
      )) {
        actionControlCount += 1;
        if (
          element.getAttribute("data-testid") === payload.excludedActionTestId
        ) {
          excludedNavigationLinkPresent = true;
          continue;
        }
        const label = normText(
          element.getAttribute("aria-label") ?? element.textContent,
        );
        if (!primaryNames.has(label)) {
          continue;
        }
        matchedPrimaryActions.push({
          tag: element.tagName.toLowerCase(),
          label,
          meaningfullyVisible: meaningfullyIntersects(
            element.getBoundingClientRect(),
          ).pass,
          clickablePoint: clickableCenterPoint(element),
        });
      }
    }

    const active =
      document.activeElement instanceof Element &&
      document.activeElement !== document.body
        ? document.activeElement
        : null;
    const workspace = await window.nestor.jobFinder.getWorkspace();

    return {
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      rowCount: rows.length,
      rows,
      workspaceSelectedDiscoveryJobId: workspace.selectedDiscoveryJobId ?? null,
      headingText: normText(
        document.getElementById(payload.headingId)?.textContent,
      ),
      detail,
      primaryActions: {
        actionControlCount,
        excludedNavigationLinkPresent,
        matched: matchedPrimaryActions,
      },
      focus: {
        activeDescriptor: active ? describeEl(active) : null,
        headingFocused: Boolean(active?.id === payload.headingId),
        detailActionFocused: Boolean(active && actionsRegion?.contains(active)),
      },
    };
  }, discoveryRevealMeasurementPayload);
}

async function probeDiscoverySelectionReveal(page, viewport, baseCapture) {
  const consistency = getStackedMediaQueryConsistency();
  const stackedMediaQueryMatches = await page.evaluate((query) => {
    return window.matchMedia?.(query)?.matches ?? false;
  }, DISCOVERY_STACKED_MEDIA_QUERY);
  if (!stackedMediaQueryMatches) {
    return null;
  }

  const failures = [];
  if (!consistency.matched) {
    failures.push(
      `stacked media query does not mirror discovery-accessibility.ts: expected ${DISCOVERY_STACKED_MEDIA_QUERY} observed ${JSON.stringify(consistency.observedQuery ?? consistency.error ?? null)}`,
    );
  }

  let chosen = null;
  let preClick = null;
  let postReveal = null;
  const arrangedRowJobIds = [];
  try {
    const initial = await measureDiscoveryRevealSurface(page);
    if (initial.rowCount === 0) {
      failures.push("no discovery result rows were rendered to click");
    }
    const differentRows = initial.rows
      .map((row, index) => ({ index, row }))
      .filter(
        ({ row }) =>
          Boolean(row.jobId) &&
          row.jobId !== initial.workspaceSelectedDiscoveryJobId,
      )
      .sort((left, right) => right.index - left.index);
    let pool = differentRows.filter(
      ({ row }) => row.meaningfullyVisible && row.clickablePoint !== null,
    );
    if (pool.length === 0) {
      pool = differentRows.slice(0, 2);
    }
    for (const candidate of pool) {
      await page
        .locator(DISCOVERY_RESULT_ROW_SELECTOR)
        .nth(candidate.index)
        .scrollIntoViewIfNeeded({ timeout: 1_500 })
        .catch(() => {});
      await page.waitForTimeout(100);
      const measured = await measureDiscoveryRevealSurface(page);
      const row = measured.rows[candidate.index];
      if (
        row &&
        row.jobId === candidate.row.jobId &&
        row.meaningfullyVisible &&
        row.clickablePoint !== null
      ) {
        chosen = {
          jobId: row.jobId,
          title: row.title,
          clickPoint: row.clickablePoint,
        };
        preClick = measured;
        break;
      }
      arrangedRowJobIds.push(candidate.row.jobId);
    }
    if (!chosen) {
      failures.push(
        "no unselected result row was meaningfully visible with an unobscured clickable center point",
      );
    } else {
      await page.mouse.click(chosen.clickPoint.x, chosen.clickPoint.y);

      // Deterministically settle the product's queued microtask reveal plus
      // scroll/layout: double rAF, then two identical geometry+identity
      // samples with the clicked identity everywhere required.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      let signature = null;
      let stableSamples = 0;
      await waitForCondition(
        async () => {
          const measurement = await measureDiscoveryRevealSurface(page);
          const nextSignature = JSON.stringify({
            jobId: measurement.workspaceSelectedDiscoveryJobId,
            heading: measurement.headingText,
            detailRect: measurement.detail?.rect ?? null,
            scrollTop:
              measurement.detail?.blockStart?.scroller?.scrollTop ?? null,
            selectedRowIds: measurement.rows
              .filter((row) => row.isSelected)
              .map((row) => row.jobId),
          });
          stableSamples = nextSignature === signature ? stableSamples + 1 : 1;
          signature = nextSignature;
          return (
            stableSamples >= 2 &&
            measurement.workspaceSelectedDiscoveryJobId === chosen.jobId &&
            measurement.headingText === chosen.title &&
            measurement.rows.some(
              (row) => row.isSelected && row.jobId === chosen.jobId,
            )
          );
        },
        `discovery selection reveal to settle on job ${chosen.jobId}`,
        10_000,
        120,
      );
      postReveal = await measureDiscoveryRevealSurface(page);

      if (postReveal.workspaceSelectedDiscoveryJobId !== chosen.jobId) {
        failures.push(
          `workspace selection did not update to ${chosen.jobId}: ${String(postReveal.workspaceSelectedDiscoveryJobId)}`,
        );
      }
      if (postReveal.headingText !== chosen.title) {
        failures.push(
          `detail heading mismatch after selection: expected ${JSON.stringify(chosen.title)} observed ${JSON.stringify(postReveal.headingText)}`,
        );
      }
      if (
        !postReveal.rows.some(
          (row) => row.isSelected && row.jobId === chosen.jobId,
        )
      ) {
        failures.push(`clicked row ${chosen.jobId} is not aria-current`);
      }

      if (
        postReveal.focus.headingFocused ||
        postReveal.focus.detailActionFocused
      ) {
        failures.push(
          `pointer selection stole focus to heading/action: activeElement=${JSON.stringify(postReveal.focus.activeDescriptor)}`,
        );
      }

      if (!postReveal.detail.exists) {
        failures.push(`${DISCOVERY_DETAIL_REGION_SELECTOR} was not rendered`);
      } else if (!postReveal.detail.blockStart.aligned) {
        failures.push(
          `${DISCOVERY_DETAIL_REGION_SELECTOR} did not top-align with the owning scrollport within ${postReveal.detail.blockStart.tolerancePx}px of block:start: delta=${postReveal.detail.blockStart.deltaPx}px clampedAtMaximum=${postReveal.detail.blockStart.clampedAtMaximum} scroller=${JSON.stringify(postReveal.detail.blockStart.scroller)} reason=${postReveal.detail.blockStart.reason}`,
        );
      } else if (!postReveal.detail.meaningfullyVisible) {
        failures.push(
          `${DISCOVERY_DETAIL_REGION_SELECTOR} does not meaningfully intersect the CSS viewport: ${JSON.stringify(postReveal.detail.viewportIntersection)}`,
        );
      }

      const actionableActions = postReveal.primaryActions.matched.filter(
        (action) =>
          action.meaningfullyVisible && action.clickablePoint !== null,
      );
      if (postReveal.primaryActions.matched.length === 0) {
        failures.push(
          `no genuine primary job action ${JSON.stringify(DISCOVERY_PRIMARY_ACTION_NAMES)} inside ${DISCOVERY_DETAIL_ACTIONS_SELECTOR}: controls=${postReveal.primaryActions.actionControlCount} excludedNavigationLinkPresent=${postReveal.primaryActions.excludedNavigationLinkPresent}`,
        );
      } else if (actionableActions.length === 0) {
        failures.push(
          `product pointer click alone exposed no primary job action with meaningful intersection and a clickable center point: ${JSON.stringify(postReveal.primaryActions.matched.map(({ label, meaningfullyVisible }) => ({ label, meaningfullyVisible })))}`,
        );
      }
    }
  } catch (error) {
    failures.push(
      `unexpected discovery reveal probe failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const entry = {
    scenarioId: "discovery-selection-reveal",
    viewportSlug: viewport.slug,
    viewport: postReveal?.viewport ?? preClick?.viewport ?? null,
    stackedMediaQuery: DISCOVERY_STACKED_MEDIA_QUERY,
    stackedMediaQueryMatches,
    mediaQueryConsistency: consistency,
    selectors: {
      resultsSection: DISCOVERY_RESULTS_SECTION_SELECTOR,
      resultRow: DISCOVERY_RESULT_ROW_SELECTOR,
      detailRegion: DISCOVERY_DETAIL_REGION_SELECTOR,
      detailHeading: DISCOVERY_DETAIL_HEADING_SELECTOR,
      actionsRegion: DISCOVERY_DETAIL_ACTIONS_SELECTOR,
      excludedActionTestId: DISCOVERY_EXCLUDED_ACTION_TEST_ID,
      primaryActionNames: DISCOVERY_PRIMARY_ACTION_NAMES,
    },
    thresholds: DISCOVERY_REVEAL_THRESHOLDS,
    click: {
      method: "page.mouse.click",
      point: chosen?.clickPoint ?? null,
      jobId: chosen?.jobId ?? null,
      rowTitle: chosen?.title ?? null,
    },
    rowSummary: {
      rowCount: preClick?.rowCount ?? null,
      meaningfullyVisibleRowCount:
        preClick?.rows.filter((row) => row.meaningfullyVisible).length ?? null,
      skippedRowJobIdsAfterArrange: arrangedRowJobIds,
    },
    identity: {
      workspaceBefore: preClick?.workspaceSelectedDiscoveryJobId ?? null,
      workspaceAfter: postReveal?.workspaceSelectedDiscoveryJobId ?? null,
      domHeadingAfter: postReveal?.headingText ?? null,
      ariaCurrentRowJobIdAfter:
        postReveal?.rows.find((row) => row.isSelected)?.jobId ?? null,
    },
    focus: {
      before: preClick?.focus.activeDescriptor ?? null,
      after: postReveal?.focus.activeDescriptor ?? null,
      headingFocusedAfter: postReveal?.focus.headingFocused ?? null,
      detailActionFocusedAfter: postReveal?.focus.detailActionFocused ?? null,
      clickedRowRetainedFocus: postReveal
        ? postReveal.focus.activeDescriptor ===
          `button[data-job-result-id=${chosen.jobId}]`
        : null,
    },
    detailRegion: postReveal?.detail ?? null,
    primaryActions: postReveal?.primaryActions ?? null,
    failures,
    pass: failures.length === 0,
  };

  report.scenarios.discoverySelectionRevealEvidence ??= [];
  report.scenarios.discoverySelectionRevealEvidence.push(entry);
  if (baseCapture) {
    baseCapture.discoverySelectionReveal = {
      viewportSlug: entry.viewportSlug,
      clickedJobId: entry.click.jobId,
      pass: entry.pass,
      failures: entry.failures,
    };
  }
  await writeJson("capture-report.json", report);
  if (!entry.pass) {
    throw new Error(
      `Discovery selection reveal evidence failed for viewport ${viewport.slug}: ${entry.failures.join("; ")}`,
    );
  }
  return entry;
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-deep-acceptance-"),
  );
  let app;

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_PROFILE_COPILOT_DELAY_MS: "4500",
        NESTOR_TEST_SYSTEM_THEME: "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 30_000 },
    );
    const browserWindow = await app.browserWindow(page);
    page.on("pageerror", (error) => {
      report.runtimeErrors.push({ type: "pageerror", message: error.message });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        report.runtimeErrors.push({
          type: "console",
          message: message.text(),
        });
      }
    });

    await page.evaluate(() =>
      window.nestor.jobFinder.test.setSystemThemeOverride("dark"),
    );
    await setViewport(page, browserWindow, viewportMatrix[0]);

    await page
      .getByRole("heading", { level: 1, name: "Guided setup" })
      .waitFor({ state: "visible", timeout: 20_000 });
    await capture(page, "fresh-guided-setup-top", {
      scenario: "fresh-workspace",
    });
    await setPrimaryScrollerPosition(page, 0, 1);
    await capture(page, "fresh-guided-setup-bottom", {
      scenario: "fresh-workspace",
      scroll: "bottom",
    });

    const resumeDemo = await page.evaluate(() =>
      window.nestor.jobFinder.test.loadResumeWorkspaceDemo(),
    );
    await page.evaluate(
      async (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      createLongProfileState(resumeDemo),
    );
    await completeProfileSetup(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await captureRouteScrollerMatrix(
      page,
      "/job-finder/profile",
      "long-profile",
    );

    const copilotBefore = await getWorkspace(page);
    const copilotMessageCount = copilotBefore.profileCopilotMessages.length;
    const keepSessionAliveBefore = copilotBefore.settings.keepSessionAlive;
    const profileCopilotLauncher = page
      .getByRole("button", { name: /the Assistant/ })
      .last();
    await profileCopilotLauncher.click();
    const composer = page.getByLabel("Message the Assistant");
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    const profileCopilotComposerFocused = await composer.evaluate(
      (element) => document.activeElement === element,
    );
    if (!profileCopilotComposerFocused) {
      throw new Error(
        "Profile Copilot did not focus its composer when opened.",
      );
    }
    report.scenarios.profileCopilotKeyboardFocus = {
      composerFocusedOnOpen: profileCopilotComposerFocused,
    };
    await composer.fill(
      "Please look for jobs around New York where the pay is about 3-4k a month. Keep every unrelated preference unchanged.",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    // There is no separate "Preparing..." button any more; the panel marks a
    // reply in flight with its own pending row.
    await page
      .locator('[data-profile-copilot-pending="true"]')
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("heading", { level: 1, name: "Settings" })
      .waitFor({ timeout: 10_000 });
    await capture(page, "copilot-pending-settings-before-change", {
      scenario: "background-profile-copilot-settings-change",
    });
    const keepBrowserCheckbox = page.getByRole("switch", {
      name: "Keep browser open after runs",
    });
    await keepBrowserCheckbox.evaluate((element) => {
      element.scrollIntoView({ block: "center", inline: "nearest" });
    });
    await page.waitForTimeout(180);
    await capture(page, "copilot-pending-settings-switch-in-view", {
      scenario: "background-profile-copilot-settings-change",
    });
    let pointerClickBlocked = false;
    try {
      await keepBrowserCheckbox.click({ timeout: 2_500 });
    } catch (error) {
      pointerClickBlocked = true;
      report.runtimeErrors.push({
        type: "interaction",
        message: `Settings switch pointer click was blocked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      await keepBrowserCheckbox.focus();
      await keepBrowserCheckbox.press("Space");
    }
    const saveSettingsButton = page
      .getByRole("button", { name: "Save settings" })
      .last();
    try {
      await saveSettingsButton.click({ timeout: 2_500 });
    } catch {
      await saveSettingsButton.focus();
      await saveSettingsButton.press("Enter");
    }
    report.scenarios.settingsPointerInteraction = {
      pointerClickBlocked,
      keyboardFallbackWorked:
        (await keepBrowserCheckbox.getAttribute("aria-checked")) === "true",
    };
    await capture(page, "copilot-pending-settings-saved", {
      scenario: "background-profile-copilot-settings-change",
    });
    const taskCenter = page.locator('summary[aria-label^="Task center:"]');
    if (await taskCenter.isVisible().catch(() => false)) {
      await taskCenter.click();
      await capture(page, "copilot-pending-task-center-open", {
        scenario: "background-profile-copilot-settings-change",
      });
      await page.keyboard.press("Escape");
      const taskCenterDetails = page.locator("details").filter({
        has: page.locator('section[aria-label="Task center"]'),
      });
      const openAfterEscape = await taskCenterDetails
        .getAttribute("open")
        .then((value) => value !== null)
        .catch(() => false);
      let triggerClickBlocked = false;
      if (openAfterEscape) {
        try {
          await taskCenter.click({ timeout: 2_500 });
        } catch (error) {
          triggerClickBlocked = true;
          report.runtimeErrors.push({
            type: "interaction",
            message: `Task center trigger could not close its popover: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          await taskCenterDetails.evaluate((details) => {
            details.open = false;
          });
        }
      }
      report.scenarios.taskCenterDismissal = {
        openAfterEscape,
        triggerClickBlocked,
        harnessForcedClose: openAfterEscape && triggerClickBlocked,
      };
    }
    try {
      await page
        .getByRole("button", { name: "Find jobs", exact: true })
        .click({ timeout: 2_500 });
    } catch {
      await navigate(page, "/job-finder/discovery");
    }
    await page
      .getByRole("heading", { level: 1, name: "Find jobs" })
      .waitFor({ timeout: 10_000 });
    await capture(page, "copilot-pending-after-navigation", {
      scenario: "background-profile-copilot-settings-change",
    });
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).profileCopilotMessages.length >
        copilotMessageCount,
      "Profile Copilot response after navigation",
      60_000,
    );
    const copilotAfter = await getWorkspace(page);
    report.scenarios.profileCopilotNavigationAndSettings = {
      request:
        "Please look for jobs around New York where the pay is about 3-4k a month. Keep every unrelated preference unchanged.",
      messageCountBefore: copilotMessageCount,
      messageCountAfter: copilotAfter.profileCopilotMessages.length,
      keepSessionAliveBefore,
      keepSessionAliveAfter: copilotAfter.settings.keepSessionAlive,
      settingChangePreserved:
        copilotAfter.settings.keepSessionAlive !== keepSessionAliveBefore,
      searchPreferencesAfter: copilotAfter.searchPreferences,
      latestAssistantMessage: [...copilotAfter.profileCopilotMessages]
        .reverse()
        .find((message) => message.role === "assistant"),
    };
    await navigate(page, "/job-finder/profile");
    const reopenCopilot = page
      .getByRole("button", { name: /the Assistant/ })
      .last();
    if (await reopenCopilot.isVisible().catch(() => false)) {
      await capture(page, "copilot-completed-before-reopen", {
        scenario: "background-profile-copilot-settings-change",
      });
      let pointerReopenBlocked = false;
      try {
        await reopenCopilot.click({ timeout: 2_500 });
      } catch (error) {
        pointerReopenBlocked = true;
        report.runtimeErrors.push({
          type: "interaction",
          message: `Profile Copilot pointer reopen was blocked after background completion: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        await reopenCopilot.focus();
        await reopenCopilot.press("Enter");
      }
      report.scenarios.profileCopilotReopen = {
        pointerReopenBlocked,
        openedAfterKeyboardFallback: await page
          .getByLabel("Message the Assistant")
          .isVisible()
          .catch(() => false),
      };
    }
    await capture(page, "copilot-completed-after-return", {
      scenario: "background-profile-copilot-settings-change",
    });
    const proposedWorkspace = await getWorkspace(page);
    const latestProposal = [...proposedWorkspace.profileCopilotMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const proposedGroups = latestProposal?.patchGroups ?? [];
    if (
      proposedGroups.length === 0 ||
      proposedGroups.some((group) => group.applyMode !== "needs_review")
    ) {
      throw new Error(
        "Profile Copilot did not return reviewable proposal-only changes.",
      );
    }
    report.scenarios.profileCopilotProposalOnly = {
      content: latestProposal?.content ?? null,
      patchGroups: proposedGroups,
      profileUnchangedBeforeApproval:
        !proposedWorkspace.searchPreferences.locations.some((location) =>
          /new york/iu.test(location),
        ),
    };

    for (let index = 0; index < proposedGroups.length; index += 1) {
      const applyProposal = page
        .getByRole("button", {
          name: "Apply changes",
        })
        .first();
      await applyProposal.waitFor({ state: "visible", timeout: 10_000 });
      await applyProposal.click();
      await page.waitForTimeout(180);
    }
    await waitForCondition(
      async () => {
        const workspace = await getWorkspace(page);
        return (
          workspace.searchPreferences.locations.some((location) =>
            /new york/iu.test(location),
          ) &&
          workspace.searchPreferences.compensation.minimum === 3_000 &&
          workspace.searchPreferences.compensation.maximum === 4_000 &&
          workspace.searchPreferences.compensation.interval === "month" &&
          workspace.searchPreferences.compensation.currency === null &&
          workspace.searchPreferences.compensation.currencyStatus ===
            "needs_clarification"
        );
      },
      "approved Profile Copilot location and monthly compensation proposal",
      20_000,
    );
    const approvedProposalWorkspace = await getWorkspace(page);
    report.scenarios.profileCopilotApprovedProposal = {
      searchPreferences: approvedProposalWorkspace.searchPreferences,
      unrelatedSettingPreserved:
        approvedProposalWorkspace.settings.keepSessionAlive !==
        keepSessionAliveBefore,
    };
    await capture(page, "copilot-proposal-approved", {
      scenario: "profile-copilot-proposal-approval",
    });

    const discoveryDemo = await page.evaluate(() =>
      window.nestor.jobFinder.test.loadResumeWorkspaceDemo(),
    );
    const longDiscoveryState = createLongDiscoveryState(discoveryDemo);
    await page.evaluate(
      async (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      longDiscoveryState,
    );
    await completeProfileSetup(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await captureRouteScrollerMatrix(
      page,
      "/job-finder/discovery",
      "long-discovery",
    );

    const detailScroll = page.locator(
      '[data-testid="discovery-detail-scroll-area"]',
    );
    if (await detailScroll.isVisible().catch(() => false)) {
      await detailScroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const resultButtons = page
        .locator(
          'section[aria-labelledby="discovery-job-results-heading"] button',
        )
        .filter({ hasText: /\d/ });
      if ((await resultButtons.count()) > 2) {
        await resultButtons.nth(2).click();
        await page.waitForTimeout(180);
        report.scenarios.discoverySelectionScrollReset = {
          detailScrollTopAfterSelection: await detailScroll.evaluate(
            (element) => element.scrollTop,
          ),
        };
        await capture(page, "discovery-selection-after-detail-bottom", {
          scenario: "selected-job-change",
        });
      }
    }

    await page.evaluate(() =>
      window.nestor.jobFinder.test.loadApplyQueueDemo(),
    );
    await completeProfileSetup(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await captureRouteScrollerMatrix(
      page,
      "/job-finder/review-queue",
      "shortlisted",
    );
    await navigate(page, "/job-finder/review-queue/job_ready/resume");
    await page
      .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
      .waitFor({ state: "visible", timeout: 20_000 });
    await resetScroll(page);
    await capture(page, "resume-studio-top", {
      route: "/job-finder/review-queue/job_ready/resume",
    });
    for (const scrollerIndex of [0, 1, 2]) {
      for (const ratio of [0.5, 1]) {
        const scroller = await setPrimaryScrollerPosition(
          page,
          scrollerIndex,
          ratio,
        );
        if (!scroller) {
          continue;
        }
        await capture(
          page,
          `resume-studio-scroller-${scrollerIndex}-${ratio === 0.5 ? "middle" : "bottom"}`,
          { scroller },
        );
        await resetScroll(page);
      }
    }
    const guidedEdits = page
      .getByRole("button", { name: /^Open the Assistant/ })
      .last();
    if (await guidedEdits.isVisible().catch(() => false)) {
      await guidedEdits.click();
      const guidedComposer = page.getByLabel("Message the Assistant");
      await guidedComposer.waitFor({ state: "visible", timeout: 10_000 });
      const composerFocusedOnOpen = await guidedComposer.evaluate(
        (element) => document.activeElement === element,
      );
      if (!composerFocusedOnOpen) {
        throw new Error(
          "The Assistant did not focus its composer when opened.",
        );
      }
      await page.keyboard.press("Escape");
      const launcherFocusedAfterEscape = await guidedEdits.evaluate(
        (element) => document.activeElement === element,
      );
      if (!launcherFocusedAfterEscape) {
        throw new Error(
          "The Assistant did not return focus to its launcher after Escape.",
        );
      }
      report.scenarios.guidedEditsKeyboardFocus = {
        composerFocusedOnOpen,
        launcherFocusedAfterEscape,
      };
      await guidedEdits.click();
      await capture(page, "resume-studio-guided-edits-open", {
        scenario: "guided-edits-viewport",
      });
      const guidedDialog = page.getByRole("dialog", {
        name: /^Assistant$/,
      });
      const dragHeader = page.getByLabel("Drag the Assistant");
      const beforeDrag = await guidedDialog.boundingBox();
      const dragBox = await dragHeader.boundingBox();
      if (beforeDrag && dragBox) {
        const startX = dragBox.x + Math.min(80, dragBox.width / 2);
        const startY = dragBox.y + dragBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(Math.max(32, startX - 180), startY, {
          steps: 8,
        });
        await page.mouse.up();
        const afterDrag = await guidedDialog.boundingBox();
        const moved =
          Boolean(afterDrag) &&
          (Math.abs((afterDrag?.x ?? beforeDrag.x) - beforeDrag.x) > 5 ||
            Math.abs((afterDrag?.y ?? beforeDrag.y) - beforeDrag.y) > 5);
        report.scenarios.guidedEditsDrag = {
          before: beforeDrag,
          after: afterDrag,
          moved,
        };
        if (!moved) {
          throw new Error(
            "The Assistant panel did not move after a leftward drag.",
          );
        }
        await capture(page, "resume-studio-guided-edits-dragged", {
          scenario: "guided-edits-viewport",
        });
      }
      // The unified Assistant panel has one size and one header control:
      // minimize. The old maximize/restore pair no longer exists.
      const minimize = page.getByRole("button", {
        name: "Minimize the Assistant",
      });
      if (await minimize.isVisible().catch(() => false)) {
        await minimize.click();
        await capture(page, "resume-studio-guided-edits-minimized", {
          scenario: "guided-edits-viewport",
        });
      }
    }

    await captureRouteScrollerMatrix(
      page,
      "/job-finder/applications",
      "applications-empty",
    );

    const actionBaseline = JSON.parse(
      await readFile(baselineWorkspacePath, "utf8"),
    );
    await page.evaluate(
      async (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      {
        ...actionBaseline,
        userActionRequests: createUserActionRequests(),
      },
    );
    await completeProfileSetup(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const actionZoomBefore = await browserWindow.evaluate((window) =>
      window.webContents.getZoomFactor(),
    );
    await captureRouteScrollerMatrix(
      page,
      "/job-finder/actions",
      "action-inbox-long",
    );
    const actionZoomAfter = await browserWindow.evaluate((window) =>
      window.webContents.getZoomFactor(),
    );
    report.scenarios.actionRouteZoom = {
      before: actionZoomBefore,
      after: actionZoomAfter,
    };

    await page.evaluate(() =>
      window.nestor.jobFinder.test.loadApplyQueueDemo(),
    );
    await completeProfileSetup(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await captureRouteScrollerMatrix(
      page,
      "/job-finder/settings",
      "settings-long",
    );
    const documentsAndAssetsHeading = page.getByText("Documents & assets", {
      exact: true,
    });
    await documentsAndAssetsHeading.scrollIntoViewIfNeeded();
    await capture(page, "settings-documents-and-assets", {
      scenario: "candidate-asset-library",
    });

    for (const viewport of viewportMatrix) {
      await setViewport(page, browserWindow, viewport);
      for (const route of [
        "/job-finder/profile",
        "/job-finder/discovery",
        "/job-finder/review-queue",
        "/job-finder/actions",
        "/job-finder/settings",
      ]) {
        await navigate(page, route);
        await resetScroll(page);
        const routeCapture = await capture(
          page,
          `${viewport.slug}-${route.split("/").at(-1)}`,
          {
            viewport,
            route,
          },
        );
        if (viewport.zoomFactor === 4) {
          const shellActionsVisible = await page.evaluate(() => {
            const actions = document.querySelector(
              '[aria-label="Notifications and actions"]',
            );
            actions?.scrollIntoView({ block: "center" });
            const actionsRect = actions?.getBoundingClientRect();
            return (
              Boolean(actionsRect) &&
              (actionsRect?.bottom ?? 0) > 0 &&
              (actionsRect?.top ?? Number.POSITIVE_INFINITY) <
                window.innerHeight
            );
          });
          if (!shellActionsVisible) {
            throw new Error(
              "400% reflow did not keep Task Center and Needs you reachable.",
            );
          }
          await page.waitForTimeout(120);
          await capture(
            page,
            `${viewport.slug}-${route.split("/").at(-1)}-shell-actions`,
            {
              viewport,
              route,
              reflowSurface: "shell-actions",
            },
          );
          const reflowState = await page.evaluate(() => {
            const shell = document.querySelector("[data-job-finder-shell]");
            const main = document.querySelector("main");
            main?.scrollIntoView({ block: "start" });
            const mainRect = main?.getBoundingClientRect();
            return {
              shellHasVerticalRange:
                shell instanceof HTMLElement &&
                shell.scrollHeight > shell.clientHeight,
              mainVisible:
                Boolean(mainRect) &&
                (mainRect?.bottom ?? 0) > 0 &&
                (mainRect?.top ?? Number.POSITIVE_INFINITY) <
                  window.innerHeight,
            };
          });
          if (!reflowState.shellHasVerticalRange || !reflowState.mainVisible) {
            throw new Error(
              `400% reflow did not keep both shell navigation and ${route} content reachable.`,
            );
          }
          report.scenarios.reflow400 ??= [];
          report.scenarios.reflow400.push({
            route,
            shellActionsVisible,
            ...reflowState,
          });
          await page.waitForTimeout(120);
          await capture(
            page,
            `${viewport.slug}-${route.split("/").at(-1)}-content`,
            {
              viewport,
              route,
              reflowSurface: "content",
            },
          );
        }
        if (route === "/job-finder/discovery") {
          await probeDiscoverySelectionReveal(page, viewport, routeCapture);
        }
      }
    }

    await setViewport(page, browserWindow, viewportMatrix[0]);
    const finalWorkspace = await getWorkspace(page);
    report.safety.submitAuthorized = finalWorkspace.userActionRequests.every(
      (request) => request.submitAuthorized === false,
    )
      ? false
      : "unexpected_true_present";
    report.safety.accountCreationAuthorized =
      finalWorkspace.userActionRequests.every(
        (request) => request.accountCreationAuthorized === false,
      )
        ? false
        : "unexpected_true_present";
    report.summary = {
      captureCount: report.captures.length,
      runtimeErrorCount: report.runtimeErrors.length,
      capturesWithDocumentHorizontalOverflow: report.captures
        .filter((entry) => entry.layout.documentHorizontalOverflow > 0)
        .map((entry) => entry.fileName),
      capturesWithMainHorizontalOverflow: report.captures
        .filter((entry) => (entry.layout.mainHorizontalOverflow ?? 0) > 0)
        .map((entry) => entry.fileName),
      capturesWithHiddenShellDestinations: report.captures
        .filter((entry) => entry.layout.hiddenShellDestinations.length > 0)
        .map((entry) => ({
          fileName: entry.fileName,
          hidden: entry.layout.hiddenShellDestinations,
        })),
      capturesWithUnreachableShellDestinations: report.captures
        .filter((entry) => entry.layout.unreachableShellDestinations.length > 0)
        .map((entry) => ({
          fileName: entry.fileName,
          unreachable: entry.layout.unreachableShellDestinations,
        })),
      capturesWithClippedInteractive: report.captures
        .filter((entry) => entry.layout.clippedInteractive.length > 0)
        .map((entry) => ({
          fileName: entry.fileName,
          controls: entry.layout.clippedInteractive,
        })),
    };
    await writeJson("capture-report.json", report);
    process.stdout.write(
      `Saved ${report.captures.length} deep acceptance captures to ${outputDir}\n`,
    );
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure.
      }
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

run().catch(async (error) => {
  report.failedAt = new Date().toISOString();
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  await mkdir(outputDir, { recursive: true });
  await writeJson("capture-report.json", report);
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
});
