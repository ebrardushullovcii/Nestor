import { CandidateProfileSchema } from "./profile";
import type { ResumeDraft, ResumeDraftIdentity } from "./resume";
import type { ResumeRenderDocument } from "./resume-computation";
import type { ResumePreviewIdentityField } from "./resume-preview-targets";
import type { z } from "zod";

/** Profile inputs the renderer can still read after a draft has been saved. */
export const ResumeRenderProfileSchema = CandidateProfileSchema.pick({
  firstName: true,
  middleName: true,
  lastName: true,
  fullName: true,
  preferredDisplayName: true,
  headline: true,
  currentLocation: true,
  email: true,
  phone: true,
  portfolioUrl: true,
  linkedinUrl: true,
  githubUrl: true,
  personalWebsiteUrl: true,
  applicationIdentity: true,
  links: true,
});
export type ResumeRenderProfile = z.infer<typeof ResumeRenderProfileSchema>;

const clean = (value: string | null | undefined) => value?.trim() || null;

/** The editable name parts and preferred contacts win over imported values. */
export function resolveResumeContactIdentity(profile: ResumeRenderProfile) {
  const name = [profile.firstName, profile.middleName, profile.lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return {
    fullName:
      clean(profile.preferredDisplayName) ??
      clean(name) ??
      clean(profile.fullName),
    email:
      clean(profile.applicationIdentity.preferredEmail) ?? clean(profile.email),
    phone:
      clean(profile.applicationIdentity.preferredPhone) ?? clean(profile.phone),
    location: clean(profile.currentLocation),
  };
}

function normalizeContactIdentity(value: string): string {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
    .replace(/(^|[^a-z0-9])c\s*\+\s*\+(?=$|[^a-z0-9])/gi, "$1cplusplus")
    .replace(/(^|[^a-z0-9])c\s*#(?=$|[^a-z0-9])/gi, "$1csharp")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildResumeDraftIdentity(
  profile: ResumeRenderProfile,
): ResumeDraftIdentity {
  const resolvedIdentity = resolveResumeContactIdentity(profile);
  const preferredLinks = profile.applicationIdentity.preferredLinkIds
    .map((linkId) =>
      profile.links.find((link) => link.id === linkId && link.url),
    )
    .filter((link): link is NonNullable<typeof link> => Boolean(link?.url));
  const fallbackLinks = profile.links.filter(
    (link) =>
      link.url &&
      ["portfolio", "github", "website", "case_study"].includes(
        link.kind ?? "",
      ) &&
      !preferredLinks.some((preferredLink) => preferredLink.id === link.id),
  );
  return {
    ...resolvedIdentity,
    headline: profile.headline ?? null,
    portfolioUrl: profile.portfolioUrl,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    personalWebsiteUrl: profile.personalWebsiteUrl,
    additionalLinks: [...preferredLinks, ...fallbackLinks]
      .map((link) => link.url?.trim() ?? "")
      .filter(Boolean)
      .filter(
        (value, index, values) =>
          values.findIndex(
            (entry) =>
              normalizeContactIdentity(entry) ===
              normalizeContactIdentity(value),
          ) === index,
      ),
  };
}

export function buildResumeContactItems(
  identity: ResumeDraftIdentity | null | undefined,
): Array<{ field: ResumePreviewIdentityField; text: string }> {
  if (!identity) return [];
  const items: Array<{
    field: ResumePreviewIdentityField;
    text: string | null;
  }> = [
    { field: "email", text: identity.email },
    { field: "phone", text: identity.phone },
    { field: "portfolioUrl", text: identity.portfolioUrl },
    { field: "personalWebsiteUrl", text: identity.personalWebsiteUrl },
    { field: "githubUrl", text: identity.githubUrl },
    { field: "linkedinUrl", text: identity.linkedinUrl },
    ...identity.additionalLinks.map((text) => ({
      field: "additionalLinks" as const,
      text,
    })),
  ];
  return items
    .flatMap((item) => {
      const text = item.text?.trim();
      return text ? [{ field: item.field, text }] : [];
    })
    .filter(
      (value, index, values) =>
        values.findIndex(
          (entry) =>
            normalizeContactIdentity(entry.text) ===
            normalizeContactIdentity(value.text),
        ) === index,
    );
}

/** Sections are saved text; only these header fallbacks can change with Profile. */
export function buildResumeRenderHeader(
  profile: ResumeRenderProfile,
  draft: Pick<ResumeDraft, "identity">,
): Pick<
  ResumeRenderDocument,
  "fullName" | "headline" | "location" | "contactItems"
> {
  const identity = draft.identity ?? buildResumeDraftIdentity(profile);
  return {
    fullName: identity.fullName ?? profile.fullName ?? "",
    headline: identity.headline ?? profile.headline ?? null,
    location: identity.location ?? profile.currentLocation ?? null,
    contactItems: buildResumeContactItems(identity),
  };
}
