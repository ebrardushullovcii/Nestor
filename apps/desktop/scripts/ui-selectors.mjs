export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function formatVisibleRunId(runId) {
  return runId.length <= 8 ? runId : runId.slice(-8)
}

export async function selectApplicationRecord(window, title, company) {
  const recordButton = window.getByRole('button', {
    name: new RegExp(
      `^View details for ${escapeRegExp(title)} at ${escapeRegExp(company)}$`,
      'i',
    ),
  }).first()
  await recordButton.waitFor({ timeout: 10000 })
  await recordButton.click()
}

export async function selectQueueJobs(window, titles) {
  for (const title of titles) {
    const jobCard = window.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(title)}(?!\\w)`, 'i'),
    }).first().locator('xpath=ancestor::div[.//label[normalize-space()="Queue"]][1]')
    const checkbox = jobCard.getByLabel('Queue').first()
    await checkbox.waitFor({ timeout: 10000 })
    await checkbox.check()
  }
}
