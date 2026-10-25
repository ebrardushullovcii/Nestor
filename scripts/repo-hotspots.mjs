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

const includeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css'])
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

function shouldIgnore(relativePath) {
  return relativePath.split('/').some((segment) => ignoredPathParts.has(segment))
}

async function countLines(relativePath) {
  await fs.access(path.join(rootDir, relativePath))
  const content = await fs.readFile(path.join(rootDir, relativePath), 'utf8')
  return content.split(/\r?\n/).length
}

function bucketWorkspace(relativePath) {
  const parts = relativePath.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : relativePath
}

async function main() {
  const rows = []

  for (const file of trackedFiles) {
    if (shouldIgnore(file)) {
      continue
    }

    if (!includeExtensions.has(path.extname(file))) {
      continue
    }

    try {
      rows.push({ path: file, lines: await countLines(file) })
    } catch {
      // Ignore deleted tracked files while the worktree is mid-refactor.
    }
  }

  rows.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))

  const buckets = new Map()
  for (const row of rows) {
    const bucket = bucketWorkspace(row.path)
    const current = buckets.get(bucket) ?? { files: 0, lines: 0 }
    current.files += 1
    current.lines += row.lines
    buckets.set(bucket, current)
  }

  const topBuckets = [...buckets.entries()]
    .map(([bucket, stats]) => ({ bucket, ...stats }))
    .sort((left, right) => right.lines - left.lines || left.bucket.localeCompare(right.bucket))

  console.log('Repo hotspot summary')
  console.log('')
  console.log('Largest source files:')
  for (const row of rows.slice(0, 15)) {
    console.log(`${String(row.lines).padStart(5)}  ${row.path}`)
  }
  console.log('')
  console.log('Workspace concentration:')
  for (const row of topBuckets.slice(0, 12)) {
    console.log(`${String(row.lines).padStart(5)} lines across ${String(row.files).padStart(3)} files  ${row.bucket}`)
  }
}

await main()
