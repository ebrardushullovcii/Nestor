import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(currentDir, '..')

function readCliOption(flag) {
  const index = process.argv.indexOf(flag)

  if (index === -1) {
    return null
  }

  return process.argv[index + 1] ?? null
}

const defaultResumePath = path.resolve(
  desktopDir,
  'test-fixtures',
  'job-finder',
  'resume-import-sample.txt'
)
const resumePath = readCliOption('--resume') ?? process.env.UI_TEST_RESUME_PATH ?? defaultResumePath
const expectedName = readCliOption('--expected-name') ?? process.env.UI_TEST_EXPECTED_NAME ?? null
const expectedHeadline = readCliOption('--expected-headline') ?? process.env.UI_TEST_EXPECTED_HEADLINE ?? null
const expectedLocation = readCliOption('--expected-location') ?? process.env.UI_TEST_EXPECTED_LOCATION ?? null
const expectedSummaryContains =
  readCliOption('--expected-summary-contains') ?? process.env.UI_TEST_EXPECTED_SUMMARY_CONTAINS ?? null
const runLabel = readCliOption('--label') ?? process.env.UI_CAPTURE_LABEL ?? 'resume-import'
const outputDir = path.join(desktopDir, 'test-artifacts', 'ui', runLabel)

function failIfExpectationMisses(snapshot) {
  if (expectedName && snapshot.profile.fullName !== expectedName) {
    throw new Error(`Expected profile fullName to be "${expectedName}" but received "${snapshot.profile.fullName}".`)
  }

  if (expectedHeadline && snapshot.profile.headline !== expectedHeadline) {
    throw new Error(`Expected profile headline to be "${expectedHeadline}" but received "${snapshot.profile.headline}".`)
  }

  if (expectedLocation && snapshot.profile.currentLocation !== expectedLocation) {
    throw new Error(
      `Expected profile currentLocation to be "${expectedLocation}" but received "${snapshot.profile.currentLocation}".`
    )
  }

  if (expectedSummaryContains && !snapshot.profile.summary.includes(expectedSummaryContains)) {
    throw new Error(
      `Expected profile summary to include "${expectedSummaryContains}" but received "${snapshot.profile.summary}".`
    )
  }
}

async function writeJson(fileName, value) {
  await writeFile(path.join(outputDir, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function waitForProfileOrSetupHeading(window) {
  await window.evaluate(() => { window.location.hash = '#/job-finder/profile' })
  await window.waitForFunction(() => {
    const heading = document.querySelector('h1')
    return heading?.textContent?.includes('Guided setup') || heading?.textContent?.includes('Your profile')
  }, undefined, { timeout: 15000 })
}

async function captureResumeImport() {
  await mkdir(outputDir, { recursive: true })
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nestor-resume-import-'))

  const app = await electron.launch({
    args: ['.'],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_ENABLE_TEST_API: '1',
      NESTOR_TEST_SYSTEM_THEME: process.env.NESTOR_TEST_SYSTEM_THEME ?? 'dark',
      NESTOR_USER_DATA_DIR: userDataDirectory
    }
  })

  try {
    const window = await app.firstWindow()

    await window.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme)
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? 'dark')

    await window.waitForLoadState('domcontentloaded')
    await waitForProfileOrSetupHeading(window)
    await window.setViewportSize({ width: 1440, height: 920 })

    const beforeImport = await window.evaluate(() => window.nestor.jobFinder.getWorkspace())
    await writeJson('workspace-before-import.json', beforeImport)

    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, 'profile-before-import.png')
    })

    const importedSnapshot = await window.evaluate(
      async (sourcePath) => {
        if (!window.nestor.jobFinder.test) {
          throw new Error('Desktop test API is not available in the renderer context.')
        }

        return window.nestor.jobFinder.test.importResumeFromPath(sourcePath)
      },
      resumePath
    )

    failIfExpectationMisses(importedSnapshot)
    await writeJson('workspace-after-import.json', importedSnapshot)

    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await waitForProfileOrSetupHeading(window)

    const headingText = (await window.locator('h1').first().textContent())?.trim() ?? ''
    if (headingText !== 'Your profile') {
      await window.getByRole('button', { name: /^Profile$/ }).click()
      await window.getByRole('heading', { level: 1, name: 'Your profile' }).waitFor({ timeout: 15000 })
    }

    const reloadedSnapshot = await window.evaluate(() => window.nestor.jobFinder.getWorkspace())
    failIfExpectationMisses(reloadedSnapshot)
    await writeJson('workspace-after-reload.json', reloadedSnapshot)

    await window.getByRole('tab', { name: /Work history/i }).click()
    await window.getByRole('heading', { level: 2, name: 'Work history' }).waitFor({ timeout: 15000 })

    const visibleExperienceCards = await window.evaluate(() => {
      const summaries = Array.from(document.querySelectorAll('details summary'))
      return summaries
        .map((summary) => {
          const title = summary.querySelector('span > span')
          return title?.textContent?.trim() ?? null
        })
        .filter(Boolean)
    })

    await writeJson('experience-tab-review.json', {
      count: visibleExperienceCards.length,
      titles: visibleExperienceCards
    })

    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, 'profile-after-import.png')
    })

    await window.screenshot({
      animations: 'disabled',
      path: path.join(outputDir, 'profile-experience-after-import.png')
    })

    await writeJson('resume-import-report.json', {
      resumePath,
      expectedName,
      expectedHeadline,
      expectedLocation,
      expectedSummaryContains,
      beforeImport: {
        fullName: beforeImport.profile.fullName,
        headline: beforeImport.profile.headline,
        resumeFileName: beforeImport.profile.baseResume.fileName
      },
      afterImport: {
        fullName: reloadedSnapshot.profile.fullName,
        firstName: reloadedSnapshot.profile.firstName,
        middleName: reloadedSnapshot.profile.middleName,
        lastName: reloadedSnapshot.profile.lastName,
        headline: reloadedSnapshot.profile.headline,
        summary: reloadedSnapshot.profile.summary,
        resumeFileName: reloadedSnapshot.profile.baseResume.fileName,
        extractionStatus: reloadedSnapshot.profile.baseResume.extractionStatus,
        analysisWarnings: reloadedSnapshot.profile.baseResume.analysisWarnings,
        visibleExperienceCards
      }
    })

    process.stdout.write(`Saved resume import artifacts to ${outputDir}\n`)
    process.stdout.write(`Detected name: ${reloadedSnapshot.profile.fullName}\n`)
    process.stdout.write(`Detected headline: ${reloadedSnapshot.profile.headline}\n`)
  } finally {
    await app.close()
    await rm(userDataDirectory, { recursive: true, force: true })
  }
}

void captureResumeImport()
