import { describe, expect, test } from 'vitest'
import { createDeterministicJobFinderAiClient } from './index'
import { createPreferences, createProfile } from './test-fixtures'

describe('deterministic ai client profile copilot audit flows', () => {
  test('can audit missing profile fields and auto-apply safe inferred details', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        currentLocation: 'Prishtina, Kosovo',
        githubUrl: null,
        linkedinUrl: null,
        timeZone: null,
        links: [{ id: 'link_github', label: 'GitHub', url: 'https://github.com/elian-morava-example', kind: 'github', isDraft: false }],
        workEligibility: { ...createProfile().workEligibility, requiresVisaSponsorship: null, remoteEligible: null },
      },
      searchPreferences: { ...createPreferences(), workModes: [], targetSalaryUsd: null },
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'look at my profile and cane you fill out different thigns that are missing based on things already there like things that are safely inferrred or assumed by the info already there',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Fill safe inferred profile details', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_identity_fields',
      value: { timeZone: 'Europe/Belgrade', githubUrl: 'https://github.com/elian-morava-example' },
    })
    expect(reply.content).toContain('Top missing or still-unclear fields')
    expect(reply.content).toContain('visa sponsorship preference')
    expect(reply.content).toContain('expected salary')
  })

  test('can save a direct github url from a raw message', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), githubUrl: null },
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'https://github.com/elian-morava-example',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update GitHub URL', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({ operation: 'replace_identity_fields', value: { githubUrl: 'https://github.com/elian-morava-example' } })
  })

  test('can save an explicitly labeled website url', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), personalWebsiteUrl: null },
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'set my website to https://elian-morava.example',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update personal website', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({ operation: 'replace_identity_fields', value: { personalWebsiteUrl: 'https://elian-morava.example' } })
  })

  test('does not auto-apply an unlabeled non-profile url', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), personalWebsiteUrl: null },
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'https://example.com/jobs/123',
    })

    expect(reply.patchGroups).toEqual([])
    expect(reply.content).toContain('could not turn it into a safe structured profile edit yet')
  })

  test('treats softer missing-profile questions as a useful gap audit', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        currentLocation: 'Prishtina, Kosovo',
        githubUrl: null,
        timeZone: null,
        workEligibility: { ...createProfile().workEligibility, requiresVisaSponsorship: null },
      },
      searchPreferences: { ...createPreferences(), targetSalaryUsd: null },
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'what should i update most on my profile based on what is missing',
    })

    expect(reply.content).toContain('Top missing or still-unclear fields')
  })

  test('can interpret no-visa and remote eligibility phrasing', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), workEligibility: { ...createProfile().workEligibility, requiresVisaSponsorship: null, remoteEligible: null } },
      searchPreferences: { ...createPreferences(), workModes: ['remote'] },
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'no i dont want a visa im fine working remote',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update visa sponsorship preference and remote eligibility', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_work_eligibility_fields',
      value: { requiresVisaSponsorship: false, remoteEligible: true },
    })
  })

  test('asks for clear visa sponsorship clarification when the intent is incomplete', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'update visa sponsorship',
    })

    expect(reply.patchGroups).toEqual([])
    expect(reply.content).toContain('I need visa sponsorship')
    expect(reply.content).toContain('I do not need visa sponsorship')
  })
})
