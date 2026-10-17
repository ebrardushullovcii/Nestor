import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "profile-setup";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const defaultResumePath = path.resolve(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "resume-import-sample.txt",
);

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
  timeoutMs = 15000,
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

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function waitForSetupStep(window, expectedStep) {
  await waitForCondition(
    async () =>
      (await getWorkspace(window)).profileSetupState.currentStep ===
      expectedStep,
    `setup step '${expectedStep}'`,
  );
}

async function waitForSetupStatus(window, expectedStatus) {
  await waitForCondition(
    async () =>
      (await getWorkspace(window)).profileSetupState.status === expectedStatus,
    `setup status '${expectedStatus}'`,
  );
}

function normalizeComparableText(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function humanizeRecordFieldKey(key) {
  switch (key) {
    case "companyName":
      return "Company";
    case "isCurrent":
      return "Current role";
    case "startDate":
      return "Start";
    case "endDate":
      return "End";
    case "fieldOfStudy":
      return "Field of study";
    case "workMode":
      return "Work mode";
    case "dateEarned":
      return "Date earned";
    default:
      return (
        key.charAt(0).toUpperCase() +
        key
          .slice(1)
          .replace(/([A-Z])/g, " $1")
          .trim()
      );
  }
}

function humanizePrimitive(value) {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

function summarizeReviewTargetValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return humanizePrimitive(value);
  }

  if (Array.isArray(value)) {
    const parts = value.flatMap(
      (entry) => summarizeReviewTargetValue(entry) ?? [],
    );
    return parts.length > 0 ? parts.join(", ") : null;
  }

  if (value && typeof value === "object") {
    const parts = Object.entries(value).flatMap(([key, entry]) => {
      const summary = summarizeReviewTargetValue(entry);
      return summary ? [`${humanizeRecordFieldKey(key)}: ${summary}`] : [];
    });

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  return null;
}

function getCurrentReviewTargetValue(workspace, target) {
  switch (target.domain) {
    case "identity":
      if (target.key === "contactPath") {
        return [
          workspace.profile.email ?? "",
          workspace.profile.phone ?? "",
        ].filter(Boolean);
      }

      return workspace.profile[target.key] ?? null;
    case "application_identity":
      if (target.key === "preferredLinkUrls") {
        return workspace.profile.applicationIdentity.preferredLinkIds
          .map(
            (linkId) =>
              workspace.profile.links.find((entry) => entry.id === linkId)
                ?.url ?? null,
          )
          .filter(
            (value) => typeof value === "string" && value.trim().length > 0,
          );
      }

      return workspace.profile.applicationIdentity[target.key] ?? null;
    case "work_eligibility":
      return workspace.profile.workEligibility[target.key] ?? null;
    case "professional_summary":
      return workspace.profile.professionalSummary[target.key] ?? null;
    case "search_preferences":
      return workspace.searchPreferences[target.key] ?? null;
    case "narrative":
      return workspace.profile.narrative[target.key] ?? null;
    case "answer_bank":
      return workspace.profile.answerBank[target.key] ?? null;
    case "experience": {
      const record = target.recordId
        ? (workspace.profile.experiences.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.experiences;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "education": {
      const record = target.recordId
        ? (workspace.profile.education.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.education;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "certification": {
      const record = target.recordId
        ? (workspace.profile.certifications.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.certifications;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "project": {
      const record = target.recordId
        ? (workspace.profile.projects.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.projects;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "link": {
      const record = target.recordId
        ? (workspace.profile.links.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.links;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "language": {
      const record = target.recordId
        ? (workspace.profile.spokenLanguages.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.spokenLanguages;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    case "proof_point": {
      const record = target.recordId
        ? (workspace.profile.proofBank.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : workspace.profile.proofBank;
      return target.key === "record" || !record || typeof record !== "object"
        ? record
        : (record[target.key] ?? null);
    }
    default:
      return null;
  }
}

async function expectNoPendingReviewItemsForCurrentStep(window) {
  const workspace = await getWorkspace(window);
  const currentStep = workspace.profileSetupState.currentStep;
  const pendingItems = workspace.profileSetupState.reviewItems.filter(
    (item) => item.step === currentStep && item.status === "pending",
  );

  if (pendingItems.length > 0) {
    throw new Error(
      `Expected no pending review items for setup step '${currentStep}', but found ${pendingItems.length}.`,
    );
  }
}

async function assertDraftAwareQueueState(window, expectedLabels) {
  const queueCard = window
    .locator("div")
    .filter({ has: window.getByText("Step review queue", { exact: true }) })
    .first();

  for (const label of expectedLabels) {
    const reviewCard = queueCard
      .locator("div")
      .filter({ has: window.getByText(label, { exact: true }) })
      .filter({ hasText: /· unsaved/ })
      .first();
    await reviewCard.waitFor({ state: "visible", timeout: 10000 });
  }

  // Draft-only resolutions render as one status badge, for example
  // "edited · unsaved" or "confirmed · unsaved".
  await queueCard
    .locator("span")
    .filter({ hasText: /^(confirmed|edited|dismissed) · unsaved$/ })
    .first()
    .waitFor({ state: "visible", timeout: 10000 });
}

async function saveCurrentStepAndWaitForPersistence(window, options = {}) {
  const { expectedMessage = "Saved this step.", expectedStep } = options;
  const previousWorkspace = await getWorkspace(window);
  const previousResolvedAtById = new Map(
    previousWorkspace.profileSetupState.reviewItems.map((item) => [
      item.id,
      item.resolvedAt ?? null,
    ]),
  );
  const currentStep =
    expectedStep ?? previousWorkspace.profileSetupState.currentStep;
  const pendingItems = previousWorkspace.profileSetupState.reviewItems.filter(
    (item) => item.step === currentStep && item.status === "pending",
  );

  await minimizeProfileCopilotIfOpen(window);
  await window
    .getByRole("button", { name: "Save changes", exact: true })
    .click();

  await waitForCondition(async () => {
    const workspace = await getWorkspace(window);
    return workspace.profileSetupState.currentStep === currentStep;
  }, `current step to remain '${currentStep}' after saving`);

  await window
    .getByRole("status")
    .filter({ hasText: expectedMessage })
    .last()
    .waitFor({ state: "visible", timeout: 10000 });

  const startedAt = Date.now();
  let lastWorkspace = previousWorkspace;

  while (Date.now() - startedAt < 15000) {
    lastWorkspace = await getWorkspace(window);

    const allResolved = pendingItems.every((item) => {
      const nextItem = lastWorkspace.profileSetupState.reviewItems.find(
        (entry) => entry.id === item.id,
      );

      if (!nextItem || nextItem.status === "pending") {
        return false;
      }

      if (nextItem.resolvedAt === previousResolvedAtById.get(item.id)) {
        return false;
      }

      const nextSummary = normalizeComparableText(
        summarizeReviewTargetValue(
          getCurrentReviewTargetValue(lastWorkspace, item.target),
        ),
      );
      const proposedSummary = normalizeComparableText(
        item.proposedValue ?? null,
      );
      const expectedStatus =
        proposedSummary && proposedSummary === nextSummary
          ? "confirmed"
          : "edited";

      return nextItem.status === expectedStatus;
    });

    if (allResolved) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `Timed out waiting for review items in setup step '${currentStep}' to persist after saving. ` +
      JSON.stringify({
        pendingItems: pendingItems.map((item) => ({
          id: item.id,
          label: item.label,
          proposedValue: item.proposedValue ?? null,
          currentValue: summarizeReviewTargetValue(
            getCurrentReviewTargetValue(lastWorkspace, item.target),
          ),
          currentStatus:
            lastWorkspace.profileSetupState.reviewItems.find(
              (entry) => entry.id === item.id,
            )?.status ?? null,
          currentResolvedAt:
            lastWorkspace.profileSetupState.reviewItems.find(
              (entry) => entry.id === item.id,
            )?.resolvedAt ?? null,
        })),
      }),
  );
}

async function applyProfileCopilotRequest(window, request, options = {}) {
  const { autoApplyReview = true } = options;
  const workspaceBefore = await getWorkspace(window);
  const previousMessageCount = workspaceBefore.profileCopilotMessages.length;
  const previousRevisionCount = workspaceBefore.profileRevisions.length;
  const requestField = await ensureProfileCopilotOpen(window);

  await requestField.fill(request);
  await window
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await window
    .locator('[data-profile-copilot-pending="true"]')
    .waitFor({ state: "visible", timeout: 10000 });

  await waitForCondition(async () => {
    const workspace = await getWorkspace(window);
    return workspace.profileCopilotMessages.length > previousMessageCount;
  }, "profile copilot assistant reply");

  const workspaceAfterReply = await getWorkspace(window);
  const latestAssistantMessage = [...workspaceAfterReply.profileCopilotMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  for (const patchGroup of latestAssistantMessage?.patchGroups ?? []) {
    if (autoApplyReview && patchGroup.applyMode === "needs_review") {
      await window
        .getByRole("button", { name: /^Apply & save: / })
        .first()
        .click();
    }
  }

  if (!autoApplyReview) {
    return;
  }

  await waitForCondition(async () => {
    const workspace = await getWorkspace(window);
    return workspace.profileRevisions.length > previousRevisionCount;
  }, "profile copilot request to finish applying a revision");
}

async function addListEditorValue(window, inputSelector, value) {
  const input = window.locator(inputSelector);
  await input.fill(value);
  await input.press("Enter");
}

async function ensureProfileCopilotOpen(window) {
  const requestField = window.getByRole("textbox", {
    name: "Message the Assistant",
    exact: true,
  });

  if (await requestField.isVisible().catch(() => false)) {
    return requestField;
  }

  await window
    .getByRole("button", { name: /the Assistant/ })
    .last()
    .click();
  await requestField.waitFor({ state: "visible", timeout: 10000 });
  return requestField;
}

async function minimizeProfileCopilotIfOpen(window) {
  const minimizeButton = window.getByRole("button", {
    name: "Minimize the Assistant",
    exact: true,
  });

  if (await minimizeButton.isVisible().catch(() => false)) {
    await minimizeButton.click();
    await minimizeButton.waitFor({ state: "hidden", timeout: 10000 });
  }
}

const PROFILE_SETUP_STEP_ORDER = [
  "import",
  "essentials",
  "background",
  "targeting",
  "extras",
];

// Exact footer continue labels rendered by ProfileSetupStepFooter. Job targets
// only offers "Save and continue to Extras" while setup cannot finish yet;
// once it can, its primary becomes "Finish setup and find jobs".
const SETUP_CONTINUE_LABEL_BY_STEP = {
  import: "Save and go to Basics",
  essentials: "Save and continue to Work history",
  background: "Save and continue to Job targets",
  targeting: "Save and continue to Extras",
};

async function assertSetupStepChrome(window, expectedStep) {
  const stepper = window.locator("nav[data-profile-setup-stepper]");
  await stepper.waitFor({ state: "visible", timeout: 10000 });
  await stepper
    .locator(
      `[data-profile-setup-stepper-step="${expectedStep}"][aria-current="step"]`,
    )
    .waitFor({ state: "visible", timeout: 10000 });
  // Guided setup has one readiness system: the stepper chips above and the
  // sticky footer's readiness line. There is no separate readiness strip.
  await window
    .locator("[data-profile-setup-finish-readiness]")
    .waitFor({ state: "visible", timeout: 10000 });
}

async function advanceSetupStep(window, nextStep) {
  const workspaceBefore = await getWorkspace(window);
  const currentStep = workspaceBefore.profileSetupState.currentStep;
  const continueLabel = SETUP_CONTINUE_LABEL_BY_STEP[currentStep];
  const isImmediateNextStep =
    PROFILE_SETUP_STEP_ORDER.indexOf(nextStep) ===
    PROFILE_SETUP_STEP_ORDER.indexOf(currentStep) + 1;

  // Prefer the real footer control so the audit exercises the visible
  // "Save and continue to …" label a first-time user actually clicks.
  if (continueLabel && isImmediateNextStep) {
    await minimizeProfileCopilotIfOpen(window);
    await window
      .getByRole("button", { name: continueLabel, exact: true })
      .click();
    await waitForSetupStep(window, nextStep);
    await window
      .getByRole("heading", { level: 1, name: "Guided setup" })
      .waitFor({ timeout: 10000 });
    await assertSetupStepChrome(window, nextStep);
    return getWorkspace(window);
  }

  const snapshot = await window.evaluate(async (step) => {
    const workspace = await window.nestor.jobFinder.getWorkspace();

    return window.nestor.jobFinder.saveProfileSetupState({
      ...workspace.profileSetupState,
      status:
        workspace.profileSetupState.status === "completed"
          ? "completed"
          : "in_progress",
      currentStep: step,
      lastResumedAt: new Date().toISOString(),
    });
  }, nextStep);

  if (snapshot.profileSetupState.currentStep !== nextStep) {
    throw new Error(
      `Expected saveProfileSetupState to move setup to '${nextStep}', but it returned '${snapshot.profileSetupState.currentStep}'.`,
    );
  }

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window
    .getByRole("heading", { level: 1, name: "Guided setup" })
    .waitFor({ timeout: 10000 });
  await waitForSetupStep(window, nextStep);
  await assertSetupStepChrome(window, nextStep);
  return snapshot;
}

async function resolveCurrentStepReviewItems(window) {
  while (true) {
    const workspace = await getWorkspace(window);
    const currentStep = workspace.profileSetupState.currentStep;
    const pendingItems = workspace.profileSetupState.reviewItems.filter(
      (item) => item.step === currentStep && item.status === "pending",
    );

    if (pendingItems.length === 0) {
      return;
    }

    const previousCount = pendingItems.length;
    const confirmButtons = window.getByRole("button", {
      name: "Confirm",
      exact: true,
    });

    if ((await confirmButtons.count()) > 0) {
      await confirmButtons.first().click();
    } else {
      const dismissButtons = window.getByRole("button", {
        name: "Dismiss for now",
        exact: true,
      });

      if ((await dismissButtons.count()) === 0) {
        throw new Error(
          `No review action buttons were available for setup step '${currentStep}'.`,
        );
      }

      await dismissButtons.first().click();
    }

    await waitForCondition(async () => {
      const nextWorkspace = await getWorkspace(window);
      return (
        nextWorkspace.profileSetupState.reviewItems.filter(
          (item) => item.step === currentStep && item.status === "pending",
        ).length < previousCount
      );
    }, `review count to decrease for setup step '${currentStep}'`);
  }
}

async function captureEssentialsDraftAwareState(window) {
  const headlineField = window.locator(
    "#profile-setup-field-identity-headline",
  );
  const yearsExperienceField = window.locator(
    "#profile-setup-field-identity-years-experience",
  );
  const portfolioField = window.locator(
    "#profile-setup-field-identity-portfolio-url",
  );

  await headlineField.fill("Lead Frontend Systems Engineer");
  await yearsExperienceField.fill("12");
  await portfolioField.fill("https://jamie.dev");

  await assertDraftAwareQueueState(window, [
    "Headline",
    "Years of experience",
    "Portfolio URL",
  ]);

  await window
    .getByText(
      "Save this step before asking the Assistant to edit it so your current setup draft does not get overwritten.",
      { exact: true },
    )
    .waitFor({ timeout: 10000 });
}

async function captureBlockedSetupCopilotMutationGuard(window) {
  await ensureProfileCopilotOpen(window);
  const sendButton = window.getByRole("button", {
    name: "Send message",
    exact: true,
  });

  await sendButton.waitFor({ state: "visible", timeout: 10000 });

  await applyProfileCopilotRequest(
    window,
    "my prefered work mode should be remote",
    { autoApplyReview: false },
  );

  const workspaceWithNeedsReviewPatch = await getWorkspace(window);
  const reviewPatchGroupPresent =
    workspaceWithNeedsReviewPatch.profileCopilotMessages.some(
      (message) =>
        message.context.surface === "setup" &&
        message.context.step === "targeting" &&
        message.patchGroups.some(
          (patchGroup) => patchGroup.applyMode === "needs_review",
        ),
    );

  if (!reviewPatchGroupPresent) {
    throw new Error(
      "Expected setup copilot to produce a needs_review patch group before verifying blocked apply/reject actions.",
    );
  }

  await addListEditorValue(
    window,
    "#profile-setup-field-search-preferences-target-roles",
    "Principal Frontend Systems Engineer",
  );

  if (!(await sendButton.isDisabled())) {
    throw new Error(
      "Expected setup copilot send to stay disabled while the current step has unsaved user edits.",
    );
  }

  await window
    .getByText(
      "Save this step before applying, rejecting, or undoing copilot changes so your current setup draft stays intact.",
      { exact: true },
    )
    .waitFor({ timeout: 10000 });

  const applyChangesButton = window
    .getByRole("button", { name: /^Apply & save: / })
    .first();
  await applyChangesButton.waitFor({ state: "visible", timeout: 10000 });
  if (!(await applyChangesButton.isDisabled())) {
    throw new Error(
      "Expected setup copilot apply action to stay disabled while the current step has unsaved user edits.",
    );
  }

  const rejectButton = window
    .getByRole("button", { name: /^Reject: / })
    .first();
  if (!(await rejectButton.isDisabled())) {
    throw new Error(
      "Expected setup copilot reject action to stay disabled while the current step has unsaved user edits.",
    );
  }

  const showRecentChangesButton = window
    .getByRole("button", { name: "Show", exact: false })
    .first();
  if (await showRecentChangesButton.isVisible().catch(() => false)) {
    await showRecentChangesButton.click();
  }

  const undoButton = window
    .getByRole("button", { name: /^Undo applied change: / })
    .first();
  await undoButton.waitFor({ state: "visible", timeout: 10000 });
  if (!(await undoButton.isDisabled())) {
    throw new Error(
      "Expected setup copilot undo action to stay disabled while the current step has unsaved user edits.",
    );
  }

  const workspaceAfter = await getWorkspace(window);
  const buildGuardComparableState = (workspace) =>
    JSON.stringify({
      targetRoles: workspace.searchPreferences.targetRoles,
      workModes: workspace.searchPreferences.workModes,
      remoteEligible: workspace.profile.workEligibility.remoteEligible,
      revisionIds: workspace.profileRevisions.map((revision) => revision.id),
      latestTargetingSetupAssistantMessage:
        [...workspace.profileCopilotMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.context.surface === "setup" &&
              message.context.step === "targeting",
          ) ?? null,
    });
  const mutationBefore = buildGuardComparableState(
    workspaceWithNeedsReviewPatch,
  );
  const mutationAfter = buildGuardComparableState(workspaceAfter);

  if (mutationBefore !== mutationAfter) {
    throw new Error(
      "Setup copilot guard should not mutate the workspace while unsaved edits are blocking actions.",
    );
  }
}

async function captureEssentialsCopilotYearsExperienceUpdate(window) {
  const requestedYearsExperience = 7;

  await applyProfileCopilotRequest(
    window,
    "change my experience to only 7 years",
  );

  await waitForCondition(async () => {
    const workspace = await getWorkspace(window);
    const reviewItem = workspace.profileSetupState.reviewItems.find(
      (item) =>
        item.target.domain === "identity" &&
        item.target.key === "yearsExperience",
    );

    return (
      workspace.profile.yearsExperience === requestedYearsExperience &&
      reviewItem?.status !== "pending"
    );
  }, "setup copilot years-of-experience update");
}

async function captureBackgroundEditJump(window) {
  // The step editor owns the fields directly; the summary strip no longer
  // repeats a "resume current step" primary action.
  await assertSetupStepChrome(window, "background");

  const workspace = await getWorkspace(window);
  const experience = workspace.profile.experiences.find(
    (entry) =>
      entry.title === "Staff Frontend Engineer" &&
      entry.companyName === "Signal Systems",
  );
  if (!experience) {
    throw new Error(
      "The seeded background experience was not available for edit-jump acceptance.",
    );
  }

  const detailsLocator = window.locator(`#experience-record-${experience.id}`);
  await detailsLocator.waitFor({ state: "visible", timeout: 10000 });
  const editButton = window.getByRole("button", {
    name: /Edit Staff Frontend Engineer at Signal Systems/i,
  });
  if (await editButton.isVisible().catch(() => false)) {
    await editButton.click();
  } else {
    await detailsLocator.evaluate((element) => {
      if (element instanceof HTMLDetailsElement) {
        element.open = true;
      }
    });
  }
  await waitForCondition(
    async () =>
      detailsLocator.evaluate(
        (element) => element instanceof HTMLDetailsElement && element.open,
      ),
    "background experience record to open from Edit this",
    10000,
  );
  const summaryField = window.locator(
    `#experience-record-${experience.id}-summary`,
  );
  await summaryField.waitFor({ state: "visible", timeout: 10000 });
  await summaryField.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
    element.blur();
  });

  return summaryField;
}

async function captureProfileSetup() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-profile-setup-"),
  );

  let app;

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_TEST_SYSTEM_THEME:
          process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        NESTOR_TEST_PROFILE_COPILOT_DELAY_MS: "1200",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");
    await window.evaluate(() => {
      window.location.hash = "#/job-finder/profile/setup";
    });
    await window.waitForFunction(
      () => {
        const heading = document.querySelector("h1");
        return (
          heading?.textContent?.includes("Guided setup") ||
          heading?.textContent?.includes("Your profile")
        );
      },
      undefined,
      { timeout: 15000 },
    );
    const initialHeading =
      (await window.locator("h1").first().textContent())?.trim() ?? "";
    if (initialHeading !== "Guided setup") {
      await window.getByRole("button", { name: /^Profile$/ }).click();
      await window
        .getByRole("heading", { level: 1, name: "Guided setup" })
        .waitFor({ timeout: 10000 });
    }
    await window.setViewportSize({ width, height });

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-setup-route.png"),
    });

    const initialWorkspace = await getWorkspace(window);
    await writeJson("workspace-before-profile-setup.json", initialWorkspace);

    const importedWorkspace = await window.evaluate(async (sourcePath) => {
      if (!window.nestor.jobFinder.test) {
        throw new Error(
          "Desktop test API is not available in the renderer context.",
        );
      }

      return window.nestor.jobFinder.test.importResumeFromPath(sourcePath);
    }, defaultResumePath);
    await writeJson("workspace-after-setup-import.json", importedWorkspace);

    // The test import mutates the durable workspace through IPC. Re-enter the
    // rendered route so the audit sees the same settled post-import state as
    // the native file-picker journey instead of a stale pre-import render.
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window
      .getByRole("button", { name: /^Profile$/ })
      .waitFor({ timeout: 15000 });
    await window.setViewportSize({ width, height });
    await waitForSetupStep(window, "essentials");
    await window
      .getByRole("heading", { level: 1, name: "Guided setup" })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-after-import-review-queue.png"),
    });

    const nextHeadline = "Principal Frontend Systems Engineer";
    const workspaceBeforeHeadlineRequest = await getWorkspace(window);
    const requestField = await ensureProfileCopilotOpen(window);
    await requestField.fill(`Update my headline to "${nextHeadline}"`);
    await window
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await window
      .locator('[data-profile-copilot-pending="true"]')
      .waitFor({ state: "visible", timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-setup-copilot-pending.png"),
    });
    await waitForCondition(
      async () => {
        const workspace = await getWorkspace(window);
        return (
          workspace.profileCopilotMessages.length >
          workspaceBeforeHeadlineRequest.profileCopilotMessages.length
        );
      },
      "setup copilot headline proposal",
      60000,
    );

    const workspaceWithHeadlineProposal = await getWorkspace(window);
    const headlineProposalMessage = [
      ...workspaceWithHeadlineProposal.profileCopilotMessages,
    ]
      .reverse()
      .find((message) => message.role === "assistant");
    const headlineProposal = headlineProposalMessage?.patchGroups.find(
      (patchGroup) => patchGroup.applyMode === "needs_review",
    );

    if (!headlineProposal) {
      throw new Error(
        "Expected the setup headline request to produce an explicit review proposal.",
      );
    }
    if (workspaceWithHeadlineProposal.profile.headline === nextHeadline) {
      throw new Error(
        "Setup Copilot changed the headline before the proposal was approved.",
      );
    }

    await writeJson(
      "workspace-with-headline-proposal.json",
      workspaceWithHeadlineProposal,
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03b-setup-copilot-proposal.png"),
    });
    await window
      .getByRole("button", { name: /^Apply & save: / })
      .first()
      .click();
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.profile.headline === nextHeadline &&
        workspace.profileRevisions.length >
          workspaceBeforeHeadlineRequest.profileRevisions.length
      );
    }, "explicit approval of the setup copilot headline proposal");
    await captureEssentialsCopilotYearsExperienceUpdate(window);
    await writeJson(
      "workspace-after-setup-copilot.json",
      await getWorkspace(window),
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-after-setup-copilot.png"),
    });

    await captureEssentialsDraftAwareState(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-essentials-draft-aware.png"),
    });

    await saveCurrentStepAndWaitForPersistence(window);
    const workspaceAfterEssentialsSave = await getWorkspace(window);
    await expectNoPendingReviewItemsForCurrentStep(window);
    await writeJson(
      "workspace-after-essentials-review.json",
      workspaceAfterEssentialsSave,
    );

    const backgroundStepSnapshot = await advanceSetupStep(window, "background");
    await writeJson(
      "workspace-after-advance-background.json",
      backgroundStepSnapshot,
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06-background-review.png"),
    });

    const backgroundSummaryField = await captureBackgroundEditJump(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06b-background-edit-jump.png"),
    });

    await backgroundSummaryField.fill(
      "Led design system modernization, improved release confidence across shared UI workflows, and partnered with product on rollout planning.",
    );
    await saveCurrentStepAndWaitForPersistence(window);

    await advanceSetupStep(window, "targeting");
    await captureBlockedSetupCopilotMutationGuard(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06c-targeting-copilot-guard.png"),
    });
    await writeJson(
      "workspace-after-blocked-setup-copilot-guard.json",
      await getWorkspace(window),
    );
    await minimizeProfileCopilotIfOpen(window);

    // Complete the same runnable-source requirement a first-time user sees.
    // Keep this public and synthetic so the audit never depends on a signed-in
    // account or private candidate data.
    await window
      .getByRole("button", { name: "Add source", exact: true })
      .click();
    await window
      .getByLabel("Source name", { exact: true })
      .last()
      .fill("Remote public jobs");
    await window
      .getByLabel("Careers or job-board URL", { exact: true })
      .last()
      .fill("https://job-boards.greenhouse.io/remotecom");

    await window
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await window
      .getByRole("status")
      .filter({ hasText: "Saved this step." })
      .last()
      .waitFor({
        state: "visible",
        timeout: 10000,
      });
    await resolveCurrentStepReviewItems(window);

    await advanceSetupStep(window, "extras");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "07-extras-step.png"),
    });

    await applyProfileCopilotRequest(
      window,
      "Update my professional story to: Product-focused frontend engineer who turns complex workflows into reliable systems.",
    );
    await resolveCurrentStepReviewItems(window);

    await window
      .locator("#profile-setup-field-answer-bank-availability")
      .fill("Available with two weeks notice.");
    await saveCurrentStepAndWaitForPersistence(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "08-extras-answers.png"),
    });

    await window
      .getByRole("button", { name: "Finish setup and find jobs", exact: true })
      .click();
    await waitForSetupStatus(window, "completed");
    // Finishing hands the user off to Find jobs, not back to the editor.
    await window
      .getByRole("heading", { level: 1, name: "Find jobs" })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "09-find-jobs-after-setup.png"),
    });

    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForSetupStatus(window, "completed");

    const workspace = await getWorkspace(window);
    await writeJson("workspace-after-profile-setup.json", workspace);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve original failure.
      }
    }

    await rm(userDataDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`Saved profile setup demo artifacts to ${outputDir}\n`);
}

void captureProfileSetup();
