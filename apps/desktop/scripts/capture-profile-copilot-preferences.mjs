import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "profile-copilot-preferences";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const snapshotPath = path.resolve(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-copilot-preferences-workspace.json",
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

async function captureProfileCopilotReviewDiagnostics(window) {
  const diagnostics = await window.evaluate(() => {
    const describeElement = (element) => {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        tagName: element.tagName,
        text: element.textContent?.trim().slice(0, 240) ?? "",
        className: element.className,
        rect: {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        overflow: style.overflow,
        overflowY: style.overflowY,
        position: style.position,
        zIndex: style.zIndex,
        disabled:
          element instanceof HTMLButtonElement ? element.disabled : false,
      };
    };

    const reviewSection = document.querySelector(
      '[data-profile-copilot-review-actions="true"]',
    );
    const panel = document.querySelector('[data-profile-copilot-panel="true"]');
    const content = document.querySelector(
      '[data-profile-copilot-content="true"]',
    );
    const transcript = document.querySelector(
      '[data-profile-copilot-transcript="true"]',
    );
    const composerFooter = document.querySelector(
      '[data-profile-copilot-composer-footer="true"]',
    );
    const applyButtons = Array.from(
      document.querySelectorAll('button[aria-label^="Apply changes"]'),
    );
    const firstButton = applyButtons[0] ?? null;
    const firstButtonRect = firstButton?.getBoundingClientRect();
    const hitTest = firstButtonRect
      ? document.elementsFromPoint(
          firstButtonRect.left + firstButtonRect.width / 2,
          firstButtonRect.top + firstButtonRect.height / 2,
        )
      : [];

    return {
      viewport: { height: window.innerHeight, width: window.innerWidth },
      reviewSection: describeElement(reviewSection),
      panel: describeElement(panel),
      content: describeElement(content),
      transcript: {
        ...describeElement(transcript),
        scrollHeight: transcript?.scrollHeight ?? null,
        scrollTop: transcript?.scrollTop ?? null,
        clientHeight: transcript?.clientHeight ?? null,
      },
      composerFooter: describeElement(composerFooter),
      applyButtons: applyButtons.map(describeElement),
      hitTest: hitTest.slice(0, 8).map(describeElement),
    };
  });

  await writeJson("02-review-action-diagnostics.json", diagnostics);
  await window.screenshot({
    animations: "disabled",
    path: path.join(outputDir, "02-review-action-diagnostics.png"),
  });
}

async function addListEditorValue(window, inputSelector, value) {
  const input = window.locator(inputSelector);
  await input.fill(value);
  await input.press("Enter");
}

async function clickProfileNavigation(window) {
  const navPatterns = [/^Profile$/, /Your profile/i];

  for (const pattern of navPatterns) {
    const button = window.getByRole("button", { name: pattern }).first();

    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return true;
    }
  }

  const fallbackButton = window
    .locator("button")
    .filter({ hasText: "Profile" })
    .first();
  if (await fallbackButton.isVisible().catch(() => false)) {
    await fallbackButton.click();
    return true;
  }

  return false;
}

async function clickProfilePreferencesTab(window) {
  const tabPatterns = [/^Preferences$/, /Preferences/i];

  for (const pattern of tabPatterns) {
    const tab = window.getByRole("tab", { name: pattern }).first();

    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      return;
    }
  }

  const fallbackTab = window
    .locator('[role="tab"]')
    .filter({ hasText: "Preferences" })
    .first();
  await fallbackTab.click();
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

async function applyProfileCopilotRequest(window, request, options = {}) {
  const { autoApplyReview = true, verifyDraftWhilePendingText = null } =
    options;
  const workspaceBefore = await getWorkspace(window);
  const previousMessageCount = workspaceBefore.profileCopilotMessages.length;
  const previousRevisionCount = workspaceBefore.profileRevisions.length;
  const requestField = await ensureProfileCopilotOpen(window);

  await requestField.fill(request);
  await window
    .getByRole("button", { name: "Send message", exact: true })
    .click();

  if (verifyDraftWhilePendingText) {
    await requestField.fill(verifyDraftWhilePendingText);
    const pendingDraft = await requestField.inputValue();

    if (pendingDraft !== verifyDraftWhilePendingText) {
      throw new Error(
        "Expected the profile copilot composer to stay editable while the assistant reply was pending.",
      );
    }
  }

  await waitForCondition(
    async () => {
      const workspace = await getWorkspace(window);
      return workspace.profileCopilotMessages.length > previousMessageCount;
    },
    "profile copilot assistant reply",
    60_000,
  );

  if (verifyDraftWhilePendingText) {
    await requestField.fill("");
  }

  const workspaceAfterReply = await getWorkspace(window);
  const latestAssistantMessage = [...workspaceAfterReply.profileCopilotMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  for (const patchGroup of latestAssistantMessage?.patchGroups ?? []) {
    if (autoApplyReview && patchGroup.applyMode === "needs_review") {
      const applyButton = window
        .getByRole("button", { name: /^Apply changes(?::|$)/ })
        .first();

      try {
        await applyButton.click();
      } catch (error) {
        await captureProfileCopilotReviewDiagnostics(window);
        throw error;
      }
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

async function captureBlockedProfileCopilotMutationGuard(window) {
  await applyProfileCopilotRequest(
    window,
    "my prefered work mode should be remote",
    { autoApplyReview: false },
  );

  const workspaceWithNeedsReviewPatch = await getWorkspace(window);
  const reviewPatchGroupPresent =
    workspaceWithNeedsReviewPatch.profileCopilotMessages.some(
      (message) =>
        message.context.surface === "profile" &&
        message.context.section === "preferences" &&
        message.patchGroups.some(
          (patchGroup) => patchGroup.applyMode === "needs_review",
        ),
    );

  if (!reviewPatchGroupPresent) {
    throw new Error(
      "Expected the full Profile copilot to produce a needs_review patch group before verifying the blocked mutation guard.",
    );
  }

  await addListEditorValue(
    window,
    "#profile-setup-field-search-preferences-target-roles",
    "Platform Engineering Lead",
  );

  const sendButton = window.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  if (!(await sendButton.isDisabled())) {
    throw new Error(
      "Expected full Profile copilot send to stay disabled while the page has unsaved user edits.",
    );
  }

  await window
    .getByText(
      "Save this page before applying, rejecting, or undoing copilot changes so your current profile draft stays intact.",
      { exact: true },
    )
    .first()
    .waitFor({ timeout: 10000 });

  const applyChangesButton = window
    .getByRole("button", { name: /^Apply changes(?::|$)/ })
    .first();
  await applyChangesButton.waitFor({ state: "visible", timeout: 10000 });
  if (!(await applyChangesButton.isDisabled())) {
    throw new Error(
      "Expected full Profile copilot apply action to stay disabled while the page has unsaved user edits.",
    );
  }

  const rejectButton = window
    .getByRole("button", { name: /^Reject(?: changes:|$)/ })
    .first();
  if (!(await rejectButton.isDisabled())) {
    throw new Error(
      "Expected full Profile copilot reject action to stay disabled while the page has unsaved user edits.",
    );
  }

  const showRecentChangesButton = window
    .getByRole("button", { name: "Show", exact: false })
    .first();
  if (await showRecentChangesButton.isVisible().catch(() => false)) {
    await showRecentChangesButton.click();
  }

  const undoButton = window
    .getByRole("button", { name: "Undo", exact: true })
    .first();
  await undoButton.waitFor({ state: "visible", timeout: 10000 });
  if (!(await undoButton.isDisabled())) {
    throw new Error(
      "Expected full Profile copilot undo to stay disabled while the page has unsaved user edits.",
    );
  }

  const workspaceAfter = await getWorkspace(window);
  const buildGuardComparableState = (workspace) =>
    JSON.stringify({
      targetRoles: workspace.searchPreferences.targetRoles,
      workModes: workspace.searchPreferences.workModes,
      remoteEligible: workspace.profile.workEligibility.remoteEligible,
      revisionIds: workspace.profileRevisions.map((revision) => revision.id),
      latestPreferencesAssistantMessage:
        [...workspace.profileCopilotMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.context.surface === "profile" &&
              message.context.section === "preferences",
          ) ?? null,
    });
  const mutationBefore = buildGuardComparableState(
    workspaceWithNeedsReviewPatch,
  );
  const mutationAfter = buildGuardComparableState(workspaceAfter);

  if (mutationBefore !== mutationAfter) {
    throw new Error(
      "Full Profile copilot guard should not mutate the saved workspace while unsaved page edits are blocking actions.",
    );
  }
}

async function captureMarkdownTranscriptPreview(window) {
  const workspace = await getWorkspace(window);
  const markdownContext = { surface: "profile", section: "preferences" };
  const markdownWorkspace = {
    ...workspace,
    profileCopilotMessages: [
      {
        id: "profile_copilot_markdown_user",
        role: "user",
        content: "Show me a polished suggestion for these preference updates.",
        context: markdownContext,
        patchGroups: [],
        createdAt: "2026-04-15T16:20:00.000Z",
      },
      {
        id: "profile_copilot_markdown_assistant",
        role: "assistant",
        content: [
          "## Recommended next move",
          "",
          "- Prefer **remote-first** targets",
          "- Add `LinkedIn Jobs` to your saved sources",
          "- Keep salary expectations in `USD` for broader job-board compatibility",
          "",
          "> Review any broader location rewrite before applying it so your current targeting stays intentional.",
          "",
          "```json",
          "{",
          '  "applyMode": "needs_review"',
          "}",
          "```",
        ].join("\n"),
        context: markdownContext,
        patchGroups: [],
        createdAt: "2026-04-15T16:20:05.000Z",
      },
    ],
    profileRevisions: [],
  };

  await window.evaluate(async (workspaceState) => {
    if (!window.nestor.jobFinder.test) {
      throw new Error(
        "Desktop test API is not available in the renderer context.",
      );
    }

    return window.nestor.jobFinder.test.resetWorkspaceState(workspaceState);
  }, markdownWorkspace);

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window
    .getByRole("heading", { level: 1, name: "Your profile" })
    .waitFor({ timeout: 10000 });
  await clickProfilePreferencesTab(window);
  await window
    .getByText("Job sources", { exact: true })
    .waitFor({ timeout: 10000 });
  await ensureProfileCopilotOpen(window);
  await window
    .getByRole("heading", { level: 3, name: "Recommended next move" })
    .waitFor({ timeout: 10000 });
}

async function captureProfileCopilotPreferences() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-profile-copilot-preferences-"),
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
    await window.setViewportSize({ width, height });

    const state = JSON.parse(await readFile(snapshotPath, "utf8"));
    await window.evaluate(async (workspaceState) => {
      if (!window.nestor.jobFinder.test) {
        throw new Error(
          "Desktop test API is not available in the renderer context.",
        );
      }

      return window.nestor.jobFinder.test.resetWorkspaceState(workspaceState);
    }, state);

    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => {
      window.location.hash = "#/job-finder/profile";
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
    if (initialHeading !== "Your profile") {
      const navigatedToProfile = await clickProfileNavigation(window);
      if (!navigatedToProfile) {
        throw new Error(
          "Could not find a visible Profile navigation control after loading the seeded workspace.",
        );
      }
      await window
        .getByRole("heading", { level: 1, name: "Your profile" })
        .waitFor({ timeout: 10000 });
    }

    await clickProfilePreferencesTab(window);
    await window
      .getByText("Job sources", { exact: true })
      .waitFor({ timeout: 10000 });

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-preferences-before.png"),
    });

    await applyProfileCopilotRequest(
      window,
      "add a few job sources for me like linkedin and wellfound",
      {
        verifyDraftWhilePendingText:
          "Draft the next preferences tweak while Copilot finishes this one.",
      },
    );

    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      const targets = workspace.searchPreferences.discovery.targets;
      return (
        targets.some((target) => target.label === "LinkedIn Jobs") &&
        targets.some((target) => target.label === "Wellfound")
      );
    }, "job sources to be added by profile copilot");

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-preferences-after-copilot.png"),
    });

    await captureBlockedProfileCopilotMutationGuard(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-preferences-copilot-guard.png"),
    });
    await writeJson(
      "workspace-after-blocked-profile-copilot-guard.json",
      await getWorkspace(window),
    );

    const hideButton = window.getByRole("button", {
      name: "Hide",
      exact: true,
    });
    if (!(await hideButton.isVisible().catch(() => false))) {
      const showButton = window.getByRole("button", {
        name: "Show",
        exact: true,
      });
      await showButton.waitFor({ state: "visible", timeout: 10000 });
      await showButton.click();
    }
    await hideButton.waitFor({ state: "visible", timeout: 10000 });
    await hideButton.click();

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-preferences-hidden-recent-changes.png"),
    });
    await writeJson(
      "workspace-after-preferences-copilot.json",
      await getWorkspace(window),
    );

    await captureMarkdownTranscriptPreview(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-preferences-copilot-markdown.png"),
    });
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

  process.stdout.write(
    `Saved profile copilot preferences artifacts to ${outputDir}\n`,
  );
}

void captureProfileCopilotPreferences();
