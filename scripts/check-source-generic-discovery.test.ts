import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  BRAND_SEGMENT_ALIASES,
  PINNED_DECLARATIONS,
  SOURCE_GENERIC_DISCOVERY_RULES,
  STRICT_STATIC_DATA_TABLES,
  aggregateFindings,
  evaluateFindingsAgainstBaseline,
  evaluateImportEdges,
  findBrandedIdentifiers,
  findStrictStaticTableMisuses,
  findUnpinnedProviderLiterals,
  hashFindingToken,
  isExportedSubpath,
  matchBrandedIdentifier,
  packageNameForPath,
  parseBaseline,
  scanImportEdges,
  shouldScanImportsForFile,
  shouldScanSourceFile,
  splitIdentifierSegments,
} from "./check-source-generic-discovery.mjs";

type BrandMatch = string | null;

function firstFindingLine(content: string): number {
  const findings = [
    ...findBrandedIdentifiers(content),
    ...findUnpinnedProviderLiterals(content),
  ];
  return findings[0]?.line ?? -1;
}

describe("brand segment matching", () => {
  test("splits camelCase, PascalCase, SCREAMING_CASE, and snake_case identifiers", () => {
    expect(splitIdentifierSegments("maxLeverage")).toEqual(["max", "leverage"]);
    expect(splitIdentifierSegments("WORKDAY_HOST")).toEqual([
      "workday",
      "host",
    ]);
    expect(splitIdentifierSegments("iCIMSJob")).toEqual(["i", "cims", "job"]);
    expect(splitIdentifierSegments("fetchLinkedInJobs")).toEqual([
      "fetch",
      "linked",
      "in",
      "jobs",
    ]);
  });

  test("matches brands only at whole consecutive-segment boundaries", () => {
    expect(matchBrandedIdentifier("maxLeverage")).toBeNull();
    expect(matchBrandedIdentifier("cleverTrick")).toBeNull();
    expect(matchBrandedIdentifier("leverage")).toBeNull();
    expect(matchBrandedIdentifier("playerScore")).toBeNull();
    expect(matchBrandedIdentifier("getLinkedInJobs")).toEqual<BrandMatch>(
      "linkedin",
    );
    expect(matchBrandedIdentifier("linkedInUrl")).toEqual<BrandMatch>(
      "linkedin",
    );
    expect(matchBrandedIdentifier("KosovaJobBoard")).toEqual<BrandMatch>(
      "kosovajob",
    );
    expect(matchBrandedIdentifier("parseWorkdayFeed")).toEqual<BrandMatch>(
      "workday",
    );
    for (const alias of BRAND_SEGMENT_ALIASES) {
      expect(matchBrandedIdentifier(`${alias}Helper`)).toEqual<BrandMatch>(
        alias,
      );
    }
  });
});

describe("scan scope and intentional exclusions", () => {
  test("scans browser-agent and job-finder internal sources", () => {
    expect(shouldScanSourceFile("packages/browser-agent/src/agent.ts")).toBe(
      true,
    );
    expect(
      shouldScanSourceFile(
        "packages/browser-agent/src/agent/search-surface-routes.ts",
      ),
    ).toBe(true);
    expect(
      shouldScanSourceFile("packages/job-finder/src/internal/matching.ts"),
    ).toBe(true);
  });

  test("excludes tests, resume- paths, profile- paths, and other packages", () => {
    expect(
      shouldScanSourceFile("packages/job-finder/src/internal/matching.test.ts"),
    ).toBe(false);
    expect(
      shouldScanSourceFile(
        "packages/job-finder/src/internal/resume-import-reconciliation.ts",
      ),
    ).toBe(false);
    expect(
      shouldScanSourceFile("packages/job-finder/src/internal/profile-merge.ts"),
    ).toBe(false);
    expect(
      shouldScanSourceFile(
        "packages/job-finder/src/nested/dir/resume-workspace-helper.ts",
      ),
    ).toBe(false);
    expect(shouldScanSourceFile("apps/desktop/src/main/index.ts")).toBe(false);
    expect(shouldScanSourceFile("packages/db/src/file-repository.ts")).toBe(
      false,
    );
  });

  test("import boundary scan covers runtime and job-finder top level but not tests", () => {
    expect(
      shouldScanImportsForFile(
        "packages/browser-runtime/src/playwright-browser-runtime.ts",
      ),
    ).toBe(true);
    expect(
      shouldScanImportsForFile("packages/job-finder/src/workspace-service.ts"),
    ).toBe(true);
    expect(
      shouldScanImportsForFile("packages/job-finder/src/internal/matching.ts"),
    ).toBe(true);
    expect(
      shouldScanImportsForFile(
        "packages/browser-runtime/src/playwright-application-flow.test.ts",
      ),
    ).toBe(false);
  });

  test("maps scoped paths to package names and null elsewhere", () => {
    expect(packageNameForPath("packages/browser-agent/src/agent.ts")).toBe(
      "browser-agent",
    );
    expect(
      packageNameForPath("packages/browser-runtime/src/runtime-types.ts"),
    ).toBe("browser-runtime");
    expect(
      packageNameForPath("packages/job-finder/src/internal/matching.ts"),
    ).toBe("job-finder");
    expect(
      packageNameForPath("packages/contracts/src/discovery.ts"),
    ).toBeNull();
  });
});

describe("branded identifier scan", () => {
  test("flags declarations, class methods, object keys, enum members, and params", () => {
    const content = [
      "export function fetchLinkedInJobs(linkedInUrl: string) {",
      "  class GreenhouseParser {",
      "    parseWorkdayFeed(workdayTenant: string) {",
      "      enum Sources { Ashby, iCIMS }",
      "      return null as unknown as Sources;",
      "    }",
      "  }",
      "  return new GreenhouseParser();",
      "}",
      "interface LeverOptions { leverBoard: string; }",
      "const options = { ashbyQueue: [] };",
    ].join("\n");

    const findings = findBrandedIdentifiers(content);
    const byName = new Map(findings.map((finding) => [finding.name, finding]));

    expect(byName.get("fetchLinkedInJobs")?.kind).toBe("function");
    expect(byName.get("linkedInUrl")?.kind).toBe("parameter");
    expect(byName.get("GreenhouseParser")?.kind).toBe("class");
    expect(byName.get("parseWorkdayFeed")?.kind).toBe("method");
    expect(byName.get("Ashby")?.kind).toBe("enum member");
    expect(byName.get("iCIMS")?.kind).toBe("enum member");
    expect(byName.get("LeverOptions")?.kind).toBe("interface");
    expect(byName.get("leverBoard")?.kind).toBe("property");
    expect(byName.get("ashbyQueue")?.kind).toBe("object key");
    expect(byName.get("fetchLinkedInJobs")?.context).toBe("<module>");
    expect(byName.get("linkedInUrl")?.context).toBe("fetchLinkedInJobs");
    expect(findings.every((finding) => finding.line > 0)).toBe(true);
  });

  test("passes generic names including near-miss segments", () => {
    const content = [
      "export function fetchBoardJobs(maxLeverage: number) {",
      "  const cleverTrick = maxLeverage > 0;",
      "  return { cleverTrick };",
      "}",
    ].join("\n");
    expect(findBrandedIdentifiers(content)).toEqual([]);
  });

  test("exempts identifiers inside pinned sanctioned tables only", () => {
    const pinned = [
      "export const PUBLIC_API_RESPONSE_ADAPTERS = {",
      "  greenhouse: { itemsPath: ['jobs'] },",
      "  workday: { itemsShape: 'single' },",
      "};",
    ].join("\n");
    expect(findBrandedIdentifiers(pinned)).toEqual([]);

    const unpinned = [
      "export const RESPONSE_ADAPTERS = {",
      "  greenhouse: { itemsPath: ['jobs'] },",
      "};",
    ].join("\n");
    expect(
      findBrandedIdentifiers(unpinned).map((finding) => finding.name),
    ).toEqual(["greenhouse"]);
  });
});

describe("provider literal scan", () => {
  test("flags unpinned provider hosts with enclosing context", () => {
    const content = [
      "function buildStartUrl() {",
      '  return "https://www.linkedin.com/jobs/search/";',
      "}",
    ].join("\n");

    const findings = findUnpinnedProviderLiterals(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("provider-host-literal");
    expect(findings[0]?.context).toBe("buildStartUrl");
    expect(findings[0]?.token).toBe("https://www.linkedin.com/jobs/search/");
    expect(firstFindingLine(content)).toBe(2);
  });

  test("flags standalone brand strings used as detection values", () => {
    const content = [
      "function detectProvider(value: string) {",
      '  if (value.includes("workday")) {',
      '    return "Workday";',
      "  }",
      "  return null;",
      "}",
    ].join("\n");

    const rules = findUnpinnedProviderLiterals(content).map(
      (finding) => finding.rule,
    );
    expect(rules).toEqual(["branded-string-literal", "branded-string-literal"]);
  });

  test("flags branded text inside template literal heads", () => {
    const content = [
      "function apiUrl(boardKey: string) {",
      "  return `https://boards-api.greenhouse.io/v1/boards/${boardKey}/jobs`;",
      "}",
    ].join("\n");

    expect(findUnpinnedProviderLiterals(content)).toHaveLength(1);
  });

  test("passes literals inside pinned capability tables and legacy constants", () => {
    const content = [
      "export const SOURCE_CAPABILITY_RULES = [",
      "  {",
      '    key: "ashby",',
      '    hostnames: { suffixes: ["ashbyhq.com"] },',
      "    resolve(url: URL) {",
      "      return {",
      "        publicApiUrlTemplate:",
      "          `https://api.ashbyhq.com/posting-api/job-board/${url.pathname}`,",
      "      };",
      "    },",
      "  },",
      "];",
      "",
      "export const LEGACY_DEFAULT_TARGET_STARTING_URL =",
      '  "https://www.linkedin.com/jobs/search/";',
    ].join("\n");

    expect(findUnpinnedProviderLiterals(content)).toEqual([]);
  });

  test("skips type-level string literal unions and module specifiers", () => {
    const content = [
      'type CapabilityKey = "greenhouse" | "lever" | "linkedin";',
      'import helper from "./generic-board-helper";',
      'export * from "./source-routes";',
    ].join("\n");

    expect(findUnpinnedProviderLiterals(content)).toEqual([]);
  });

  test("does not flag generic URLs or unrelated strings", () => {
    const content = [
      'const docsUrl = "https://example.com/jobs/search";',
      'const label = "Primary target";',
      "const template = `https://${host}/jobs`;",
    ].join("\n");

    expect(findUnpinnedProviderLiterals(content)).toEqual([]);
  });

  test("flags provider hosts hidden behind string concatenation folds", () => {
    const content = [
      "function buildSearchUrl() {",
      '  return "https://www.linkedin" + ".com/jobs/search/";',
      "}",
    ].join("\n");

    const findings = findUnpinnedProviderLiterals(content);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("provider-host-literal");
    expect(findings[0]?.token).toBe("https://www.linkedin.com/jobs/search/");
    expect(findings[0]?.context).toBe("buildSearchUrl");
  });

  test("does not flag benign concatenation without brand text", () => {
    const content = [
      'const greeting = "hello " + "world";',
      'const path = "/jobs" + "/search";',
      "const template = `https://${host}/jobs`;",
    ].join("\n");

    expect(findUnpinnedProviderLiterals(content)).toEqual([]);
  });
});

describe("sanctioned ATS provider host taxonomy", () => {
  const productionTable = [
    "type AtsProviderHostRule = {",
    "  provider: string;",
    "  exact?: readonly string[];",
    "  suffixes?: readonly string[];",
    "};",
    "",
    "const ATS_PROVIDER_HOST_RULES: readonly AtsProviderHostRule[] = [",
    '  { provider: "Greenhouse", suffixes: ["greenhouse.io"] },',
    '  { provider: "Lever", suffixes: ["lever.co"] },',
    '  { provider: "Workday", suffixes: ["myworkdayjobs.com"] },',
    '  { provider: "Ashby", suffixes: ["ashbyhq.com"] },',
    '  { provider: "iCIMS", suffixes: ["icims.com", "icims.eu"] },',
    "];",
  ].join("\n");

  test("pins the taxonomy under the strict static-data contract only", () => {
    expect(PINNED_DECLARATIONS.get("ATS_PROVIDER_HOST_RULES")).toMatch(
      /metadata taxonomy/,
    );
    expect([...STRICT_STATIC_DATA_TABLES]).toEqual(["ATS_PROVIDER_HOST_RULES"]);
  });

  test("accepts the production parsed-host rows as direct static data", () => {
    expect(findStrictStaticTableMisuses(productionTable)).toEqual([]);
    expect(findUnpinnedProviderLiterals(productionTable)).toEqual([]);
    expect(findBrandedIdentifiers(productionTable)).toEqual([]);
  });

  test("rejects alias initializers and export-rename laundering", () => {
    const alias = [
      'import { hostRows } from "./generic-ats-host-rows";',
      "const ATS_PROVIDER_HOST_RULES = hostRows;",
    ].join("\n");
    const aliasMisuses = findStrictStaticTableMisuses(alias);
    expect(aliasMisuses).toHaveLength(1);
    expect(aliasMisuses[0]?.reason).toMatch(/alias/);

    const renameLaundering = [
      'const HOST_ROWS = [{ provider: "Ashby", suffixes: ["ashbyhq.com"] }];',
      "export { HOST_ROWS as ATS_PROVIDER_HOST_RULES };",
    ].join("\n");
    expect(findStrictStaticTableMisuses(renameLaundering)).toEqual([]);
    expect(
      findUnpinnedProviderLiterals(renameLaundering).map(
        (finding) => finding.token,
      ),
    ).toContain("ashbyhq.com");
  });

  test("rejects dynamic import, require, and call initializers", () => {
    const cases = [
      'const ATS_PROVIDER_HOST_RULES = (await import("./ats-rows")).default;',
      'const ATS_PROVIDER_HOST_RULES = require("./ats-rows");',
      "const ATS_PROVIDER_HOST_RULES = buildAtsHostRows();",
    ];

    for (const snippet of cases) {
      const misuses = findStrictStaticTableMisuses(snippet);
      expect(misuses).toHaveLength(1);
      expect(misuses[0]?.reason).toMatch(/dynamic import|call result/);
    }
  });

  test("rejects non-array, mutable, spread, computed, quoted, and folded shapes", () => {
    const cases: Array<[string, RegExp]> = [
      ["const ATS_PROVIDER_HOST_RULES = {};", /array literal/],
      ["let ATS_PROVIDER_HOST_RULES = [];", /const binding/],
      ["const BASE = []; const ATS_PROVIDER_HOST_RULES = [...BASE];", /spread/],
      [
        'const key = "provider"; const ATS_PROVIDER_HOST_RULES = [{ [key]: "Ashby" }];',
        /computed or quoted/,
      ],
      [
        'const ATS_PROVIDER_HOST_RULES = [{ ashby: ["ashbyhq.com"] }];',
        /brand segment/,
      ],
      [
        'const ATS_PROVIDER_HOST_RULES = [{ provider: "green" + "house.io" }];',
        /concatenation folding/,
      ],
      [
        'const tld = "com"; const ATS_PROVIDER_HOST_RULES = [{ provider: `icims.${tld}` }];',
        /template folding/,
      ],
    ];

    for (const [snippet, expected] of cases) {
      const misuses = findStrictStaticTableMisuses(snippet);
      expect(misuses.length).toBeGreaterThan(0);
      expect(misuses.some((misuse) => expected.test(misuse.reason))).toBe(true);
    }
  });
});

describe("board route policy stays unpinned", () => {
  test("retired SEARCH_SURFACE_ROUTE_RULES pin cannot sanction reintroduced routes", () => {
    expect(PINNED_DECLARATIONS.has("SEARCH_SURFACE_ROUTE_RULES")).toBe(false);

    const reintroducedRoutes = [
      "export const SEARCH_SURFACE_ROUTE_RULES = [",
      "  {",
      '    board: "linkedin",',
      '    startUrl: "https://www.linkedin.com/jobs/search/",',
      "  },",
      "];",
    ].join("\n");

    expect(findStrictStaticTableMisuses(reintroducedRoutes)).toEqual([]);
    const rules = findUnpinnedProviderLiterals(reintroducedRoutes).map(
      (finding) => finding.rule,
    );
    expect(rules).toContain("branded-string-literal");
    expect(rules).toContain("provider-host-literal");
  });
});

describe("finding hashing and aggregation", () => {
  test("hashes are deterministic per rule and token", () => {
    const hash = hashFindingToken("provider-host-literal", "https://x");
    expect(hashFindingToken("provider-host-literal", "https://x")).toBe(hash);
    expect(hashFindingToken("branded-string-literal", "https://x")).not.toBe(
      hash,
    );
    expect(hashFindingToken("provider-host-literal", "https://y")).not.toBe(
      hash,
    );
  });

  test("aggregates identical findings into counted entries", () => {
    const findings = [
      {
        rule: "provider-host-literal",
        file: "a.ts",
        context: "f",
        hash: "h1",
        line: 1,
      },
      {
        rule: "provider-host-literal",
        file: "a.ts",
        context: "f",
        hash: "h1",
        line: 5,
      },
      {
        rule: "branded-string-literal",
        file: "a.ts",
        context: "g",
        hash: "h2",
        line: 9,
      },
    ];

    const aggregated = aggregateFindings(findings);
    expect(aggregated).toHaveLength(2);
    const h1 = aggregated.find((entry) => entry.hash === "h1");
    expect(h1?.count).toBe(2);
  });
});

describe("baseline ratchet evaluation", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    rule: "provider-host-literal",
    file: "pkg/src/a.ts",
    context: "buildUrl",
    hash: "abc",
    count: 1,
    ...overrides,
  });

  test("exact file/context/hash/count passes", () => {
    const result = evaluateFindingsAgainstBaseline([entry()], [entry()]);
    expect(result.violations).toEqual([]);
    expect(result.staleEntries).toEqual([]);
  });

  test("new occurrences hard-fail", () => {
    const result = evaluateFindingsAgainstBaseline([entry()], []);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.reason).toBe("new occurrence");
  });

  test("count exceeding the baseline fails on the surplus", () => {
    const doubled = { ...entry(), count: 2 };
    const result = evaluateFindingsAgainstBaseline([doubled], [entry()]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.reason).toBe("baseline count exceeded");
    expect(result.staleEntries).toEqual([]);
  });

  test("changed literal content counts as a new occurrence", () => {
    const changed = { ...entry(), hash: "different" };
    const result = evaluateFindingsAgainstBaseline([changed], [entry()]);
    expect(result.violations).toHaveLength(1);
    expect(result.staleEntries).toHaveLength(1);
  });

  test("occurrences moved to another file or context fail until rebaselined", () => {
    for (const moved of [
      entry({ file: "pkg/src/b.ts" }),
      entry({ context: "parseBoardFeed" }),
    ]) {
      const result = evaluateFindingsAgainstBaseline([moved], [entry()]);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.reason).toBe("new occurrence");
      expect(result.staleEntries).toEqual([entry()]);
    }
  });

  test("stale entries are reported so the baseline shrinks", () => {
    const result = evaluateFindingsAgainstBaseline([], [entry()]);
    expect(result.violations).toEqual([]);
    expect(result.staleEntries).toEqual([entry()]);
  });

  test("multiple files sharing a context stay independent", () => {
    const baseline = [entry({ file: "a.ts" }), entry({ file: "b.ts" })];
    const findings = [entry({ file: "b.ts" })];
    const result = evaluateFindingsAgainstBaseline(findings, baseline);
    expect(result.violations).toEqual([]);
    expect(result.staleEntries.map((stale) => stale.file)).toEqual(["a.ts"]);
  });
});

describe("package export subpath matching", () => {
  test("accepts root and explicitly exported subpaths", () => {
    const keys = [".", "./resume-record-identity", "./source-health"];
    expect(isExportedSubpath(keys, "")).toBe(true);
    expect(isExportedSubpath(keys, "/source-health")).toBe(true);
    expect(isExportedSubpath(keys, "/resume-record-identity")).toBe(true);
  });

  test("rejects non-exported internal subpaths", () => {
    const keys = ["."];
    expect(isExportedSubpath(keys, "/src/internal/state")).toBe(false);
    expect(isExportedSubpath(keys, "/src/index")).toBe(false);
  });

  test("supports single-star export patterns", () => {
    expect(isExportedSubpath(["./*"], "/anything/here")).toBe(true);
    expect(isExportedSubpath(["./features/*"], "/features/board")).toBe(true);
    expect(isExportedSubpath(["./features/*"], "/internal/state")).toBe(false);
  });
});

describe("import edge scanning and boundaries", () => {
  test("collects static imports, re-exports, and dynamic imports", () => {
    const content = [
      'import { state } from "@nestor/db";',
      'export { helper } from "./helper";',
      'await import("@nestor/contracts");',
      'const legacy = require("./legacy");',
    ].join("\n");

    const edges = scanImportEdges(content);
    expect(edges.map((edge) => edge.specifier)).toEqual([
      "@nestor/db",
      "./helper",
      "@nestor/contracts",
      "./legacy",
    ]);
  });

  test("allows bare workspace package and exported subpath imports", () => {
    const edges = scanImportEdges(
      [
        'import { x } from "@nestor/db";',
        'import { identity } from "@nestor/job-finder/source-health";',
      ].join("\n"),
    );
    const index = new Map([
      ["db", ["."]],
      ["job-finder", [".", "./source-health"]],
    ]);

    const result = evaluateImportEdges(edges, "db", index);
    expect(result.deepImportViolations).toEqual([]);
    expect(result.directionFindings).toEqual([]);
  });

  test("hard-fails deep imports into non-exported package internals", () => {
    const edges = scanImportEdges(
      'import { state } from "@nestor/db/src/internal/state";',
    );
    const result = evaluateImportEdges(edges, "browser-agent", new Map());
    expect(result.deepImportViolations).toHaveLength(1);
    expect(result.deepImportViolations[0]?.targetPackage).toBe("db");
    expect(result.deepImportViolations[0]?.subpath).toBe("/src/internal/state");
  });

  test("ignores self-package imports", () => {
    const edges = scanImportEdges(
      'import { state } from "@nestor/job-finder/source-health";',
    );
    const result = evaluateImportEdges(edges, "job-finder", new Map());
    expect(result.deepImportViolations).toEqual([]);
    expect(result.directionFindings).toEqual([]);
  });

  test("ratchets forbidden runtime->agent direction and allows orchestrator->agent", () => {
    const runtimeEdges = scanImportEdges(
      'import { runAgentDiscovery } from "@nestor/browser-agent";',
    );
    const runtimeResult = evaluateImportEdges(
      runtimeEdges,
      "browser-runtime",
      new Map(),
    );
    expect(runtimeResult.directionFindings).toHaveLength(1);
    expect(runtimeResult.directionFindings[0]?.rule).toBe(
      "import-direction:runtime-to-agent-import",
    );

    const orchestratorEdges = scanImportEdges(
      'import { runAgentDiscovery } from "@nestor/browser-agent";',
    );
    const orchestratorResult = evaluateImportEdges(
      orchestratorEdges,
      "job-finder",
      new Map(),
    );
    expect(orchestratorResult.directionFindings).toEqual([]);
  });

  test("ratchets agent->orchestrator direction", () => {
    const edges = scanImportEdges(
      'import type { JobFinderService } from "@nestor/job-finder";',
    );
    const result = evaluateImportEdges(edges, "browser-agent", new Map());
    expect(result.directionFindings).toHaveLength(1);
    expect(result.directionFindings[0]?.rule).toBe(
      "import-direction:agent-to-orchestrator-import",
    );
  });

  test("returns no findings for files outside scanned packages", () => {
    const edges = scanImportEdges(
      'import { state } from "@nestor/db/src/internal/state";',
    );
    const result = evaluateImportEdges(edges, null, new Map());
    expect(result.deepImportViolations).toEqual([]);
    expect(result.directionFindings).toEqual([]);
  });
});

describe("baseline parsing", () => {
  test("parses well-formed baselines", () => {
    const parsed = parseBaseline(
      JSON.stringify({
        version: 1,
        entries: [
          {
            rule: "provider-host-literal",
            file: "a.ts",
            context: "f",
            hash: "abc",
            count: 2,
          },
        ],
      }),
      "baseline.json",
    );
    expect(parsed).toEqual([
      {
        rule: "provider-host-literal",
        file: "a.ts",
        context: "f",
        hash: "abc",
        count: 2,
      },
    ]);
  });

  test("rejects malformed baselines", () => {
    expect(() => parseBaseline("{broken", "baseline.json")).toThrow();
    expect(() => parseBaseline("{}", "baseline.json")).toThrow(/entries/);
    expect(() =>
      parseBaseline(
        JSON.stringify({ entries: [{ rule: "x" }] }),
        "baseline.json",
      ),
    ).toThrow(/missing|string field|"file"/);
    expect(() =>
      parseBaseline(
        JSON.stringify({
          entries: [
            {
              rule: "x",
              file: "a.ts",
              context: "f",
              hash: "abc",
              count: 0,
            },
          ],
        }),
        "baseline.json",
      ),
    ).toThrow(/count/);
  });
});

describe("rule registry", () => {
  test("declares all enforced ratchet rules", () => {
    expect(SOURCE_GENERIC_DISCOVERY_RULES).toEqual([
      "branded-identifier",
      "provider-host-literal",
      "branded-string-literal",
    ]);
  });
});

describe("synthetic temp fixture integration", () => {
  test("end-to-end scan and ratchet over fixture files on disk", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "source-generic-check-"),
    );

    try {
      const relativePaths = {
        agentSource: "packages/browser-agent/src/agent.ts",
        agentFixtureTest: "packages/browser-agent/src/agent.behavior.test.ts",
        resumeDomain: "packages/job-finder/src/internal/resume-import-links.ts",
      };

      await fs.mkdir(
        path.dirname(path.join(tempRoot, relativePaths.agentSource)),
        { recursive: true },
      );
      await fs.mkdir(
        path.dirname(path.join(tempRoot, relativePaths.agentFixtureTest)),
        { recursive: true },
      );
      await fs.mkdir(
        path.dirname(path.join(tempRoot, relativePaths.resumeDomain)),
        { recursive: true },
      );

      const sourceFixture = [
        "export const maxLeverage = 10;",
        "export function buildStartUrl() {",
        '  return "https://www.linkedin.com/jobs/search/";',
        "}",
      ].join("\n");
      await fs.writeFile(
        path.join(tempRoot, relativePaths.agentSource),
        sourceFixture,
      );
      await fs.writeFile(
        path.join(tempRoot, relativePaths.agentFixtureTest),
        sourceFixture,
      );
      await fs.writeFile(
        path.join(tempRoot, relativePaths.resumeDomain),
        sourceFixture,
      );

      expect(shouldScanSourceFile(relativePaths.agentSource)).toBe(true);
      expect(shouldScanSourceFile(relativePaths.agentFixtureTest)).toBe(false);
      expect(shouldScanSourceFile(relativePaths.resumeDomain)).toBe(false);

      const scannedContent = await fs.readFile(
        path.join(tempRoot, relativePaths.agentSource),
        "utf8",
      );
      const identifierFindings = findBrandedIdentifiers(scannedContent);
      const literalFindings = findUnpinnedProviderLiterals(scannedContent);

      expect(identifierFindings).toEqual([]);
      expect(literalFindings).toHaveLength(1);
      expect(literalFindings[0]?.token).toBe(
        "https://www.linkedin.com/jobs/search/",
      );

      const occurrence = {
        rule: literalFindings[0]!.rule,
        file: relativePaths.agentSource,
        context: literalFindings[0]!.context,
        hash: hashFindingToken(
          literalFindings[0]!.rule,
          literalFindings[0]!.token,
        ),
        count: 1,
      };
      const baselinePass = evaluateFindingsAgainstBaseline(
        [occurrence],
        [occurrence],
      );
      expect(baselinePass.violations).toEqual([]);

      const expandedOccurrence = { ...occurrence, count: 2 };
      const baselineBreach = evaluateFindingsAgainstBaseline(
        [expandedOccurrence],
        [occurrence],
      );
      expect(baselineBreach.violations).toHaveLength(1);

      const debtRemoved = evaluateFindingsAgainstBaseline([], [occurrence]);
      expect(debtRemoved.staleEntries).toEqual([occurrence]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
