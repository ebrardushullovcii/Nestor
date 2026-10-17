import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "resume-workspace";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

const LOCAL_PATH_KEYS = new Set([
  "approvedFilePath",
  "filePath",
  "storagePath",
]);

function safeFileName(filePath) {
  return path.posix.basename(path.win32.basename(filePath));
}

function sanitizeWorkspaceArtifact(value) {
  const localPaths = new Map();
  const collectLocalPaths = (current) => {
    if (Array.isArray(current)) {
      current.forEach(collectLocalPaths);
      return;
    }
    if (!current || typeof current !== "object") {
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (LOCAL_PATH_KEYS.has(key) && typeof entry === "string") {
        localPaths.set(entry, safeFileName(entry));
      } else {
        collectLocalPaths(entry);
      }
    }
  };
  collectLocalPaths(value);

  const sanitize = (current) => {
    if (Array.isArray(current)) {
      return current.map(sanitize);
    }
    if (typeof current === "string") {
      return [...localPaths.entries()]
        .sort(([left], [right]) => right.length - left.length)
        .reduce(
          (safeValue, [localPath, fileName]) =>
            safeValue.replaceAll(localPath, fileName),
          current,
        );
    }
    if (!current || typeof current !== "object") {
      return current;
    }
    return Object.fromEntries(
      Object.entries(current).flatMap(([key, entry]) =>
        LOCAL_PATH_KEYS.has(key) ? [] : [[key, sanitize(entry)]],
      ),
    );
  };

  return sanitize(value);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function encodeContractSegment(value) {
  return encodeURIComponent(value);
}

async function getResumeWorkspace(window, jobId) {
  return window.evaluate(
    async (currentJobId) =>
      window.nestor.jobFinder.getResumeWorkspace(currentJobId),
    jobId,
  );
}

async function getResumeAssistantMessages(window, jobId) {
  return window.evaluate(
    async (currentJobId) =>
      window.nestor.jobFinder.getResumeAssistantMessages(currentJobId),
    jobId,
  );
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

function getDraftSummaryText(workspace) {
  return (
    workspace.draft.sections.find((section) => section.kind === "summary")
      ?.text ?? ""
  );
}

function getPreviewExpectation(workspace) {
  const summarySection = workspace.draft.sections.find(
    (section) => section.kind === "summary",
  );
  const summaryText = summarySection?.text?.trim() ?? "";
  if (summarySection?.included && summaryText.length > 0) {
    return summaryText;
  }

  for (const section of workspace.draft.sections) {
    if (!section.included) {
      continue;
    }

    const sectionText = section.text?.trim();
    if (sectionText) {
      return sectionText;
    }

    for (const entry of section.entries) {
      if (!entry.included) {
        continue;
      }

      const entryText = [entry.title, entry.subtitle, entry.summary].find(
        (value) => typeof value === "string" && value.trim().length > 0,
      );
      if (entryText) {
        return entryText.trim();
      }

      const entryBulletText = entry.bullets.find(
        (bullet) => bullet.included && bullet.text.trim().length > 0,
      )?.text;
      if (entryBulletText) {
        return entryBulletText.trim();
      }
    }

    const sectionBulletText = section.bullets.find(
      (bullet) => bullet.included && bullet.text.trim().length > 0,
    )?.text;
    if (sectionBulletText) {
      return sectionBulletText.trim();
    }
  }

  return null;
}

function buildEntryFieldTarget(sectionId, entryId, field) {
  return [
    "entry",
    encodeContractSegment(sectionId),
    encodeContractSegment(entryId),
    encodeContractSegment(field),
  ].join(":");
}

function getEntryPreviewTarget(section, entry) {
  const fieldCandidates = [
    { field: "title", editorLabel: "Title", value: entry.title },
    { field: "subtitle", editorLabel: "Subtitle", value: entry.subtitle },
    { field: "summary", editorLabel: "Summary", value: entry.summary },
  ];

  for (const candidate of fieldCandidates) {
    const expectedValue = candidate.value?.trim();
    if (expectedValue) {
      return {
        sectionId: section.id,
        entryId: entry.id,
        targetId: buildEntryFieldTarget(section.id, entry.id, candidate.field),
        editorLabel: candidate.editorLabel,
        expectedValue,
      };
    }
  }

  const bullet = entry.bullets.find(
    (entryBullet) => entryBullet.included && entryBullet.text.trim().length > 0,
  );
  if (!bullet) {
    return null;
  }

  return {
    sectionId: section.id,
    entryId: entry.id,
    targetId: [
      "entry",
      encodeContractSegment(section.id),
      encodeContractSegment(entry.id),
      "bullet",
      encodeContractSegment(bullet.id),
    ].join(":"),
    editorLabel: "Bullet text",
    expectedValue: bullet.text.trim(),
  };
}

function getClickablePreviewTarget(workspace) {
  const targets = [];

  for (const section of workspace.draft.sections) {
    if (!section.included) {
      continue;
    }

    let entryTarget = null;
    for (const entry of section.entries) {
      if (!entry.included) {
        continue;
      }

      entryTarget = getEntryPreviewTarget(section, entry);
      if (entryTarget) {
        break;
      }
    }

    if (entryTarget) {
      targets.push(entryTarget);
      continue;
    }

    if (section.text?.trim()) {
      targets.push({
        sectionId: section.id,
        entryId: null,
        targetId: ["section", encodeContractSegment(section.id), "text"].join(
          ":",
        ),
        editorLabel: "Section text",
        expectedValue: section.text?.trim() ?? null,
      });
    }
  }

  return targets[1] ?? targets[0] ?? null;
}

function getExperienceSection(workspace) {
  return (
    workspace?.draft.sections.find(
      (section) => section.kind === "experience",
    ) ?? null
  );
}

function getExperienceEntries(workspace) {
  return getExperienceSection(workspace)?.entries ?? [];
}

function getExperienceEntryIds(workspace) {
  return getExperienceEntries(workspace).map((entry) => entry.id);
}

function getPreviewEntryOrder(html, entryIds) {
  return entryIds
    .map((entryId) => ({
      entryId,
      index: html.indexOf(`data-resume-entry-id="${entryId}"`),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.entryId);
}

function getLatestBy(items, getTimestamp) {
  if (!items?.length) {
    return null;
  }

  return (
    items
      .map((item, index) => {
        const parsedTimestamp = Date.parse(getTimestamp(item));

        return {
          item,
          index,
          timestamp: Number.isFinite(parsedTimestamp)
            ? parsedTimestamp
            : Number.NEGATIVE_INFINITY,
        };
      })
      .sort((left, right) => {
        const timestampDifference = right.timestamp - left.timestamp;
        return timestampDifference !== 0
          ? timestampDifference
          : right.index - left.index;
      })[0]?.item ?? null
  );
}

async function waitForProfileOrSetupHeading(window) {
  await window.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test),
    undefined,
    { timeout: 15000 },
  );
  await window.evaluate(() => {
    window.location.hash = "#/job-finder/profile";
  });
  const waitForHeading = () =>
    window.waitForFunction(
      () => {
        const heading = document.querySelector("h1");
        return /Your profile|Guided setup/.test(heading?.textContent ?? "");
      },
      undefined,
      { timeout: 15000 },
    );
  try {
    await waitForHeading();
  } catch (error) {
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15000 },
    );
    await window.evaluate(() => {
      window.location.hash = "#/job-finder/profile";
    });
    try {
      await waitForHeading();
      return;
    } catch {
      // Fall through to the detailed first-failure diagnostic below.
    }
    const pageState = await window.evaluate(() => ({
      hash: window.location.hash,
      headings: Array.from(document.querySelectorAll("h1")).map(
        (heading) => heading.textContent,
      ),
      bodyText: document.body.innerText.slice(0, 500),
    }));
    throw new Error(
      `Profile route did not become ready: ${JSON.stringify(pageState)}`,
      { cause: error },
    );
  }
}

function summaryField(window) {
  return editorFieldByTarget(window, "section:section_summary:text");
}

function editorFieldByTarget(window, targetId) {
  return window
    .locator(`[data-resume-editor-target="${targetId}"]:visible`)
    .first();
}

function assistantField(window) {
  return window
    .locator(
      '[data-resume-guided-edits-open="true"] textarea[aria-label="Message the Assistant"]:visible',
    )
    .first();
}

async function loadResumeWorkspaceDemo(window, previewMode = "ok") {
  const state = await window.evaluate(async (mode) => {
    if (!window.nestor.jobFinder.test) {
      throw new Error("Desktop test API is unavailable in the renderer.");
    }

    await window.nestor.jobFinder.test.setResumePreviewMode(mode);
    return window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
  }, previewMode);

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await waitForProfileOrSetupHeading(window);
  await window.setViewportSize({ width, height });

  return state;
}

async function openResumeWorkspace(window) {
  await window
    .getByRole("button", {
      name: /Edit resume|Open the resume|Review the resume/i,
    })
    .first()
    .click();
  await window
    .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
    .waitFor({ timeout: 10000 });
}

function visiblePreviewPane(window) {
  return window
    .locator("section:visible")
    .filter({
      has: window.getByText("Resume preview", { exact: true }),
    })
    .first();
}

function visiblePreviewFrame(window) {
  return window.locator('iframe[title="Live resume preview"]:visible').first();
}

async function getPreviewSrcdoc(window) {
  return visiblePreviewFrame(window).evaluate(
    (iframe) => iframe.getAttribute("srcdoc") ?? iframe.srcdoc ?? "",
  );
}

async function waitForPreviewFailure(window) {
  const previewPane = visiblePreviewPane(window);
  await previewPane
    .getByRole("heading", { name: "Preview unavailable" })
    .waitFor({ timeout: 10000 });
  await previewPane
    .locator("p:visible", {
      hasText: /^Preview rendering failed in desktop test mode\.$/,
    })
    .first()
    .waitFor({ timeout: 10000 });
}

async function waitForPreviewReady(window, options = {}) {
  const normalizedOptions = options ?? {};
  const expectedText =
    typeof normalizedOptions === "string"
      ? normalizedOptions
      : (normalizedOptions.expectedText ?? null);
  const changedFrom =
    typeof normalizedOptions === "string"
      ? null
      : (normalizedOptions.changedFrom ?? null);

  await visiblePreviewFrame(window).waitFor({ timeout: 10000 });
  await waitForCondition(
    async () => {
      let previewHtml;
      try {
        previewHtml = await getPreviewSrcdoc(window);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /detached|execution context was destroyed|target closed|frame was detached|context destroyed/i.test(
            message,
          )
        ) {
          return false;
        }

        throw error;
      }

      if (expectedText && !previewHtml.includes(expectedText)) {
        return false;
      }

      if (changedFrom !== null && previewHtml === changedFrom) {
        return false;
      }

      return previewHtml.length > 0;
    },
    expectedText && changedFrom !== null
      ? `resume preview to include '${expectedText}' after a fresh render`
      : expectedText
        ? `resume preview to include '${expectedText}'`
        : changedFrom !== null
          ? "fresh resume preview content"
          : "resume preview content",
  );
}

async function waitForSavedSummaryText(window, expectedText) {
  await waitForCondition(
    async () =>
      getDraftSummaryText(await getResumeWorkspace(window, "job_ready")) ===
      expectedText,
    `saved summary text '${expectedText}'`,
  );
}

async function getActiveEditorLabel(window) {
  return window.evaluate(() => {
    const activeElement = document.activeElement;

    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    return (
      activeElement.getAttribute("aria-label") ??
      activeElement.labels?.[0]?.textContent?.trim() ??
      null
    );
  });
}

async function getTemplateBadgeText(window) {
  const selectedTemplateLabel = await window
    .locator("[data-resume-template-toggle]:visible")
    .first()
    .locator("xpath=ancestor::section[1]")
    .locator("span.text-sm.font-semibold")
    .first()
    .textContent();

  return selectedTemplateLabel?.trim() ?? null;
}

function templateStrategyPanel(window) {
  return window
    .locator(
      "[data-resume-template-toggle]:visible, [data-resume-template-option]:visible",
    )
    .first()
    .locator("xpath=ancestor::section[1]");
}

async function clickLocatorViaDom(locator, description) {
  try {
    await locator.waitFor({ timeout: 10000 });
    await locator.click();
  } catch (error) {
    throw new Error(
      `Could not click ${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function clickShellNavigationWithMouse(window, name) {
  const navigation = window.locator(
    'nav[aria-label="Job Finder sections"]:visible, nav[aria-label="Job Finder sidebar destinations"]:visible',
  );
  const control = navigation.getByRole("button", { name }).first();
  await control.waitFor({ state: "visible", timeout: 10_000 });
  await control.evaluate((element) => element.click());
}

async function clickTemplateStrategyVariant(window, variantLabel, buttonText) {
  const strategySection = templateStrategyPanel(window);
  const variantCard = strategySection
    .locator("[data-resume-template-option]")
    .filter({ hasText: variantLabel })
    .first();
  const button = variantCard.locator("[data-resume-template-select]").first();

  await clickLocatorViaDom(
    button,
    `button '${buttonText}' for template variant '${variantLabel}'`,
  );
}

async function captureResumeWorkspace() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-workspace-"),
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
        NESTOR_TEST_SYSTEM_THEME:
          process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15_000 },
    );
    await window.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");
    await waitForProfileOrSetupHeading(window);
    await window.setViewportSize({ width, height });

    await loadResumeWorkspaceDemo(window, "fail_once");

    const studioResults = {};

    await clickShellNavigationWithMouse(window, /^Shortlisted/);
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-review-queue.png"),
    });

    await window.getByText(/Company site:/).waitFor({ timeout: 10000 });

    await openResumeWorkspace(window);
    await waitForPreviewFailure(window);
    const initialWorkspace = await getResumeWorkspace(window, "job_ready");
    const initialPreviewExpectation = getPreviewExpectation(initialWorkspace);
    const previewFailureMessage = await visiblePreviewPane(window)
      .locator("p:visible", {
        hasText: /^Preview rendering failed in desktop test mode\.$/,
      })
      .first()
      .textContent();
    const failureEditorVisible = await summaryField(window).isVisible();
    assert(
      failureEditorVisible,
      "Editing should remain available while preview rendering fails.",
    );
    Object.assign(studioResults, {
      previewFailure: {
        editorStillAvailable: failureEditorVisible,
        message: previewFailureMessage,
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-preview-failure.png"),
    });

    await window.getByRole("button", { name: "Refresh preview" }).click();
    await waitForPreviewReady(window, initialPreviewExpectation);
    Object.assign(studioResults, {
      previewRecovery: {
        expectedText: initialPreviewExpectation,
        previewStatus: await visiblePreviewPane(window)
          .locator("span:visible", {
            hasText: /^(Saved draft rendered|Unsaved edits rendered)$/,
          })
          .first()
          .textContent(),
        previewContainsExpectedText: initialPreviewExpectation
          ? (await getPreviewSrcdoc(window)).includes(initialPreviewExpectation)
          : (await getPreviewSrcdoc(window)).length > 0,
      },
    });
    const recoveredWorkspace = await getResumeWorkspace(window, "job_ready");
    const recoveredExperienceSection = getExperienceSection(recoveredWorkspace);
    const recoveredExperienceEntries = getExperienceEntries(recoveredWorkspace);
    const recoveredEntryIds = getExperienceEntryIds(recoveredWorkspace);
    const recoveredPreviewHtml = await getPreviewSrcdoc(window);
    const expectedRecoveredProfileOrder = [
      "experience_1",
      "experience_coreledger_recent",
      "experience_coreledger_older",
    ];
    assert(
      expectedRecoveredProfileOrder.every(
        (profileRecordId, index) =>
          recoveredExperienceEntries[index]?.profileRecordId ===
          profileRecordId,
      ),
      `Expected corrected experience profile order ${expectedRecoveredProfileOrder.join(", ")}, got ${recoveredExperienceEntries.map((entry) => entry.profileRecordId ?? entry.id).join(", ")}.`,
    );
    const expectedRecoveredEntryIds = recoveredExperienceEntries
      .slice(0, expectedRecoveredProfileOrder.length)
      .map((entry) => entry.id);
    assert(
      JSON.stringify(
        getPreviewEntryOrder(recoveredPreviewHtml, expectedRecoveredEntryIds),
      ) === JSON.stringify(expectedRecoveredEntryIds),
      "Preview should render experience entries in the same corrected chronological order as the editor.",
    );
    Object.assign(studioResults, {
      experienceOrdering: {
        initialMode: recoveredExperienceSection?.entryOrderMode ?? null,
        editorOrder: recoveredEntryIds,
        editorProfileOrder: recoveredExperienceEntries.map(
          (entry) => entry.profileRecordId ?? null,
        ),
        previewOrder: getPreviewEntryOrder(
          recoveredPreviewHtml,
          expectedRecoveredEntryIds,
        ),
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-preview-recovered.png"),
    });

    const resumeProofDetails = window
      .locator("details")
      .filter({ hasText: /Resume proof details/ })
      .first();
    await resumeProofDetails.locator(":scope > summary").click();
    await window
      .getByText("Saved research", { exact: true })
      .first()
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-resume-workspace-sources.png"),
    });

    await window.getByText("Template", { exact: true }).first().waitFor({
      timeout: 10000,
    });
    const changeTemplateButton = window.getByRole("button", {
      name: "Change template",
    });
    if (await changeTemplateButton.isVisible()) {
      await changeTemplateButton.click();
    }
    const recommendedTemplateLabels = await templateStrategyPanel(window)
      .locator('[data-slot="badge"]')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.textContent?.trim() ?? "")
          .filter((label) => label.includes("Recommended")),
      );
    Object.assign(studioResults, {
      catalogRecommendations: {
        recommendationBadges: recommendedTemplateLabels,
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04a-template-strategy-default.png"),
    });

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04b-template-strategy-options.png"),
    });

    const preTemplatePreviewSrcdoc = await getPreviewSrcdoc(window);
    await clickTemplateStrategyVariant(
      window,
      "Engineering Spec · Technical Brief",
      "Use template",
    );
    await waitForCondition(
      async () =>
        window
          .getByText("Engineering Spec · Technical Brief", { exact: true })
          .first()
          .isVisible(),
      "template header badge to reflect the recommended template selection",
    );
    await waitForPreviewReady(window, {
      changedFrom: preTemplatePreviewSrcdoc,
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04c-template-selected-engineering-spec.png"),
    });

    const savedSummaryBeforePreviewEdit = getDraftSummaryText(
      await getResumeWorkspace(window, "job_ready"),
    );
    const unsavedPreviewSentinel = savedSummaryBeforePreviewEdit.endsWith(".")
      ? savedSummaryBeforePreviewEdit.slice(0, -1)
      : `${savedSummaryBeforePreviewEdit}.`;
    await summaryField(window).fill(unsavedPreviewSentinel);
    await visiblePreviewPane(window)
      .locator("span:visible", { hasText: /^Unsaved edits rendered$/ })
      .first()
      .waitFor({ timeout: 10000 });
    await waitForPreviewReady(window, unsavedPreviewSentinel);
    const unsavedWorkspace = await getResumeWorkspace(window, "job_ready");
    assert(
      getDraftSummaryText(unsavedWorkspace) !== unsavedPreviewSentinel,
      "Unsaved preview text should not persist to the saved draft before saving.",
    );
    Object.assign(studioResults, {
      unsavedPreview: {
        fieldValue: await summaryField(window).inputValue(),
        previewContainsSentinel: (await getPreviewSrcdoc(window)).includes(
          unsavedPreviewSentinel,
        ),
        savedSummaryText: getDraftSummaryText(unsavedWorkspace),
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-unsaved-live-preview.png"),
    });

    const clickTarget = getClickablePreviewTarget(
      await getResumeWorkspace(window, "job_ready"),
    );
    assert(
      clickTarget,
      "Expected a clickable preview target in the resume workspace demo.",
    );
    const previewFrame = window.frameLocator(
      'iframe[title="Live resume preview"]:visible',
    );
    const previewTargetLocator = previewFrame
      .locator(`[data-resume-target-id="${clickTarget.targetId}"]`)
      .first();
    await previewTargetLocator.waitFor({ timeout: 10000 });
    await previewTargetLocator.click();

    await waitForCondition(
      async () =>
        previewTargetLocator.evaluate(
          (element) => element.getAttribute("data-resume-selected") === "true",
        ),
      "clicked preview target to become selected",
    );

    const clickToFocusMessage =
      clickTarget.editorLabel === "Title"
        ? "entry title input focus after clicking the live preview"
        : "section text input focus after clicking the live preview";
    try {
      await waitForCondition(
        async () =>
          editorFieldByTarget(window, clickTarget.targetId).evaluate(
            (element, expectedValue) =>
              element === element.ownerDocument.activeElement &&
              element.value === expectedValue,
            clickTarget.expectedValue,
          ),
        clickToFocusMessage,
      );
    } catch (error) {
      await writeJson("preview-click-focus-failure.json", {
        clickTarget,
        editorField: await editorFieldByTarget(
          window,
          clickTarget.targetId,
        ).evaluate((element) => ({
          activeElementTagName:
            element.ownerDocument.activeElement?.tagName ?? null,
          activeElementTarget:
            element.ownerDocument.activeElement?.getAttribute(
              "data-resume-editor-target",
            ) ?? null,
          editorTarget: element.getAttribute("data-resume-editor-target"),
          editorValue: element.value,
          isActiveElement: element === element.ownerDocument.activeElement,
        })),
      });
      throw error;
    }

    Object.assign(studioResults, {
      clickToFocus: {
        target: clickTarget,
        activeEditorLabel: await getActiveEditorLabel(window),
        focusedValue: await editorFieldByTarget(
          window,
          clickTarget.targetId,
        ).inputValue(),
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06-preview-click-focus.png"),
    });

    const beforeManualOrderWorkspace = await getResumeWorkspace(
      window,
      "job_ready",
    );
    const beforeManualOrderEntries = getExperienceEntries(
      beforeManualOrderWorkspace,
    );
    const beforeManualOrder = getExperienceEntryIds(beforeManualOrderWorkspace);
    const beforeManualPreviewHtml = await getPreviewSrcdoc(window);
    const currentRoleEntryId = beforeManualOrderEntries.find(
      (entry) => entry.profileRecordId === "experience_1",
    )?.id;
    const recentCoreLedgerEntryId = beforeManualOrderEntries.find(
      (entry) => entry.profileRecordId === "experience_coreledger_recent",
    )?.id;
    assert(
      currentRoleEntryId && recentCoreLedgerEntryId,
      "Resume workspace demo must expose current and recent CoreLedger entries for ordering controls.",
    );
    const currentRoleTitleTarget = `entry:section_experience:${currentRoleEntryId}:title`;
    await window
      .locator(`[data-resume-editor-target="${currentRoleTitleTarget}"]`)
      .first()
      .evaluate((input) => {
        const article = input.closest("article");
        const buttons = Array.from(article?.querySelectorAll("button") ?? []);
        const moveDownButton = buttons.find((button) => {
          const label = button.getAttribute("aria-label")?.toLowerCase() ?? "";
          return label.startsWith("move ") && label.endsWith(" down");
        });

        if (!(moveDownButton instanceof HTMLButtonElement)) {
          throw new Error(
            "Unable to find Move entry down button for the current role card.",
          );
        }

        moveDownButton.click();
      });
    await waitForCondition(async () => {
      const workspace = await getResumeWorkspace(window, "job_ready");
      const order = getExperienceEntryIds(workspace);
      return (
        getExperienceSection(workspace)?.entryOrderMode === "manual" &&
        order[0] === recentCoreLedgerEntryId &&
        order[1] === currentRoleEntryId
      );
    }, "manual experience entry reorder to persist");
    await waitForPreviewReady(window, { changedFrom: beforeManualPreviewHtml });
    const manualOrderWorkspace = await getResumeWorkspace(window, "job_ready");
    const manualOrder = getExperienceEntryIds(manualOrderWorkspace);
    const manualPreviewHtml = await getPreviewSrcdoc(window);
    assert(
      getExperienceSection(manualOrderWorkspace)?.entryOrderMode === "manual",
      "Expected persisted workspace to enter manual order after moving an experience entry.",
    );
    await window
      .getByRole("button", { name: "Reset to chronology" })
      .evaluateAll((buttons) => {
        const resetButton = buttons.find(
          (button) => button instanceof HTMLButtonElement && !button.disabled,
        );

        if (!(resetButton instanceof HTMLButtonElement)) {
          throw new Error("Unable to find enabled Reset to chronology button.");
        }

        resetButton.click();
      });
    await window
      .locator("[data-resume-workspace-scroll-region]:visible")
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    let lastResetWorkspace = null;
    await waitForCondition(
      async () => {
        const workspace = await getResumeWorkspace(window, "job_ready");
        lastResetWorkspace = workspace;
        return (
          getExperienceSection(workspace)?.entryOrderMode === "chronology" &&
          JSON.stringify(getExperienceEntryIds(workspace)) ===
            JSON.stringify(beforeManualOrder)
        );
      },
      `experience entry order reset to chronology from ${JSON.stringify({
        beforeManualOrder,
        manualOrder,
        lastMode:
          getExperienceSection(lastResetWorkspace)?.entryOrderMode ?? null,
        lastOrder: lastResetWorkspace
          ? getExperienceEntryIds(lastResetWorkspace)
          : [],
      })}`,
    );
    const resetOrderWorkspace = await getResumeWorkspace(window, "job_ready");
    let resetPreviewOrder = [];
    await waitForCondition(async () => {
      const resetPreviewHtml = await getPreviewSrcdoc(window);
      resetPreviewOrder = getPreviewEntryOrder(
        resetPreviewHtml,
        beforeManualOrder,
      );
      return (
        JSON.stringify(resetPreviewOrder) ===
        JSON.stringify(getExperienceEntryIds(resetOrderWorkspace))
      );
    }, "visible reset preview order to match reset editor order");
    assert(
      JSON.stringify(resetPreviewOrder) ===
        JSON.stringify(getExperienceEntryIds(resetOrderWorkspace)),
      `Expected reset preview order to match reset editor order, got ${resetPreviewOrder.join(", ")} versus ${getExperienceEntryIds(resetOrderWorkspace).join(", ")}.`,
    );
    Object.assign(studioResults, {
      experienceOrdering: {
        ...(studioResults.experienceOrdering ?? {}),
        manualOrder,
        manualMode:
          getExperienceSection(manualOrderWorkspace)?.entryOrderMode ?? null,
        manualPreviewOrder: getPreviewEntryOrder(
          manualPreviewHtml,
          manualOrder,
        ),
        resetOrder: getExperienceEntryIds(resetOrderWorkspace),
        resetMode:
          getExperienceSection(resetOrderWorkspace)?.entryOrderMode ?? null,
        resetPreviewOrder,
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06a-experience-order-controls.png"),
    });

    await window.getByRole("button", { name: "Save draft" }).click();
    await waitForSavedSummaryText(window, unsavedPreviewSentinel);
    await waitForPreviewReady(window, unsavedPreviewSentinel);
    await visiblePreviewPane(window)
      .locator("span:visible", { hasText: /^Saved draft rendered$/ })
      .first()
      .waitFor({ timeout: 10000 });
    Object.assign(studioResults, {
      savedDraft: {
        savedSummaryText: getDraftSummaryText(
          await getResumeWorkspace(window, "job_ready"),
        ),
        selectedTemplateBadge: await getTemplateBadgeText(window),
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "07-after-manual-edit.png"),
    });

    const assistantDraftBefore = await getResumeWorkspace(window, "job_ready");
    const previousMessageCount = (
      await getResumeAssistantMessages(window, "job_ready")
    ).length;
    await window.getByRole("button", { name: /^Open the Assistant/ }).click();
    await waitForCondition(
      async () =>
        await window
          .locator('[data-resume-guided-edits-open="true"]')
          .first()
          .isVisible(),
      "the Assistant panel to open",
    );
    await assistantField(window).fill(
      "Shorten the summary for ATS readability.",
    );
    await window.getByRole("button", { name: "Send message" }).click();
    await waitForCondition(
      async () => {
        const messages = await getResumeAssistantMessages(window, "job_ready");
        const lastAssistant = [...messages]
          .reverse()
          .find((message) => message.role === "assistant");
        return (
          messages.length > previousMessageCount &&
          lastAssistant?.role === "assistant" &&
          lastAssistant.content.trim().length > 0 &&
          lastAssistant.content !== "Updating your draft..."
        );
      },
      "assistant reply in resume workspace demo",
      60_000,
    );
    const proposedMessages = await getResumeAssistantMessages(
      window,
      "job_ready",
    );
    const pendingProposal = [...proposedMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.proposalStatus === "pending",
      );
    assert(
      pendingProposal?.patches.length > 0,
      "Expected the Assistant to create a pending proposal with at least one patch.",
    );
    const assistantDraftProposed = await getResumeWorkspace(
      window,
      "job_ready",
    );
    assert(
      JSON.stringify(assistantDraftProposed.draft) ===
        JSON.stringify(assistantDraftBefore.draft),
      "The Assistant changed the saved draft before the user approved its proposal.",
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "08-assistant-proposal.png"),
    });

    const assistantDialog = window.getByRole("dialog", {
      name: /^Assistant$/,
    });
    await assistantDialog
      .getByRole("button", { name: /Accept selected \(\d+\)/i })
      .click();
    await waitForCondition(async () => {
      const messages = await getResumeAssistantMessages(window, "job_ready");
      return messages.some(
        (message) =>
          message.id === pendingProposal.id &&
          message.proposalStatus === "accepted" &&
          message.resolvedPatchIds.length > 0,
      );
    }, "explicit acceptance of the Assistant proposal");
    const assistantDraftAccepted = await getResumeWorkspace(
      window,
      "job_ready",
    );
    assert(
      JSON.stringify(assistantDraftAccepted.draft) !==
        JSON.stringify(assistantDraftBefore.draft),
      "The saved draft did not change after the user approved the Assistant proposal.",
    );
    Object.assign(studioResults, {
      guidedEditsProposal: {
        draftUnchangedBeforeApproval: true,
        proposalId: pendingProposal.id,
        proposedPatchCount: pendingProposal.patches.length,
        acceptedPatchCount: (
          await getResumeAssistantMessages(window, "job_ready")
        ).find((message) => message.id === pendingProposal.id)?.resolvedPatchIds
          .length,
      },
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "08b-assistant-approved.png"),
    });

    await window.getByRole("button", { name: "Export PDF" }).click();
    await waitForCondition(
      async () =>
        (await getResumeWorkspace(window, "job_ready")).exports.length > 0,
      "resume export in demo flow",
    );
    const exportedWorkspace = await getResumeWorkspace(window, "job_ready");
    const latestExport = [...exportedWorkspace.exports].sort((left, right) =>
      right.exportedAt.localeCompare(left.exportedAt),
    )[0];
    assert(
      latestExport,
      "Expected the exported resume artifact to be available.",
    );
    await copyFile(
      latestExport.filePath,
      path.join(outputDir, "09-exported-resume.pdf"),
    );
    await writeJson("09-exported-resume.json", {
      format: latestExport.format,
      isApproved: latestExport.isApproved,
      pageCount: latestExport.pageCount,
      sha256: latestExport.sha256 ?? null,
      templateId: latestExport.templateId,
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "09-after-export.png"),
    });

    await window.getByRole("button", { name: /Back to Shortlisted/i }).click();
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    const gatedPrepareButtons = window.getByRole("button", {
      name: /^Prepare application/,
    });
    const enabledPrepareButtonCount = await gatedPrepareButtons.evaluateAll(
      (buttons) =>
        buttons.filter(
          (button) => button instanceof HTMLButtonElement && !button.disabled,
        ).length,
    );
    if (enabledPrepareButtonCount > 0) {
      throw new Error(
        "Prepare application should stay unavailable before resume approval.",
      );
    }
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "10-review-queue-gated.png"),
    });

    await openResumeWorkspace(window);
    const reopenedWorkspace = await getResumeWorkspace(window, "job_ready");
    await waitForPreviewReady(window, getPreviewExpectation(reopenedWorkspace));

    const approveButton = window.getByRole("button", {
      name: /Approve (?:this|current) PDF/,
    });
    await approveButton.waitFor({ timeout: 10000 });
    await approveButton.click();
    await waitForCondition(async () => {
      const workspace = await getResumeWorkspace(window, "job_ready");
      return (
        workspace.exports.some((entry) => entry.isApproved) &&
        workspace.draft.status === "approved"
      );
    }, "approved resume export in demo flow");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "11-after-approval.png"),
    });

    await window.getByRole("button", { name: /Back to Shortlisted/i }).click();
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    const readyApproveButton = window
      .getByRole("button", {
        name: /^Prepare application/,
      })
      .first();
    if (await readyApproveButton.isDisabled()) {
      throw new Error(
        "Prepare application should be enabled after resume approval.",
      );
    }
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "12-review-queue-approved.png"),
    });

    await readyApproveButton.click();
    const checkpointDialog = window.getByRole("dialog");
    await checkpointDialog.waitFor({ timeout: 10000 });
    await checkpointDialog
      .getByRole("button", { name: "Prepare application", exact: true })
      .click();
    await waitForCondition(async () => {
      const currentWorkspace = await getWorkspace(window);
      return currentWorkspace.applicationRecords.length > 0;
    }, "application record created by the prepare-only run");
    await window.evaluate(() => {
      window.location.hash = "#/job-finder/applications";
    });
    try {
      await window
        .locator("h1")
        .filter({ hasText: /^Applications$/ })
        .waitFor({ timeout: 10000 });
    } catch (error) {
      const pageState = await window.evaluate(() => ({
        hash: window.location.hash,
        headings: Array.from(document.querySelectorAll("h1")).map(
          (heading) => heading.textContent,
        ),
        bodyText: document.body.innerText.slice(0, 750),
      }));
      throw new Error(
        `Applications route did not become ready: ${JSON.stringify(pageState)}`,
        { cause: error },
      );
    }
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "13-applications-after-apply.png"),
    });

    await window
      .getByText("Apply run review data", { exact: true })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "14-applications-after-copilot.png"),
    });

    const workspace = await getWorkspace(window);
    const latestAttempt = getLatestBy(
      workspace.applicationAttempts,
      (attempt) => attempt.updatedAt,
    );
    const applicationSummary = {
      latestAttemptState: latestAttempt?.state ?? null,
      latestAttemptOutcome: latestAttempt?.outcome ?? null,
    };

    if (applicationSummary.latestAttemptState !== "paused") {
      throw new Error(
        `Apply copilot should pause before submit, got '${applicationSummary.latestAttemptState ?? "null"}'.`,
      );
    }

    if (applicationSummary.latestAttemptOutcome !== null) {
      throw new Error("Apply copilot should not record a submitted outcome.");
    }

    await writeJson("studio-preview-results.json", studioResults);
    await writeJson(
      "workspace-after-demo.json",
      sanitizeWorkspaceArtifact(workspace),
    );
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure while still cleaning up the temp profile.
      }
    }
    try {
      await rm(userDataDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original failure while still cleaning up the temp profile.
    }
  }

  process.stdout.write(
    `Saved resume workspace demo artifacts to ${outputDir}\n`,
  );
}

void captureResumeWorkspace();
