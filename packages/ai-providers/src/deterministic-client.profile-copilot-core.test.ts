import { describe, expect, test } from 'vitest'
import { createDeterministicJobFinderAiClient } from './index'
import { createPreferences, createProfile } from './test-fixtures'

describe('deterministic ai client profile copilot core', () => {
  test('returns a safe applied profile copilot patch for explicit headline edits', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'essentials' },
      relevantReviewItems: [
        {
          id: 'review_headline',
          step: 'essentials',
          target: { domain: 'identity', key: 'headline', recordId: null },
          label: 'Headline',
          reason: 'Confirm the imported headline before setup is complete.',
          severity: 'recommended',
          status: 'pending',
          proposedValue: 'Principal Product Designer',
          sourceSnippet: 'Principal Product Designer',
          sourceCandidateId: 'headline_candidate',
          sourceRunId: 'run_1',
          createdAt: '2026-04-12T10:00:00.000Z',
          resolvedAt: null,
        },
      ],
      request: 'Update my headline to: Principal Product Designer'
    })

    expect(reply.patchGroups).toHaveLength(1)
    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ applyMode: 'applied', summary: 'Update headline' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_identity_fields',
      value: { headline: 'Principal Product Designer' }
    })
    expect(reply.patchGroups[0]?.operations[1]).toEqual({
      operation: 'resolve_review_items',
      reviewItemIds: ['review_headline'],
      resolutionStatus: 'confirmed'
    })
  })

  test('can update years of experience from a practical setup request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), yearsExperience: 6 },
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'essentials' },
      relevantReviewItems: [
        {
          id: 'review_years_experience',
          step: 'essentials',
          target: { domain: 'identity', key: 'yearsExperience', recordId: null },
          label: 'Years of experience',
          reason: 'Confirm the imported years of experience before setup is complete.',
          severity: 'recommended',
          status: 'pending',
          proposedValue: '7',
          sourceSnippet: '7 years of experience',
          sourceCandidateId: 'years_experience_candidate',
          sourceRunId: 'run_1',
          createdAt: '2026-04-14T10:00:00.000Z',
          resolvedAt: null,
        },
      ],
      request: 'change my years of experience from 6 to 7',
    })

    expect(reply.patchGroups).toHaveLength(1)
    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ applyMode: 'applied', summary: 'Update years of experience' }))
    expect(reply.patchGroups[0]?.operations).toEqual([
      { operation: 'replace_identity_fields', value: { yearsExperience: 7 } },
      { operation: 'resolve_review_items', reviewItemIds: ['review_years_experience'], resolutionStatus: 'confirmed' },
    ])
  })

  test('understands practical experience phrasing without the full years-of-experience label', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), yearsExperience: 6 },
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'essentials' },
      relevantReviewItems: [],
      request: 'change my experience to only 5 years',
    })

    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_identity_fields',
      value: { yearsExperience: 5 },
    })
  })

  test('returns guidance-only profile copilot replies for ambiguous requests', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [
        {
          id: 'review_1',
          step: 'targeting',
          target: { domain: 'search_preferences', key: 'targetRoles', recordId: null },
          label: 'Target roles',
          reason: 'Choose a clearer target role list.',
          severity: 'critical',
          status: 'pending',
          proposedValue: null,
          sourceSnippet: null,
          sourceCandidateId: null,
          sourceRunId: null,
          createdAt: '2026-04-12T10:00:00.000Z',
          resolvedAt: null
        }
      ],
      request: 'Make this better somehow'
    })

    expect(reply.patchGroups).toEqual([])
    expect(reply.content).toContain('Target roles')
  })

  test('can mark a pending experience review item as remote', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        experiences: [{
          id: 'experience_1',
          companyName: 'NORTHLANE',
          companyUrl: null,
          title: 'Senior Full-Stack Software Engineer',
          employmentType: null,
          location: 'Prishtina, Kosovo',
          workMode: [],
          startDate: '2023-07',
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        }],
      },
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'background' },
      relevantReviewItems: [{
        id: 'review_experience_remote',
        step: 'background',
        target: { domain: 'experience', key: 'record', recordId: 'experience_1' },
        label: 'Senior Full-Stack Software Engineer at NORTHLANE',
        reason: 'Work-history records stay review-first so resume tailoring and fit scoring do not assume the wrong role details.',
        severity: 'critical',
        status: 'pending',
        proposedValue: null,
        sourceSnippet: 'NORTHLANE - PRISHTINA, KOSOVO',
        sourceCandidateId: 'candidate_experience_1',
        sourceRunId: 'run_1',
        createdAt: '2026-04-14T00:50:00.000Z',
        resolvedAt: null,
      }],
      request: 'for north lane i actually worked remote can you fix that for me',
    })

    expect(reply.patchGroups).toHaveLength(1)
    const operations = reply.patchGroups[0]?.operations ?? []
    expect(operations.find((operation) => operation.operation === 'upsert_experience_record')).toMatchObject({
      operation: 'upsert_experience_record',
      record: { id: 'experience_1', workMode: ['remote'] },
    })
    expect(operations.find((operation) => operation.operation === 'resolve_review_items')).toEqual({
      operation: 'resolve_review_items',
      reviewItemIds: ['review_experience_remote'],
      resolutionStatus: 'edited',
    })
  })

  test('answers grounded tenure questions for saved experience history', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        experiences: [{
          id: 'experience_northlane',
          companyName: 'NORTHLANE',
          companyUrl: null,
          title: 'React/Next.js Developer',
          employmentType: null,
          location: 'Prishtina, Kosovo',
          workMode: ['remote'],
          startDate: '2023-07',
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        }],
      },
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'background' },
      relevantReviewItems: [],
      request: 'how long did i work on northlane ?',
    })

    expect(reply.patchGroups).toEqual([])
    expect(reply.content).toContain('NORTHLANE')
    expect(reply.content).toContain('React/Next.js Developer')
    expect(reply.content.toLowerCase()).toContain('saved from')
  })

  test('can apply a safe narrative story edit when the request includes explicit replacement text', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'narrative' },
      relevantReviewItems: [{
        id: 'review_story',
        step: 'narrative',
        target: { domain: 'narrative', key: 'professionalStory', recordId: null },
        label: 'Professional story',
        reason: 'Add a concise story before setup is complete.',
        severity: 'recommended',
        status: 'pending',
        proposedValue: null,
        sourceSnippet: null,
        sourceCandidateId: null,
        sourceRunId: null,
        createdAt: '2026-04-14T00:50:00.000Z',
        resolvedAt: null,
      }],
      request: 'Update my professional story to: Product-focused frontend engineer who turns complex workflows into reliable systems.',
    })

    expect(reply.patchGroups).toHaveLength(1)
    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ applyMode: 'applied', summary: 'Update professional story' }))
    expect(reply.patchGroups[0]?.operations).toEqual(expect.arrayContaining([
      { operation: 'replace_narrative_fields', value: { professionalStory: 'Product-focused frontend engineer who turns complex workflows into reliable systems.' } },
      { operation: 'resolve_review_items', reviewItemIds: ['review_story'], resolutionStatus: 'edited' },
    ]))
  })

  test('can update preferred display name through a direct explicit request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), preferredDisplayName: null },
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'basics' },
      relevantReviewItems: [],
      request: 'set my preferred display name to Elian',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update preferred display name', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_identity_fields',
      value: { preferredDisplayName: 'Elian' },
    })
  })

  test('can update professional-summary list fields from a direct request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'basics' },
      relevantReviewItems: [],
      request: 'set my strengths to systems thinking, frontend architecture, mentoring',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update strengths', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_professional_summary_fields',
      value: { strengths: ['systems thinking', 'frontend architecture', 'mentoring'] },
    })
  })

  test('can update narrative list fields from a direct request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'setup', step: 'narrative' },
      relevantReviewItems: [],
      request: 'set my differentiators to strong product judgment, fast iteration, reliable delivery',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update differentiators', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_narrative_fields',
      value: { differentiators: ['strong product judgment', 'fast iteration', 'reliable delivery'] },
    })
  })

  test('can update answer-bank fields from a direct request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'set my short self introduction to Senior full-stack engineer focused on AI workflows.',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update short self-introduction', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_answer_bank_fields',
      value: { selfIntroduction: 'Senior full-stack engineer focused on AI workflows.' },
    })
  })

  test('can update application identity fields from a direct request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'preferences' },
      relevantReviewItems: [],
      request: 'set my preferred application email to jobs@example.com',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update preferred application email', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_application_identity_fields',
      value: { preferredEmail: 'jobs@example.com' },
    })
  })

  test('can update skill group list fields from a direct request', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'basics' },
      relevantReviewItems: [],
      request: 'set my core skills to React, TypeScript, Node.js',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update core skills', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_skill_group_fields',
      value: { coreSkills: ['React', 'TypeScript', 'Node.js'] },
    })
  })

  test('can update top-level profile skills with a typed patch', async () => {
    const client = createDeterministicJobFinderAiClient()

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: 'profile', section: 'basics' },
      relevantReviewItems: [],
      request: 'set my overall skills to React, TypeScript, Electron',
    })

    expect(reply.patchGroups[0]).toEqual(expect.objectContaining({ summary: 'Update skills', applyMode: 'applied' }))
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: 'replace_profile_list_fields',
      value: { skills: ['React', 'TypeScript', 'Electron'] },
    })
  })
})
