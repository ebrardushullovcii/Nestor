/**
 * Local stand-ins for the ADR 0022 contract names while they are still being
 * added to `@nestor/contracts` by the package owner.
 *
 * TODO(ADR 0022): delete this module and import `ApplyMode`, the apply-facts
 * record and the five per-job apply states from `@nestor/contracts` once
 * they land there. Nothing here describes behaviour — these are only the
 * names and shapes the renderer needs so the apply surface can be built
 * against them; no renderer file may define product types of its own once the
 * package exports them (AGENTS.md: shared types come from `packages/contracts`).
 */

/** The one switch in Settings: off fills the form, on also sends it. */
export type ApplyMode = "fill_only" | "apply_for_me";

/** The one-time facts a form commonly asks, saved once and reused. */
export interface ApplyFactsRecord {
  workAuthorization: string;
  needsSponsorship: string;
  noticePeriod: string;
  payExpectation: string;
  relocation: string;
  /** May Job Finder certify the person's answers are true and accept terms. */
  mayAttest: boolean;
  /** May voluntary self-identification questions be answered from the profile. */
  maySelfIdentify: boolean;
}

/**
 * The five states an application can be in, and the only five. Everything the
 * apply surface shows — Applications, Home, the Tasks card — is one of these.
 */
export type ApplyJobStateKind =
  | "filling_in"
  | "ready_to_send"
  | "applied"
  | "needs_you"
  | "could_not_apply";
