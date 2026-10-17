// The listing-evidence-depth assessment moved to `@nestor/contracts` so
// the browser workflow that collects postings and the orchestration that
// persists them classify identical fields the same way. This module stays as
// the package-local import path; the behaviour is unchanged.
export { assessJobPostingDetailQuality } from "@nestor/contracts";
