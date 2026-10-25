import { describe, expect, it } from "vitest";

import {
  ApplicationAuthorityEnvelopePolicyInputSchema,
  CreateApplicationAuthorityEnvelopeInputSchema,
  ResolveSubmissionOutcomeInputSchema,
  UpdateApplicationAuthorityEnvelopeInputSchema,
} from "./index";

const VALID_SHA = "a".repeat(64);
const VALID_POLICY = {
  mode: "prepare_only" as const,
  scope: { campaignId: null, jobIds: [] },
  maxApplicationsPerRun: 1,
  intermediateMutationsAuthorized: false,
  allowedResumeSha256: [VALID_SHA],
  allowedOrigins: ["https://boards.example.com"],
  expiresAt: null,
};

describe("application authority management inputs", () => {
  it("defaults only the safe prepare-only mode", () => {
    const parsed = ApplicationAuthorityEnvelopePolicyInputSchema.parse({
      ...VALID_POLICY,
      mode: undefined,
    });
    expect(parsed.mode).toBe("prepare_only");
    expect(CreateApplicationAuthorityEnvelopeInputSchema.parse(parsed)).toEqual(
      parsed,
    );
  });

  it.each([
    "decisionPolicy",
    "submitAuthorized",
    "allowAutoSubmitOverride",
    "legacyApprovalMode",
  ])("rejects legacy or uncontracted field %s", (field) => {
    const result = ApplicationAuthorityEnvelopePolicyInputSchema.safeParse({
      ...VALID_POLICY,
      [field]: true,
    });
    expect(result.success).toBe(false);
  });

  it("does not accept lifecycle fields from a renderer update", () => {
    const result = UpdateApplicationAuthorityEnvelopeInputSchema.safeParse({
      id: "authority_1",
      expectedRevision: 1,
      ...VALID_POLICY,
      status: "active",
      revision: 2,
      createdAt: "2026-08-27T10:00:00.000Z",
      revokedAt: null,
      accountCreationAuthorized: false,
    });
    expect(result.success).toBe(false);
  });

  it.each(["answerPolicy", "stopConditions"])(
    "rejects renderer-supplied %s instead of minting policy identity",
    (field) => {
      const result = ApplicationAuthorityEnvelopePolicyInputSchema.safeParse({
        ...VALID_POLICY,
        [field]: {},
      });
      expect(result.success).toBe(false);
    },
  );

  it("keeps elevated mode data structurally inspectable for main to reject", () => {
    const parsed = ApplicationAuthorityEnvelopePolicyInputSchema.parse({
      ...VALID_POLICY,
      mode: "autonomous_submit",
      scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
      allowedResumeSha256: [VALID_SHA],
      expiresAt: "2026-08-28T10:00:00.000Z",
    });
    expect(parsed.mode).toBe("autonomous_submit");
    expect("decisionPolicy" in parsed).toBe(false);
  });

  it("requires explicit scope, resume, and expiry before requesting bounded ATS autosave", () => {
    const rejected = ApplicationAuthorityEnvelopePolicyInputSchema.safeParse({
      ...VALID_POLICY,
      allowedResumeSha256: [],
      intermediateMutationsAuthorized: true,
    });
    expect(rejected.success).toBe(false);
    if (rejected.success) {
      throw new Error("Expected unsafe autosave policy to be rejected.");
    }
    expect(rejected.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["expiresAt", "scope", "allowedResumeSha256"]),
    );

    expect(
      ApplicationAuthorityEnvelopePolicyInputSchema.parse({
        ...VALID_POLICY,
        expiresAt: "2026-08-28T10:00:00.000Z",
        intermediateMutationsAuthorized: true,
        scope: { campaignId: null, jobIds: ["job_1"] },
      }).intermediateMutationsAuthorized,
    ).toBe(true);

    expect(
      ApplicationAuthorityEnvelopePolicyInputSchema.safeParse({
        ...VALID_POLICY,
        allowedOrigins: [
          "https://boards.example.com",
          "https://other.example.com",
        ],
        expiresAt: "2026-08-28T10:00:00.000Z",
        intermediateMutationsAuthorized: true,
        scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
      }).success,
    ).toBe(false);
  });

  it("accepts only a redacted employer-site verification choice", () => {
    expect(
      ResolveSubmissionOutcomeInputSchema.parse({
        uncertainOutcomeId: "outcome_uncertain",
        resolution: "not_submitted",
        confirmedOnEmployerSite: true,
      }),
    ).toEqual({
      uncertainOutcomeId: "outcome_uncertain",
      resolution: "not_submitted",
      confirmedOnEmployerSite: true,
    });
    expect(
      ResolveSubmissionOutcomeInputSchema.safeParse({
        uncertainOutcomeId: "outcome_uncertain",
        resolution: "submitted",
        confirmedOnEmployerSite: false,
      }).success,
    ).toBe(false);
    expect(
      ResolveSubmissionOutcomeInputSchema.safeParse({
        uncertainOutcomeId: "outcome_uncertain",
        resolution: "submitted",
        confirmedOnEmployerSite: true,
        evidence: [{ summary: "renderer forged evidence" }],
      }).success,
    ).toBe(false);
  });
});
