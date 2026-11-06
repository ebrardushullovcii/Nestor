import { describe, expect, test } from "vitest";

import {
  areEquivalentEducationRecords,
  areEquivalentCertificationReadings,
  areEquivalentExperienceRecords,
  canonicalizeRecordDateText,
} from "./resume-record-identity";

describe("resume record identity", () => {
  test("merges delivery-format labels but preserves certificate levels, issuers and dates", () => {
    const base = {
      name: "Workflow Foundations",
      issuer: "Example Academy",
      issueDate: "2024",
    };
    expect(
      areEquivalentCertificationReadings(base, {
        ...base,
        name: "Workflow Foundations (online course)",
      }),
    ).toBe(true);
    expect(
      areEquivalentCertificationReadings(base, {
        ...base,
        name: "Workflow Foundations (Advanced)",
      }),
    ).toBe(false);
    expect(
      areEquivalentCertificationReadings(base, {
        ...base,
        name: "Workflow Foundations (online course)",
        issuer: "Other Academy",
      }),
    ).toBe(false);
    expect(
      areEquivalentCertificationReadings(base, {
        ...base,
        name: "Workflow Foundations (online course)",
        issueDate: "2025",
      }),
    ).toBe(false);
  });

  const locatedRole = {
    companyName: "Signal Systems",
    title: "Senior Full-stack Engineer",
    location: "Berlin, Germany",
    startDate: "2020-01",
    endDate: "2026-09",
    isCurrent: false,
  };
  const roleWithLocationInEmployer = {
    ...locatedRole,
    companyName: "Signal Systems, Berlin, Germany",
    title: "Senior Full-Stack Engineer",
    location: null,
  };

  test("merges the same dated role when one employer includes the other record's exact location", () => {
    expect(
      areEquivalentExperienceRecords(locatedRole, roleWithLocationInEmployer),
    ).toBe(true);
    expect(
      areEquivalentExperienceRecords(roleWithLocationInEmployer, locatedRole),
    ).toBe(true);
  });

  test.each([
    [
      "an unknown employer suffix",
      { companyName: "Signal Systems, Consulting" },
    ],
    [
      "a different employer",
      { companyName: "Signal Holdings, Berlin, Germany" },
    ],
    ["a different office", { location: "Munich, Germany" }],
    ["a different title", { title: "Staff Platform Engineer" }],
    ["a different start month", { startDate: "2021-01" }],
    ["a different end month", { endDate: "2025-09" }],
  ])("keeps a location-suffixed role separate with %s", (_label, change) => {
    expect(
      areEquivalentExperienceRecords(locatedRole, {
        ...roleWithLocationInEmployer,
        ...change,
      }),
    ).toBe(false);
  });

  test("does not guess that an employer suffix is a location when neither record states one", () => {
    expect(
      areEquivalentExperienceRecords(
        { ...locatedRole, location: null },
        roleWithLocationInEmployer,
      ),
    ).toBe(false);
  });

  test("treats a skeleton with no employer as the same role when title and start month match", () => {
    expect(
      areEquivalentExperienceRecords(
        {
          companyName: null,
          title: "Marketing Manager",
          startDate: "2021-03",
          endDate: null,
          isCurrent: false,
        },
        {
          companyName: "Northstar Learning Tools",
          title: "Marketing Manager",
          startDate: "March 2021",
          endDate: null,
          isCurrent: true,
        },
      ),
    ).toBe(true);
  });

  test("keeps two roles with the same title apart when both name different employers", () => {
    expect(
      areEquivalentExperienceRecords(
        {
          companyName: "Acme",
          title: "Engineer",
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
        },
        {
          companyName: "Globex",
          title: "Engineer",
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
        },
      ),
    ).toBe(false);
  });

  test("canonicalizes month names and keeps non-date text", () => {
    expect(canonicalizeRecordDateText("March 2021")).toBe("2021-03");
    expect(canonicalizeRecordDateText("2021-03-01")).toBe("2021-03");
    expect(canonicalizeRecordDateText("Summer internship")).toBe(
      "Summer internship",
    );
    expect(canonicalizeRecordDateText("")).toBeNull();
  });

  test("treats M/D/YYYY slash dates as month-first when the first capture is a valid month", () => {
    expect(
      areEquivalentExperienceRecords(
        {
          companyName: "Example Co",
          title: "Engineer",
          startDate: "5/10/2020",
          endDate: "6/15/2021",
          isCurrent: false,
        },
        {
          companyName: "Example Co",
          title: "Engineer",
          startDate: "2020-05",
          endDate: "2021-06",
          isCurrent: false,
        },
      ),
    ).toBe(true);
  });

  test("treats zero-padded imported dates as D/M/YYYY when both positions are ambiguous", () => {
    expect(
      areEquivalentExperienceRecords(
        {
          companyName: "Example Co",
          title: "Engineer",
          startDate: "01/07/2023",
          endDate: "30/06/2024",
          isCurrent: false,
        },
        {
          companyName: "Example Co",
          title: "Engineer",
          startDate: "2023-07",
          endDate: "2024-06",
          isCurrent: false,
        },
      ),
    ).toBe(true);
  });
});

describe("areEquivalentEducationRecords stubs", () => {
  test("treats a dateless, fieldless stub of the same degree at the same school as the same record", () => {
    expect(
      areEquivalentEducationRecords(
        {
          schoolName: "University of Texas at Austin",
          degree: "Bachelor of Science",
          fieldOfStudy: "Computer Science",
          startDate: "2012-08",
          endDate: "2016-05",
        },
        {
          schoolName: "University of Texas at Austin",
          degree: "Bachelor of Science",
          fieldOfStudy: null,
          startDate: null,
          endDate: null,
        },
      ),
    ).toBe(true);
  });
});

describe("complementary education readings", () => {
  const qualification = {
    schoolName: "Synthetic College",
    degree: "Associate of Applied Science",
    fieldOfStudy: "Supply Chain Management",
    endDate: null,
  };
  test("keeps complementary readings separate without shared source evidence", () => {
    const yearOnly = { schoolName: "Synthetic College", endDate: "2018" };
    expect(areEquivalentEducationRecords(yearOnly, qualification)).toBe(false);
    expect(areEquivalentEducationRecords(qualification, yearOnly)).toBe(false);
  });
  test.each([{ startDate: "2016" }, { endDate: "2018" }])(
    "matches a dated stub to the same entry by its dates: %j",
    (date) => {
      // A re-import that read only the school and dates must still find the
      // saved full record; the stub adds no qualification to invent.
      const dateOnly = { schoolName: "Synthetic College", ...date };
      const datedQualification = { ...qualification, ...date };
      expect(areEquivalentEducationRecords(dateOnly, datedQualification)).toBe(
        true,
      );
      expect(areEquivalentEducationRecords(datedQualification, dateOnly)).toBe(
        true,
      );
    },
  );
  test("does not join a degree-only and a field-only reading by a shared year", () => {
    const degreeOnly = {
      schoolName: "Synthetic University",
      degree: "Bachelor of Science",
      endDate: "2018",
    };
    const fieldOnly = {
      schoolName: "Synthetic University",
      fieldOfStudy: "Business Administration",
      endDate: "2018",
    };
    expect(areEquivalentEducationRecords(degreeOnly, fieldOnly)).toBe(false);
    expect(areEquivalentEducationRecords(fieldOnly, degreeOnly)).toBe(false);
  });
  test.each([
    { degree: "Bachelor of Science" },
    { fieldOfStudy: "Computer Science" },
    { endDate: "2020" },
  ])("keeps conflicting entries separate: %j", (change) => {
    const dated = { ...qualification, endDate: "2018" };
    expect(areEquivalentEducationRecords(dated, { ...dated, ...change })).toBe(
      false,
    );
  });
});

describe("comma specialties in role identity", () => {
  test("keeps Platform and Security manager roles distinct at the same employer", () => {
    const record = {
      companyName: "Acme Corp",
      title: "Engineering Manager, Platform",
      startDate: "2021-01",
      endDate: "2025-12",
    };
    expect(
      areEquivalentExperienceRecords(record, {
        ...record,
        title: "Engineering Manager, Security",
      }),
    ).toBe(false);
  });
  test("matches a combined comma employer when companyName is absent", () => {
    const record = {
      companyName: "Acme Corp",
      title: "Senior Engineer",
      startDate: "2021-01",
      endDate: "2025-12",
    };
    expect(
      areEquivalentExperienceRecords(record, {
        ...record,
        title: "Senior Engineer, Acme Corp",
        companyName: null,
      }),
    ).toBe(true);
  });
});
