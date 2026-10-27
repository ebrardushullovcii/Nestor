// Seeds a job store with a synthetic hunt of a given size for `perf`:
// a finished guided setup, N jobs across every stage with fits, M job sites,
// searches, approved resumes and tracked applications. Invented names only.
import {
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  createFreshStartCandidateProfile,
  type FoundJob,
} from "@nestor/contracts";
import {
  approveOriginalResumesForTests,
  createJobFinderRepository,
  createJobSitesStore,
  openJobStore,
  seedTrackerDemo,
} from "@nestor/db/job-store";

const TITLES = [
  "Frontend Engineer",
  "Platform Engineer",
  "Data Engineer",
  "Product Designer",
  "Backend Engineer",
  "Engineering Manager",
  "Site Reliability Engineer",
  "Mobile Engineer",
];
const PLACES = ["Remote", "Berlin, Germany", "Lisbon, Portugal", "London, UK"];

// About the size of a real listing's text (3-6 KB).
function description(n: number): string {
  const paragraph = `Role ${n} works on a fictional product with a small team. You will build, test and ship features, review code, and talk to the people who use it. `;
  return Array.from({ length: 24 + (n % 16) }, () => paragraph).join("\n");
}

export async function seedPerfWorkspace(input: {
  file: string;
  jobs: number;
  sites: number;
}): Promise<Record<string, number>> {
  const store = openJobStore(input.file);
  const started = performance.now();
  try {
    const repository = createJobFinderRepository(store);
    const fresh = createFreshStartCandidateProfile();
    await repository.saveProfileAndSearchPreferences(
      {
        ...fresh,
        firstName: "Riley",
        lastName: "Okafor",
        fullName: "Riley Okafor",
        headline: "Frontend engineer",
        summary: "Builds calm tools for busy teams.",
        currentLocation: "Lisbon, Portugal",
        email: "riley.okafor@example.test",
        skills: ["TypeScript", "React", "Accessibility"],
      },
      JobSearchPreferencesSchema.parse({
        targetRoles: ["Frontend Engineer"],
        locations: ["Remote"],
        workModes: ["remote"],
        minimumSalaryUsd: null,
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
      }),
    );
    await repository.saveSettings(
      JobFinderSettingsSchema.parse({
        resumeTemplateId: "classic_ats",
        resumeFormat: "pdf",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        keepSessionAlive: false,
        discoveryOnly: false,
        // Resume writing would run the whole time; a hunt's shortlist has
        // its resumes already.
        writeResumesOnShortlist: false,
      }),
    );
    await repository.saveProfileSetupState(
      ProfileSetupStateSchema.parse({
        status: "completed",
        currentStep: "ready_check",
        completedAt: "2026-10-01T09:00:00.000Z",
        reviewItems: [],
        lastResumedAt: null,
      }),
    );

    const sites = createJobSitesStore(store);
    for (let from = 0; from < input.sites; from += 200)
      sites.add({
        text: Array.from(
          { length: Math.min(200, input.sites - from) },
          (_, i) => `https://careers${from + i}.example.test/jobs`,
        ).join("\n"),
      });

    const ids: number[] = [];
    for (let from = 0; from < input.jobs; from += 1000) {
      const jobs: FoundJob[] = Array.from(
        { length: Math.min(1000, input.jobs - from) },
        (_, i) => {
          const n = from + i + 1;
          const day = String(1 + (n % 28)).padStart(2, "0");
          return {
            title: `${TITLES[n % TITLES.length]} ${n}`,
            company: `Synthetic Co ${n % 400}`,
            location: PLACES[n % PLACES.length]!,
            workModes: n % 3 === 0 ? ["remote"] : ["hybrid"],
            url: `https://careers${n % Math.max(1, input.sites)}.example.test/jobs/${n}`,
            applyUrl: null,
            sourceId: String(1 + (n % Math.max(1, input.sites))),
            sourceLabel: `careers${n % Math.max(1, input.sites)}.example.test`,
            sourceJobId: `job-${n}`,
            postedAt: `2026-10-${day}T08:00:00.000Z`,
            salaryText: n % 4 === 0 ? "€60,000 - €80,000" : null,
            salaryMin: n % 4 === 0 ? 60000 : null,
            salaryMax: n % 4 === 0 ? 80000 : null,
            salaryCurrency: n % 4 === 0 ? "EUR" : null,
            seniority: null,
            employmentType: "Full-time",
            summary: `A fictional role number ${n}.`,
            description: description(n),
          };
        },
      );
      const saved = store.saveFoundJobs({ searchId: null, jobs });
      store.setFit(
        saved.ids.map((id, i) => {
          const score = 30 + (((from + i) * 37) % 70);
          return {
            id,
            score,
            summary: `Fit ${score}: overlaps on frontend work.`,
            reasons: ["Frontend work matches", "Remote is fine"],
            gaps: score < 60 ? ["Different stack"] : [],
          };
        }),
      );
      ids.push(...saved.ids);
    }

    // A real hunt hides most of what it looks at and keeps a few.
    const share = (fraction: number, offset: number) =>
      ids.filter((_, i) => i % Math.round(1 / fraction) === offset);
    const hidden = share(0.4, 1);
    const shortlisted = share(0.02, 2);
    const approved = share(0.01, 3);
    const applied = share(0.01, 4);
    const move = (moved: number[], to: "hidden" | "shortlisted") => {
      for (let from = 0; from < moved.length; from += 5000)
        store.moveJobs({
          selection: { ids: moved.slice(from, from + 5000) },
          to,
        });
    };
    move(hidden, "hidden");
    move(shortlisted, "shortlisted");
    if (approved.length) {
      move(approved, "shortlisted");
      approveOriginalResumesForTests(store, approved);
      store.setStage(approved, "resume");
    }
    if (applied.length) seedTrackerDemo(store, applied);

    return {
      jobs: ids.length,
      sites: input.sites,
      hidden: hidden.length,
      shortlisted: shortlisted.length,
      approved: approved.length,
      applied: applied.length,
      seedMs: Math.round(performance.now() - started),
    };
  } finally {
    store.close();
  }
}
