import type {
  CandidateProfile,
  JobFinderSettings,
  JobPosting,
  JobSearchPreferences,
} from '@nestor/contracts'
import { JobPostingSchema } from '@nestor/contracts'
import type { JobFinderAiClient } from './shared'

export function createEnvironment(
  overrides: Partial<Record<string, string | undefined>> = {}
) {
  return {
    NESTOR_AI_API_KEY: 'test-key',
    NESTOR_AI_BASE_URL: 'https://example.com/v1',
    NESTOR_AI_MODEL: 'test-model',
    NESTOR_AI_API_MODE: 'chat_completions',
    NESTOR_AI_TIMEOUT_MS: undefined,
    NESTOR_AI_RESUME_TIMEOUT_MS: undefined,
    ...overrides
  }
}

export function mockJsonFetch(payload: unknown, init: ResponseInit = {}) {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      })
    )) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

export function mockTextFetch(body: string, init: ResponseInit = {}) {
  const originalFetch = globalThis.fetch
  const responseInit: ResponseInit = {
    status: init.status ?? 200
  }

  if (init.headers) {
    responseInit.headers = init.headers
  }

  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, responseInit)
    )) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

export function mockRejectedFetch(error: Error) {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (() => Promise.reject(error)) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

interface CapturingFetchMock {
  getCapturedBody(): string
  restore(): void
}

function serializeCapturedBody(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (body instanceof FormData) {
    return JSON.stringify(
      Array.from(body.entries()).map(([key, value]) => [key, typeof value === 'string' ? value : value.name])
    )
  }

  if (body instanceof Blob) {
    return `[blob size=${body.size} type=${body.type || 'application/octet-stream'}]`
  }

  if (body instanceof ArrayBuffer) {
    return `[arraybuffer byteLength=${body.byteLength}]`
  }

  if (body && typeof body === 'object' && 'byteLength' in body && typeof body.byteLength === 'number') {
    return `[arraybuffer-view byteLength=${body.byteLength}]`
  }

  if (body && typeof body === 'object' && 'getReader' in body) {
    return '[readablestream]'
  }

  if (body == null) {
    return ''
  }

  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

export function mockCapturingJsonFetch(
  payload: unknown,
  init: ResponseInit = {}
): CapturingFetchMock {
  const originalFetch = globalThis.fetch
  let capturedBody = ''

  globalThis.fetch = ((_, requestInit) => {
    capturedBody = serializeCapturedBody(requestInit?.body)

    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      })
    )
  }) as typeof fetch

  return {
    getCapturedBody() {
      return capturedBody
    },
    restore() {
      globalThis.fetch = originalFetch
    }
  }
}

export function createProfile(): CandidateProfile {
  return {
    id: 'candidate_1',
    firstName: 'Alex',
    lastName: 'Vanguard',
    middleName: null,
    fullName: 'Alex Vanguard',
    preferredDisplayName: null,
    headline: 'Workflow engineer',
    summary: 'Builds reliable automation.',
    currentLocation: 'London, UK',
    currentCity: null,
    currentRegion: null,
    currentCountry: null,
    timeZone: null,
    yearsExperience: 8,
    email: null,
    secondaryEmail: null,
    phone: null,
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    narrative: {
      professionalStory: null,
      nextChapterSummary: null,
      careerTransitionSummary: null,
      differentiators: [],
      motivationThemes: []
    },
    proofBank: [],
    answerBank: {
      workAuthorization: null,
      visaSponsorship: null,
      relocation: null,
      travel: null,
      noticePeriod: null,
      availability: null,
      salaryExpectations: null,
      selfIntroduction: null,
      careerTransition: null,
      customAnswers: []
    },
    applicationIdentity: {
      preferredEmail: null,
      preferredPhone: null,
      preferredLinkIds: []
    },
    baseResume: {
      id: 'resume_1',
      fileName: 'resume.txt',
      uploadedAt: '2026-03-20T10:00:00.000Z',
      storagePath: null,
      textContent: 'Resume text',
      textUpdatedAt: '2026-03-20T10:00:00.000Z',
      extractionStatus: 'ready' as const,
      lastAnalyzedAt: '2026-03-20T10:01:00.000Z',
      analysisProviderKind: 'deterministic',
      analysisProviderLabel: 'Built-in deterministic agent fallback',
      analysisWarnings: []
    },
    workEligibility: {
      authorizedWorkCountries: [],
      requiresVisaSponsorship: null,
      willingToRelocate: null,
      preferredRelocationRegions: [],
      willingToTravel: null,
      remoteEligible: null,
      noticePeriodDays: null,
      availableStartDate: null,
      securityClearance: null
    },
    professionalSummary: {
      shortValueProposition: null,
      fullSummary: null,
      careerThemes: [],
      leadershipSummary: null,
      domainFocusSummary: null,
      strengths: []
    },
    skillGroups: {
      coreSkills: [],
      tools: [],
      languagesAndFrameworks: [],
      softSkills: [],
      highlightedSkills: []
    },
    targetRoles: ['Staff Frontend Engineer'],
    locations: ['London, UK'],
    skills: ['React', 'TypeScript'],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: []
  }
}

export function createPreferences(): JobSearchPreferences {
  return {
    targetRoles: ['Staff Frontend Engineer'],
    jobFamilies: [],
    locations: ['London, UK'],
    excludedLocations: [],
    workModes: ['remote'],
    seniorityLevels: ['Staff'],
    targetIndustries: [],
    targetCompanyStages: [],
    employmentTypes: [],
    minimumSalaryUsd: 150000,
    targetSalaryUsd: null,
    salaryCurrency: 'USD',
    compensation: {
      minimum: 150000,
      maximum: null,
      interval: 'year',
      currency: 'USD',
      currencyStatus: 'explicit'
    },
    approvalMode: 'review_before_submit' as const,
    tailoringMode: 'balanced' as const,
    companyBlacklist: [],
    companyWhitelist: [],
    discovery: {
      historyLimit: 5,
      targets: [
        {
          id: 'target_primary',
          label: 'Primary target',
          startingUrl: 'https://www.linkedin.com/jobs/search/',
          enabled: true,
          adapterKind: 'auto',
          customInstructions: null,
          instructionStatus: 'missing',
          validatedInstructionId: null,
          draftInstructionId: null,
          lastDebugRunId: null,
          lastVerifiedAt: null,
          staleReason: null
        }
      ]
    }
  }
}

export function createSettings(): JobFinderSettings {
  return {
    resumeFormat: 'html',
    resumeTemplateId: 'classic_ats',
    fontPreset: 'inter_requisite',
    appearanceTheme: 'system',
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
  }
}

export function createJobPosting(): JobPosting {
  return JobPostingSchema.parse({
    source: 'target_site',
    sourceJobId: 'job_1',
    discoveryMethod: 'browser_agent',
    canonicalUrl: 'https://jobs.example.com/1',
    applicationUrl: null,
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    workMode: ['remote'],
    applyPath: 'unknown',
    easyApplyEligible: false,
    postedAt: '2026-03-20T10:00:00.000Z',
    postedAtText: null,
    discoveredAt: '2026-03-20T10:00:00.000Z',
    firstSeenAt: '2026-03-20T10:00:00.000Z',
    lastSeenAt: '2026-03-20T10:00:00.000Z',
    lastVerifiedActiveAt: '2026-03-20T10:00:00.000Z',
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    summary: 'Build product interfaces',
    // A body with enough of its own content to distinguish this posting from
    // another one: a draft generated against three boilerplate words is not
    // tailored, and the generator now declines to call it that.
    description:
      'Build product interfaces for customer workflows. Own the React component library, partner with design on accessibility, instrument usage analytics, and lead migration away from the legacy checkout surface.',
    keySkills: ['React'],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    sourceIntelligence: null,
    collectionMethod: 'fallback_search',
    titleTriageOutcome: 'pass',
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: []
    },
    keywordSignals: [],
    benefits: []
  })
}

export function createExtraction(
  overrides: Partial<Awaited<ReturnType<JobFinderAiClient['extractProfileFromResume']>>> = {}
) {
  return {
    firstName: null,
    lastName: null,
    middleName: null,
    fullName: null,
    headline: null,
    summary: null,
    currentLocation: null,
    timeZone: null,
    salaryCurrency: null,
    yearsExperience: null,
    email: null,
    phone: null,
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    professionalSummary: {
      shortValueProposition: null,
      fullSummary: null,
      careerThemes: [],
      leadershipSummary: null,
      domainFocusSummary: null,
      strengths: []
    },
    skillGroups: {
      coreSkills: [],
      tools: [],
      languagesAndFrameworks: [],
      softSkills: [],
      highlightedSkills: []
    },
    skills: [],
    targetRoles: [],
    preferredLocations: [],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
    analysisProviderKind: 'deterministic' as const,
    analysisProviderLabel: 'test',
    notes: [],
    ...overrides
  }
}
