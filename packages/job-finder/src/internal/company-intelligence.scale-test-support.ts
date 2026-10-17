import {
  ApplicationRecordSchema,
  SavedJobSchema,
  type SavedJob,
} from "@nordri/contracts";

export const companyScaleNow = "2026-10-13T10:00:00.000Z";

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Synthetic only. Reusable by private repository/snapshot QA without AI. */
export function createCompanyScaleFixture(input: {
  jobCount: number;
  companyCount?: number;
  sharedListingHosts?: boolean;
  freeze?: boolean;
}) {
  const companyCount = input.companyCount ?? input.jobCount;
  const sharedHosts = input.sharedListingHosts ?? true;
  const body =
    "Synthetic engineering responsibilities and qualifications. ".repeat(400);
  const template = SavedJobSchema.parse({
    id: "synthetic_template",
    source: "target_site",
    sourceJobId: "synthetic_template",
    discoveryMethod: "catalog_seed",
    canonicalUrl: "https://listing.example/template",
    applicationUrl: null,
    title: "Engineer",
    company: "Synthetic company 0",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    discoveredAt: companyScaleNow,
    salaryText: null,
    description: body,
    keySkills: ["TypeScript"],
    responsibilities: ["Develop synthetic software"],
    minimumQualifications: [],
    preferredQualifications: [],
    benefits: [],
    status: "discovered",
    matchAssessment: { score: 80 },
    provenance: [],
  });
  const jobs: SavedJob[] = [];
  for (let index = 0; index < input.jobCount; index += 1) {
    const employer = index % companyCount;
    const company = `Synthetic company ${employer}`;
    const canonicalUrl = `https://listing.example/employer/${employer}/job/${index}`;
    const applicationUrl = `https://apply.example/employer/${employer}/job/${index}`;
    const sighting = {
      targetId: "synthetic_source",
      adapterKind: "auto" as const,
      startingUrl: "https://source.example/jobs",
      discoveredAt: companyScaleNow,
      listingUrl: canonicalUrl,
      applicationUrl,
      pageApplyUrl: applicationUrl,
      listingFacts: {
        title: `Engineer ${index}`,
        company,
        location: "Remote",
        salaryText: null,
        seniority: null,
        description: body,
        summary: null,
      },
    };
    const job = SavedJobSchema.parse({
      ...template,
      id: `synthetic_job_${index}`,
      sourceJobId: `posting_${index}`,
      title: `Engineer ${index}`,
      company,
      canonicalUrl,
      applicationUrl,
      employerDomain: sharedHosts
        ? ["listing.example", "apply.example", "source.example"][index % 3]
        : null,
      firstSeenAt: companyScaleNow,
      lastSeenAt: companyScaleNow,
      status: index % 4 === 0 ? "rejected" : "discovered",
      // Repeated sightings retain their full listing facts in canonical data.
      provenance: [
        sighting,
        sighting,
        { ...sighting, targetId: "synthetic_duplicate" },
        sighting,
      ],
    });
    jobs.push(input.freeze === false ? job : freezeTree(job));
  }
  const applicationRecords = jobs
    .filter((_, index) => index % 5 === 0)
    .map((job) => {
      const record = ApplicationRecordSchema.parse({
        id: `application_${job.id}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "submitted",
        lastActionLabel: "Tracked locally",
        nextActionLabel: null,
        lastUpdatedAt: companyScaleNow,
      });
      return input.freeze === false ? record : freezeTree(record);
    });
  return { jobs, applicationRecords, companyCount };
}
