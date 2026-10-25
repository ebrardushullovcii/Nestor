export const resumePreviewIdentityFieldValues = [
  'fullName',
  'headline',
  'location',
  'email',
  'phone',
  'portfolioUrl',
  'linkedinUrl',
  'githubUrl',
  'personalWebsiteUrl',
  'additionalLinks',
] as const

export type ResumePreviewIdentityField = (typeof resumePreviewIdentityFieldValues)[number]

export const resumePreviewEntryFieldValues = [
  'title',
  'subtitle',
  'location',
  'dateRange',
  'startDate',
  'endDate',
  'isCurrent',
  'summary',
] as const

export type ResumePreviewEntryField = (typeof resumePreviewEntryFieldValues)[number]

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function emptyResumePreviewTargetContext() {
  return {
    sectionId: null,
    entryId: null,
  }
}

export function getResumeIdentityTargetId(field: ResumePreviewIdentityField): string {
  return `identity:${field}`
}

export function getResumeSectionTextTargetId(sectionId: string): string {
  return `section:${encodeSegment(sectionId)}:text`
}

export function getResumeSectionBulletTargetId(sectionId: string, bulletId: string): string {
  return `section:${encodeSegment(sectionId)}:bullet:${encodeSegment(bulletId)}`
}

export function getResumeEntryFieldTargetId(
  sectionId: string,
  entryId: string,
  field: ResumePreviewEntryField,
): string {
  return `entry:${encodeSegment(sectionId)}:${encodeSegment(entryId)}:${field}`
}

export function getResumeEntryBulletTargetId(sectionId: string, entryId: string, bulletId: string): string {
  return `entry:${encodeSegment(sectionId)}:${encodeSegment(entryId)}:bullet:${encodeSegment(bulletId)}`
}

export function getResumePreviewTargetContext(targetId: string): {
  sectionId: string | null
  entryId: string | null
} {
  if (targetId.startsWith('identity:')) {
    return emptyResumePreviewTargetContext()
  }

  const sectionTextMatch = /^section:([^:]+):text$/.exec(targetId)
  if (sectionTextMatch) {
    const sectionId = decodeSegment(sectionTextMatch[1] ?? '')
    if (!sectionId) {
      return emptyResumePreviewTargetContext()
    }

    return {
      sectionId,
      entryId: null,
    }
  }

  const sectionBulletMatch = /^section:([^:]+):bullet:([^:]+)$/.exec(targetId)
  if (sectionBulletMatch) {
    const sectionId = decodeSegment(sectionBulletMatch[1] ?? '')
    if (!sectionId) {
      return emptyResumePreviewTargetContext()
    }

    return {
      sectionId,
      entryId: null,
    }
  }

  const entryFieldMatch = /^entry:([^:]+):([^:]+):([a-zA-Z]+)$/.exec(targetId)
  if (entryFieldMatch) {
    const sectionId = decodeSegment(entryFieldMatch[1] ?? '')
    const entryId = decodeSegment(entryFieldMatch[2] ?? '')
    if (!sectionId || !entryId) {
      return emptyResumePreviewTargetContext()
    }

    return {
      sectionId,
      entryId,
    }
  }

  const entryBulletMatch = /^entry:([^:]+):([^:]+):bullet:([^:]+)$/.exec(targetId)
  if (entryBulletMatch) {
    const sectionId = decodeSegment(entryBulletMatch[1] ?? '')
    const entryId = decodeSegment(entryBulletMatch[2] ?? '')
    if (!sectionId || !entryId) {
      return emptyResumePreviewTargetContext()
    }

    return {
      sectionId,
      entryId,
    }
  }

  return emptyResumePreviewTargetContext()
}
