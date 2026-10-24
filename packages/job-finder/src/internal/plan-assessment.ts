import type { SavedJob, MatchAssessment } from "@nestor/contracts";
import { copyView } from "@nestor/core";
const planViews = new WeakMap<
  SavedJob,
  {
    assessment: MatchAssessment;
    view: SavedJob;
  }
>();
export function withPlanAssessment<T extends SavedJob>(
  job: T,
  planId: string | null,
  assessment: MatchAssessment = job.matchAssessment,
  sharedAssessment: MatchAssessment = job.matchAssessment,
): T {
  const matchAssessment = planId ? sharedAssessment : assessment;
  const planChanged = planId
    ? job.planAssessments?.[planId] !== assessment
    : false;
  if (job.matchAssessment === matchAssessment && !planChanged)
    return job;
  return copyView(job, {
    matchAssessment,
    ...(planChanged && planId
      ? { planAssessments: { ...job.planAssessments, [planId]: assessment } }
      : {}),
  });
}
export function readPlanAssessment<T extends SavedJob>(
  job: T,
  planId: string | null,
): T {
  const assessment = planId ? job.planAssessments?.[planId] : null;
  // A plan without its own verdict shows the shared one, which plan-scoped
  // writes no longer change. Jobs judged before plans kept their own
  // verdicts keep showing that judgment instead of losing their fit.
  if (!assessment || assessment === job.matchAssessment) return job;
  if (Object.isFrozen(job)) {
    const previous = planViews.get(job);
    // A cached view was made by spreading this exact source object, so it
    // retains the caller's additional fields as well as the SavedJob fields.
    if (previous?.assessment === assessment) return previous.view as T;
    const view: T = copyView(job, { matchAssessment: assessment });
    Object.freeze(view);
    planViews.set(job, { assessment, view });
    return view;
  }
  return { ...job, matchAssessment: assessment };
}
export function personPickedJob(job: SavedJob): boolean {
  return personSuppliedJob(job) || job.status !== "discovered";
}

/** A job the person brought in themselves: a pasted link or a page they read. */
export function personSuppliedJob(job: SavedJob): boolean {
  return (
    job.personSupplied === true ||
    job.provenance.some((source) => source.targetId === "assistant_page")
  );
}
