import { describe, expect, test } from "vitest";
import { createPreferences, createProfile } from "../test-fixtures";
import { buildDeterministicResumeProfileExtraction } from "./resume-parser";

function parse(resumeText: string) {
  return buildDeterministicResumeProfileExtraction(
    {
      resumeText,
      existingProfile: createProfile(),
      existingSearchPreferences: createPreferences(),
    },
    "deterministic",
    "Test",
    { preserveExistingValues: false },
  );
}

describe("resume import field quality", () => {
  test("rejoins known software names broken across PDF lines", () => {
    expect(
      parse("Skills\nTypeScript, Kubern\netes, JavaScript\n").skills,
    ).toEqual(["TypeScript", "Kubernetes", "JavaScript"]);
    expect(parse("Skills\nType\nScript, AWS").skills).toEqual([
      "TypeScript",
      "AWS",
    ]);
  });
  test("keeps a student's current dated role and separates spoken languages from software skills", () => {
    const result = parse(
      "Jordan Example\njordan@example.test\nExperience\nWorking Student, Analytics — Example Labs, Berlin — Oct 2024 - present\n- Built useful reports for an operations team.\nSkills\nPython (pandas, scikit-learn), Excel (advanced), English (fluent), French (B2)",
    );
    expect(result.experiences[0]).toMatchObject({
      title: "Working Student, Analytics",
      companyName: "Example Labs",
      isCurrent: true,
    });
    expect(result.skills).toEqual([
      "Python",
      "pandas",
      "scikit-learn",
      "Excel",
      "advanced",
    ]);
    expect(result.spokenLanguages).toEqual([
      expect.objectContaining({ language: "English", proficiency: "fluent" }),
      expect.objectContaining({ language: "French", proficiency: "B2" }),
    ]);
  });
  test("keeps complete institutions and separates a degree's major", () => {
    const result = parse(
      "Education\nM.Sc. Data Science, Technische Universität Example, Berlin — expected graduation March 2027\nB.Sc. Statistics, American University of Example, Beirut, Lebanon — 2023\nMaster of Education, Curriculum and Instruction — Example State University, 2018",
    );
    expect(result.education).toEqual([
      expect.objectContaining({
        schoolName: "Technische Universität Example",
        degree: "M.Sc. Data Science",
        endDate: "March 2027",
        startDate: null,
      }),
      expect.objectContaining({
        schoolName: "American University of Example",
        degree: "B.Sc. Statistics",
        location: "Beirut, Lebanon",
        endDate: "2023",
      }),
      expect.objectContaining({
        schoolName: "Example State University",
        degree: "Master of Education",
        fieldOfStudy: "Curriculum and Instruction",
        endDate: "2018",
      }),
    ]);
  });
  test("imports bare header links without turning software names into websites", () => {
    const result = parse(
      "Jordan Example\nNode.js Developer\njordan.example@example.test | github.com/jordan-example\nlinkedin.com/in/jordan-example\nportfolio.example.test\nSkills\nNode.js, Next.js",
    );
    expect(result.githubUrl).toBe("https://github.com/jordan-example");
    expect(result.linkedinUrl).toBe("https://linkedin.com/in/jordan-example");
    expect(result.personalWebsiteUrl).toBe("https://portfolio.example.test");
    expect(result.links).toHaveLength(3);
  });
  test("keeps Markdown roles outside the old occupation vocabulary", () => {
    const result = parse(
      "# Jordan Example\n## Experience\n### Shift Supervisor — Example Warehouse, Lisbon\n*March 2013 - December 2018*\n- Managed safe operations across two shifts.\n### Warehouse Associate — Example Warehouse, Porto\n*June 2010 - February 2013*\n## Education\n- Licenciatura in Management, Universidade de Example, 2010",
    );
    expect(result.experiences.map(({ title }) => title)).toEqual([
      "Shift Supervisor",
      "Warehouse Associate",
    ]);
    expect(result.education[0]).toMatchObject({
      schoolName: "Universidade de Example",
      degree: "Licenciatura",
      fieldOfStudy: "Management",
    });
  });
});
