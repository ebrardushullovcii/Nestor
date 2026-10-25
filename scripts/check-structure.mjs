import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const rootDir = path.resolve(import.meta.dirname, '..')

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  {
  cwd: rootDir,
  encoding: 'utf8'
  }
)
  .split(/\r?\n/)
  .map((entry) => entry.trim())
  .filter(Boolean)

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx'])
const ignoredPathParts = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'test-artifacts',
  'playwright-report',
  '.next'
])

const budgets = {
  generalWarn: 800,
  hardFail: 1200,
  indexWarn: 200,
  rendererComponentWarn: 400
}

function shouldIgnore(relativePath) {
  return relativePath.split('/').some((segment) => ignoredPathParts.has(segment))
}

function toPosixPath(relativePath) {
  return relativePath.replace(/\\/g, '/')
}

async function countLines(relativePath) {
  const absolutePath = path.join(rootDir, relativePath)
  await fs.access(absolutePath)
  const content = await fs.readFile(absolutePath, 'utf8')
  return content.split(/\r?\n/).length
}

function isRendererComponent(relativePath) {
  return (
    relativePath.startsWith('apps/desktop/src/renderer/src/') &&
    relativePath.endsWith('.tsx') &&
    !relativePath.endsWith('.test.tsx')
  )
}

function isPackageIndex(relativePath) {
  return /^packages\/[^/]+\/src\/index\.(ts|tsx|js|jsx)$/.test(relativePath)
}

function formatTable(rows) {
  if (rows.length === 0) {
    return []
  }

  const lineWidth = Math.max(...rows.map((row) => String(row.lines).length), 5)
  return rows.map((row) => `${String(row.lines).padStart(lineWidth)}  ${row.path}`)
}

async function main() {
  const rows = []

  for (const relativePath of trackedFiles) {
    const normalizedPath = toPosixPath(relativePath)
    if (shouldIgnore(normalizedPath)) {
      continue
    }

    const extension = path.extname(normalizedPath)
    if (!sourceExtensions.has(extension)) {
      continue
    }

    try {
      rows.push({
        path: normalizedPath,
        lines: await countLines(normalizedPath)
      })
    } catch {
      // The worktree can contain deleted tracked files during active refactors.
      // Skip anything that no longer exists instead of failing the whole report.
    }
  }

  rows.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))

  const oversizedFiles = rows.filter((row) => row.lines >= budgets.generalWarn)
  const oversizedIndexes = rows.filter(
    (row) => isPackageIndex(row.path) && row.lines >= budgets.indexWarn
  )
  const oversizedRendererComponents = rows.filter(
    (row) => isRendererComponent(row.path) && row.lines >= budgets.rendererComponentWarn
  )
  const hardFailCandidates = rows.filter((row) => row.lines >= budgets.hardFail)

  console.log('Structure report (warn-only)')
  console.log('')
  console.log(`- General source warning threshold: ${budgets.generalWarn} lines`)
  console.log(`- Renderer component warning threshold: ${budgets.rendererComponentWarn} lines`)
  console.log(`- Package index warning threshold: ${budgets.indexWarn} lines`)
  console.log(`- Future hard-fail candidate threshold: ${budgets.hardFail} lines`)
  console.log('')

  if (oversizedFiles.length === 0) {
    console.log('No source files exceeded the current warning thresholds.')
    return
  }

  console.log('Largest source files:')
  for (const line of formatTable(oversizedFiles.slice(0, 20))) {
    console.log(line)
  }
  console.log('')

  if (oversizedIndexes.length > 0) {
    console.log('Package entrypoints to shrink into barrel exports:')
    for (const line of formatTable(oversizedIndexes)) {
      console.log(line)
    }
    console.log('')
  }

  if (oversizedRendererComponents.length > 0) {
    console.log('Desktop renderer components over budget:')
    for (const line of formatTable(oversizedRendererComponents)) {
      console.log(line)
    }
    console.log('')
  }

  if (hardFailCandidates.length > 0) {
    console.log('Future hard-fail candidates:')
    for (const line of formatTable(hardFailCandidates)) {
      console.log(line)
    }
    console.log('')
  }

  console.log('This check is warn-only for now and exits successfully.')
}

await main()
