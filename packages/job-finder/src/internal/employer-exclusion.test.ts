import { describe, expect, it } from "vitest";
import {
  CompanyEntitySchema,
  genericCompanyNameValues,
  JobSearchPreferencesSchema,
  SavedJobSchema,
  type CompanyEntity,
} from "@nestor/contracts";

import { createSeed } from "../workspace-service.test-fixtures";
import {
  appendExactEmployerExclusion,
  removeExactEmployerExclusion,
  resolveEmployerExclusionPreview,
} from "./employer-exclusion";

const now = "2026-08-23T10:00:00.000Z";

function company(
  id: string,
  canonicalName: string,
  overrides: Partial<CompanyEntity> = {},
): CompanyEntity {
  return CompanyEntitySchema.parse({
    id,
    canonicalName,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function resolve(input: {
  companyName?: string;
  employerDomain?: string | null;
  companies?: CompanyEntity[];
  whitelist?: string[];
}) {
  const seed = createSeed();
  const job = SavedJobSchema.parse({
    ...seed.savedJobs[1],
    company: input.companyName ?? "Northwind Labs",
    employerDomain: input.employerDomain ?? null,
  });
  const preferences = JobSearchPreferencesSchema.parse({
    ...seed.searchPreferences,
    companyWhitelist: input.whitelist ?? [],
  });
  return resolveEmployerExclusionPreview({
    job,
    searchPreferences: preferences,
    companies: input.companies ?? [],
  });
}

describe("resolveEmployerExclusionPreview", () => {
  it("uses only the exact normalized authoritative job company", () => {
    expect(resolve({ companyName: " Northwind Labs, Inc. " })).toMatchObject({
      status: "available",
      displayCompanyName: "Northwind Labs, Inc.",
      normalizedCompanyName: "northwind labs inc",
    });
    expect(
      appendExactEmployerExclusion(
        ["Other"],
        "Northwind Labs, Inc.",
        "northwind labs inc",
      ),
    ).toEqual({ values: ["Other", "Northwind Labs, Inc."], added: true });
    expect(
      removeExactEmployerExclusion(
        ["Northwind Labs", "Northwind Labs, Inc.", "Northwind Labs LLC"],
        "northwind labs inc",
      ),
    ).toEqual(["Northwind Labs", "Northwind Labs LLC"]);
  });

  it("allows a specific exact name with no CompanyEntity", () => {
    expect(resolve({ companyName: "Specific Workshop" }).status).toBe(
      "available",
    );
  });

  it("preserves C++ and C# identity in exact exclusion operations", () => {
    expect(resolve({ companyName: "C++ Works" })).toMatchObject({
      status: "available",
      normalizedCompanyName: "cplusplus works",
    });
    expect(resolve({ companyName: "C# Works" })).toMatchObject({
      status: "available",
      normalizedCompanyName: "csharp works",
    });
  });

  it.each(genericCompanyNameValues)(
    "rejects generic company name %s",
    (companyName) => {
      expect(resolve({ companyName })).toMatchObject({
        status: "unavailable",
        reason: "missing_or_generic_company",
      });
    },
  );

  it("normalizes punctuation, whitespace, and Unicode for exact-name operations", () => {
    expect(resolve({ companyName: "  Café---Works  " })).toMatchObject({
      status: "available",
      normalizedCompanyName: "cafe works",
    });
    expect(
      appendExactEmployerExclusion(
        ["CAFE\u0301   WORKS"],
        "Café Works",
        "cafe works",
      ),
    ).toEqual({ values: ["CAFE\u0301   WORKS"], added: false });
  });

  it.each([
    "Named Staffing Agency",
    "Recruiting Agency Partners",
    "Staffing Agency, Inc.",
  ])("keeps legitimate specific agency name %s available", (companyName) => {
    expect(resolve({ companyName }).status).toBe("available");
  });

  it("rejects exact-name ambiguity, domain ambiguity, and name/domain conflict", () => {
    const first = company("first", "Acme", {
      domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
    });
    const second = company("second", "Acme", {
      domains: [{ domain: "other.example", primary: true, verifiedAt: null }],
    });
    expect(
      resolve({ companyName: "Acme", companies: [first, second] }),
    ).toMatchObject({
      reason: "ambiguous_company_name",
    });
    expect(
      resolve({
        companyName: "Specific",
        employerDomain: "acme.example",
        companies: [
          first,
          company("third", "Third", { domains: first.domains }),
        ],
      }),
    ).toMatchObject({ reason: "ambiguous_employer_domain" });
    expect(
      resolve({
        companyName: "Acme",
        employerDomain: "other.example",
        companies: [
          first,
          company("other", "Other", { domains: second.domains }),
        ],
      }),
    ).toMatchObject({ reason: "company_name_domain_conflict" });
  });

  it("ignores unknown aliases but recognizes user-approved merge aliases", () => {
    const unknown = company("unknown", "Legacy Holdings", {
      aliases: [
        {
          alias: "Acme",
          normalized: "acme",
          confidence: 1,
          identityAuthority: "unknown",
        },
      ],
    });
    expect(
      resolve({ companyName: "Acme", companies: [unknown] }),
    ).toMatchObject({ status: "available" });

    const approved = company("approved", "Acme Incorporated", {
      aliases: [
        {
          alias: "Acme",
          normalized: "acme",
          confidence: 1,
          identityAuthority: "user_approved_merge",
        },
      ],
      mergeReviewCandidates: [
        {
          candidateCompanyId: "candidate",
          reason: "Needs review",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
    });
    expect(
      resolve({ companyName: "Acme", companies: [approved] }),
    ).toMatchObject({
      status: "unavailable",
      reason: "pending_company_merge",
    });
  });

  it("rejects provider-domain-only, pending merge, and whitelist conflicts", () => {
    const acme = company("acme", "Acme", {
      domains: [
        { domain: "provider.example", primary: true, verifiedAt: null },
      ],
      mergeReviewCandidates: [
        {
          candidateCompanyId: "candidate",
          reason: "Needs review",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
    });
    expect(
      resolve({
        companyName: "Specific",
        employerDomain: "provider.example",
        companies: [acme],
      }),
    ).toMatchObject({ reason: "provider_domain_only" });
    expect(resolve({ companyName: "Acme", companies: [acme] })).toMatchObject({
      reason: "pending_company_merge",
    });
    expect(
      resolve({ companyName: "Acme, Inc.", whitelist: ["ACME INC"] }),
    ).toMatchObject({ reason: "company_whitelisted" });
  });

  it("ignores pending merges reached only through an unrelated rejected edge", () => {
    const acme = company("acme", "Acme");
    const other = company("other", "Other", {
      mergeReviewCandidates: [
        {
          candidateCompanyId: "acme",
          reason: "Not the same company",
          decision: "rejected",
          decidedAt: now,
          requiresUserDecision: true,
        },
        {
          candidateCompanyId: "third",
          reason: "Needs review",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
    });

    expect(
      resolve({ companyName: "Acme", companies: [acme, other] }),
    ).toMatchObject({ status: "available" });
  });

  it("rejects a direct pending merge owned by the other company", () => {
    const acme = company("acme", "Acme");
    const other = company("other", "Other", {
      mergeReviewCandidates: [
        {
          candidateCompanyId: "acme",
          reason: "Needs review",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
    });

    expect(
      resolve({ companyName: "Acme", companies: [acme, other] }),
    ).toMatchObject({
      status: "unavailable",
      reason: "pending_company_merge",
    });
  });
});
