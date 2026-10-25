import { describe, expect, test } from "vitest";

import { chunkText, createLocalKnowledgeIndex } from "./index";

describe("chunkText", () => {
  test("splits long text into deterministic overlapping chunks", () => {
    const chunks = chunkText(
      [
        "Signal Systems builds workflow software for operational teams.",
        "The platform emphasizes reliability, incident response, and cross-functional execution.",
        "Design partners collaborate with engineering and product on dense admin experiences.",
      ].join(" "),
      {
        maxChars: 90,
        overlapChars: 20,
      },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("workflow software");
    expect(chunks[1]?.text).toContain("reliability");
    expect(chunks[1]?.text).toContain("admin experiences");
    expect(chunks[1]?.startOffset).toBeLessThan(chunks[0]?.endOffset ?? 0);
  });
});

describe("createLocalKnowledgeIndex", () => {
  test("retrieves the most relevant passages and respects tag filters", () => {
    const index = createLocalKnowledgeIndex({
      chunking: { maxChars: 100, overlapChars: 20 },
    });

    index.addDocument(
      "job_1",
      "Signal Systems needs a product designer who can improve workflow tooling, incident response coordination, and operational clarity.",
      {
        tags: ["job"],
        title: "Job Description",
        section: "summary",
      },
    );
    index.addDocument(
      "profile_1",
      "Alex led workflow redesigns for internal tooling and partnered with engineering on dense admin surfaces.",
      {
        tags: ["profile"],
        title: "Experience",
        section: "experience",
      },
    );
    index.addDocument(
      "research_1",
      "The company describes its platform as mission-critical software for operations teams and incident management.",
      {
        tags: ["research"],
        title: "About Company",
        section: "mission",
      },
    );

    const allResults = index.search("workflow incident operations", {
      limit: 3,
    });
    const profileOnlyResults = index.search("workflow admin engineering", {
      tags: ["profile"],
      limit: 3,
    });

    expect(allResults).toHaveLength(3);
    expect(allResults[0]?.documentId).toBe("job_1");
    expect(profileOnlyResults).toHaveLength(1);
    expect(profileOnlyResults[0]?.documentId).toBe("profile_1");
    expect(profileOnlyResults[0]?.metadata.tags).toEqual(["profile"]);
  });

  test("replaces existing document content when the same id is re-added", () => {
    const index = createLocalKnowledgeIndex();

    index.addDocument("job_1", "React and Electron desktop workflow role.", {
      tags: ["job"],
    });
    index.addDocument("job_1", "Python and data pipelines role.", {
      tags: ["job"],
    });

    expect(index.search("React desktop")).toEqual([]);
    expect(index.search("Python pipelines")[0]?.documentId).toBe("job_1");
  });

  test("clears all indexed content", () => {
    const index = createLocalKnowledgeIndex();

    index.addDocument("resume_1", "Built design systems in React.", {
      tags: ["resume"],
    });
    expect(index.search("design systems")).toHaveLength(1);

    index.clear();

    expect(index.search("design systems")).toEqual([]);
  });

  test("a document added after a search is found by the next search", () => {
    const index = createLocalKnowledgeIndex();
    index.addDocument("resume_1", "Built design systems in React.", {
      tags: ["resume"],
    });
    expect(index.search("payments")).toEqual([]);

    index.addDocument("job_1", "Own the payments platform.", {
      tags: ["job"],
    });

    expect(index.search("payments").map((result) => result.documentId)).toEqual(
      ["job_1"],
    );
    expect(index.search("design systems")).toHaveLength(1);
  });
});
