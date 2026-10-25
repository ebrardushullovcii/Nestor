/* eslint-env node, browser */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(currentDir, '..')
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? '1440', 10)
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? '920', 10)
const runLabel = process.env.UI_CAPTURE_LABEL ?? 'applications-consent-states'
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
  await window.evaluate(() => { window.location.hash = '#/job-finder/profile' })
  await window.waitForFunction(() => {
    const heading = document.querySelector('h1')
    return heading?.textContent?.includes('Your profile') || heading?.textContent?.includes('Guided setup')
  }, undefined, { timeout: 15000 })
}

async function waitForShell(window) {
  await window.getByRole('button', { name: /^Applications/ }).waitFor({ timeout: 15000 })
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace())
}

async function getApplyRunDetails(window, runId, jobId) {
  return window.evaluate(
    ({ currentRunId, currentJobId }) =>
      window.nestor.jobFinder.getApplyRunDetails(currentRunId, currentJobId),
    { currentRunId: runId, currentJobId: jobId },
  )
}

function getApplicationRecords(workspace) {
  return Array.isArray(workspace?.applicationRecords) ? workspace.applicationRecords : []
}

async function loadApplyQueueDemo(window) {
  await window.evaluate(async () => {
    if (!window.nestor.jobFinder.test) {
      throw new Error('Desktop test API is unavailable in the renderer.')
    }

    return window.nestor.jobFinder.test.loadApplyQueueDemo()
  })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await waitForShell(window)
  await window.setViewportSize({ width, height })
}

async function refreshShell(window) {
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await waitForShell(window)
  await window.setViewportSize({ width, height })
}

async function navigateToApplications(window) {
  await window.getByRole('button', { name: /^Applications/ }).click()
  await window.getByRole('heading', { level: 1, name: 'Applications' }).waitFor({ timeout: 10000 })
}

async function showAllApplications(window) {
  const allButton = window.getByRole('button', { name: /^All\s+\d+/ }).first()
  await allButton.waitFor({ timeout: 10000 })
  await allButton.click()
}

async function debugVisibleApplicationTitles(window) {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((entry) => entry.textContent?.trim()).filter(Boolean),
  )
}

async function getApplicationRecordSummary(window, jobId) {
  const workspace = await getWorkspace(window)
  const record = workspace.applicationRecords.find((entry) => entry.jobId === jobId) ?? null
  return record
    ? {
        title: record.title,
        company: record.company,
        consentStatus: record.consentSummary.status,
        nextActionLabel: record.nextActionLabel,
        lastActivity: record.lastActionLabel,
      }
    : null
}

async function writeWorkspaceDebug(window, fileName) {
  const workspace = await getWorkspace(window)
  await writeJson(fileName, workspace)
}

async function selectApplicationByJobId(window, jobId) {
  await waitForCondition(
    async () => {
      const workspace = await getWorkspace(window)
      return workspace.applicationRecords.some((entry) => entry.jobId === jobId)
    },
    `application record for ${jobId}`,
  )

  const workspace = await getWorkspace(window)
  const record = workspace.applicationRecords.find((entry) => entry.jobId === jobId)
  if (!record) {
    throw new Error(`Could not find application record for ${jobId}.`)
  }

  const buttons = await debugVisibleApplicationTitles(window)
  const matchingButton = window
    .getByRole('button', {
      name: `View details for ${record.title} at ${record.company}`,
    })
    .first()

  try {
    await matchingButton.waitFor({ timeout: 3000 })
    await matchingButton.click()
  } catch {
    throw new Error(`Could not find visible Applications row for ${record.title} / ${record.company}. Visible buttons: ${buttons.join(' | ')}`)
  }
}

async function stageQueueConsentRun(window) {
  const stagedSnapshot = await window.evaluate(async () => {
    const snapshot = await window.nestor.jobFinder.startAutoApplyQueueRun([
      'job_consent_queue',
      'job_ready',
    ])
    const runId = snapshot.applyRuns[0]?.id
    if (!runId) {
      throw new Error('Missing queue run id after staging consent demo run.')
    }

    return window.nestor.jobFinder.approveApplyRun(runId)
  })

  const fullWorkspace = await getWorkspace(window)
  const runId = stagedSnapshot.applyRuns[0]?.id
  if (!runId) {
    throw new Error('Missing queue run id after approval.')
  }

  const runDetails = await getApplyRunDetails(window, runId, 'job_consent_queue')
  const request = runDetails.consentRequests.find(
    (entry) => entry.jobId === 'job_consent_queue' && entry.status === 'pending',
  )
  if (!request) {
    throw new Error('Expected a pending consent request for job_consent_queue.')
  }

  return {
    requestId: request.id,
    runId: request.runId,
    snapshot: fullWorkspace,
    runDetails,
  }
}

async function resolveConsent(window, requestId, action) {
  return window.evaluate(
    async ({ currentRequestId, currentAction }) =>
      window.nestor.jobFinder.resolveApplyConsentRequest(currentRequestId, currentAction),
    { currentRequestId: requestId, currentAction: action },
  )
}

async function captureApplicationsConsentStates() {
  await mkdir(outputDir, { recursive: true })
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nestor-applications-consent-'))

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
      if (!window.nestor.jobFinder.test) {
        throw new Error('Desktop test API is unavailable in the renderer.')
      }

      await window.nestor.jobFinder.test.setSystemThemeOverride(theme)
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? 'dark')
    await waitForProfileOrSetupHeading(window)
    await window.setViewportSize({ width, height })

    await loadApplyQueueDemo(window)
    const { requestId, runId, snapshot: stagedSnapshot } = await stageQueueConsentRun(window)
    await refreshShell(window)
    await navigateToApplications(window)
    await showAllApplications(window)
    await writeWorkspaceDebug(window, 'debug-requested-workspace.json')
    await selectApplicationByJobId(window, 'job_consent_queue')
    await waitForCondition(async () => {
      const summary = await getApplicationRecordSummary(window, 'job_consent_queue')
      return summary?.consentStatus === 'requested'
    }, 'requested consent application summary')
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '01-consent-requested.png') })

    const approvedSnapshot = await resolveConsent(window, requestId, 'approve')
    await waitForCondition(
      async () => {
        const workspace = await getWorkspace(window)
        const record = workspace.applicationRecords.find((entry) => entry.jobId === 'job_consent_queue')
        return record?.consentSummary.status === 'approved'
      },
      'approved consent state in Applications',
    )
    await selectApplicationByJobId(window, 'job_consent_queue')
    await waitForCondition(async () => {
      const summary = await getApplicationRecordSummary(window, 'job_consent_queue')
      return summary?.consentStatus === 'approved'
    }, 'approved consent application summary')
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '02-consent-approved.png') })

    await loadApplyQueueDemo(window)
    const declinedRun = await stageQueueConsentRun(window)
    await refreshShell(window)
    await navigateToApplications(window)
    await showAllApplications(window)
    const declinedSnapshot = await resolveConsent(window, declinedRun.requestId, 'decline')
    await waitForCondition(
      async () => {
        const workspace = await getWorkspace(window)
        const record = workspace.applicationRecords.find((entry) => entry.jobId === 'job_consent_queue')
        return record?.consentSummary.status === 'declined'
      },
      'declined consent state in Applications',
    )
    await selectApplicationByJobId(window, 'job_consent_queue')
    await waitForCondition(async () => {
      const summary = await getApplicationRecordSummary(window, 'job_consent_queue')
      return summary?.consentStatus === 'declined'
    }, 'declined consent application summary')
    await window.screenshot({ animations: 'disabled', path: path.join(outputDir, '03-consent-declined.png') })

    await writeJson('consent-state-report.json', {
        requested: {
          runId,
          requestId,
          consentStatus: getApplicationRecords(stagedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.consentSummary,
        },
        approved: {
          runId,
          consentStatus: getApplicationRecords(approvedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.consentSummary,
          status: getApplicationRecords(approvedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.status,
        },
        declined: {
          runId: declinedRun.runId,
          consentStatus: getApplicationRecords(declinedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.consentSummary,
          status: getApplicationRecords(declinedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.status,
          nextActionLabel: getApplicationRecords(declinedSnapshot).find((entry) => entry.jobId === 'job_consent_queue')?.nextActionLabel,
        },
      })
  } finally {
    if (app) {
      try {
        await app.close()
      } catch {
        // Preserve original failure.
      }
    }

    await rm(userDataDirectory, { recursive: true, force: true })
  }

  process.stdout.write(`Saved Applications consent-state artifacts to ${outputDir}\n`)
}

void captureApplicationsConsentStates().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
