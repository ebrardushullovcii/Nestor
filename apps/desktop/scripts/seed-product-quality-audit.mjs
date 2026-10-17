import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(currentDir, '..')

function readRequiredOption(flag) {
  const index = process.argv.indexOf(flag)
  const value = index === -1 ? null : process.argv[index + 1]

  if (!value?.trim()) {
    throw new Error(`Missing required ${flag} option.`)
  }

  return path.resolve(value)
}

async function seedProductQualityAudit() {
  const userDataDirectory = readRequiredOption('--user-data-dir')
  const resumePath = readRequiredOption('--resume')
  const reportPath = path.join(userDataDirectory, 'product-quality-audit-seed.json')

  await mkdir(userDataDirectory, { recursive: true })

  const app = await electron.launch({
    args: ['.'],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_BROWSER_AGENT: '0',
      NESTOR_ENABLE_TEST_API: '1',
      NESTOR_TEST_SYSTEM_THEME: 'dark',
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test?.importResumeFromPath),
      undefined,
      { timeout: 20_000 },
    )

    const snapshot = await window.evaluate(
      async (sourcePath) =>
        window.nestor.jobFinder.test.importResumeFromPath({
          sourcePath,
          useVision: false,
        }),
      resumePath,
    )

    const report = {
      seededAt: new Date().toISOString(),
      resumePath,
      profile: {
        fullName: snapshot.profile.fullName,
        headline: snapshot.profile.headline,
        currentLocation: snapshot.profile.currentLocation,
        resumeFileName: snapshot.profile.baseResume.fileName,
        extractionStatus: snapshot.profile.baseResume.extractionStatus,
        sha256: snapshot.profile.baseResume.sha256,
      },
    }

    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`Seeded isolated product-quality audit data at ${userDataDirectory}\n`)
    process.stdout.write(`Wrote ${reportPath}\n`)
  } finally {
    await app.close().catch(() => undefined)
  }
}

await seedProductQualityAudit()
