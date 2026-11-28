import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import { applicationOwnerFacts } from "../apply/application-facts";
import { APPLICATION_ELIGIBILITY_INSTRUCTIONS } from "../apply/eligibility-instructions";
import { buildListingFitPerson } from "./listing-fit-person";

const rule =
  "Remote from Kosovo I need no sponsorship for any employer. To work in the UK I would need sponsorship, and I'm open to it.";
const profile = (workAuthorizationInOwnWords: string | null) =>
  CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    currentCountry: "Kosovo",
    yearsExperience: 8,
    workEligibility: {
      authorizedWorkCountries: ["Kosovo"],
      requiresVisaSponsorship: false,
      workAuthorizationInOwnWords,
    },
    baseResume: {
      id: "synthetic",
      fileName: "synthetic.txt",
      uploadedAt: "2026-11-28T00:00:00Z",
    },
  });

test("fit and application models get the person's own work rule (R10)", () => {
  expect(buildListingFitPerson(profile(rule)).workEligibility).toMatchObject({
    authorizedWorkCountries: ["Kosovo"],
    workAuthorizationInOwnWords: rule,
  });
  const facts = applicationOwnerFacts({
    profile: profile(rule),
    reusableAnswers: [],
  } as never);
  expect(facts.workEligibility).toMatchObject({
    workAuthorizationInOwnWords: rule,
  });
  expect(APPLICATION_ELIGIBILITY_INSTRUCTIONS).toContain(
    "workEligibility.workAuthorizationInOwnWords, when present, is the person's own statement",
  );
  expect(APPLICATION_ELIGIBILITY_INSTRUCTIONS).toContain(
    "Answer for this job's actual arrangement.",
  );
});

test("fit gets the person's citizenship, and no key when none is saved", () => {
  expect(buildListingFitPerson(profile(null))).not.toHaveProperty(
    "citizenshipCountries",
  );
  const person = buildListingFitPerson({
    ...profile(null),
    citizenshipCountries: ["Kosovo"],
  });
  expect(person).toMatchObject({ citizenshipCountries: ["Kosovo"] });
});

test("an empty rule leaves the fit key as it was, so an upgrade re-scores nothing", () => {
  const person = buildListingFitPerson(profile(null));
  expect(person.workEligibility).not.toHaveProperty(
    "workAuthorizationInOwnWords",
  );
  expect(Object.keys(person.workEligibility)).toEqual([
    "authorizedWorkCountries",
    "requiresVisaSponsorship",
    "willingToRelocate",
    "preferredRelocationRegions",
    "willingToTravel",
    "remoteEligible",
    "noticePeriodDays",
    "availableStartDate",
    "securityClearance",
  ]);
});
