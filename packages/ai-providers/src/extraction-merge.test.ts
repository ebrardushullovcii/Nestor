import { describe, expect, test } from 'vitest'
import { completeResumeExtraction } from './index'
import { ResumeProfileExtractionSchema } from './shared'
import { createExtraction } from './test-fixtures'

describe('resume extraction merge', () => {
  test('keeps merged experience and education unions when fallback data is richer', () => {
    const primary = createExtraction({
      experiences: [
        {
          companyName: null,
          companyUrl: null,
          title: 'Software Engineer',
          employmentType: null,
          location: null,
          workMode: [],
          startDate: '2024',
          endDate: null,
          isCurrent: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        },
        {
          companyName: 'DesignCo',
          companyUrl: null,
          title: 'Designer',
          employmentType: null,
          location: 'Remote',
          workMode: ['remote'],
          startDate: '2022',
          endDate: '2023',
          isCurrent: false,
          summary: 'Owned design systems',
          achievements: ['Led a redesign'],
          skills: ['Figma'],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        }
      ],
      education: [
        {
          schoolName: 'Arbana',
          degree: null,
          fieldOfStudy: null,
          location: 'Prishtina',
          startDate: null,
          endDate: null,
          summary: null
        },
        {
          schoolName: 'Local College',
          degree: 'BSc',
          fieldOfStudy: 'Computer Science',
          location: 'London',
          startDate: null,
          endDate: null,
          summary: null
        }
      ]
    })
    const fallback = createExtraction({
      experiences: [
        {
          companyName: 'Acme',
          companyUrl: 'https://acme.example',
          title: 'Engineer',
          employmentType: 'full_time',
          location: 'Remote',
          workMode: ['remote'],
          startDate: '2024',
          endDate: null,
          isCurrent: true,
          summary: 'Built product features',
          achievements: ['Shipped new flows'],
          skills: ['React'],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        },
        {
          companyName: 'Ops Co',
          companyUrl: null,
          title: 'Operations Lead',
          employmentType: null,
          location: 'Berlin',
          workMode: ['hybrid'],
          startDate: '2021',
          endDate: '2022',
          isCurrent: false,
          summary: 'Led operations',
          achievements: ['Scaled hiring'],
          skills: ['Leadership'],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        }
      ],
      education: [
        {
          schoolName: 'Arbana College',
          degree: 'BSc',
          fieldOfStudy: 'Computer Science',
          location: 'Prishtina',
          startDate: null,
          endDate: null,
          summary: 'Graduated with honors'
        },
        {
          schoolName: 'Graduate School',
          degree: 'MSc',
          fieldOfStudy: 'Design Systems',
          location: 'Berlin',
          startDate: null,
          endDate: null,
          summary: null
        }
      ]
    })

    const result = completeResumeExtraction(primary, fallback)

    expect(result.experiences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Software Engineer', companyName: 'Acme', isCurrent: true }),
        expect.objectContaining({ title: 'Designer', companyName: 'DesignCo' }),
        expect.objectContaining({ title: 'Operations Lead', companyName: 'Ops Co' })
      ])
    )
    expect(result.education).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schoolName: 'Arbana College', degree: 'BSc' }),
        expect.objectContaining({ schoolName: 'Local College', degree: 'BSc' }),
        expect.objectContaining({ schoolName: 'Graduate School', degree: 'MSc' })
      ])
    )
  })

  test('preserves unmatched fallback links without urls while still merging null-url positions', () => {
    const primary = createExtraction({
      links: [
        {
          label: null,
          url: null,
          kind: null
        },
        {
          label: 'GitHub',
          url: 'https://github.com/alex-vanguard',
          kind: null
        }
      ]
    })
    const fallback = createExtraction({
      links: [
        {
          label: 'Portfolio',
          url: null,
          kind: 'portfolio'
        },
        {
          label: 'Personal website',
          url: null,
          kind: 'website'
        },
        {
          label: null,
          url: 'https://github.com/alex-vanguard',
          kind: 'github'
        }
      ]
    })

    const result = completeResumeExtraction(primary, fallback)

    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Portfolio', url: null, kind: 'portfolio' }),
        expect.objectContaining({ label: 'Personal website', url: null, kind: 'website' }),
        expect.objectContaining({ label: 'GitHub', url: 'https://github.com/alex-vanguard', kind: 'github' })
      ])
    )
    expect(result.links.filter((entry) => entry.url === null)).toHaveLength(2)
  })

  test('backfills missing experience title and start date from the matched fallback entry', () => {
    const primary = createExtraction({
      experiences: [
        {
          companyName: 'Acme',
          companyUrl: null,
          title: null,
          employmentType: null,
          location: 'Remote',
          workMode: [],
          startDate: null,
          endDate: null,
          isCurrent: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        }
      ]
    })
    const fallback = createExtraction({
      experiences: [
        {
          companyName: 'Acme',
          companyUrl: null,
          title: 'Senior Engineer',
          employmentType: null,
          location: 'Remote',
          workMode: [],
          startDate: '2023',
          endDate: null,
          isCurrent: true,
          summary: 'Led platform work',
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        }
      ]
    })

    const result = completeResumeExtraction(primary, fallback)

    expect(result.experiences[0]).toMatchObject({
      title: 'Senior Engineer',
      startDate: '2023',
      isCurrent: true
    })
  })

  test('does not graft a concrete fallback url onto a null-url link by position', () => {
    const primary = createExtraction({
      links: [
        {
          label: 'Portfolio',
          url: null,
          kind: null
        }
      ]
    })
    const fallback = createExtraction({
      links: [
        {
          label: 'GitHub',
          url: 'https://github.com/alex-vanguard',
          kind: 'github'
        }
      ]
    })

    const result = completeResumeExtraction(primary, fallback)

    expect(result.links).toEqual([
      expect.objectContaining({ label: 'Portfolio', url: null, kind: null }),
      expect.objectContaining({ label: 'GitHub', url: 'https://github.com/alex-vanguard', kind: 'github' })
    ])
  })

  test('normalizes single and array workMode values into arrays during extraction parsing', () => {
    const parsed = ResumeProfileExtractionSchema.parse({
      ...createExtraction(),
      experiences: [
        {
          companyName: 'Acme',
          companyUrl: null,
          title: 'Engineer',
          employmentType: null,
          location: 'Remote',
          workMode: 'remote',
          startDate: '2024',
          endDate: null,
          isCurrent: true,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        },
        {
          companyName: 'Beta',
          companyUrl: null,
          title: 'Designer',
          employmentType: null,
          location: 'Hybrid',
          workMode: ['hybrid'],
          startDate: '2022',
          endDate: '2023',
          isCurrent: false,
          summary: null,
          achievements: [],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null
        }
      ]
    })

    expect(parsed.experiences[0]?.workMode).toEqual(['remote'])
    expect(parsed.experiences[1]?.workMode).toEqual(['hybrid'])
  })
})
