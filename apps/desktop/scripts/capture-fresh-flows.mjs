import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  ACCEPTANCE_VERSION,
  acceptanceEnvironment,
  assertViewportEvidence,
  assertFileRenderer,
  assertPrepareOnly,
  attachProcessOutput,
  cleanupDirectory,
  createOwnedProcessLedger,
  digestSeed,
  ensureFreshOutputDir,
  finalizeProcessOutput,
  loadAcceptanceContext,
  makeIsolatedUserDataDirectory,
  PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
  resolvePrimaryRunError,
  resolveStartupBrowserWindow,
  screenshotMetadata,
  stopAndVerifyOwnedElectron,
  stableJson,
  installPrepareOnlySafetyProbe,
  verifyAcceptanceArtifacts,
} from "./release-acceptance-harness.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const acceptance = loadAcceptanceContext("fresh");
const outputDir = acceptance.outputDir;
const viewports = [
  { slug: "desktop", width: 1440, height: 920, zoomFactor: 1 },
  { slug: "native-125", width: 1440, height: 920, zoomFactor: 1.25 },
  { slug: "minimum", width: 1024, height: 768, zoomFactor: 1 },
];
const PLANNING_SETTINGS_MENU_LABEL = "More";
// The expanded 17rem sidebar lists everything inline; only the compact top
// navigation keeps a More menu.
const WIDE_SIDEBAR_DESTINATIONS = Object.freeze([
  "Home",
  "Profile",
  "Find jobs",
  "Shortlisted",
  "Applications",
  "Companies",
  "Outcomes",
  "Search plans",
  "Resume approaches",
  "Safeguards",
  "Settings",
  "Keyboard shortcuts",
]);
const PLANNING_SETTINGS_MENU_DESTINATIONS = Object.freeze([
  "Search plans",
  "Resume approaches",
  "Settings",
]);
const LONG_LABEL_JOB_TITLES = Object.freeze([
  "Principal Accessibility Platform Engineer For Distributed Realtime Collaboration Infrastructure And Design Tooling",
  "Staff Machine Learning Infrastructure Engineer Focused On Large Scale Retrieval Evaluation And Offline Replay Systems",
]);
const LONG_LABEL_COMPANIES = Object.freeze([
  "Northwind Consolidated Manufacturing And Robotics Systems International Holdings Public Limited Company",
  "Mercury Advanced Computational Sciences Laboratory For Applied Research Engineering And Product Development Group",
]);
const LONG_LABEL_LOCATIONS = Object.freeze([
  "Hybrid, London, United Kingdom, with quarterly travel to the Lisbon engineering hub and occasional customer sites",
  "Remote, European Union, headquartered in Berlin with distributed teammates across Amsterdam, Dublin, and Warsaw",
]);
const LONG_LABEL_META_LINES = Object.freeze([
  `${LONG_LABEL_COMPANIES[0]} • ${LONG_LABEL_LOCATIONS[0]}`,
  `${LONG_LABEL_COMPANIES[1]} • ${LONG_LABEL_LOCATIONS[1]}`,
]);
const LONG_LABEL_SOURCE_NAMES = Object.freeze([
  "Northwind Consolidated Manufacturing Careers Board With An Extremely Long Organizational Descriptor For Truncation Truth Coverage",
  "Mercury Advanced Computational Sciences Laboratory Job Listings Portal With A Deliberately Exhaustive Suffix For Ellipsis Coverage",
]);
const LONG_LABEL_CAMPAIGN_NAME =
  "Synthetic Long-Label Campaign With A Deliberately Verbose Name To Exercise Header And Pill Truncation Truth";
const LONG_LABEL_JOB_TOTAL = 12;
const LONG_LABEL_SOURCE_TOTAL = 8;
// Distinct required scenario IDs claim different semantic state, so they must
// never produce pixel-identical PNG evidence. A deliberate duplicate would have
// to be declared here as a frozen ["scenario-a", "scenario-b"] pair scoped to
// exactly those two IDs; none are expected for this component.
const DECLARED_DUPLICATE_SCREENSHOT_SCENARIO_PAIRS = Object.freeze([]);
const pngSha256Index = new Map();

function canonicalDuplicatePairKey(leftScenarioId, rightScenarioId) {
  return [leftScenarioId, rightScenarioId].sort().join("\u0000");
}

function registerScreenshotCollisionGuard(entry) {
  const digest = entry.screenshot?.sha256;
  assert(
    typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
    `Capture ${entry.scenarioId} (${entry.fileName}) has no usable PNG sha256 for the screenshot collision guard.`,
  );
  const priorOwners = pngSha256Index.get(digest) ?? [];
  for (const owner of priorOwners) {
    if (owner.scenarioId === entry.scenarioId) continue;
    const declared = DECLARED_DUPLICATE_SCREENSHOT_SCENARIO_PAIRS.some(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        canonicalDuplicatePairKey(pair[0], pair[1]) ===
          canonicalDuplicatePairKey(owner.scenarioId, entry.scenarioId),
    );
    if (declared) continue;
    throw new Error(
      `Screenshot collision guard failed: required scenarios "${owner.scenarioId}" (${owner.fileName}) and "${entry.scenarioId}" (${entry.fileName}) produced identical PNG sha256 ${digest}. Distinct required scenarios must not ship pixel-identical evidence; declare a deliberate duplicate pair explicitly if one is ever intended.`,
    );
  }
  pngSha256Index.set(digest, [
    ...priorOwners,
    { scenarioId: entry.scenarioId, fileName: entry.fileName },
  ]);
  report.screenshotCollisionGuard.checkedCaptures += 1;
}

const report = {
  startedAt: new Date().toISOString(),
  outputDir,
  acceptance: {
    version: ACCEPTANCE_VERSION,
    manifestPath: acceptance.manifestPath,
    runDir: acceptance.runDir,
    sourceFingerprint: acceptance.manifest.source?.afterBuild?.digest ?? null,
    buildArtifactFingerprint: acceptance.manifest.artifacts?.digest ?? null,
    seedDigest: acceptance.seedDigest,
  },
  pass: false,
  safety: {
    syntheticCandidateDataOnly: true,
    browserAgentEnabled: false,
    applicationActionsExecuted: null,
    finalSubmissionClicked: null,
    submitAuthorized: null,
    accountCreationAuthorized: null,
    prepareOnlyVerified: null,
    observedSafetyEvents: [],
  },
  captures: [],
  scenarios: {},
  screenshotCollisionGuard: {
    declaredDuplicatePairs: DECLARED_DUPLICATE_SCREENSHOT_SCENARIO_PAIRS,
    checkedCaptures: 0,
  },
  requiredScenarioCompletionIds: [
    "home-zero-desktop",
    "home-zero-minimum",
    "profile-basics-populated-first-viewport",
    "profile-experience-populated-first-viewport",
    "collapsed-shell-wordmark-minimum",
    "opening-workspace-desktop",
    "guided-setup-empty-desktop",
    "guided-setup-empty-native125",
    "wide-sidebar-1440",
    "compact-planning-settings-minimum",
    "profile-sources-p1",
    "profile-sources-p2",
    "profile-sources-filtered-empty",
    "profile-sources-native125",
    "discovery-p1",
    "discovery-filtered-empty",
    "discovery-native125",
    "planning-settings-menu-native125",
    "home-zero-native125",
    "long-label-desktop",
    "long-label-minimum",
    "long-label-native125",
    "long-label-sources-native125",
  ],
  scenarioCompletionIds: [],
  runtimeErrors: [],
  mainProcess: { pid: null, stdout: "", stderr: "" },
  processOwnership: {
    trackedProcesses: [],
    verifications: [],
    leftoverPids: [],
    verified: false,
    failure: null,
  },
};
let activeBrowserWindow = null;

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function completeScenario(scenarioId, evidence) {
  if (!report.requiredScenarioCompletionIds.includes(scenarioId))
    throw new Error(
      `Unknown required scenario completion ID: ${scenarioId}. Update the manifest before completing it.`,
    );
  if (!evidence || typeof evidence !== "object")
    throw new Error(
      `Scenario ${scenarioId} completed without capture evidence.`,
    );
  if (
    evidence.pass !== true ||
    evidence.insideViewport !== true ||
    evidence.noClip !== true
  )
    throw new Error(
      `Required scenario ${scenarioId} did not pass its capture evidence: ${JSON.stringify(
        {
          pass: evidence.pass,
          insideViewport: evidence.insideViewport,
          noClip: evidence.noClip,
          failures: evidence.failures ?? [],
        },
      )}`,
    );
  if (!report.scenarioCompletionIds.includes(scenarioId))
    report.scenarioCompletionIds.push(scenarioId);
}
function assertZeroDashboardMetrics(workspace) {
  assert(
    workspace?.hydration?.phase === "complete",
    "Fresh home metrics were read before workspace hydration completed.",
  );
  const dashboard = workspace.dashboard;
  assert(
    dashboard && typeof dashboard === "object",
    "Fresh home has no dashboard snapshot.",
  );
  const metrics = {
    jobsFoundToday: dashboard.jobsFoundToday,
    jobsAwaitingReview: dashboard.jobsAwaitingReview,
    applicationsReadyForApproval: dashboard.applicationsReadyForApproval,
    applicationsAppliedToday: dashboard.applicationsAppliedToday,
    applicationsAppliedThisWeek: dashboard.applicationsAppliedThisWeek,
    needsYouCount: dashboard.needsYouCount,
    upcomingInterviews: dashboard.upcomingInterviews,
    upcomingFollowUps: dashboard.upcomingFollowUps,
    sourceCount: dashboard.sourceHealth?.total,
  };
  const nonZeroMetrics = Object.entries(metrics).filter(
    ([, value]) => value !== 0,
  );
  assert(
    nonZeroMetrics.length === 0,
    `Fresh home did not have zero dashboard metrics: ${JSON.stringify(nonZeroMetrics)}`,
  );
  return metrics;
}
function assertHydratedCollectionCount(
  workspace,
  collection,
  expectedCount,
  label,
) {
  assert(
    workspace?.hydration?.phase === "complete",
    `${label} was read before workspace hydration completed.`,
  );
  const values = workspace[collection];
  assert(
    Array.isArray(values) && values.length === expectedCount,
    `${label} expected ${expectedCount} populated ${collection}, received ${Array.isArray(values) ? values.length : "missing"}.`,
  );
  return values.length;
}
async function writeReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "capture-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}
async function waitForCondition(check, description, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function getWorkspace(page) {
  return page.evaluate(() => window.nestor.jobFinder.getWorkspace());
}
async function setViewport(page, browserWindow, viewport) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await browserWindow.evaluate((win, zoomFactor) => {
    win.webContents.setZoomFactor(zoomFactor);
  }, viewport.zoomFactor);
  await page.waitForTimeout(320);
}
async function resetScroll(page) {
  await page.evaluate(() => {
    document.querySelector("main")?.scrollTo({ top: 0, left: 0 });
    for (const el of document.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY)) el.scrollTo({ top: 0, left: 0 });
    }
  });
}
async function ensureLocatorText(page, text) {
  await page.getByText(text, { exact: true }).first().waitFor({
    state: "visible",
    timeout: 10000,
  });
}
async function clickNavigationControl(page, name) {
  const roleControl = page.getByRole("button", { name }).first();
  if (await roleControl.count()) {
    await roleControl.click({ force: true });
    return;
  }

  const control = page
    .locator('button:visible, [role="tab"]:visible')
    .filter({ hasText: name })
    .first();
  if (await control.count()) {
    await control.click();
    return;
  }

  await page.getByRole("tab", { name }).click({ force: true });
}
async function scanLayout(page) {
  return page.evaluate((wideSidebarDestinations) => {
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const label = (el) =>
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
      el.tagName.toLowerCase();
    const descriptor = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : ""}`;
    const interactive = Array.from(
      document.querySelectorAll(
        "button,a,input,select,textarea,summary,[role=button],[role=checkbox],[role=radio],[tabindex]",
      ),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    const clippedInteractive = interactive
      .flatMap((el) => {
        const rect = el.getBoundingClientRect();
        const intersects =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        const scrollableAncestor = (() => {
          let ancestor = el.parentElement;
          while (ancestor) {
            const style = getComputedStyle(ancestor);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + 2
            )
              return ancestor;
            ancestor = ancestor.parentElement;
          }
          return null;
        })();
        const verticallyClipped =
          rect.top < -1 || rect.bottom > window.innerHeight + 1;
        const horizontallyClipped =
          rect.left < -1 || rect.right > window.innerWidth + 1;
        if (
          !intersects ||
          (rect.left >= -1 &&
            rect.right <= window.innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= window.innerHeight + 1)
        )
          return [];
        if (verticallyClipped && !horizontallyClipped && scrollableAncestor)
          return [];
        return [
          {
            label: label(el),
            selector: descriptor(el),
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
            },
          },
        ];
      })
      .slice(0, 20);
    const shell = document.querySelector("[data-job-finder-shell]");
    const shellRect = shell?.getBoundingClientRect();
    const shellStyle =
      shell instanceof HTMLElement ? getComputedStyle(shell) : null;
    const shellScrollable =
      shell instanceof HTMLElement &&
      Boolean(shellStyle && /(auto|scroll)/.test(shellStyle.overflowY)) &&
      shell.scrollHeight > shell.clientHeight + 2;
    const shellControls = Array.from(
      document.querySelectorAll(
        'nav[aria-label="Job Finder sections"] button, [aria-label="Notifications and actions"] > button, [aria-label="Notifications and actions"] > details > summary',
      ),
    );
    const shellDestinations = shellControls.map((el) => {
      const shellContainer = el.closest(
        'nav[aria-label="Job Finder sections"], [aria-label="Notifications and actions"]',
      );
      // The compact sections nav is intentionally hidden at the wide sidebar
      // breakpoint. Only controls owned by a rendered shell container are
      // expected at the active breakpoint; controls in that container still
      // have to be visible and reachable.
      const expectedAtBreakpoint =
        shellContainer instanceof HTMLElement && rendered(shellContainer);
      const rect = el.getBoundingClientRect();
      const horizontal = rect.left >= -1 && rect.right <= window.innerWidth + 1;
      const vertical = rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      const shellTop =
        shell instanceof HTMLElement && shellRect
          ? rect.top - shellRect.top + shell.scrollTop
          : null;
      const verticallyReachable =
        shellScrollable &&
        shellTop !== null &&
        shellTop >= -1 &&
        shellTop + rect.height <= shell.scrollHeight + 1;
      return {
        label: label(el),
        expectedAtBreakpoint,
        visible: rendered(el) && horizontal && vertical,
        reachable:
          expectedAtBreakpoint &&
          rendered(el) &&
          horizontal &&
          (vertical || verticallyReachable),
      };
    });
    const main = document.querySelector("main");
    const inputsOverflow = Array.from(
      document.querySelectorAll("input,textarea,select"),
    )
      .filter((el) => el instanceof HTMLElement && rendered(el))
      .map((el) => {
        const overflow = el.scrollWidth > el.clientWidth + 2;
        const value =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.value
            : (el.textContent ?? "");
        return {
          selector: descriptor(el),
          type: el.tagName.toLowerCase(),
          valueSnippet: value.slice(0, 80),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflow,
          rect: {
            left: Math.round(el.getBoundingClientRect().left),
            right: Math.round(el.getBoundingClientRect().right),
          },
        };
      })
      .filter((e) => e.overflow)
      .slice(0, 10);
    const pills = Array.from(
      document.querySelectorAll(
        '[class*="truncate"], .truncate, [class*="badge"], .badge, [class*="pill"]',
      ),
    )
      .filter((el) => el instanceof HTMLElement && rendered(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        // Pill truncate fix: elements with textOverflow ellipsis and overflow hidden are expected to have scrollWidth > clientWidth but should not be flagged if they correctly truncate
        const style = getComputedStyle(el);
        const isTruncate =
          el.classList.contains("truncate") ||
          style.textOverflow === "ellipsis" ||
          style.overflow === "hidden";
        const clipped =
          rect.right > window.innerWidth + 1 ||
          (el.scrollWidth > el.clientWidth + 2 && !isTruncate);
        // Also check if the element's parent clips it correctly
        return {
          text: el.textContent?.replace(/\s+/g, " ").trim().slice(0, 80),
          clipped,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          className: el.className.slice(0, 200),
          isTruncate,
          styleOverflow: style.overflow,
          textOverflow: style.textOverflow,
        };
      })
      .filter((e) => e.clipped)
      .slice(0, 10);
    const shellPt = (() => {
      const content = document.querySelector("[data-job-finder-shell-content]");
      if (!(content instanceof HTMLElement)) return null;
      const style = getComputedStyle(content);
      return {
        paddingTop: style.paddingTop,
        className: content.className.slice(0, 300),
      };
    })();
    const sidebar = document.querySelector("[data-job-finder-sidebar]");
    const sidebarNavigation = sidebar?.querySelector(
      'nav[aria-label="Job Finder sidebar destinations"]',
    );
    const sidebarRect = sidebar?.getBoundingClientRect();
    const sidebarLabels = sidebarNavigation
      ? Array.from(sidebarNavigation.querySelectorAll("button"))
          .filter((button) => button instanceof HTMLElement && rendered(button))
          .map((button) => label(button))
      : [];
    const sidebarVisible =
      sidebar instanceof HTMLElement && rendered(sidebar) && sidebarRect;
    const sidebarInsideViewport = Boolean(
      sidebarVisible &&
      sidebarRect.left >= -1 &&
      sidebarRect.right <= window.innerWidth + 1 &&
      sidebarRect.top >= -1 &&
      sidebarRect.bottom <= window.innerHeight + 1,
    );
    const wideSidebarInfo = {
      exists: sidebar instanceof HTMLElement,
      visible: Boolean(sidebarVisible),
      insideViewport: sidebarInsideViewport,
      horizontalOverflow:
        sidebar instanceof HTMLElement
          ? Math.max(0, sidebar.scrollWidth - sidebar.clientWidth)
          : null,
      horizontalOverflowSuppressed:
        sidebar instanceof HTMLElement
          ? ["hidden", "clip"].includes(getComputedStyle(sidebar).overflowX)
          : false,
      labels: sidebarLabels,
      // At >=1440 CSS px every destination is an inline sidebar row: the
      // journey, both "Everything else" groups, and the shortcuts entry. No
      // dropdown lives inside a navigation column that is already on screen.
      requiredLabels: wideSidebarDestinations,
      requiredDestinationsVisible: wideSidebarDestinations.every(
        (requiredLabel) =>
          sidebarLabels.some((sidebarLabel) =>
            sidebarLabel.startsWith(requiredLabel),
          ),
      ),
      moreTriggerCount: sidebarNavigation
        ? sidebarNavigation.querySelectorAll(
            '[data-job-finder-sidebar-more], button[aria-label^="More"]',
          ).length
        : null,
      scrollOwnerOverflowY: (() => {
        const region = sidebar?.querySelector(
          "[data-job-finder-sidebar-scroll-region]",
        );
        return region instanceof HTMLElement
          ? getComputedStyle(region).overflowY
          : null;
      })(),
      pass: Boolean(sidebarVisible && sidebarInsideViewport),
      rect: sidebarRect
        ? {
            top: sidebarRect.top,
            right: sidebarRect.right,
            bottom: sidebarRect.bottom,
            left: sidebarRect.left,
          }
        : null,
    };
    wideSidebarInfo.pass = Boolean(
      wideSidebarInfo.pass &&
      wideSidebarInfo.horizontalOverflowSuppressed &&
      wideSidebarInfo.requiredDestinationsVisible &&
      wideSidebarInfo.moreTriggerCount === 0 &&
      /(auto|scroll)/.test(wideSidebarInfo.scrollOwnerOverflowY ?? ""),
    );

    const planningButton = document.querySelector('button[aria-label^="More"]');
    const compactNavigation = document.querySelector(
      'nav[aria-label="Job Finder sections"]',
    );
    const compactPlanningInfo = {
      buttonExists: planningButton instanceof HTMLElement,
      buttonVisible:
        planningButton instanceof HTMLElement && rendered(planningButton),
      navigationVisible:
        compactNavigation instanceof HTMLElement && rendered(compactNavigation),
      sidebarHidden: !(sidebar instanceof HTMLElement && rendered(sidebar)),
    };
    compactPlanningInfo.pass =
      compactPlanningInfo.buttonVisible &&
      compactPlanningInfo.navigationVisible &&
      compactPlanningInfo.sidebarHidden;

    const planningMenu = document.querySelector(
      '[role="navigation"][aria-label="More"]',
    );
    const planningMenuInfo = planningMenu
      ? (() => {
          const rect = planningMenu.getBoundingClientRect();
          const visible = rendered(planningMenu);
          const style = getComputedStyle(planningMenu);
          const menuScrollable =
            planningMenu.scrollHeight > planningMenu.clientHeight + 2 ||
            /(auto|scroll)/.test(style.overflowY);
          const items = Array.from(planningMenu.querySelectorAll("button")).map(
            (item) => {
              const itemRect = item.getBoundingClientRect();
              const itemVisible = rendered(item);
              const withinViewport =
                itemRect.left >= -1 &&
                itemRect.right <= window.innerWidth + 1 &&
                itemRect.top >= -1 &&
                itemRect.bottom <= window.innerHeight + 1;
              return {
                label: (
                  item.getAttribute("aria-label") ??
                  item.textContent?.replace(/\s+/g, " ").trim() ??
                  ""
                ).slice(0, 80),
                visible: itemVisible,
                withinViewport,
                reachable: itemVisible && (withinViewport || menuScrollable),
                tabIndex: item.getAttribute("tabindex"),
              };
            },
          );
          const horizontallyInside =
            rect.left >= -1 && rect.right <= window.innerWidth + 1;
          const verticallyInside =
            rect.top >= -1 && rect.top < window.innerHeight;
          const insideViewport =
            visible &&
            horizontallyInside &&
            verticallyInside &&
            (rect.bottom <= window.innerHeight + 1 || menuScrollable) &&
            items.every((item) => item.reachable);
          return {
            exists: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            visible,
            insideViewport,
            horizontallyInside,
            verticallyInside,
            menuScrollable,
            labels: items.map((item) => item.label),
            requiredLabels: ["Search plans", "Resume approaches", "Settings"],
            requiredDestinationsVisible: [
              "Search plans",
              "Resume approaches",
              "Settings",
            ].every((requiredLabel) =>
              items.some((item) => item.label === requiredLabel),
            ),
            items,
          };
        })()
      : {
          exists: false,
          visible: false,
          insideViewport: false,
          requiredDestinationsVisible: false,
          items: [],
        };
    planningMenuInfo.pass =
      planningMenuInfo.insideViewport &&
      planningMenuInfo.requiredDestinationsVisible;
    const emptyUnified = Array.from(document.querySelectorAll("*"))
      .filter(
        (el) =>
          el instanceof HTMLElement &&
          /No sources match|No jobs|No matching jobs|No sources match this view/i.test(
            el.textContent ?? "",
          ) &&
          rendered(el),
      )
      .slice(0, 5)
      .map((el) => ({
        text: el.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
        className: el.className.slice(0, 200),
      }));
    return {
      route: window.location.hash,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentHorizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      mainHorizontalOverflow:
        main instanceof HTMLElement
          ? Math.max(0, main.scrollWidth - main.clientWidth)
          : null,
      clippedInteractive,
      shellDestinations,
      hiddenShellDestinations: shellDestinations
        .filter((e) => e.expectedAtBreakpoint && !e.visible)
        .map((e) => e.label),
      unreachableShellDestinations: shellDestinations
        .filter((e) => e.expectedAtBreakpoint && !e.reachable)
        .map((e) => e.label),
      inputsOverflow,
      pillsClipped: pills,
      shellPt,
      wideSidebarInfo,
      compactPlanningInfo,
      planningMenuInfo,
      emptyUnified,
      scrollables: Array.from(document.querySelectorAll("*"))
        .filter(
          (el) =>
            el instanceof HTMLElement &&
            rendered(el) &&
            /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
            el.scrollHeight > el.clientHeight + 2,
        )
        .slice(0, 5)
        .map((el) => ({
          selector: descriptor(el),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        })),
    };
  }, WIDE_SIDEBAR_DESTINATIONS);
}

async function collectWordmarkEvidence(page) {
  return page.evaluate(() => {
    const wordmark = document.querySelector("[data-desktop-brand-wordmark]");
    const shell = document.querySelector("[data-job-finder-shell]");
    if (!(wordmark instanceof HTMLElement)) {
      return { pass: false, failures: ["wordmark marker is missing"] };
    }
    const rect = wordmark.getBoundingClientRect();
    const style = getComputedStyle(wordmark);
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0;
    const insideViewport =
      rect.left >= -1 &&
      rect.top >= -1 &&
      rect.right <= window.innerWidth + 1 &&
      rect.bottom <= window.innerHeight + 1;
    const text = wordmark.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const collapsed = shell?.getAttribute("data-sidebar-collapsed") === "true";
    const failures = [];
    if (!visible) failures.push("wordmark is not visibly rendered");
    if (!insideViewport)
      failures.push("wordmark is clipped outside the viewport");
    if (text !== "NESTOR") failures.push(`unexpected wordmark text: ${text}`);
    return {
      collapsed,
      failures,
      insideViewport,
      pass: failures.length === 0,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      text,
      visible,
    };
  });
}

async function collectGuidedSetupPrimaryActionEvidence(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const clippingValues = new Set([
      "auto",
      "clip",
      "hidden",
      "overlay",
      "scroll",
    ]);
    const describe = (element) =>
      element instanceof Element
        ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`
        : null;
    const rendered = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails && !element.matches("summary")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        element.getClientRects().length > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const geometry = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const visibleRect = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
      const clippingAncestors = [];
      for (
        let ancestor = element.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        const clipsX = clippingValues.has(style.overflowX);
        const clipsY = clippingValues.has(style.overflowY);
        if (clipsX || clipsY) clippingAncestors.push(describe(ancestor));
        if (clipsX) {
          visibleRect.left = Math.max(visibleRect.left, ancestorRect.left);
          visibleRect.right = Math.min(visibleRect.right, ancestorRect.right);
        }
        if (clipsY) {
          visibleRect.top = Math.max(visibleRect.top, ancestorRect.top);
          visibleRect.bottom = Math.min(
            visibleRect.bottom,
            ancestorRect.bottom,
          );
        }
      }
      visibleRect.left = Math.max(visibleRect.left, 0);
      visibleRect.top = Math.max(visibleRect.top, 0);
      visibleRect.right = Math.min(visibleRect.right, window.innerWidth);
      visibleRect.bottom = Math.min(visibleRect.bottom, window.innerHeight);
      const visibleWidth = Math.max(0, visibleRect.right - visibleRect.left);
      const visibleHeight = Math.max(0, visibleRect.bottom - visibleRect.top);
      const fullyInsideViewport =
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= window.innerWidth + 1 &&
        rect.bottom <= window.innerHeight + 1;
      const fullyUnclipped =
        visibleWidth >= rect.width - 1 && visibleHeight >= rect.height - 1;
      const centerInsideViewport =
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight;
      const hit = centerInsideViewport
        ? document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          )
        : null;
      const hitTestInsideTarget =
        hit instanceof Node && (hit === element || element.contains(hit));
      return {
        clippingAncestors,
        fullyInsideViewport,
        fullyUnclipped,
        hitTestInsideTarget,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        visibleRect: {
          left: visibleRect.left,
          top: visibleRect.top,
          right: visibleRect.right,
          bottom: visibleRect.bottom,
          width: visibleWidth,
          height: visibleHeight,
        },
      };
    };
    const heading = Array.from(document.querySelectorAll("h1")).find(
      (candidate) => normalize(candidate.textContent) === "Guided setup",
    );
    const actionSpecs = [
      { id: "choose-resume", label: "Choose my resume file…" },
      { id: "enter-manually", label: "Enter details manually" },
    ];
    const actions = actionSpecs.map(({ id, label }) => {
      const matches = Array.from(document.querySelectorAll("button")).filter(
        (candidate) => normalize(candidate.textContent).includes(label),
      );
      const renderedMatches = matches.filter(rendered);
      const element = renderedMatches[0] ?? matches[0] ?? null;
      const measured = geometry(element);
      const visible = rendered(element);
      const enabled =
        element instanceof HTMLButtonElement &&
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true";
      return {
        enabled,
        found: renderedMatches.length === 1,
        id,
        label,
        matchCount: matches.length,
        renderedMatchCount: renderedMatches.length,
        text: element ? normalize(element.textContent) : null,
        visible,
        ...(measured ?? {}),
      };
    });
    const failures = [];
    const headingVisible = rendered(heading);
    if (!headingVisible) failures.push("Guided setup heading is not visible");
    if (window.location.hash !== "#/job-finder/profile/setup")
      failures.push(
        `expected pristine Guided setup route, observed ${window.location.hash}`,
      );
    for (const action of actions) {
      if (!action.found)
        failures.push(
          `${action.label} did not resolve to exactly one rendered button`,
        );
      if (!action.visible) failures.push(`${action.label} is not visible`);
      if (!action.fullyInsideViewport)
        failures.push(`${action.label} is outside the CSS viewport`);
      if (!action.fullyUnclipped)
        failures.push(`${action.label} is clipped by an ancestor or viewport`);
      if (!action.hitTestInsideTarget)
        failures.push(
          `${action.label} is not the visible element at its center`,
        );
      if (!action.enabled) failures.push(`${action.label} is disabled`);
    }
    return {
      actions,
      failures,
      heading: {
        text: heading ? normalize(heading.textContent) : null,
        visible: headingVisible,
      },
      pass: failures.length === 0,
      route: window.location.hash,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

async function collectOpeningHeaderEvidence(page) {
  return page.evaluate(() => {
    const shell = document.querySelector("[data-job-finder-opening-shell]");
    const header = document.querySelector("[data-job-finder-shell-header]");
    const brand = document.querySelector("[data-desktop-brand]");
    const wordmark = document.querySelector("[data-desktop-brand-wordmark]");
    const navigation = document.querySelector(
      "[data-desktop-module-navigation]",
    );
    const isMac = shell?.classList.contains("platform-darwin") === true;
    if (
      !(shell instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(brand instanceof HTMLElement) ||
      !(wordmark instanceof HTMLElement) ||
      !(navigation instanceof HTMLElement)
    ) {
      return {
        pass: false,
        failures: ["opening-shell header markers are missing"],
      };
    }
    const headerRect = header.getBoundingClientRect();
    const brandRect = brand.getBoundingClientRect();
    const wordmarkRect = wordmark.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const macControlClearancePx = wordmarkRect.left;
    const navigationCenterDelta = Math.abs(
      navigationRect.left +
        navigationRect.width / 2 -
        (headerRect.left + headerRect.width / 2),
    );
    const failures = [];
    if (wordmark.textContent?.trim() !== "NESTOR")
      failures.push("opening-shell wordmark is not the production wordmark");
    if (headerRect.height !== 56)
      failures.push(`opening-shell header height is ${headerRect.height}px`);
    if (isMac && macControlClearancePx < 88)
      failures.push(
        `opening-shell wordmark starts inside the macOS controls area (${macControlClearancePx}px)`,
      );
    if (navigationCenterDelta > 2)
      failures.push(
        `opening-shell module navigation center delta ${navigationCenterDelta}px`,
      );
    if (brandRect.bottom > headerRect.bottom + 1)
      failures.push("opening-shell brand escapes the header bounds");
    return {
      failures,
      headerHeight: headerRect.height,
      isMac,
      macControlClearancePx,
      navigationCenterDelta,
      pass: failures.length === 0,
      wordmark: wordmark.textContent?.trim() ?? "",
    };
  });
}

async function collectWorkspaceStateGeometry(page) {
  return page.evaluate(() => {
    const card = document.querySelector("[data-workspace-state-screen]");
    const title = document.querySelector("[data-workspace-state-title]");
    const message = document.querySelector("[data-workspace-state-message]");
    const main = card?.closest("main");
    if (
      !(card instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(message instanceof HTMLElement) ||
      !(main instanceof HTMLElement)
    ) {
      return {
        pass: false,
        failures: ["workspace-state geometry markers are missing"],
      };
    }
    const mainRect = main.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();
    const centerDeltaX = Math.abs(
      cardRect.left + cardRect.width / 2 - (mainRect.left + mainRect.width / 2),
    );
    const centerDeltaY = Math.abs(
      cardRect.top + cardRect.height / 2 - (mainRect.top + mainRect.height / 2),
    );
    const textCentered = [title, message].every(
      (element) => getComputedStyle(element).textAlign === "center",
    );
    const childrenCentered = getComputedStyle(card).justifyItems === "center";
    const failures = [];
    if (centerDeltaX > 2)
      failures.push(`card horizontal center delta ${centerDeltaX}`);
    if (centerDeltaY > 2)
      failures.push(`card vertical center delta ${centerDeltaY}`);
    if (!textCentered) failures.push("title/message text is not centered");
    if (!childrenCentered)
      failures.push("workspace-state card children are not centered");
    return {
      centerDeltaX,
      centerDeltaY,
      childrenCentered,
      failures,
      pass: failures.length === 0,
      textCentered,
      title: title.textContent?.replace(/\s+/g, " ").trim() ?? "",
      message: message.textContent?.replace(/\s+/g, " ").trim() ?? "",
      rects: {
        main: mainRect.toJSON(),
        card: cardRect.toJSON(),
        title: titleRect.toJSON(),
        message: messageRect.toJSON(),
      },
    };
  });
}
async function probeNestedScroll(page) {
  const setup = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("*"))
      .filter(
        (el) =>
          el instanceof HTMLElement &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 2 &&
          el.getBoundingClientRect().bottom > 0 &&
          el.getBoundingClientRect().top < window.innerHeight,
      )
      .sort(
        (a, b) =>
          b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
      );
    const openMenu = document.querySelector(
      '[role="navigation"][aria-label="More"]',
    );
    if (openMenu instanceof HTMLElement && !candidates.includes(openMenu)) {
      return { available: false };
    }
    const lockedPane = candidates.find((candidate) =>
      candidate.matches("[data-locked-pane-scroll-region]"),
    );
    const target =
      openMenu instanceof HTMLElement && candidates.includes(openMenu)
        ? openMenu
        : (lockedPane ?? candidates[0]);
    if (!(target instanceof HTMLElement)) return { available: false };
    for (const candidate of candidates) candidate.scrollTop = 0;
    if (lockedPane === target) {
      for (const candidate of candidates) {
        if (candidate !== target && candidate.contains(target)) {
          candidate.scrollTop = Math.max(
            0,
            candidate.scrollHeight - candidate.clientHeight,
          );
        }
      }
    }
    for (const candidate of candidates) {
      candidate.setAttribute(
        "data-acceptance-scroll-baseline",
        String(candidate.scrollTop),
      );
    }
    const rect = target.getBoundingClientRect();
    const hadTabIndex = target.hasAttribute("tabindex");
    const previousTabIndex = target.getAttribute("tabindex");
    if (!hadTabIndex) target.setAttribute("tabindex", "-1");
    target.setAttribute("data-acceptance-scroll-target", "true");
    target.focus({ preventScroll: true });
    return {
      available: true,
      centerX: Math.max(
        2,
        Math.min(window.innerWidth - 2, rect.left + rect.width / 2),
      ),
      centerY: Math.max(
        2,
        Math.min(window.innerHeight - 2, rect.top + rect.height / 2),
      ),
      candidateCount: candidates.length,
      hadTabIndex,
      previousTabIndex,
      target: target.tagName.toLowerCase(),
    };
  });
  if (!setup.available)
    return {
      available: false,
      wheelMoved: false,
      keyboardMoved: false,
      wheelLeaked: false,
      keyboardLeaked: false,
    };
  await page.mouse.move(setup.centerX, setup.centerY);
  const beforeWheel = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-acceptance-scroll-target], *"))
      .filter(
        (el) =>
          el instanceof HTMLElement &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 2,
      )
      .map((el) => ({
        target: el.hasAttribute("data-acceptance-scroll-target"),
        top: el.scrollTop,
      })),
  );
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(80);
  const wheel = await page.evaluate(() => {
    const target = document.querySelector("[data-acceptance-scroll-target]");
    if (!(target instanceof HTMLElement))
      return { moved: false, leaked: false };
    const candidates = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        el instanceof HTMLElement &&
        /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
        el.scrollHeight > el.clientHeight + 2,
    );
    const targetTop = target.scrollTop;
    const leaked = candidates.some(
      (el) =>
        el !== target &&
        el.contains(target) &&
        el.scrollTop !==
          Number(el.getAttribute("data-acceptance-scroll-baseline") ?? "0"),
    );
    return { moved: targetTop > 0, leaked, targetTop };
  });
  await page.evaluate(() => {
    const target = document.querySelector("[data-acceptance-scroll-target]");
    if (target instanceof HTMLElement) target.scrollTop = 0;
    for (const candidate of document.querySelectorAll(
      "[data-acceptance-scroll-baseline]",
    )) {
      if (candidate instanceof HTMLElement) {
        candidate.setAttribute(
          "data-acceptance-scroll-baseline",
          String(candidate.scrollTop),
        );
      }
    }
  });
  await page.mouse.move(setup.centerX, setup.centerY);
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(80);
  const keyboard = await page.evaluate(() => {
    const target = document.querySelector("[data-acceptance-scroll-target]");
    if (!(target instanceof HTMLElement))
      return { moved: false, leaked: false };
    const candidates = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        el instanceof HTMLElement &&
        /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
        el.scrollHeight > el.clientHeight + 2,
    );
    return {
      moved: target.scrollTop > 0,
      leaked: candidates.some(
        (el) =>
          el !== target &&
          el.contains(target) &&
          el.scrollTop !==
            Number(el.getAttribute("data-acceptance-scroll-baseline") ?? "0"),
      ),
      targetTop: target.scrollTop,
    };
  });
  await page.evaluate(({ hadTabIndex, previousTabIndex }) => {
    const target = document.querySelector("[data-acceptance-scroll-target]");
    if (!(target instanceof HTMLElement)) return;
    target.removeAttribute("data-acceptance-scroll-target");
    for (const candidate of document.querySelectorAll(
      "[data-acceptance-scroll-baseline]",
    )) {
      candidate.removeAttribute("data-acceptance-scroll-baseline");
    }
    if (hadTabIndex) target.setAttribute("tabindex", previousTabIndex ?? "");
    else target.removeAttribute("tabindex");
  }, setup);
  return {
    available: true,
    candidateCount: setup.candidateCount,
    target: setup.target,
    wheelMoved: wheel.moved,
    keyboardMoved: keyboard.moved,
    wheelLeaked: wheel.leaked,
    keyboardLeaked: keyboard.leaked,
    wheelTargetTop: wheel.targetTop,
    keyboardTargetTop: keyboard.targetTop,
    wheelBaselineCount: beforeWheel.length,
  };
}
async function capture(page, label, metadata = {}) {
  await resetScroll(page);
  const {
    profileFirstViewport: profileFirstViewportOptions,
    guidedSetupPrimaryActionEvidence: guidedSetupPrimaryActionEvidenceMetadata,
    ...reportMetadata
  } = metadata;
  let contentTargetScroll = null;
  let contentTargetEvidence = null;
  let preScreenshotGeometry = null;
  let postScreenshotGeometry = null;
  if (metadata.contentTarget)
    contentTargetScroll = await scrollCaptureTargetIntoView(
      page,
      metadata.contentTarget,
    );
  if (metadata.scrollSelector) {
    const scrollTarget = page.locator(metadata.scrollSelector).first();
    await scrollTarget.waitFor({ state: "visible", timeout: 10000 });
    await scrollTarget.scrollIntoViewIfNeeded();
  }
  const profileFirstViewportEvidence = profileFirstViewportOptions
    ? await collectProfileFirstViewportEvidence(
        page,
        profileFirstViewportOptions,
      )
    : (metadata.profileFirstViewportEvidence ?? null);
  const guidedSetupPrimaryActionEvidence =
    metadata.expectGuidedSetupPrimaryActions
      ? await collectGuidedSetupPrimaryActionEvidence(page)
      : (guidedSetupPrimaryActionEvidenceMetadata ?? null);
  const fileName = `${String(report.captures.length + 1).padStart(3, "0")}-${slugify(label)}.png`;
  const fullPath = path.join(outputDir, fileName);
  // Gating evidence must describe the exact pre-screenshot state, so it is
  // collected and geometry-bound before the screenshot is taken.
  if (metadata.contentTarget) {
    contentTargetEvidence = await collectVisibleContentEvidence(
      page,
      metadata.contentTarget,
    );
    preScreenshotGeometry = await readContentTargetGeometrySnapshot(
      page,
      metadata.contentTarget,
    );
  }
  await page.screenshot({ animations: "disabled", path: fullPath });
  if (metadata.contentTarget) {
    postScreenshotGeometry = await readContentTargetGeometrySnapshot(
      page,
      metadata.contentTarget,
    );
    const geometryStableAcrossScreenshot =
      stableJson(preScreenshotGeometry) === stableJson(postScreenshotGeometry);
    contentTargetEvidence = {
      ...contentTargetEvidence,
      geometryBinding: {
        preScreenshotGeometry,
        postScreenshotGeometry,
        stableAcrossScreenshot: geometryStableAcrossScreenshot,
      },
    };
    if (!geometryStableAcrossScreenshot) {
      contentTargetEvidence.failures.push(
        "target geometry moved across the screenshot; evidence does not describe the captured frame",
      );
      contentTargetEvidence.pass = contentTargetEvidence.failures.length === 0;
    }
  }
  const screenshot = await screenshotMetadata(
    page,
    activeBrowserWindow,
    fullPath,
    {
      clickablePointScopeSelector: metadata.clickablePointScopeSelector ?? null,
      viewport: metadata.viewport ?? null,
      seedDigest: acceptance.seedDigest,
      route: metadata.route,
    },
  );
  const layout = await scanLayout(page);
  const nestedScroll = await probeNestedScroll(page);
  const viewportInfo = metadata.viewport ?? {
    slug: "unknown",
    width: layout.viewport.width,
    height: layout.viewport.height,
    zoomFactor: 1,
  };
  assertViewportEvidence(screenshot.viewport, viewportInfo);
  const size = {
    bytes: screenshot.screenshot.bytes,
    width: screenshot.screenshot.width,
    height: screenshot.screenshot.height,
  };
  const filteredClipped = layout.clippedInteractive;
  const unreachableFiltered = layout.unreachableShellDestinations;
  const insideViewportBase =
    layout.documentHorizontalOverflow === 0 &&
    (layout.mainHorizontalOverflow ?? 0) === 0 &&
    filteredClipped.length === 0 &&
    layout.inputsOverflow.length === 0 &&
    layout.pillsClipped.length === 0 &&
    unreachableFiltered.length === 0;
  const noClipBase =
    insideViewportBase &&
    !nestedScroll.wheelLeaked &&
    !nestedScroll.keyboardLeaked;
  let navigationPass = true;
  if (metadata.expectWideSidebar) {
    navigationPass = layout.wideSidebarInfo.pass;
  }
  if (metadata.expectCompactPlanningButton) {
    navigationPass = navigationPass && layout.compactPlanningInfo.pass;
  }
  if (metadata.expectPlanningMenu) {
    navigationPass = navigationPass && layout.planningMenuInfo.pass;
  }
  if (metadata.expectPlanningMenuKeyboard) {
    navigationPass =
      navigationPass && metadata.planningMenuKeyboard?.pass === true;
  }
  if (metadata.expectLongLabelScenario) {
    navigationPass =
      navigationPass && metadata.longLabelEvidence?.pass === true;
  }
  if (metadata.expectSemanticPaginationEvidence) {
    navigationPass =
      navigationPass && metadata.semanticPaginationEvidence?.pass === true;
  }
  if (metadata.expectProfileDeepLinkEvidence) {
    navigationPass =
      navigationPass &&
      metadata.profileDeepLinkVisibilityEvidence?.pass === true;
  }
  if (metadata.expectProfileFirstViewport) {
    navigationPass =
      navigationPass && profileFirstViewportEvidence?.pass === true;
  }
  if (metadata.expectGuidedSetupPrimaryActions) {
    navigationPass =
      navigationPass && guidedSetupPrimaryActionEvidence?.pass === true;
  }
  if (metadata.expectWordmark) {
    navigationPass = navigationPass && metadata.wordmarkEvidence?.pass === true;
  }
  if (metadata.expectWorkspaceStateGeometry) {
    navigationPass =
      navigationPass && metadata.workspaceStateGeometry?.pass === true;
  }
  if (metadata.expectOpeningHeader) {
    navigationPass =
      navigationPass && metadata.openingHeaderEvidence?.pass === true;
  }
  if (metadata.contentTarget) {
    navigationPass = navigationPass && contentTargetEvidence?.pass === true;
  }
  if (screenshot.clickablePointEvidence.pass !== true) {
    navigationPass = false;
  }
  const insideViewport = insideViewportBase && navigationPass;
  const noClip = noClipBase && navigationPass;
  const entry = {
    id: report.captures.length + 1,
    label,
    scenarioId: metadata.scenarioId ?? label,
    fileName,
    path: fullPath,
    viewport: viewportInfo,
    viewportMetadata: screenshot.viewport,
    route: screenshot.route,
    seedDigest: screenshot.seedDigest,
    screenshot: screenshot.screenshot,
    clickablePointEvidence: screenshot.clickablePointEvidence,
    size,
    insideViewport,
    noClip,
    navigation: {
      wideSidebar: layout.wideSidebarInfo,
      compactPlanning: layout.compactPlanningInfo,
      planningMenu: layout.planningMenuInfo,
      keyboard: metadata.planningMenuKeyboard ?? null,
    },
    layout,
    nestedScroll,
    ...reportMetadata,
    ...(profileFirstViewportEvidence ? { profileFirstViewportEvidence } : {}),
    ...(guidedSetupPrimaryActionEvidence
      ? { guidedSetupPrimaryActionEvidence }
      : {}),
  };
  // Attach pass/fail logic
  const failures = [];
  if (
    !(
      layout.documentHorizontalOverflow === 0 &&
      (layout.mainHorizontalOverflow ?? 0) === 0
    )
  )
    failures.push(
      `horizontal overflow ${layout.documentHorizontalOverflow}/${layout.mainHorizontalOverflow}`,
    );
  if (filteredClipped.length > 0)
    failures.push(`clippedInteractive ${JSON.stringify(filteredClipped)}`);
  if (unreachableFiltered.length > 0)
    failures.push(`unreachableShell ${unreachableFiltered.join(",")}`);
  if (
    nestedScroll.available &&
    (!nestedScroll.wheelMoved || !nestedScroll.keyboardMoved)
  )
    failures.push(
      `real scroll interaction did not move target wheel=${nestedScroll.wheelMoved} keyboard=${nestedScroll.keyboardMoved}`,
    );
  if (nestedScroll.wheelLeaked || nestedScroll.keyboardLeaked)
    failures.push(
      `scroll chaining leaked wheel=${nestedScroll.wheelLeaked} keyboard=${nestedScroll.keyboardLeaked}`,
    );
  if (layout.inputsOverflow.length > 0)
    failures.push(`inputsOverflow ${JSON.stringify(layout.inputsOverflow)}`);
  if (layout.pillsClipped.length > 0)
    failures.push(`pillsClipped ${JSON.stringify(layout.pillsClipped)}`);
  if (metadata.expectWideSidebar && !layout.wideSidebarInfo.pass)
    failures.push(
      `1440 sidebar does not list every destination inline with its own scroll owner ${JSON.stringify(layout.wideSidebarInfo)}`,
    );
  if (metadata.expectCompactPlanningButton && !layout.compactPlanningInfo.pass)
    failures.push(
      `Compact More navigation is not visible below 1440 ${JSON.stringify(layout.compactPlanningInfo)}`,
    );
  if (metadata.expectPlanningMenu && !layout.planningMenuInfo.pass)
    failures.push(
      `More menu is not inside the viewport with required destinations ${JSON.stringify(layout.planningMenuInfo)}`,
    );
  if (
    metadata.expectPlanningMenuKeyboard &&
    metadata.planningMenuKeyboard?.pass !== true
  )
    failures.push(
      `More menu is not keyboard reachable ${JSON.stringify(metadata.planningMenuKeyboard)}`,
    );
  if (
    metadata.expectLongLabelScenario &&
    metadata.longLabelEvidence?.pass !== true
  )
    failures.push(
      `long-label semantic evidence failed: ${JSON.stringify(metadata.longLabelEvidence?.failures ?? [])}`,
    );
  if (
    metadata.expectSemanticPaginationEvidence &&
    metadata.semanticPaginationEvidence?.pass !== true
  )
    failures.push(
      `semantic pagination evidence failed: ${JSON.stringify(metadata.semanticPaginationEvidence?.failures ?? [])}`,
    );
  if (metadata.contentTarget && contentTargetEvidence?.pass !== true)
    failures.push(
      `content-target visible-content evidence failed for ${metadata.contentTarget.selector}: ${JSON.stringify(contentTargetEvidence?.failures ?? [])}`,
    );
  if (metadata.expectWordmark && metadata.wordmarkEvidence?.pass !== true)
    failures.push(
      `visible NESTOR wordmark evidence failed: ${JSON.stringify(metadata.wordmarkEvidence?.failures ?? [])}`,
    );
  if (
    metadata.expectWorkspaceStateGeometry &&
    metadata.workspaceStateGeometry?.pass !== true
  )
    failures.push(
      `workspace-state center geometry failed: ${JSON.stringify(metadata.workspaceStateGeometry?.failures ?? [])}`,
    );
  if (
    metadata.expectOpeningHeader &&
    metadata.openingHeaderEvidence?.pass !== true
  )
    failures.push(
      `opening-shell header geometry failed: ${JSON.stringify(metadata.openingHeaderEvidence?.failures ?? [])}`,
    );
  if (
    metadata.expectProfileDeepLinkEvidence &&
    metadata.profileDeepLinkVisibilityEvidence?.pass !== true
  )
    failures.push(
      `profile deep-link visibility evidence failed: ${JSON.stringify(metadata.profileDeepLinkVisibilityEvidence?.failures ?? [])}`,
    );
  if (
    metadata.expectProfileFirstViewport &&
    profileFirstViewportEvidence?.pass !== true
  )
    failures.push(
      `profile first-viewport evidence failed: ${JSON.stringify(profileFirstViewportEvidence?.failures ?? [])}`,
    );
  if (
    metadata.expectGuidedSetupPrimaryActions &&
    guidedSetupPrimaryActionEvidence?.pass !== true
  )
    failures.push(
      `Guided setup primary-action visibility evidence failed: ${JSON.stringify(guidedSetupPrimaryActionEvidence?.failures ?? [])}`,
    );
  if (screenshot.clickablePointEvidence.pass !== true)
    failures.push(
      `interactive controls have no unobscured clickable point: ${JSON.stringify(screenshot.clickablePointEvidence.failures)}`,
    );
  entry.failures = failures;
  entry.contentTargetScroll = contentTargetScroll;
  entry.contentTargetEvidence = contentTargetEvidence;
  entry.pass = failures.length === 0;
  report.captures.push(entry);
  registerScreenshotCollisionGuard(entry);
  completeScenario(entry.scenarioId, entry);
  await writeReport();
  if (failures.length)
    console.warn(`⚠ Capture "${label}" FAIL: ${failures.join("; ")}`);
  else
    console.log(
      `✓ Capture "${label}" PASS viewport=${viewportInfo.slug} size=${size.bytes} insideViewport=${insideViewport} noClip=${noClip}`,
    );
  return entry;
}

async function exercisePlanningSettingsKeyboard(page, menu) {
  const menuItems = menu.getByRole("button");
  const count = await menuItems.count();
  if (count < PLANNING_SETTINGS_MENU_DESTINATIONS.length)
    throw new Error(
      `More menu exposed ${count} items; expected at least ${PLANNING_SETTINGS_MENU_DESTINATIONS.length}.`,
    );
  const labels = await menuItems.evaluateAll((items) =>
    items.map(
      (item) =>
        item.getAttribute("aria-label") ??
        item.textContent?.replace(/\s+/g, " ").trim() ??
        "",
    ),
  );
  for (const requiredLabel of PLANNING_SETTINGS_MENU_DESTINATIONS) {
    if (!labels.some((label) => label.trim() === requiredLabel))
      throw new Error(
        `More menu did not expose ${requiredLabel}. Labels: ${JSON.stringify(labels)}`,
      );
  }
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.closest(
        '[role="navigation"][aria-label="More"]',
      ) !== null,
    undefined,
    { timeout: 10_000 },
  );
  await page.keyboard.press("Home");
  const first = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      label:
        active?.getAttribute("aria-label") ??
        active?.textContent?.replace(/\s+/g, " ").trim() ??
        null,
      isPlanningDestination:
        active instanceof HTMLButtonElement &&
        active.closest('[role="navigation"][aria-label="More"]') !== null,
    };
  });
  await page.keyboard.press("End");
  const last = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      label:
        active?.getAttribute("aria-label") ??
        active?.textContent?.replace(/\s+/g, " ").trim() ??
        null,
      isPlanningDestination:
        active instanceof HTMLButtonElement &&
        active.closest('[role="navigation"][aria-label="More"]') !== null,
    };
  });
  const pass =
    first.isPlanningDestination &&
    first.label === labels[0].trim() &&
    last.isPlanningDestination &&
    last.label === labels[labels.length - 1].trim();
  if (!pass)
    throw new Error(
      `More keyboard traversal did not reach first and last menu items: ${JSON.stringify({ first, last, labels })}`,
    );
  return {
    pass,
    firstFocusedLabel: first.label,
    lastFocusedLabel: last.label,
    labels: labels.map((label) => label.trim()),
  };
}

const CAPTURE_SCROLL_BLOCKS = Object.freeze([
  "start",
  "center",
  "end",
  "nearest",
]);

async function scrollCaptureTargetIntoView(page, contentTarget) {
  const block = contentTarget.block ?? "center";
  const index = contentTarget.index ?? 0;
  assert(
    CAPTURE_SCROLL_BLOCKS.includes(block),
    `Unsupported capture content-target block alignment: ${JSON.stringify(block)}.`,
  );
  assert(
    Number.isInteger(index) && index >= 0,
    `Capture content-target index must be a non-negative integer: ${JSON.stringify(index)}.`,
  );
  const applied = await page.evaluate(
    ({ selector, block, index }) => {
      const rendered = (el) => {
        const closedDetails = el.closest("details:not([open])");
        if (closedDetails && !el.matches("summary")) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      // Indexing parity with collectVisibleContentEvidence: the same
      // rendered-element filter selects the scroll target, so the element
      // scrolled into view and the evidenced element at [index] are identical.
      const candidates = Array.from(document.querySelectorAll(selector)).filter(
        (el) => el instanceof HTMLElement && rendered(el),
      );
      const element = candidates[index];
      if (!(element instanceof HTMLElement))
        return { renderedCount: candidates.length, scrolled: false };
      element.scrollIntoView({ block, inline: "nearest" });
      const rect = element.getBoundingClientRect();
      return {
        renderedCount: candidates.length,
        scrolled: true,
        selectedTarget: {
          rowId:
            element.getAttribute("data-job-result-id") ??
            element.getAttribute("data-compact-source-id") ??
            element.getAttribute("data-expanded-source-id"),
          text: (element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        },
      };
    },
    { selector: contentTarget.selector, block, index },
  );
  assert(
    applied.scrolled,
    `Capture content target ${contentTarget.selector}[${index}] did not resolve to a rendered element (${applied.renderedCount} rendered matches).`,
  );
  await page.waitForTimeout(150);
  return {
    selector: contentTarget.selector,
    block,
    index,
    matched: applied.renderedCount,
    selectedTarget: applied.selectedTarget,
  };
}

async function readContentTargetGeometrySnapshot(page, contentTarget) {
  return page.evaluate((payload) => {
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const candidates = Array.from(
      document.querySelectorAll(payload.selector),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rows: candidates.map((el, position) => {
        const rect = el.getBoundingClientRect();
        return {
          position,
          rowId:
            el.getAttribute("data-job-result-id") ??
            el.getAttribute("data-compact-source-id") ??
            el.getAttribute("data-expanded-source-id"),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }),
    };
  }, contentTarget);
}

async function collectVisibleContentEvidence(page, contentTarget) {
  return page.evaluate((payload) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const candidates = Array.from(
      document.querySelectorAll(payload.selector),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    const rows = candidates.map((el, position) => {
      const rect = el.getBoundingClientRect();
      const intersectionHeight =
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const coverageRatio =
        rect.height > 0 ? Math.max(0, intersectionHeight) / rect.height : 0;
      const horizontallyInside =
        rect.left >= -1 && rect.right <= window.innerWidth + 1;
      return {
        position,
        rowId:
          el.getAttribute("data-job-result-id") ??
          el.getAttribute("data-compact-source-id") ??
          el.getAttribute("data-expanded-source-id"),
        text: normalize(el.textContent).slice(0, 160),
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
        },
        intersectionHeight,
        coverageRatio,
        // Meaningfully inside the CSS viewport requires a majority of the
        // element box to intersect the viewport; Playwright `visible` alone
        // accepts elements clipped to a 1px sliver and is not sufficient.
        inViewport:
          horizontallyInside &&
          intersectionHeight >= 16 &&
          coverageRatio >= 0.5,
      };
    });
    const visibleRows = rows.filter((row) => row.inViewport);
    const exactTextInViewport = (expected) =>
      visibleRows.some((row) => {
        const element = candidates[row.position];
        const scopes = payload.textSelector
          ? Array.from(element.querySelectorAll(payload.textSelector))
          : [element];
        return scopes.some(
          (scope) => normalize(scope.textContent) === expected,
        );
      });
    const textEvidence = (payload.requiredTexts ?? []).map((expected) => ({
      expected,
      foundInViewport: exactTextInViewport(expected),
    }));
    const matchedSeededRowIds = (payload.requiredRowIds ?? []).filter((rowId) =>
      visibleRows.some((row) => row.rowId === rowId),
    );
    const failures = [];
    const minVisibleRows = payload.minVisibleRows ?? 1;
    if (candidates.length === 0)
      failures.push(`no rendered elements match ${payload.selector}`);
    else if (visibleRows.length < minVisibleRows)
      failures.push(
        `${visibleRows.length} of ${candidates.length} rendered ${payload.selector} elements are meaningfully inside the CSS viewport; required at least ${minVisibleRows}`,
      );
    if (
      (payload.requiredTexts ?? []).length > 0 &&
      !textEvidence.some((item) => item.foundInViewport)
    )
      failures.push(
        `no in-viewport ${payload.selector} element contains an exact seeded label: ${JSON.stringify(textEvidence.map((item) => item.expected))}`,
      );
    if (
      (payload.requiredRowIds ?? []).length > 0 &&
      matchedSeededRowIds.length === 0
    )
      failures.push(
        `no in-viewport ${payload.selector} row carries a seeded identity: ${JSON.stringify(payload.requiredRowIds)}`,
      );
    return {
      selector: payload.selector,
      block: payload.block ?? "center",
      index: payload.index ?? 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      renderedCount: candidates.length,
      minVisibleRows,
      inViewportCount: visibleRows.length,
      inViewportRowIds: visibleRows.map((row) => row.rowId),
      rows,
      textEvidence,
      seededRowEvidence: {
        requiredRowIds: payload.requiredRowIds ?? [],
        matchedInViewportRowIds: matchedSeededRowIds,
      },
      failures,
      pass: failures.length === 0,
    };
  }, contentTarget);
}

async function collectLongLabelEvidence(page, expectations) {
  return page.evaluate((payload) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const reachableWithinScrollers = (el) => {
      const rect = el.getBoundingClientRect();
      const horizontal = rect.left >= -1 && rect.right <= window.innerWidth + 1;
      const verticallyVisible =
        rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      const hasScrollableAncestor = (() => {
        let ancestor = el.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (
            /(auto|scroll)/.test(style.overflowY) &&
            ancestor.scrollHeight > ancestor.clientHeight + 2
          )
            return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      })();
      return (
        rendered(el) &&
        horizontal &&
        (verticallyVisible || hasScrollableAncestor)
      );
    };
    const cards = Array.from(
      document.querySelectorAll("[data-job-result-id]"),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    const cardHasExactText = (expected, selector) =>
      cards.some((card) =>
        Array.from(card.querySelectorAll(selector)).some(
          (el) => normalize(el.textContent) === expected,
        ),
      );
    const labelEvidence = [
      ...payload.titles.map((expected) => ({
        field: "job-title",
        expected,
        via: cardHasExactText(expected, "strong") ? "text-content" : "missing",
      })),
      ...payload.metaLines.map((expected) => ({
        field: "company-location",
        expected,
        via: cardHasExactText(expected, "span") ? "text-content" : "missing",
      })),
    ];
    const shortlistButtons = Array.from(
      document.querySelectorAll(
        '[data-testid="discovery-detail-primary-action"] button',
      ),
    ).filter(
      (el) =>
        normalize(el.getAttribute("aria-label") ?? el.textContent) ===
        payload.shortlistActionLabel,
    );
    const searchInput = Array.from(document.querySelectorAll("input")).find(
      (el) =>
        normalize(el.getAttribute("placeholder")) ===
        "Search roles or companies",
    );
    const controls = [
      {
        control: "discovery-search-input",
        found: Boolean(searchInput),
        reachable:
          searchInput instanceof HTMLElement
            ? reachableWithinScrollers(searchInput)
            : false,
      },
      {
        control: "result-card-buttons",
        found: cards.length > 0,
        count: cards.length,
        reachable: cards.length > 0 && cards.every(reachableWithinScrollers),
      },
      {
        control: "detail-shortlist-action",
        found: shortlistButtons.length > 0,
        count: shortlistButtons.length,
        reachable:
          shortlistButtons.length > 0 &&
          shortlistButtons.every(reachableWithinScrollers),
      },
    ];
    const failures = [];
    if (cards.length !== payload.expectedRows)
      failures.push(`renderedRows ${cards.length} !== ${payload.expectedRows}`);
    for (const item of labelEvidence)
      if (item.via === "missing")
        failures.push(`full label missing from rendered text: ${item.field}`);
    for (const control of controls)
      if (!control.found || !control.reachable)
        failures.push(`key control not reachable: ${control.control}`);
    return {
      expectedRows: payload.expectedRows,
      renderedRows: cards.length,
      shortlistActionLabel: payload.shortlistActionLabel,
      labels: labelEvidence,
      controls,
      failures,
      pass: failures.length === 0,
    };
  }, expectations);
}

async function collectSourceLabelEvidence(page, expectations) {
  return page.evaluate((payload) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const reachableWithinScrollers = (el) => {
      const rect = el.getBoundingClientRect();
      const horizontal = rect.left >= -1 && rect.right <= window.innerWidth + 1;
      const verticallyVisible =
        rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      const hasScrollableAncestor = (() => {
        let ancestor = el.parentElement;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (
            /(auto|scroll)/.test(style.overflowY) &&
            ancestor.scrollHeight > ancestor.clientHeight + 2
          )
            return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      })();
      return (
        rendered(el) &&
        horizontal &&
        (verticallyVisible || hasScrollableAncestor)
      );
    };
    const rows = Array.from(
      document.querySelectorAll("[data-compact-source-id]"),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    const rowEvidence = payload.names.map((name) => {
      const heading = rows
        .map((row) => row.querySelector("h4"))
        .find(
          (el) =>
            el instanceof HTMLElement &&
            normalize(el.textContent) === name &&
            normalize(el.getAttribute("title")) === name,
        );
      if (!(heading instanceof HTMLElement))
        return { name, found: false, truncatedPx: null, controls: [] };
      const includeControl = rows
        .flatMap((row) =>
          Array.from(row.querySelectorAll("input, [role=checkbox]")),
        )
        .find(
          (el) =>
            normalize(el.getAttribute("aria-label")) ===
            `Include ${name} in searches`,
        );
      const editControl = rows
        .flatMap((row) => Array.from(row.querySelectorAll("button")))
        .find(
          (el) => normalize(el.getAttribute("aria-label")) === `Edit ${name}`,
        );
      return {
        name,
        found: true,
        truthSource: "text-content-and-title-attribute",
        truncatedPx: Math.max(0, heading.scrollWidth - heading.clientWidth),
        controls: [
          {
            control: "include-in-search-checkbox",
            found: Boolean(includeControl),
            reachable:
              includeControl instanceof HTMLElement
                ? reachableWithinScrollers(includeControl)
                : false,
          },
          {
            control: "edit-source-button",
            found: Boolean(editControl),
            reachable:
              editControl instanceof HTMLElement
                ? reachableWithinScrollers(editControl)
                : false,
          },
        ],
      };
    });
    const failures = [];
    if (rows.length !== payload.expectedRows)
      failures.push(
        `renderedSourceRows ${rows.length} !== ${payload.expectedRows}`,
      );
    for (const item of rowEvidence) {
      if (!item.found)
        failures.push(
          `truthful compact source row missing: ${item.name.slice(0, 48)}…`,
        );
      for (const control of item.controls)
        if (!control.found || !control.reachable)
          failures.push(
            `key control not reachable for long source label: ${control.control}`,
          );
    }
    const truncatedRowCount = rowEvidence.filter(
      (item) => (item.truncatedPx ?? 0) > 1,
    ).length;
    return {
      expectedRows: payload.expectedRows,
      renderedRows: rows.length,
      truncatedRowCount,
      rows: rowEvidence,
      failures,
      pass: failures.length === 0,
    };
  }, expectations);
}

async function collectProfileDeepLinkVisibilityEvidence(page) {
  return page.evaluate(() => {
    const failures = [];
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const cssWidthBand = { min: 640, max: 1279 };
    const cssWidthInBand =
      viewport.width >= cssWidthBand.min && viewport.width <= cssWidthBand.max;
    if (!cssWidthInBand)
      failures.push(
        `CSS viewport width ${viewport.width} is outside the ${cssWidthBand.min}-${cssWidthBand.max} deep-link alignment band`,
      );
    const headerSelector = "[data-job-finder-shell-header]";
    const header = document.querySelector(headerSelector);
    const headerRect =
      header instanceof HTMLElement ? header.getBoundingClientRect() : null;
    const headerFound =
      header instanceof HTMLElement &&
      headerRect !== null &&
      headerRect.height > 0;
    if (!headerFound)
      failures.push(`fixed shell chrome not measurable via ${headerSelector}`);
    const headerBottom = headerRect ? headerRect.bottom : null;
    const headingSelector = "#profile-job-sources-heading";
    const heading = document.querySelector(headingSelector);
    const headingRect =
      heading instanceof HTMLElement ? heading.getBoundingClientRect() : null;
    const headingStyle =
      heading instanceof HTMLElement ? getComputedStyle(heading) : null;
    const headingRendered =
      heading instanceof HTMLElement &&
      headingStyle !== null &&
      headingStyle.display !== "none" &&
      headingStyle.visibility !== "hidden" &&
      Number.parseFloat(headingStyle.opacity || "1") > 0 &&
      headingRect !== null &&
      headingRect.width > 0 &&
      headingRect.height > 0;
    if (!headingRendered)
      failures.push(
        `owned Job sources heading not rendered via ${headingSelector}`,
      );
    const headingTextMatches =
      heading instanceof HTMLElement &&
      heading.textContent?.replace(/\s+/g, " ").trim() === "Job sources";
    if (!headingTextMatches)
      failures.push(
        `element at ${headingSelector} does not carry the exact Job sources heading text`,
      );
    const intersectionHeight = headingRect
      ? Math.max(
          0,
          Math.min(headingRect.bottom, viewport.height) -
            Math.max(headingRect.top, 0),
        )
      : 0;
    const coverageRatio =
      headingRect && headingRect.height > 0
        ? intersectionHeight / headingRect.height
        : 0;
    const meaningfulVisibleHeight =
      intersectionHeight >= 16 && coverageRatio >= 0.6;
    if (headingRendered && !meaningfulVisibleHeight)
      failures.push(
        `heading visible height ${intersectionHeight.toFixed(1)}px (coverage ${(coverageRatio * 100).toFixed(0)}%) is not meaningful`,
      );
    const horizontalContained = headingRect
      ? headingRect.left >= -1 && headingRect.right <= window.innerWidth + 1
      : false;
    if (headingRendered && !horizontalContained)
      failures.push(
        `heading horizontally outside the viewport: left ${headingRect.left.toFixed(1)} right ${headingRect.right.toFixed(1)}`,
      );
    const alignmentBelowChrome =
      headingRect && headerBottom !== null
        ? headingRect.top >= headerBottom - 1
        : null;
    if (alignmentBelowChrome === false)
      failures.push(
        `heading top ${headingRect.top.toFixed(1)} sits above measured shell header bottom ${headerBottom.toFixed(1)}; the app landed it under fixed chrome`,
      );
    const visibleTop = headingRect
      ? Math.max(headingRect.top, headerBottom ?? 0)
      : 0;
    const visibleBottom = headingRect
      ? Math.min(headingRect.bottom, viewport.height)
      : 0;
    const hitTest = {
      point: null,
      resolvedDescriptor: null,
      resolvedInsideTarget: null,
    };
    if (
      headingRendered &&
      headerFound &&
      meaningfulVisibleHeight &&
      horizontalContained
    ) {
      const x = Math.min(
        Math.max(headingRect.left + headingRect.width / 2, 2),
        window.innerWidth - 2,
      );
      const y = Math.min(
        Math.max((visibleTop + visibleBottom) / 2, 2),
        window.innerHeight - 2,
      );
      const hit = document.elementFromPoint(x, y);
      const resolvedInsideTarget =
        hit instanceof Node && (hit === heading || heading.contains(hit));
      hitTest.point = { x: Math.round(x), y: Math.round(y) };
      hitTest.resolvedDescriptor =
        hit instanceof Element
          ? `${hit.tagName.toLowerCase()}${hit.getAttribute("data-testid") ? `[data-testid=${hit.getAttribute("data-testid")}]` : ""}`
          : String(hit);
      hitTest.resolvedInsideTarget = resolvedInsideTarget;
      if (!resolvedInsideTarget)
        failures.push(
          `elementFromPoint at (${x.toFixed(0)},${y.toFixed(0)}) resolved outside the Job sources heading: ${hitTest.resolvedDescriptor}`,
        );
    }
    // Supplemental container/library geometry only; it cannot substitute for
    // any heading gate above and contributes no pass/fail signal here.
    const librarySelector = "[data-job-sources-library]";
    const library = document.querySelector(librarySelector);
    const libraryRect =
      library instanceof HTMLElement ? library.getBoundingClientRect() : null;
    const supplementalLibrary = {
      selector: librarySelector,
      found: library instanceof HTMLElement,
      rect: libraryRect
        ? {
            left: Math.round(libraryRect.left),
            top: Math.round(libraryRect.top),
            width: Math.round(libraryRect.width),
            height: Math.round(libraryRect.height),
          }
        : null,
      intersectsViewportBelowChrome:
        libraryRect && headerBottom !== null
          ? Math.min(libraryRect.bottom, viewport.height) -
              Math.max(libraryRect.top, headerBottom) >
            0
          : false,
    };
    return {
      route: window.location.hash,
      sampledBeforeHarnessCentering: true,
      viewport,
      cssWidthBand: { ...cssWidthBand, inBand: cssWidthInBand },
      header: {
        selector: headerSelector,
        found: headerFound,
        measuredFrom: "element-rect",
        bottom: headerBottom,
      },
      target: {
        selector: headingSelector,
        kind: "owned-heading",
        headingTextMatches,
        found: headingRendered,
        rect: headingRect
          ? {
              left: Math.round(headingRect.left),
              top: Math.round(headingRect.top),
              width: Math.round(headingRect.width),
              height: Math.round(headingRect.height),
            }
          : null,
        intersectionHeight,
        coverageRatio,
        meaningfulVisibleHeight,
        horizontalContained,
      },
      alignmentBelowChrome,
      hitTest,
      supplementalLibrary,
      failures,
      pass: failures.length === 0,
    };
  });
}

async function collectProfileFirstViewportEvidence(
  page,
  { activeSection, expectedHeading, expectedResumeFileName, expectCompact },
) {
  return page.evaluate(
    ({
      activeSection,
      expectedHeading,
      expectedResumeFileName,
      expectCompact,
    }) => {
      const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const rendered = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const geometry = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        const intersectionHeight = Math.max(
          0,
          Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
        );
        const coverageRatio =
          rect.height > 0 ? intersectionHeight / rect.height : 0;
        return {
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          intersectionHeight,
          coverageRatio,
          visible: rendered(element),
          horizontallyContained:
            rect.left >= -1 && rect.right <= window.innerWidth + 1,
        };
      };
      const failures = [];
      const scrollRegion = document.querySelector(
        "[data-locked-pane-scroll-region]",
      );
      const tab = document.querySelector(`#${activeSection}-tab`);
      const tabPanel = document.querySelector(
        `#profile-section-panel[aria-labelledby="${activeSection}-tab"]`,
      );
      const resumeSummary = document.querySelector(
        "[data-profile-resume-summary]",
      );
      const resumeHost = tabPanel?.previousElementSibling;
      const fullResumePanel =
        resumeHost instanceof HTMLElement
          ? resumeHost.querySelector(":scope > section")
          : null;
      const resumePanel = expectCompact ? resumeSummary : fullResumePanel;
      const activeHeading = tabPanel?.querySelector("h2, h3, [role=heading]");
      const scrollTop =
        scrollRegion instanceof HTMLElement ? scrollRegion.scrollTop : null;
      const resumeGeometry = geometry(resumePanel);
      const activeHeadingGeometry = geometry(activeHeading);
      const resumeText = normalize(resumePanel?.textContent);
      const activeText = normalize(tabPanel?.textContent);
      const compactObserved = resumeSummary instanceof HTMLElement;
      const tabSelected =
        tab instanceof HTMLElement &&
        tab.getAttribute("aria-selected") === "true";
      const activeHeadingMatches =
        activeHeading?.textContent?.replace(/\s+/g, " ").trim() ===
        expectedHeading;
      const resumePopulated =
        resumeText.includes(expectedResumeFileName) &&
        (expectCompact || resumeText.includes("Imported details"));
      const activeFields = Array.from(
        tabPanel?.querySelectorAll("input, textarea, select") ?? [],
      );
      const activeContentPopulated =
        activeText.includes(expectedHeading) &&
        (activeFields.length > 0 || activeText.length > expectedHeading.length);
      const resumeVisible =
        resumeGeometry?.visible === true &&
        resumeGeometry.intersectionHeight >= (expectCompact ? 24 : 64) &&
        resumeGeometry.coverageRatio >= 0.25 &&
        resumeGeometry.horizontallyContained;
      const activeHeadingAboveFold =
        activeHeadingGeometry?.visible === true &&
        activeHeadingGeometry.intersectionHeight >= 16 &&
        activeHeadingGeometry.coverageRatio >= 0.6 &&
        activeHeadingGeometry.horizontallyContained;

      if (scrollTop === null) failures.push("profile scroll region is missing");
      else if (scrollTop > 1)
        failures.push(`first viewport scrollTop is ${scrollTop}`);
      if (!tabSelected)
        failures.push(`active ${activeSection} tab is not selected`);
      if (!activeHeadingMatches)
        failures.push(
          `active ${activeSection} heading ${JSON.stringify(activeHeading?.textContent?.trim() ?? null)} does not match ${JSON.stringify(expectedHeading)}`,
        );
      if (!resumePopulated)
        failures.push(
          `resume panel is not populated with ${expectedResumeFileName}`,
        );
      if (compactObserved !== expectCompact)
        failures.push(
          `expected ${expectCompact ? "compact" : "full"} resume panel, observed ${compactObserved ? "compact" : "full"}`,
        );
      if (!resumeVisible)
        failures.push(
          "resume panel is not meaningfully visible in the first viewport",
        );
      if (!activeContentPopulated)
        failures.push(`active ${activeSection} content is not populated`);
      if (expectCompact && !activeHeadingAboveFold)
        failures.push(
          `active ${activeSection} content heading is not meaningfully above the fold`,
        );

      return {
        activeSection,
        activeContentPopulated,
        activeHeading:
          activeHeading?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        activeHeadingAboveFold,
        activeHeadingGeometry,
        compactObserved,
        expectedHeading,
        expectedResumeFileName,
        firstViewport: true,
        failures,
        pass: failures.length === 0,
        resumeGeometry,
        resumePopulated,
        resumeText: resumeText.slice(0, 240),
        scrollTop,
        tabSelected,
      };
    },
    { activeSection, expectedHeading, expectedResumeFileName, expectCompact },
  );
}

function sameIdentityList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    [...left].sort().join("\u0000") === [...right].sort().join("\u0000")
  );
}

async function observeProfileSourcesPageState(page, rangePatternSource) {
  return page.evaluate((patternSource) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const rendered = (el) => {
      const closedDetails = el.closest("details:not([open])");
      if (closedDetails && !el.matches("summary")) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const pattern = new RegExp(patternSource);
    const pagesNav = document.querySelector(
      'nav[aria-label="Job source pages"]',
    );
    const rangeCandidates =
      pagesNav instanceof HTMLElement && rendered(pagesNav)
        ? Array.from(pagesNav.querySelectorAll("*")).filter(
            (el) =>
              el instanceof HTMLElement &&
              rendered(el) &&
              pattern.test(normalize(el.textContent)),
          )
        : [];
    const rangeElement = rangeCandidates.find(
      (el) =>
        !rangeCandidates.some((other) => other !== el && el.contains(other)),
    );
    const rows = Array.from(
      document.querySelectorAll(
        "[data-compact-source-id], [data-expanded-source-id]",
      ),
    ).filter((el) => el instanceof HTMLElement && rendered(el));
    return {
      observedRangeText: rangeElement
        ? normalize(rangeElement.textContent)
        : null,
      observedRowIds: rows.map(
        (row) =>
          row.getAttribute("data-compact-source-id") ??
          row.getAttribute("data-expanded-source-id"),
      ),
      observedRowLabels: rows.map((row) =>
        normalize(
          row.querySelector("h4")?.textContent ??
            row.getAttribute("title") ??
            "",
        ),
      ),
      scrollHeights: {
        document: document.documentElement.scrollHeight,
        main:
          document.querySelector("main") instanceof HTMLElement
            ? document.querySelector("main").scrollHeight
            : null,
        jobFinderShell: (() => {
          const shell = document.querySelector("[data-job-finder-shell]");
          return shell instanceof HTMLElement ? shell.scrollHeight : null;
        })(),
        jobSourcesLibrary: (() => {
          const library = document.querySelector("[data-job-sources-library]");
          return library instanceof HTMLElement ? library.scrollHeight : null;
        })(),
      },
    };
  }, rangePatternSource);
}

async function readAnimationFrameGeometrySample(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const readGeometry = () => ({
          document: document.documentElement.scrollHeight,
          main:
            document.querySelector("main") instanceof HTMLElement
              ? document.querySelector("main").scrollHeight
              : null,
          jobFinderShell: (() => {
            const shell = document.querySelector("[data-job-finder-shell]");
            return shell instanceof HTMLElement ? shell.scrollHeight : null;
          })(),
          jobSourcesLibrary: (() => {
            const library = document.querySelector(
              "[data-job-sources-library]",
            );
            return library instanceof HTMLElement ? library.scrollHeight : null;
          })(),
        });
        requestAnimationFrame(() => {
          const firstFrame = readGeometry();
          requestAnimationFrame(() =>
            resolve({ firstFrame, secondFrame: readGeometry() }),
          );
        });
      }),
  );
}

async function waitForSemanticSourcesPagination(
  page,
  { phase, rangePatternSource, expectedRowIds },
) {
  await waitForCondition(
    async () => {
      const state = await observeProfileSourcesPageState(
        page,
        rangePatternSource,
      );
      return (
        state.observedRangeText !== null &&
        new RegExp(rangePatternSource).test(state.observedRangeText) &&
        sameIdentityList(state.observedRowIds, expectedRowIds)
      );
    },
    `${phase} observed page/range text and visible row identities`,
    15000,
  );
  let geometryFrames = null;
  await waitForCondition(
    async () => {
      geometryFrames = await readAnimationFrameGeometrySample(page);
      return (
        stableJson(geometryFrames.firstFrame) ===
        stableJson(geometryFrames.secondFrame)
      );
    },
    `${phase} scrollHeight/geometry stability across two animation frames`,
    10000,
  );
  const finalState = await observeProfileSourcesPageState(
    page,
    rangePatternSource,
  );
  const failures = [];
  if (
    finalState.observedRangeText === null ||
    !new RegExp(rangePatternSource).test(finalState.observedRangeText)
  )
    failures.push(
      `observed page/range ${JSON.stringify(finalState.observedRangeText)} does not prove ${phase} (pattern ${rangePatternSource})`,
    );
  if (!sameIdentityList(finalState.observedRowIds, expectedRowIds))
    failures.push(
      `visible row identities ${JSON.stringify(finalState.observedRowIds)} do not match expected ${JSON.stringify(expectedRowIds)}`,
    );
  if (finalState.observedRowLabels.some((label) => label.length === 0))
    failures.push(
      `visible rows are missing labels: ${JSON.stringify(finalState.observedRowLabels)}`,
    );
  if (
    stableJson(geometryFrames.firstFrame) !==
    stableJson(geometryFrames.secondFrame)
  )
    failures.push(
      "scrollHeight/geometry did not settle across two animation frames",
    );
  return {
    phase,
    expectedRangePatternSource: rangePatternSource,
    observedRangeText: finalState.observedRangeText,
    expectedRowIds,
    expectedRowCount: expectedRowIds.length,
    observedRowIds: finalState.observedRowIds,
    observedRowLabels: finalState.observedRowLabels,
    observedRowCount: finalState.observedRowIds.length,
    geometryFrames,
    geometryStableAcrossAnimationFrames:
      stableJson(geometryFrames.firstFrame) ===
      stableJson(geometryFrames.secondFrame),
    scrollHeightsAtSettlement: finalState.scrollHeights,
    failures,
    pass: failures.length === 0,
  };
}

function resolveConfiguredDiscoveryTarget(state) {
  const targets =
    state?.searchPreferences?.discovery?.targets ??
    state?.searchPreferences?.discoveryTargets ??
    [];
  assert(
    Array.isArray(targets) && targets.length > 0,
    "Discovery fixture provenance requires a configured discovery target in the seeded state.",
  );
  const preferred =
    targets.find(
      (target) =>
        target.id === "target_linkedin_default" && target.enabled !== false,
    ) ?? targets.find((target) => target.enabled !== false);
  assert(
    Boolean(preferred),
    "Discovery fixture provenance requires a runnable (enabled) configured discovery target.",
  );
  return preferred;
}

function buildFixtureJobProvenance(target, discoveredAt) {
  assert(
    typeof discoveredAt === "string" && discoveredAt.length > 0,
    "Fixture job provenance requires the job's discoveredAt timestamp.",
  );
  return {
    targetId: target.id,
    adapterKind: target.adapterKind ?? "auto",
    resolvedAdapterKind: "target_site",
    startingUrl: target.startingUrl,
    collectionMethod: "fallback_search",
    discoveredAt,
  };
}

function assertSyntheticProvenanceClosure(
  jobs,
  configuredTargets,
  label,
  expectedJobs = null,
) {
  assert(
    Array.isArray(jobs) && jobs.length > 0,
    `${label} exposed no jobs to verify provenance closure.`,
  );
  const targetsById = new Map(
    (Array.isArray(configuredTargets) ? configuredTargets : []).map(
      (target) => [target.id, target],
    ),
  );
  assert(
    targetsById.size > 0,
    `${label} provenance closure requires configured discovery targets.`,
  );
  const expectedById = expectedJobs
    ? new Map(expectedJobs.map((job) => [job.id, job]))
    : null;
  if (expectedById)
    assert(
      jobs.length === expectedById.size,
      `${label} job count ${jobs.length} does not match the ${expectedById.size} synthetic fixture jobs; provenance closure cannot be verified across dropped or duplicated jobs.`,
    );
  const unattributedJobs = [];
  const linkedTargetIds = new Set();
  for (const job of jobs) {
    const expected =
      expectedById && typeof job?.id === "string"
        ? expectedById.get(job.id)
        : null;
    if (expectedById && !expected) {
      unattributedJobs.push(`${job.id ?? "<unknown>"}:unexpected-hydrated-id`);
      continue;
    }
    const expectedEntry =
      expected && Array.isArray(expected.provenance)
        ? expected.provenance[0]
        : null;
    if (expectedById && !expectedEntry) {
      unattributedJobs.push(`${job.id}:fixture-provenance-missing`);
      continue;
    }
    const entries = Array.isArray(job.provenance) ? job.provenance : [];
    const match = entries.find((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.targetId !== "string" ||
        entry.targetId.length === 0 ||
        typeof entry.adapterKind !== "string" ||
        entry.adapterKind.length === 0 ||
        typeof entry.startingUrl !== "string" ||
        entry.startingUrl.length === 0 ||
        typeof entry.discoveredAt !== "string" ||
        entry.discoveredAt.length === 0 ||
        (entry.collectionMethod != null &&
          !["api", "listing_route", "careers_page", "fallback_search"].includes(
            entry.collectionMethod,
          )) ||
        !(
          entry.resolvedAdapterKind == null ||
          typeof entry.resolvedAdapterKind === "string"
        )
      )
        return false;
      // Mutated target linkage: the hydrated entry must still reference the
      // exact configured target the fixture was built against.
      if (expectedEntry && entry.targetId !== expectedEntry.targetId)
        return false;
      const configured = targetsById.get(entry.targetId);
      if (!configured) return false;
      return (
        entry.adapterKind === (configured.adapterKind ?? "auto") &&
        entry.startingUrl === configured.startingUrl &&
        entry.discoveredAt === job.discoveredAt &&
        (!expected || entry.discoveredAt === expected.discoveredAt)
      );
    });
    if (!match) {
      unattributedJobs.push(job.id);
      continue;
    }
    linkedTargetIds.add(match.targetId);
  }
  assert(
    unattributedJobs.length === 0,
    `${label} jobs lack schema-shaped attributable provenance resolving to the configured fixture target (dropped, defaulted, mutated linkage, or timestamp drift): ${JSON.stringify(unattributedJobs.slice(0, 5))}`,
  );
  assert(
    linkedTargetIds.size > 0,
    `${label} provenance did not resolve to any configured target.`,
  );
  return {
    verified: true,
    jobCount: jobs.length,
    attributedJobCount: jobs.length,
    resolvedTargetIds: [...linkedTargetIds].sort(),
    ...(expectedJobs ? { matchedFixtureJobCount: expectedById.size } : {}),
  };
}

function buildSyntheticTargets(baseTargets, count) {
  const template = baseTargets?.[0] ?? {
    id: "target_template",
    label: "Template Source",
    startingUrl: "https://example.com/jobs",
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  };
  const targets = [];
  const domains = [
    "greenhouse.example.test",
    "lever.example.test",
    "ashbyhq.example.test",
    "workday.example.test",
    "example.test",
  ];
  const companies = [
    "Northstar Systems",
    "Atlas Works",
    "Signal Systems",
    "CoreLedger",
    "RemoteCom",
    "Northwind Labs",
    "Consent Labs",
    "Mercury AI",
    "Glean",
    "Constructor",
  ];
  for (let i = 0; i < count; i++) {
    const domain = domains[i % domains.length];
    const company = companies[i % companies.length];
    const id = `target_synth_${String(i + 1).padStart(3, "0")}`;
    const label =
      i % 7 === 0
        ? `Very Long Company Name With Excessive Descriptor That Should Truncate Elegantly In Compact Pill ${i + 1} With Extra Words To Test Ellipsis`
        : `${company} - Board ${i + 1}`;
    const startingUrl = `https://${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${domain}/careers/${i + 1}`;
    const enabled = i % 3 !== 0;
    const instructionStatus =
      i % 5 === 0 ? "stale" : i % 7 === 0 ? "draft" : "missing";
    targets.push({
      ...structuredClone(template),
      id,
      label,
      startingUrl,
      enabled,
      instructionStatus,
      lastVerifiedAt: null,
    });
  }
  if (targets.length > 2) {
    targets[2].startingUrl =
      "https://jobs.example.test/source/example-eu-board";
    targets[2].label =
      "EU Lever EU Board With Very Long Title To Test Truncate At 125 Percent Zoom Effectively";
  }
  return targets;
}
function buildSyntheticJobs(baseJobs, count, options = {}) {
  const { provenanceTarget = null } = options;
  const template = baseJobs?.[0] ??
    baseJobs?.find(Boolean) ?? {
      id: "job_template",
      source: "target_site",
      sourceJobId: "template_source",
      discoveryMethod: "catalog_seed",
      canonicalUrl: "https://jobs.example.test/roles/template",
      applicationUrl: "https://jobs.example.test/roles/template/apply",
      title: "Senior Product Designer",
      company: "Signal Systems",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "easy_apply",
      easyApplyEligible: true,
      postedAt: "2026-03-20T09:00:00.000Z",
      postedAtText: null,
      discoveredAt: "2026-03-20T09:05:00.000Z",
      firstSeenAt: "2026-03-20T09:05:00.000Z",
      lastSeenAt: "2026-03-20T09:05:00.000Z",
      lastVerifiedActiveAt: "2026-03-20T09:05:00.000Z",
      salaryText: "$180k - $220k",
      normalizedCompensation: {
        currency: "USD",
        interval: "year",
        minAmount: 180000,
        maxAmount: 220000,
        minAnnualUsd: 180000,
        maxAnnualUsd: 220000,
      },
      summary: "Own the design system.",
      description: "Own the design system and workflow platform.",
      keySkills: ["Figma", "Design Systems"],
      responsibilities: ["Own the design system roadmap."],
      minimumQualifications: ["Strong product design systems experience."],
      preferredQualifications: ["Workflow-platform product background."],
      seniority: "Senior",
      employmentType: "Full-time",
      department: "Design",
      team: "Design Systems",
      employerWebsiteUrl: "https://signalsystems.example.com",
      employerDomain: "signalsystems.example.com",
      atsProvider: null,
      screeningHints: {
        sponsorshipText: null,
        requiresSecurityClearance: null,
        relocationText: null,
        travelText: null,
        remoteGeographies: ["Europe"],
      },
      keywordSignals: [
        { id: "sig_1", label: "Design Systems", kind: "skill", weight: 5 },
      ],
      benefits: ["Remote-first collaboration"],
      status: "ready_for_review",
      matchAssessment: {
        score: 96,
        reasons: ["Strong design-systems overlap"],
        gaps: [],
        recommendation: "review_before_applying",
        evidence: [],
      },
      provenance: [],
      discoveryFeedback: null,
      latestMatchAssessmentAudit: null,
    };
  const jobs = [];
  const titles = [
    "Senior Product Designer",
    "Principal UX Engineer",
    "Staff Product Designer",
    "Lead UX Strategist",
    "Senior Systems Designer",
    "Platform Engineer",
    "Very Long Job Title That Should Truncate In Pill And Not Overflow The Card At 125 Percent Zoom For Verification Purposes With Extra Long Descriptor To Test Pill Ellipsis",
  ];
  const companies = [
    "Signal Systems",
    "Northstar Systems",
    "Atlas Works",
    "CoreLedger",
    "Northwind Labs",
    "Consent Labs",
    "Mercury AI",
  ];
  for (let i = 0; i < count; i++) {
    const base = structuredClone(template);
    const ordinal = i + 1;
    const discoveredAt = new Date(
      Date.now() - (count - i) * 60000,
    ).toISOString();
    const title =
      titles[i % titles.length] +
      (i % 10 === 0
        ? ` ${ordinal} with extra long descriptor to test pill truncate behavior in job cards and badges at high zoom`
        : "");
    const company = companies[i % companies.length];
    jobs.push({
      ...base,
      id: `job_synth_${String(ordinal).padStart(3, "0")}`,
      sourceJobId: `source_synth_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/synth_${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/synth_${ordinal}/apply`,
      title,
      company,
      location:
        i % 3 === 0
          ? "Remote"
          : i % 3 === 1
            ? "Hybrid, London"
            : "On-site, Berlin with a very long location descriptor that should truncate elegantly without overflow",
      summary: `Synthetic job ${ordinal} for deterministic UI coverage.`,
      description: `Synthetic listing content for coverage ${ordinal}; no external source opened.`,
      status: "ready_for_review",
      provenance: provenanceTarget
        ? [buildFixtureJobProvenance(provenanceTarget, discoveredAt)]
        : [],
      discoveredAt,
      lastSeenAt: new Date().toISOString(),
      firstSeenAt: new Date(Date.now() - (count - i) * 60000).toISOString(),
      lastVerifiedActiveAt: new Date().toISOString(),
    });
  }
  return jobs;
}
async function waitForWorkspaceHydrated(page, timeoutMs = 30000) {
  await waitForCondition(
    async () => {
      const w = await getWorkspace(page);
      return w && w.hydration && w.hydration.phase === "complete";
    },
    "workspace hydration",
    timeoutMs,
  );
}
async function createEmptyStateInRenderer(page) {
  await page.evaluate(() => window.nestor.jobFinder.resetWorkspace());
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.getWorkspace),
    undefined,
    { timeout: 15000 },
  );
  await waitForWorkspaceHydrated(page, 20000);
}
async function run() {
  await ensureFreshOutputDir(outputDir);
  await verifyAcceptanceArtifacts(acceptance);
  const userDataDirectory = await makeIsolatedUserDataDirectory(
    "nestor-fresh-flows-",
  );
  report.safety.isolatedUserDataDir = userDataDirectory;
  report.safety.syntheticTestDataDigest = digestSeed({
    seed: acceptance.seedDigest,
    component: "fresh",
    source: "preload.test",
  });
  let app;
  let processOutputState = null;
  let scenarioSucceeded = false;
  let primaryScenarioError = null;
  let finalizationError = null;
  let ownershipError = null;
  let cleanupError = null;
  let reportPersistenceError = null;
  const ownedProcesses = createOwnedProcessLedger();
  const observedSafetyEvents = [];
  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: acceptanceEnvironment({
        NESTOR_USER_DATA_DIR: userDataDirectory,
        NESTOR_TEST_WORKSPACE_OPENING_HOLD_MS: "750",
      }),
    });
    processOutputState = attachProcessOutput(app, report);
    const page = await app.firstWindow();
    await page.exposeFunction("__jobFinderAcceptanceSafetyEvents", (record) => {
      observedSafetyEvents.push(record);
    });
    await page.addInitScript(installPrepareOnlySafetyProbe);
    await page.evaluate(installPrepareOnlySafetyProbe);
    page.on("pageerror", (error) => {
      report.runtimeErrors.push({ type: "pageerror", message: error.message });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error")
        report.runtimeErrors.push({ type: "console", message: msg.text() });
    });
    await page.waitForLoadState("domcontentloaded");
    await assertFileRenderer(page);
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 30000 },
    );
    const browserWindow = await resolveStartupBrowserWindow(app, page);
    activeBrowserWindow = browserWindow;
    await page.evaluate(() =>
      window.nestor.jobFinder.test.setSystemThemeOverride("dark"),
    );
    await setViewport(page, browserWindow, viewports[0]);

    const openingState = page.locator("[data-workspace-state-screen]");
    if ((await openingState.count()) > 0 && (await openingState.isVisible())) {
      const workspaceStateGeometry = await collectWorkspaceStateGeometry(page);
      const openingHeaderEvidence = await collectOpeningHeaderEvidence(page);
      await capture(page, "opening-workspace-centered-desktop", {
        viewport: viewports[0],
        scenario: "opening-workspace",
        scenarioId: "opening-workspace-desktop",
        expectWorkspaceStateGeometry: true,
        expectOpeningHeader: true,
        openingHeaderEvidence,
        workspaceStateGeometry,
      });
    } else {
      throw new Error(
        "Opening workspace state completed before acceptance could capture it; expose a narrow test-only bootstrap hold instead of silently omitting loading-state evidence.",
      );
    }

    const baseApplySnapshot = await page.evaluate(() =>
      window.nestor.jobFinder.test.loadApplyQueueDemo(),
    );
    const baseResumeSnapshot = await page.evaluate(() =>
      window.nestor.jobFinder.test.loadResumeWorkspaceDemo(),
    );

    console.log(
      "=== Populated Profile Basics and non-Basics first viewports ===",
    );
    const populatedProfileSnapshot = structuredClone(baseResumeSnapshot);
    populatedProfileSnapshot.profileSetupState = {
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-03-20T10:05:00.000Z",
      reviewItems: [],
      lastResumedAt: "2026-03-20T10:05:00.000Z",
    };
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      populatedProfileSnapshot,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 15000 },
    );
    await waitForWorkspaceHydrated(page, 20000);
    const hydratedProfileWorkspace = await getWorkspace(page);
    assert(
      hydratedProfileWorkspace?.profile?.fullName ===
        populatedProfileSnapshot.profile.fullName &&
        hydratedProfileWorkspace?.profile?.baseResume?.fileName ===
          populatedProfileSnapshot.profile.baseResume.fileName &&
        hydratedProfileWorkspace?.profile?.experiences?.length > 0,
      "Populated Profile viewport fixture did not hydrate profile, resume, and experience data.",
    );
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/profile";
    });
    await page
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ state: "visible", timeout: 10000 });
    await clickNavigationControl(page, "Basics");
    await ensureLocatorText(page, "Personal details");
    const profileBasicsFirstViewport = await capture(
      page,
      "profile-basics-populated-first-viewport",
      {
        viewport: viewports[0],
        scenario: "profile-basics-populated-first-viewport",
        scenarioId: "profile-basics-populated-first-viewport",
        expectProfileFirstViewport: true,
        profileFirstViewport: {
          activeSection: "basics",
          expectedHeading: "Personal details",
          expectedResumeFileName:
            populatedProfileSnapshot.profile.baseResume.fileName,
          expectCompact: false,
        },
      },
    );
    await clickNavigationControl(page, "Work history");
    await ensureLocatorText(page, "Work history");
    const profileExperienceFirstViewport = await capture(
      page,
      "profile-experience-populated-first-viewport",
      {
        viewport: viewports[0],
        scenario: "profile-experience-populated-first-viewport",
        scenarioId: "profile-experience-populated-first-viewport",
        expectProfileFirstViewport: true,
        profileFirstViewport: {
          activeSection: "experience",
          expectedHeading: "Work history",
          expectedResumeFileName:
            populatedProfileSnapshot.profile.baseResume.fileName,
          expectCompact: true,
        },
      },
    );
    report.scenarios.profileFirstViewports = {
      basics: profileBasicsFirstViewport.profileFirstViewportEvidence,
      experience: profileExperienceFirstViewport.profileFirstViewportEvidence,
    };

    console.log("=== Fresh Home 0 metrics with guidance ===");
    await createEmptyStateInRenderer(page);
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/home";
    });
    await page
      .getByRole("heading", { level: 1, name: "Home" })
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    const freshHomeDesktop = await capture(
      page,
      "fresh-home-desktop-0-metrics",
      {
        viewport: viewports[0],
        scenario: "fresh-home",
        scenarioId: "home-zero-desktop",
        expectWideSidebar: true,
      },
    );
    const freshHomeWorkspace = await getWorkspace(page);
    const freshHomeMetrics = assertZeroDashboardMetrics(freshHomeWorkspace);
    await setViewport(page, browserWindow, viewports[2]);
    const freshHomeMinimum = await capture(
      page,
      "fresh-home-minimum-width-0-metrics",
      {
        viewport: viewports[2],
        scenario: "fresh-home-minimum-width",
        scenarioId: "home-zero-minimum",
        expectCompactPlanningButton: true,
        expectWordmark: true,
        wordmarkEvidence: await collectWordmarkEvidence(page),
      },
    );
    completeScenario("wide-sidebar-1440", freshHomeDesktop);
    completeScenario("compact-planning-settings-minimum", freshHomeMinimum);
    completeScenario("collapsed-shell-wordmark-minimum", freshHomeMinimum);
    await setViewport(page, browserWindow, viewports[0]);
    report.scenarios.freshHome = {
      metricsZero: Object.values(freshHomeMetrics).every(
        (value) => value === 0,
      ),
      metrics: freshHomeMetrics,
      viewport: viewports[0].slug,
      minimumWidth: viewports[2].width,
    };

    console.log("=== Guided Setup empty ===");
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/profile/setup";
    });
    await page
      .getByRole("heading", { name: /Guided setup/ })
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await capture(page, "guided-setup-empty-desktop", {
      viewport: viewports[0],
      scenario: "guided-setup-empty",
      scenarioId: "guided-setup-empty-desktop",
    });
    await setViewport(page, browserWindow, viewports[1]);
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/profile/setup";
    });
    await capture(page, "guided-setup-empty-native125", {
      viewport: viewports[1],
      scenario: "guided-setup-empty-native125",
      scenarioId: "guided-setup-empty-native125",
      expectGuidedSetupPrimaryActions: true,
    });
    await setViewport(page, browserWindow, viewports[0]);
    report.scenarios.guidedSetup = { empty: true };

    console.log(
      "=== Profile sources 25 rows p1/p2/filtered empty at native 125% pill truncate ===",
    );
    let sourceState = structuredClone(baseResumeSnapshot);
    const syntheticTargets = buildSyntheticTargets(
      sourceState.searchPreferences?.discovery?.targets ??
        sourceState.searchPreferences?.discoveryTargets ??
        [],
      32,
    );
    // Ensure discoveryTargets field correct location
    if (sourceState.searchPreferences?.discovery?.targets) {
      sourceState.searchPreferences.discovery.targets = syntheticTargets;
    } else if (sourceState.searchPreferences) {
      sourceState.searchPreferences.discoveryTargets = syntheticTargets;
    }
    sourceState.searchPreferences.discovery.targets = syntheticTargets;
    sourceState.profileSetupState = {
      status: "completed",
      currentStep: "ready_check",
      completedAt: new Date().toISOString(),
      reviewItems: [],
      lastResumedAt: new Date().toISOString(),
    };
    // Ensure profile has minimal required fields
    if (!sourceState.profile.firstName) sourceState.profile.firstName = "Alex";
    if (!sourceState.profile.lastName)
      sourceState.profile.lastName = "Vanguard";
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      sourceState,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 10000 },
    );
    await waitForWorkspaceHydrated(page, 20000);
    const profileWorkspace = await getWorkspace(page);
    const profileSourceTargets =
      profileWorkspace?.searchPreferences?.discovery?.targets ??
      profileWorkspace?.searchPreferences?.discoveryTargets;
    assert(
      Array.isArray(profileSourceTargets) &&
        profileSourceTargets.length === syntheticTargets.length,
      `Profile sources did not hydrate the expected populated state: expected ${syntheticTargets.length}, received ${Array.isArray(profileSourceTargets) ? profileSourceTargets.length : "missing"}.`,
    );
    await setViewport(page, browserWindow, viewports[0]);
    await page.evaluate(() => {
      window.location.hash =
        "#/job-finder/profile?section=sources&focus=job-sources";
    });
    await page
      .getByRole("heading", { name: "Your profile" })
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("#profile-job-sources-heading")
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("[data-job-sources-library]")
      .waitFor({ state: "visible", timeout: 10000 });
    const jobSourcesPageSize = 25;
    assert(
      syntheticTargets.length > jobSourcesPageSize,
      `Profile sources pagination needs more than ${jobSourcesPageSize} synthetic targets to exercise page 2.`,
    );
    const profileSourcesRangePatternSource = (first, last) =>
      `(^|\\D)${first}[–-]${last} of ${syntheticTargets.length}(?:\\D|$)`;
    const profileP1Settlement = await waitForSemanticSourcesPagination(page, {
      phase: "profile-sources page 1",
      rangePatternSource: profileSourcesRangePatternSource(
        1,
        Math.min(jobSourcesPageSize, syntheticTargets.length),
      ),
      expectedRowIds: syntheticTargets
        .slice(0, jobSourcesPageSize)
        .map((target) => target.id),
    });
    await capture(page, "profile-sources-25rows-p1-desktop", {
      viewport: viewports[0],
      scenario: "profile-sources-p1",
      scenarioId: "profile-sources-p1",
      totalSources: syntheticTargets.length,
      expectedRows: jobSourcesPageSize,
      expectSemanticPaginationEvidence: true,
      semanticPaginationEvidence: profileP1Settlement,
      scrollSelector: "[data-job-sources-library]",
    });
    const profileP1Rows = await page
      .locator("[data-compact-source-id], [data-expanded-source-id]")
      .count();
    assert(
      profileP1Rows === 25,
      `Profile sources page 1 rendered ${profileP1Rows} rows instead of 25.`,
    );
    // p2 via Next
    const nextBtn = page
      .getByRole("button", { name: "Next", exact: true })
      .first();
    if (!(await nextBtn.isEnabled()))
      throw new Error(
        "Profile source pagination did not expose an enabled Next button for page 2.",
      );
    await nextBtn.click();
    const profileP2Settlement = await waitForSemanticSourcesPagination(page, {
      phase: "profile-sources page 2",
      rangePatternSource: profileSourcesRangePatternSource(
        jobSourcesPageSize + 1,
        syntheticTargets.length,
      ),
      expectedRowIds: syntheticTargets
        .slice(jobSourcesPageSize)
        .map((target) => target.id),
    });
    await capture(page, "profile-sources-25rows-p2-desktop", {
      viewport: viewports[0],
      scenario: "profile-sources-p2",
      scenarioId: "profile-sources-p2",
      expectedRows: syntheticTargets.length - jobSourcesPageSize,
      expectSemanticPaginationEvidence: true,
      semanticPaginationEvidence: profileP2Settlement,
      scrollSelector: "[data-job-sources-library]",
    });
    const profileP2Rows = await page
      .locator("[data-compact-source-id], [data-expanded-source-id]")
      .count();
    assert(
      profileP2Rows === 7,
      `Profile sources page 2 rendered ${profileP2Rows} rows instead of 7.`,
    );
    // filtered empty
    const searchInput = page
      .getByPlaceholder("Search by company, board, or URL")
      .first();
    await searchInput.waitFor({ state: "visible", timeout: 10000 });
    await searchInput.fill("zzznonexistentquery999");
    await page
      .getByText("No sources match this view", { exact: true })
      .waitFor({ state: "visible", timeout: 10000 });
    await capture(page, "profile-sources-filtered-empty-desktop", {
      viewport: viewports[0],
      scenario: "profile-filtered-empty",
      scenarioId: "profile-sources-filtered-empty",
      emptyUnified: true,
      scrollSelector: "[data-job-sources-library]",
    });
    await searchInput.fill("");
    // Native 125% pill truncate
    await setViewport(page, browserWindow, viewports[1]);
    await page.evaluate(() => {
      window.location.hash =
        "#/job-finder/profile?section=sources&focus=job-sources";
    });
    await page
      .getByRole("heading", { name: "Your profile" })
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("#profile-job-sources-heading")
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("[data-job-sources-library]")
      .waitFor({ state: "visible", timeout: 10000 });
    const profileDeepLinkVisibilityEvidence =
      await collectProfileDeepLinkVisibilityEvidence(page);
    await capture(page, "profile-sources-25rows-native125", {
      viewport: viewports[1],
      scenario: "profile-sources-native125",
      scenarioId: "profile-sources-native125",
      pillsTruncate: true,
      expectProfileDeepLinkEvidence: true,
      profileDeepLinkVisibilityEvidence,
      contentTarget: {
        selector: "[data-compact-source-id]",
        block: "center",
        minVisibleRows: 2,
        requiredRowIds: syntheticTargets.slice(0, 2).map((target) => target.id),
      },
    });
    await setViewport(page, browserWindow, viewports[0]);
    report.scenarios.profileSources = {
      total: profileSourceTargets.length,
      pageSize: jobSourcesPageSize,
      renderedRows: { page1: profileP1Rows, page2: profileP2Rows },
      pageEvidence: {
        page1: {
          observedRangeText: profileP1Settlement.observedRangeText,
          observedRowIds: profileP1Settlement.observedRowIds,
          observedRowCount: profileP1Settlement.observedRowCount,
          geometryStableAcrossAnimationFrames:
            profileP1Settlement.geometryStableAcrossAnimationFrames,
        },
        page2: {
          observedRangeText: profileP2Settlement.observedRangeText,
          observedRowIds: profileP2Settlement.observedRowIds,
          observedRowCount: profileP2Settlement.observedRowCount,
          geometryStableAcrossAnimationFrames:
            profileP2Settlement.geometryStableAcrossAnimationFrames,
        },
      },
    };

    console.log("=== Discovery 50 rows + filtered empty ===");
    let discoveryState = structuredClone(baseApplySnapshot);
    // For discovery filtering, ensure at least one source enabled before
    // deriving fixture provenance from the runnable configured target.
    if (discoveryState.searchPreferences?.discovery?.targets) {
      // enable first target if none enabled
      const hasEnabled =
        discoveryState.searchPreferences.discovery.targets.some(
          (t) => t.enabled,
        );
      if (!hasEnabled && discoveryState.searchPreferences.discovery.targets[0])
        discoveryState.searchPreferences.discovery.targets[0].enabled = true;
    }
    const discoveryProvenanceTarget =
      resolveConfiguredDiscoveryTarget(discoveryState);
    const discoveryJobs = buildSyntheticJobs(
      discoveryState.savedJobs ?? discoveryState.discoveryJobs ?? [],
      50,
      { provenanceTarget: discoveryProvenanceTarget },
    );
    // Set both savedJobs and discoveryJobs if field exists
    discoveryState.savedJobs = discoveryJobs;
    if ("discoveryJobs" in discoveryState)
      discoveryState.discoveryJobs = discoveryJobs;
    // Also ensure recentDiscoveryJobs includes Completed?
    // The apply-queue demo snapshot always contains at least one campaign;
    // binding to it is the only valid path. Fabricating a replacement here
    // would drift from the schema, so fail fast when the invariant breaks.
    const campaign = discoveryState.campaigns?.[0];
    assert(
      campaign,
      "Discovery scenario found no existing campaign in the apply-queue demo snapshot.",
    );
    campaign.jobIds = discoveryJobs.map((j) => j.id);
    campaign.progress = {
      ...campaign.progress,
      jobsFound: discoveryJobs.length,
      jobsRetained: discoveryJobs.length,
    };
    discoveryState.activeCampaignId = campaign.id;
    discoveryState.profileSetupState = {
      status: "completed",
      currentStep: "ready_check",
      completedAt: new Date().toISOString(),
      reviewItems: [],
      lastResumedAt: new Date().toISOString(),
    };
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      discoveryState,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 10000 },
    );
    await waitForWorkspaceHydrated(page, 20000);
    const discoveryWorkspace = await getWorkspace(page);
    const hydratedDiscoveryJobs = assertHydratedCollectionCount(
      discoveryWorkspace,
      "discoveryJobs",
      discoveryJobs.length,
      "Discovery jobs",
    );
    assert(
      discoveryWorkspace.activeCampaignId &&
        discoveryWorkspace.campaigns?.some(
          (candidate) =>
            candidate.id === discoveryWorkspace.activeCampaignId &&
            candidate.jobIds.length === discoveryJobs.length,
        ),
      "Discovery workspace did not hydrate a populated active campaign with all synthetic jobs.",
    );
    const discoveryProvenanceAttribution = assertSyntheticProvenanceClosure(
      discoveryJobs,
      discoveryState.searchPreferences?.discovery?.targets ??
        discoveryState.searchPreferences?.discoveryTargets ??
        [],
      "Fresh discovery",
    );
    const hydratedDiscoveryProvenance = assertSyntheticProvenanceClosure(
      discoveryWorkspace.discoveryJobs ?? [],
      discoveryWorkspace.searchPreferences?.discovery?.targets ??
        discoveryWorkspace.searchPreferences?.discoveryTargets ??
        [],
      "Fresh discovery hydrated",
      discoveryJobs,
    );
    await setViewport(page, browserWindow, viewports[0]);
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/discovery";
    });
    await page
      .getByRole("heading", { name: "Find jobs" })
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator('[aria-labelledby="discovery-job-results-heading"]')
      .waitFor({ state: "visible", timeout: 10000 });
    await capture(page, "discovery-50rows-p1-desktop", {
      viewport: viewports[0],
      scenario: "discovery-p1",
      scenarioId: "discovery-p1",
      jobCount: 50,
    });
    const discoveryP1Rows = await page.locator("[data-job-result-id]").count();
    assert(
      discoveryP1Rows === discoveryJobs.length,
      `Discovery page 1 rendered ${discoveryP1Rows} jobs instead of ${discoveryJobs.length}.`,
    );
    // discovery p2 if available (50 page size 50 => only 1 page, but we still test pagination existence)
    // For 50 jobs with pageSize 50, p1 is 1-50, no p2 expected. We'll try to trigger filtered empty via search.
    const discoverySearchInput = page.getByPlaceholder(/Search/i).first();
    await discoverySearchInput.waitFor({ state: "visible", timeout: 10000 });
    await discoverySearchInput.fill("qzqzqz");
    await page
      .getByText(/No matching jobs|No jobs/i)
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .getByText("Choose a job to review", { exact: true })
      .waitFor({ state: "visible", timeout: 10000 });
    assert(
      (await page.getByRole("button", { name: /^Shortlist / }).count()) === 0,
      "Discovery inspector retained actions for a job outside the filtered result set.",
    );
    await capture(page, "discovery-filtered-empty-desktop", {
      viewport: viewports[0],
      scenario: "discovery-filtered-empty",
      scenarioId: "discovery-filtered-empty",
      emptyUnified: true,
    });
    assert(
      (await page.locator("[data-job-result-id]").count()) === 0,
      "Discovery filtered-empty state still rendered job results.",
    );
    await discoverySearchInput.fill("");
    await setViewport(page, browserWindow, viewports[1]);
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/discovery";
    });
    await page.waitForTimeout(700);
    await capture(page, "discovery-50rows-native125", {
      viewport: viewports[1],
      scenario: "discovery-native125",
      scenarioId: "discovery-native125",
    });
    await setViewport(page, browserWindow, viewports[0]);
    report.scenarios.discovery = {
      jobCount: hydratedDiscoveryJobs,
      renderedRows: discoveryP1Rows,
      filteredRenderedRows: 0,
      provenanceAttribution: {
        ...discoveryProvenanceAttribution,
        hydrated: hydratedDiscoveryProvenance,
        provenanceTargetId: discoveryProvenanceTarget.id,
      },
    };

    console.log(
      "=== Long-label truth at desktop, minimum width, and native 125% zoom ===",
    );
    const longLabelJobs = buildSyntheticJobs(
      discoveryState.savedJobs ?? discoveryState.discoveryJobs ?? [],
      LONG_LABEL_JOB_TOTAL,
      { provenanceTarget: discoveryProvenanceTarget },
    ).map((job, index) => ({
      ...job,
      // The discovery detail panel exposes its primary "Shortlist job" action
      // only for undiscovered results (`status !== "discovered"` renders an
      // "Open in Shortlisted" link instead), so these synthetic rows must stay
      // in the discovered state for the shortlist-action reachability
      // evidence below to describe a real control.
      status: "discovered",
      title: LONG_LABEL_JOB_TITLES[index % LONG_LABEL_JOB_TITLES.length],
      company: LONG_LABEL_COMPANIES[index % LONG_LABEL_COMPANIES.length],
      location: LONG_LABEL_LOCATIONS[index % LONG_LABEL_LOCATIONS.length],
    }));
    const longLabelState = structuredClone(discoveryState);
    longLabelState.savedJobs = longLabelJobs;
    if ("discoveryJobs" in longLabelState)
      longLabelState.discoveryJobs = longLabelJobs;
    if (
      Array.isArray(longLabelState.campaigns) &&
      longLabelState.campaigns[0]
    ) {
      longLabelState.campaigns[0] = {
        ...longLabelState.campaigns[0],
        id: "campaign_long_label_truth",
        name: LONG_LABEL_CAMPAIGN_NAME,
        jobIds: longLabelJobs.map((job) => job.id),
        progress: {
          ...longLabelState.campaigns[0].progress,
          jobsFound: longLabelJobs.length,
          jobsRetained: longLabelJobs.length,
        },
      };
      longLabelState.activeCampaignId = "campaign_long_label_truth";
    }
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      longLabelState,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 10000 },
    );
    await waitForWorkspaceHydrated(page, 20000);
    const longLabelWorkspace = await getWorkspace(page);
    assertHydratedCollectionCount(
      longLabelWorkspace,
      "discoveryJobs",
      longLabelJobs.length,
      "Long-label jobs",
    );
    const longLabelProvenanceAttribution = assertSyntheticProvenanceClosure(
      longLabelJobs,
      discoveryState.searchPreferences?.discovery?.targets ??
        discoveryState.searchPreferences?.discoveryTargets ??
        [],
      "Long-label",
    );
    const longLabelHydratedProvenance = assertSyntheticProvenanceClosure(
      longLabelWorkspace.discoveryJobs ?? [],
      longLabelWorkspace.searchPreferences?.discovery?.targets ??
        longLabelWorkspace.searchPreferences?.discoveryTargets ??
        [],
      "Long-label hydrated",
      longLabelJobs,
    );
    const longLabelViewports = [
      {
        key: "desktop",
        viewport: viewports[0],
        scenarioId: "long-label-desktop",
      },
      {
        key: "minimum",
        viewport: viewports[2],
        scenarioId: "long-label-minimum",
      },
      {
        key: "native125",
        viewport: viewports[1],
        scenarioId: "long-label-native125",
      },
    ];
    for (const target of longLabelViewports) {
      await setViewport(page, browserWindow, target.viewport);
      await page.evaluate(() => {
        window.location.hash = "#/job-finder/discovery";
      });
      await page
        .getByRole("heading", { name: "Find jobs" })
        .first()
        .waitFor({ state: "visible", timeout: 10000 });
      await page
        .locator('[aria-labelledby="discovery-job-results-heading"]')
        .waitFor({ state: "visible", timeout: 10000 });
      const longLabelSearchInput = page
        .getByPlaceholder("Search roles or companies", { exact: true })
        .first();
      await longLabelSearchInput.waitFor({ state: "visible", timeout: 10000 });
      if ((await longLabelSearchInput.inputValue()) !== "")
        await longLabelSearchInput.fill("");
      await page.locator("[data-job-result-id]").first().click();
      const firstCardTitle = await page.evaluate(() => {
        const heading = document
          .querySelector("[data-job-result-id]")
          ?.querySelector("strong");
        return heading ? heading.textContent.replace(/\s+/g, " ").trim() : null;
      });
      assert(
        typeof firstCardTitle === "string" &&
          LONG_LABEL_JOB_TITLES.includes(firstCardTitle),
        `First long-label result card did not render a known deterministic title: ${JSON.stringify(firstCardTitle)}`,
      );
      const longLabelEvidence = await collectLongLabelEvidence(page, {
        expectedRows: longLabelJobs.length,
        titles: LONG_LABEL_JOB_TITLES,
        metaLines: LONG_LABEL_META_LINES,
        shortlistActionLabel: "Shortlist job",
      });
      await capture(page, `long-labels-find-jobs-${target.key}`, {
        viewport: target.viewport,
        scenario: "job-finder-long-labels",
        scenarioId: target.scenarioId,
        expectLongLabelScenario: true,
        longLabelEvidence,
        contentTarget: {
          selector: "[data-job-result-id]",
          // The loop has already clicked the first rendered result, so it is
          // visible before capture. `nearest` keeps the evidence target
          // stable while avoiding a synthetic outer-page scroll caused by
          // centering a tall long-label card under the fixed app header.
          block: "nearest",
          textSelector: "strong",
          requiredTexts: LONG_LABEL_JOB_TITLES,
        },
      });
    }
    report.scenarios.longLabelsFindJobs = {
      jobCount: longLabelJobs.length,
      scenarioIds: [
        "long-label-desktop",
        "long-label-minimum",
        "long-label-native125",
      ],
      viewports: longLabelViewports.map((target) => target.viewport.slug),
      provenanceAttribution: {
        ...longLabelProvenanceAttribution,
        hydrated: longLabelHydratedProvenance,
        provenanceTargetId: discoveryProvenanceTarget.id,
      },
    };

    console.log(
      "=== Long-label job sources truncation truth at native 125% zoom ===",
    );
    const longLabelSources = buildSyntheticTargets(
      discoveryState.searchPreferences?.discovery?.targets ?? [],
      LONG_LABEL_SOURCE_TOTAL,
    ).map((target, index) => ({
      ...target,
      label: LONG_LABEL_SOURCE_NAMES[index % LONG_LABEL_SOURCE_NAMES.length],
    }));
    const longLabelSourcesState = structuredClone(longLabelState);
    if (longLabelSourcesState.searchPreferences?.discovery) {
      longLabelSourcesState.searchPreferences.discovery.targets =
        longLabelSources;
    } else if (longLabelSourcesState.searchPreferences) {
      longLabelSourcesState.searchPreferences.discoveryTargets =
        longLabelSources;
    }
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      longLabelSourcesState,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 10000 },
    );
    await waitForWorkspaceHydrated(page, 20000);
    const longLabelSourcesWorkspace = await getWorkspace(page);
    const hydratedLongLabelSources =
      longLabelSourcesWorkspace?.searchPreferences?.discovery?.targets ??
      longLabelSourcesWorkspace?.searchPreferences?.discoveryTargets;
    assert(
      Array.isArray(hydratedLongLabelSources) &&
        hydratedLongLabelSources.length === longLabelSources.length,
      `Long-label sources did not hydrate the expected populated state: expected ${longLabelSources.length}, received ${Array.isArray(hydratedLongLabelSources) ? hydratedLongLabelSources.length : "missing"}.`,
    );
    await setViewport(page, browserWindow, viewports[1]);
    await page.evaluate(() => {
      window.location.hash =
        "#/job-finder/profile?section=sources&focus=job-sources";
    });
    await page
      .getByRole("heading", { name: "Your profile" })
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("#profile-job-sources-heading")
      .waitFor({ state: "visible", timeout: 10000 });
    await page
      .locator("[data-job-sources-library]")
      .waitFor({ state: "visible", timeout: 10000 });
    const sourceLabelEvidence = await collectSourceLabelEvidence(page, {
      expectedRows: longLabelSources.length,
      names: LONG_LABEL_SOURCE_NAMES,
    });
    assert(
      sourceLabelEvidence.truncatedRowCount >= 1,
      "Intended ellipsis truncation did not engage for any long source label at native 125% zoom.",
    );
    await capture(page, "long-labels-job-sources-native125", {
      viewport: viewports[1],
      scenario: "job-finder-long-labels",
      scenarioId: "long-label-sources-native125",
      expectLongLabelScenario: true,
      longLabelEvidence: sourceLabelEvidence,
      contentTarget: {
        selector: "[data-compact-source-id]",
        block: "center",
        textSelector: "h4",
        requiredTexts: LONG_LABEL_SOURCE_NAMES,
      },
    });
    await setViewport(page, browserWindow, viewports[0]);
    report.scenarios.longLabelsJobSources = {
      sourceCount: longLabelSources.length,
      scenarioIds: ["long-label-sources-native125"],
    };

    console.log("=== More menu at native 125% inside viewport + keyboard ===");
    await setViewport(page, browserWindow, viewports[1]);
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/home";
    });
    await page
      .getByRole("heading", { level: 1, name: "Home" })
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    const planningSettingsButton = page.getByRole("button", {
      name: /^More/,
      exact: false,
    });
    await planningSettingsButton.waitFor({ state: "visible", timeout: 8000 });
    await planningSettingsButton.click();
    const planningSettingsMenu = page.getByRole("navigation", {
      name: PLANNING_SETTINGS_MENU_LABEL,
      exact: true,
    });
    await planningSettingsMenu.waitFor({ state: "visible", timeout: 8000 });
    const planningMenuKeyboard = await exercisePlanningSettingsKeyboard(
      page,
      planningSettingsMenu,
    );
    const planningSettingsCapture = await capture(
      page,
      "planning-settings-menu-native125",
      {
        viewport: viewports[1],
        scenario: "planning-settings-menu",
        scenarioId: "planning-settings-menu-native125",
        expectPlanningMenu: true,
        expectPlanningMenuKeyboard: true,
        clickablePointScopeSelector: '[role="navigation"][aria-label="More"]',
        planningMenuKeyboard,
      },
    );
    const planningMenuLayout = report.captures.at(-1)?.navigation?.planningMenu;
    if (
      !planningMenuLayout?.requiredDestinationsVisible ||
      !planningMenuLayout.labels?.includes("Settings")
    )
      throw new Error(
        `More menu did not retain Settings at native 125%: ${JSON.stringify(planningMenuLayout)}`,
      );
    completeScenario(
      "planning-settings-menu-native125",
      planningSettingsCapture,
    );
    await page.keyboard.press("Escape");
    await planningSettingsMenu.waitFor({ state: "hidden", timeout: 5000 });
    // Also capture the native 125% home for final sweep sanity
    await capture(page, "fresh-home-native125", {
      viewport: viewports[1],
      scenario: "fresh-home-native125",
      scenarioId: "home-zero-native125",
    });
    await setViewport(page, browserWindow, viewports[0]);

    // Safety checks
    const finalWorkspace = await getWorkspace(page);
    if (!finalWorkspace)
      throw new Error(
        "Fresh-flow acceptance could not read the final synthetic workspace.",
      );
    {
      const submitFlags = (finalWorkspace.userActionRequests ?? []).map(
        (r) => r.submitAuthorized,
      );
      const acctFlags = (finalWorkspace.userActionRequests ?? []).map(
        (r) => r.accountCreationAuthorized,
      );
      report.safety.observedSafetyEvents = observedSafetyEvents;
      report.safety.applicationActionsExecuted =
        observedSafetyEvents.length > 0;
      report.safety.finalSubmissionClicked = observedSafetyEvents.some((c) =>
        /submit|application|apply/i.test(c.label ?? ""),
      );
      report.safety.submitAuthorized = submitFlags.some(Boolean);
      report.safety.accountCreationAuthorized = acctFlags.some(Boolean);
      report.safety.authoritativePersistedFacts = assertPrepareOnly(
        finalWorkspace,
        observedSafetyEvents,
      );
      assert(
        report.safety.applicationActionsExecuted === false &&
          report.safety.finalSubmissionClicked === false &&
          report.safety.submitAuthorized === false &&
          report.safety.accountCreationAuthorized === false &&
          observedSafetyEvents.length === 0,
        `Fresh-flow safety completion was not prepare-only: ${JSON.stringify(report.safety)}`,
      );
      report.safety.prepareOnlyVerified = true;
    }
    if (report.runtimeErrors.length > 0) {
      throw new Error(
        `Runtime errors: ${JSON.stringify(report.runtimeErrors)}`,
      );
    }
    const completedScenarioIds = new Set(report.scenarioCompletionIds);
    const missingScenarioIds = report.requiredScenarioCompletionIds.filter(
      (scenarioId) => !completedScenarioIds.has(scenarioId),
    );
    if (missingScenarioIds.length > 0)
      throw new Error(
        `Fresh-flow acceptance did not complete required scenarios: ${missingScenarioIds.join(", ")}`,
      );
    assert(
      report.scenarioCompletionIds.length ===
        report.requiredScenarioCompletionIds.length,
      `Fresh-flow acceptance completed ${report.scenarioCompletionIds.length} scenarios but requires ${report.requiredScenarioCompletionIds.length}.`,
    );
    assert(
      report.safety.prepareOnlyVerified === true,
      "Fresh-flow acceptance did not complete its explicit prepare-only safety check.",
    );
    report.summary = {
      captureCount: report.captures.length,
      passCount: report.captures.filter((c) => c.pass).length,
      failCount: report.captures.filter((c) => !c.pass).length,
      viewports: viewports.map((v) => v.slug),
      allInsideViewport: report.captures.every((c) => c.insideViewport),
      allNoClip: report.captures.every((c) => c.noClip),
    };
    scenarioSucceeded = true;
    await writeReport();
    console.log(
      `Saved ${report.captures.length} fresh-flow captures to ${outputDir}`,
    );
    // List
    for (const c of report.captures) {
      console.log(
        `  ${c.id}: ${c.fileName} viewport=${c.viewport.slug} insideViewport=${c.insideViewport} noClip=${c.noClip} pass=${c.pass}`,
      );
    }
  } catch (error) {
    primaryScenarioError = error;
  } finally {
    if (app) {
      try {
        const verification = await stopAndVerifyOwnedElectron(
          app,
          ownedProcesses,
          "fresh",
        );
        report.processOwnership.verifications.push(verification);
      } catch (error) {
        ownershipError = error;
        // The diagnostic is persisted even when exit precedence later picks
        // the primary scenario error, so an ownership teardown failure can
        // never disappear from the report.
        report.processOwnership.failure =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
      }
    }
    report.processOwnership.trackedProcesses = ownedProcesses.entries();
    report.processOwnership.leftoverPids =
      report.processOwnership.verifications.flatMap(
        (verification) => verification.leftoverPids,
      );
    report.processOwnership.verified =
      !ownershipError &&
      report.processOwnership.trackedProcesses.length > 0 &&
      report.processOwnership.leftoverPids.length === 0;
    if (processOutputState) {
      try {
        finalizeProcessOutput(processOutputState, report, {
          acceptedStderrPatterns: [
            PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
          ],
        });
      } catch (error) {
        finalizationError = error;
      }
    }
    cleanupError = await cleanupDirectory(userDataDirectory);
    report.safety.cleanedUp = !cleanupError;
    if (cleanupError) report.safety.cleanupError = String(cleanupError);
    if (
      scenarioSucceeded &&
      !finalizationError &&
      !ownershipError &&
      !cleanupError
    ) {
      report.pass = true;
      report.completedAt = new Date().toISOString();
    }
    try {
      await writeReport();
    } catch (error) {
      reportPersistenceError = error;
    }
  }
  const teardownFailure = resolvePrimaryRunError(
    primaryScenarioError,
    finalizationError,
  );
  if (teardownFailure) throw teardownFailure;
  if (ownershipError) throw ownershipError;
  if (cleanupError)
    throw new Error(
      `Unable to clean isolated user data directory: ${cleanupError}`,
    );
  if (reportPersistenceError) throw reportPersistenceError;
}

run().catch(async (err) => {
  console.error(err);
  report.failedAt = new Date().toISOString();
  report.failure =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Truthful failure completion: even when the in-run persistence attempt
  // failed and this outer retry succeeds, the persisted artifact must never
  // claim pass:true or a completed run alongside failure.
  report.pass = false;
  report.completedAt = null;
  await writeReport();
  process.exitCode = 1;
});
