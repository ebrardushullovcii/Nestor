import type { CandidateProfile } from "./profile";

export function followPrimaryContact(input: {
  before: string | null;
  after: string | null;
  preferred: string | null;
  nextPreferred: string | null;
  phone?: boolean;
}): string | null {
  const normalize = (value: string | null) =>
    input.phone
      ? (value ?? "").replace(/\D/gu, "")
      : (value ?? "").trim().toLowerCase();
  return normalize(input.before) !== normalize(input.after) &&
    normalize(input.preferred) === normalize(input.nextPreferred) &&
    (!normalize(input.preferred) ||
      normalize(input.preferred) === normalize(input.before))
    ? input.after
    : input.nextPreferred;
}

/** Mirrored contacts follow a primary edit; deliberate application contacts are kept. */
export function followPrimaryContacts(
  current: CandidateProfile,
  next: CandidateProfile,
): CandidateProfile {
  const preferredEmail = followPrimaryContact({
    before: current.email,
    after: next.email,
    preferred: current.applicationIdentity.preferredEmail,
    nextPreferred: next.applicationIdentity.preferredEmail,
  });
  const preferredPhone = followPrimaryContact({
    before: current.phone,
    after: next.phone,
    preferred: current.applicationIdentity.preferredPhone,
    nextPreferred: next.applicationIdentity.preferredPhone,
    phone: true,
  });
  return preferredEmail === next.applicationIdentity.preferredEmail &&
    preferredPhone === next.applicationIdentity.preferredPhone
    ? next
    : {
        ...next,
        applicationIdentity: {
          ...next.applicationIdentity,
          preferredEmail,
          preferredPhone,
        },
      };
}
