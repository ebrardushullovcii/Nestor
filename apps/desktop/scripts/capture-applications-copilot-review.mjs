import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(currentDir, '..')
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? '1440', 10)
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? '920', 10)

if (!Number.isFinite(width) || !Number.isFinite(height)) {
  throw new Error(
    `Invalid capture dimensions: width='${process.env.UI_CAPTURE_WIDTH ?? '1440'}', height='${process.env.UI_CAPTURE_HEIGHT ?? '920'}'. Expected numeric values.`,
  )
}
const runLabel = process.env.UI_CAPTURE_LABEL ?? 'applications-copilot-review'
const outputDir = path.join(desktopDir, 'test-artifacts', 'ui', runLabel)

async function writeJson(fileName, value) {
  await writeFile(path.join(outputDir, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function waitForCondition(check, description, timeoutMs = 15000, intervalMs = 150) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for ${description}.`)
}

async function waitForProfileOrSetupHeading(window) {
  await window.waitForFunction(() => Boolean(window.nestor?.jobFinder?.test), undefined, { timeout: 15000 })
  await window.evaluate(() => {
    window.location.hash = '#/job-finder/profile'
  })
  const waitForHeading = () =>
    window.waitForFunction(
      () => {
        const heading = document.querySelector('h1')
        return /Your profile|Guided setup/.test(heading?.textContent ?? '')
      },
      undefined,
      { timeout: 15000 },
    )

  try {
    await waitForHeading()
  } catch (error) {
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => Boolean(window.nestor?.jobFinder?.test), undefined, { timeout: 15000 })
    await window.evaluate(() => {
      window.location.hash = '#/job-finder/profile'
    })

    try {
      await waitForHeading()
      return
    } catch {
      const pageState = await window.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 500),
        hash: window.location.hash,
        headings: Array.from(document.querySelectorAll('h1')).map((heading) => heading.textContent),
      }))
      throw new Error(`Profile route did not become ready: ${JSON.stringify(pageState)}`, { cause: error })
    }
  }
}

async function getResumeWorkspace(window, jobId) {
  return window.evaluate(
    async (currentJobId) => window.nestor.jobFinder.getResumeWorkspace(currentJobId),
    jobId,
  )
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace())
}

async function getApplicationDocuments(window, jobId, applicationRecordId) {
  return window.evaluate(
    async ({ currentJobId, currentApplicationRecordId }) =>
      window.nestor.jobFinder.listApplicationDocuments({
        jobId: currentJobId,
        applicationRecordId: currentApplicationRecordId,
      }),
    { currentJobId: jobId, currentApplicationRecordId: applicationRecordId },
  )
}

async function getSelectedApplyReviewData(window) {
  return window.evaluate(async () => {
    const snapshot = await window.nestor.jobFinder.getWorkspace()
    const selectedRecord =
      snapshot.applicationRecords.find((record) => record.id === snapshot.selectedApplicationRecordId) ??
      snapshot.applicationRecords[0] ??
      null

    if (!selectedRecord) {
      return null
    }

    const matchingResults = snapshot.applyJobResults
      .filter((result) => result.jobId === selectedRecord.jobId)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
    const selectedApplyResult =
      matchingResults.find((result) => result.runId === snapshot.selectedApplyRunId) ??
      matchingResults[0] ??
      null

    if (!selectedApplyResult) {
      return null
    }

    const details = await window.nestor.jobFinder.getApplyRunDetails(
      selectedApplyResult.runId,
      selectedRecord.jobId,
    )

    const latestAttempt = snapshot.applicationAttempts.find(
      (attempt) => attempt.jobId === selectedRecord.jobId,
    ) ?? null

    return {
      details,
      selectedApplyResult,
      selectedRecord,
      latestAttempt,
      selectedApplyRunId: snapshot.selectedApplyRunId,
    }
  })
}

async function captureApplicationsCopilotReview() {
  await mkdir(outputDir, { recursive: true })
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nestor-applications-copilot-review-'))

  let app

  try {
    app = await electron.launch({
      args: ['.'],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: '0',
        NESTOR_ENABLE_TEST_API: '1',
        NESTOR_TEST_SYSTEM_THEME: process.env.NESTOR_TEST_SYSTEM_THEME ?? 'dark',
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    })

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.evaluate(async (theme) => {
      if (!window.nestor?.jobFinder?.test?.setSystemThemeOverride) {
        throw new Error('Desktop test API theme override is unavailable in the renderer.')
      }

      await window.nestor.jobFinder.test.setSystemThemeOverride(theme)
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? 'dark')
    await waitForProfileOrSetupHeading(window)
    await window.setViewportSize({ width, height })

    await window.evaluate(async () => {
      if (!window.nestor.jobFinder.test) {
        throw new Error('Desktop test API is unavailable in the renderer.')
      }

      return window.nestor.jobFinder.test.loadResumeWorkspaceDemo()
    })
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    await window.getByRole('button', { name: /^Shortlisted/ }).click()
    await window.getByRole('heading', { level: 1, name: 'Shortlisted jobs' }).waitFor({ timeout: 10000 })

    await window.getByRole('button', { name: /Edit resume|Open the resume|Review the resume/i }).first().click()
    await window.getByRole('heading', { level: 1, name: /Senior Product Designer/i }).waitFor({ timeout: 10000 })

    await window.getByRole('button', { name: 'Export PDF' }).click()
    await waitForCondition(
      async () => (await getResumeWorkspace(window, 'job_ready')).exports.length > 0,
      'resume export before applications copilot review capture',
    )

    const approveButton = window.getByRole('button', { name: 'Approve current PDF' })
    await approveButton.waitFor({ timeout: 10000 })
    await approveButton.click()
    await waitForCondition(
      async () => {
        const workspace = await getResumeWorkspace(window, 'job_ready')
        return workspace.exports.some((entry) => entry.isApproved) && workspace.draft.status === 'approved'
      },
      'approved resume export before applications copilot review capture',
    )
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '01-resume-approved.png') })

    await window.getByRole('button', { name: /Back to Shortlisted/i }).click()
    await window.getByRole('heading', { level: 1, name: 'Shortlisted jobs' }).waitFor({ timeout: 10000 })
    const startApplyCopilotButton = window.getByRole('button', { name: 'Prepare application' })
    if (await startApplyCopilotButton.isDisabled()) {
      throw new Error('Prepare application should be enabled after resume approval.')
    }
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '02-review-queue-approved.png') })

    await startApplyCopilotButton.click()
    const checkpointDialog = window.getByRole('dialog')
    await checkpointDialog.waitFor({ timeout: 10000 })
    await checkpointDialog.getByRole('button', { name: 'Prepare application', exact: true }).click()
    await waitForCondition(
      async () => (await getWorkspace(window)).applicationRecords.length > 0,
      'application record created by the prepare-only run',
    )
    await window.evaluate(() => { window.location.hash = '#/job-finder/applications' })
    await window.locator('h1').filter({ hasText: /^Applications$/ }).waitFor({ timeout: 10000 })
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '03-applications-open.png') })

    const reviewDataHeading = window.getByText('Apply run review data', { exact: true })
    const reviewDataSection = reviewDataHeading.locator('xpath=ancestor::section[1]')
    await reviewDataSection.waitFor({ timeout: 10000 })
    await reviewDataSection.getByText('Replay checkpoints', { exact: true }).waitFor({ timeout: 10000 })
    await reviewDataSection.getByText('Retained artifacts', { exact: true }).waitFor({ timeout: 10000 })
    await reviewDataSection.getByText('Attached selected resume', { exact: true }).first().waitFor({ timeout: 10000 })
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '04-applications-copilot-review-data.png') })

    const reviewData = await getSelectedApplyReviewData(window)
    if (!reviewData) {
      throw new Error('Applications copilot review data should be available for the selected record.')
    }

    if (reviewData.latestAttempt?.state !== 'paused') {
      throw new Error(`Apply copilot should pause before submit, got '${reviewData.latestAttempt?.state ?? 'null'}'.`)
    }

    if (reviewData.latestAttempt?.outcome !== null) {
      throw new Error('Apply copilot should not record a submitted outcome.')
    }

    if (reviewData.details.run.state !== 'paused_for_user_review') {
      throw new Error(`Expected apply run to remain paused_for_user_review, got '${reviewData.details.run.state}'.`)
    }

    if (reviewData.details.result?.state !== 'awaiting_review') {
      throw new Error(`Expected apply result to remain awaiting_review, got '${reviewData.details.result?.state ?? 'null'}'.`)
    }

    if (reviewData.details.questionRecords.length === 0) {
      throw new Error('Expected persisted apply review data to include detected questions.')
    }

    if (reviewData.details.answerRecords.length === 0) {
      throw new Error('Expected persisted apply review data to include grounded answers.')
    }

    if (reviewData.details.artifactRefs.length === 0) {
      throw new Error('Expected persisted apply review data to include retained artifacts.')
    }

    if (reviewData.details.checkpoints.length === 0) {
      throw new Error('Expected persisted apply review data to include replay checkpoints.')
    }

    const applicationDocumentsHeading = window.getByText('Application documents', { exact: true })
    await applicationDocumentsHeading.scrollIntoViewIfNeeded()
    await applicationDocumentsHeading.waitFor({ timeout: 10000 })
    await window.getByRole('button', { name: 'Generate grounded proposal' }).click()

    const documentEditor = window.getByLabel('Edit proposed text')
    await documentEditor.waitFor({ timeout: 10000 })
    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, '05-grounded-document-proposal.png'),
    })

    const proposedContent = await documentEditor.inputValue()
    await documentEditor.fill(
      `${proposedContent.trim()}\n\nI would welcome the opportunity to discuss this work and the role.`,
    )
    await window.getByRole('button', { name: 'Save edit as new revision' }).click()
    await window.getByText(/Saved user-authored revision \d+\./).waitFor({ timeout: 10000 })
    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, '06-user-edited-document-revision.png'),
    })

    await window.getByRole('button', { name: 'Approve exact revision' }).click()
    await window
      .getByText('Approved and added to Documents & assets for prepare-only use.', { exact: true })
      .waitFor({ timeout: 10000 })
    await window.getByRole('button', { name: 'Export .txt' }).waitFor({ timeout: 10000 })
    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, '07-approved-application-document.png'),
    })

    const applicationDocuments = await getApplicationDocuments(
      window,
      reviewData.selectedRecord.jobId,
      reviewData.selectedRecord.id,
    )
    const approvedDocument = applicationDocuments.documents.find(
      (document) => document.status === 'approved',
    )
    if (!approvedDocument?.outputAsset?.id) {
      throw new Error('Expected the approved application document to create a Candidate Asset.')
    }
    if (!approvedDocument.requiresGroundingReview || approvedDocument.authorship !== 'user_edited') {
      throw new Error('Expected the approved manual edit to retain user-authored grounding review provenance.')
    }

    const workspace = await getWorkspace(window)
    await writeJson('apply-run-details.json', reviewData)
    await writeJson('application-documents.json', applicationDocuments)
    await writeJson('workspace-after-review.json', workspace)
  } finally {
    if (app) {
      try {
        await app.close()
      } catch {
        // Preserve the original failure while still cleaning up the temp profile.
      }
    }
    await rm(userDataDirectory, { recursive: true, force: true })
  }

  process.stdout.write(`Saved applications copilot review artifacts to ${outputDir}\n`)
}

void captureApplicationsCopilotReview().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
