import { z } from "zod";
import { SourceInstructionStatusSchema } from "./base";
import type { JobDiscoveryTarget } from "./discovery";

const SiteUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use a public http or https address without credentials.");

export const JobSiteSchema = z.object({
  id: z.number().int().positive(),
  label: z.string().trim().min(1).max(300),
  url: SiteUrlSchema,
  enabled: z.boolean(),
  provider: z.string().max(100).nullable(),
  lane: z.enum(["auto", "http", "browser"]),
  health: z.enum(["unknown", "healthy", "needs_sign_in", "blocked", "failed"]),
  lastSearchedAt: z.string().nullable(),
  signInState: z.enum(["unknown", "not_required", "required", "signed_in"]),
  customInstructions: z.string().nullable(),
  instructionStatus: SourceInstructionStatusSchema,
  validatedInstructionId: z.string().nullable(),
  draftInstructionId: z.string().nullable(),
  lastDebugRunId: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  staleReason: z.string().nullable(),
});
export type JobSite = z.infer<typeof JobSiteSchema>;
export const JobSiteRuntimeUpdateSchema = JobSiteSchema.pick({
  provider: true,
  lane: true,
  health: true,
  lastSearchedAt: true,
  signInState: true,
  instructionStatus: true,
  validatedInstructionId: true,
  draftInstructionId: true,
  lastDebugRunId: true,
  lastVerifiedAt: true,
  staleReason: true,
})
  .partial()
  .strict();
export type JobSiteRuntimeUpdate = z.input<typeof JobSiteRuntimeUpdateSchema>;

/** Runtime/source-debug configuration is built from the site row, never saved in Profile. */
export function jobSiteTarget(site: JobSite): JobDiscoveryTarget {
  return {
    id: String(site.id),
    label: site.label,
    startingUrl: site.url,
    enabled: site.enabled,
    adapterKind: "auto",
    customInstructions: site.customInstructions,
    instructionStatus: site.instructionStatus,
    validatedInstructionId: site.validatedInstructionId,
    draftInstructionId: site.draftInstructionId,
    lastDebugRunId: site.lastDebugRunId,
    lastVerifiedAt: site.lastVerifiedAt,
    staleReason: site.staleReason,
  };
}

/** Selection across pages. "All" needs no array containing every site's id. */
export const JobSiteSelectionSchema = z.union([
  z
    .object({
      all: z.literal(true),
      except: z.array(z.number().int().positive()).default([]),
    })
    .strict(),
  z.object({ ids: z.array(z.number().int().positive()) }).strict(),
]);
export type JobSiteSelection = z.infer<typeof JobSiteSelectionSchema>;

export const JobSiteListQuerySchema = z
  .object({
    text: z.string().trim().max(300).default(""),
    filter: z
      .enum(["all", "enabled", "disabled", "needs_attention"])
      .default("all"),
    selection: JobSiteSelectionSchema.optional(),
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type JobSiteListQuery = z.input<typeof JobSiteListQuerySchema>;

export const JobSiteCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  enabled: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  needs_attention: z.number().int().nonnegative(),
});
export type JobSiteCounts = z.infer<typeof JobSiteCountsSchema>;
export const JobSitePageSchema = z.object({
  rows: z.array(JobSiteSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  enabledTotal: z.number().int().nonnegative(),
  counts: JobSiteCountsSchema,
});
export type JobSitePage = z.infer<typeof JobSitePageSchema>;

export const AddJobSitesInputSchema = z
  .object({
    text: z.string().trim().min(1).max(1_000_000),
  })
  .strict();
export type AddJobSitesInput = z.input<typeof AddJobSitesInputSchema>;
export const AddJobSitesResultSchema = z.object({
  added: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  duplicateUrls: z.array(z.string()),
  invalid: z.array(z.string()),
  firstAddedId: z.number().int().positive().nullable(),
});
export type AddJobSitesResult = z.infer<typeof AddJobSitesResultSchema>;

export const UpdateJobSiteInputSchema = JobSiteSchema.pick({
  label: true,
  url: true,
  enabled: true,
  lane: true,
  customInstructions: true,
})
  .partial()
  .extend({ id: JobSiteSchema.shape.id })
  .strict();
export type UpdateJobSiteInput = z.input<typeof UpdateJobSiteInputSchema>;

/** The same parser powers textarea feedback and the authoritative add command. */
export function canonicalJobSiteUrl(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(value)
    ? value
    : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (
      !SiteUrlSchema.safeParse(url.href).success ||
      /\s|%20|%09|%0a|%0d/iu.test(url.hostname)
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseJobSiteUrls(input: string): {
  urls: string[];
  invalid: string[];
  duplicates: number;
  duplicateUrls: string[];
} {
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const duplicateUrls = new Set<string>();

  for (const rawValue of input.split(/[\n,]+/u)) {
    const value = rawValue.trim();
    if (!value) continue;
    // Addresses cannot contain literal spaces. A list entered without a
    // paste event uses the same parser as pasted input.
    if (/\s/u.test(value)) {
      const entries = value.split(/\s+/u);
      let invalidWords: string[] = [];
      const flushInvalid = () => {
        if (invalidWords.length) invalid.push(invalidWords.join(" "));
        invalidWords = [];
      };
      for (const entry of entries) {
        const address =
          /^https?:\/\//iu.test(entry) || entry.includes(".")
            ? canonicalJobSiteUrl(entry)
            : null;
        if (!address) {
          invalidWords.push(entry);
          continue;
        }
        flushInvalid();
        if (!seen.has(address)) {
          seen.add(address);
          urls.push(address);
        } else {
          duplicates++;
          duplicateUrls.add(address);
        }
      }
      flushInvalid();
      continue;
    }
    const url = canonicalJobSiteUrl(value);
    if (!url) {
      invalid.push(value);
      continue;
    }
    const key = url;
    if (seen.has(key)) {
      duplicates++;
      duplicateUrls.add(url);
      continue;
    }
    seen.add(key);
    urls.push(url);
  }

  return { urls, invalid, duplicates, duplicateUrls: [...duplicateUrls] };
}

export const SetJobSitesEnabledInputSchema = JobSiteListQuerySchema.pick({
  text: true,
  filter: true,
})
  .extend({
    selection: JobSiteSelectionSchema,
    enabled: z.boolean(),
  })
  .strict();
export type SetJobSitesEnabledInput = z.input<
  typeof SetJobSitesEnabledInputSchema
>;

export function jobSiteLabel(address: string): string {
  const url = new URL(address);
  const first = url.pathname.split("/").filter(Boolean)[0];
  return first
    ? `${url.host.replace(/^www\./iu, "")}/${first}`
    : url.hostname.replace(/^www\./iu, "");
}
