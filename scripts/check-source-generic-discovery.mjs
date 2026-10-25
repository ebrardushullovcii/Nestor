import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = path.resolve(import.meta.dirname, "..");

// Source-generic discovery policy (see docs/ARCHITECTURE.md and ADR 0007).
//
// Layer 1 - identifier scan: declarations, class methods, properties/object
//   keys, enum members, and parameters in scoped paths must not carry
//   job-source brand segments. Brand matching works on identifier segment
//   boundaries (`maxLeverage` passes; `getLinkedInJobs` and `linkedInUrl`
//   fail). Identifiers inside pinned declaration spans are exempt because
//   they are structural parts of sanctioned data-driven tables.
//   Pre-existing branded identifiers (today: a profile-link taxonomy key in
//   browser-agent test fixtures) are ratchet-baselined debt like layer 2
//   occurrences.
// Layer 2 - provider host/URL + standalone brand string literals: allowed only
//   inside pinned declaration spans that represent sanctioned data-driven
//   capability/adapter tables or explicit legacy constants. Everything else is
//   ratcheted debt tracked in scripts/source-generic-baseline.json: existing
//   occurrences pass only at exact file/context/hash/count; new occurrences
//   hard-fail; stale baseline entries fail so the baseline shrinks.
//   ATS_PROVIDER_HOST_RULES carries a stricter contract than span exemption
//   alone: it must stay a const array of plain static rows (see
//   STRICT_STATIC_DATA_TABLES); aliases, computed names, spreads, calls,
//   dynamic imports, and concatenation/template folding fail outright.
//   String-literal concatenation chains are constant-folded before matching so
//   split literals cannot hide provider hosts either.
// Layer 3 - import boundaries: scanned packages must not deep-import another
//   package's internal/non-entry source (subpaths must be exported by the
//   target package), and browser-runtime/browser-agent direction stays
//   one-way per architecture: runtime must not depend on workflow policy, and
//   the agent must not depend on the orchestrator. The single pre-existing
//   runtime->agent edge is ratchet-baselined debt and must not expand.
//
// Intentional, preserved exclusions for the identifier/literal layers:
// - `*.test.ts`: test fixtures are not shipped discovery or workflow policy.
// - `resume-*` paths: resume product domain; resume import legitimately reads
//   provider links out of user documents.
// - `profile-*` paths: candidate profile link taxonomy; profile merge/setup
//   legitimately classify social/profile link hosts. These exclusions do NOT
//   apply to layer 3, which still checks their imports.
// Type-level string literal unions (e.g. `key: "ashby" | "workday"`) are out
// of scope for both identifier and literal layers.

export const SCANNED_SOURCE_PREFIXES = [
  "packages/job-list-policy/src/",
  "packages/browser-agent/src/",
  "packages/job-finder/src/internal/",
];

export const SOURCE_EXCLUSIONS = [
  {
    pattern: /\.test\.ts$/,
    label: "*.test.ts",
    reason: "test fixtures are not shipped discovery or workflow policy",
  },
  {
    pattern: /(^|\/)resume-/,
    label: "resume-*",
    reason: "resume product domain reads provider links from user documents",
  },
  {
    pattern: /(^|\/)profile-/,
    label: "profile-*",
    reason: "candidate profile link taxonomy classifies social/profile hosts",
  },
];

export const IMPORT_SCAN_ROOTS = [
  "packages/job-list-policy/src/",
  "packages/browser-agent/src/",
  "packages/browser-runtime/src/",
  "packages/job-finder/src/",
];

export const BRAND_SEGMENT_ALIASES = new Set([
  "ashby",
  "greenhouse",
  "icims",
  "kosovajob",
  "lever",
  "linkedin",
  "workday",
]);

export const PROVIDER_HOST_PATTERN =
  /(linkedin\.com|greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|icims\.(?:com|eu)|kosovajob\.com)/i;

// SEARCH_SURFACE_ROUTE_RULES was retired with the removed board-route policy
// and must not come back here: a reintroduced board-specific route/query table
// then fails the identifier/literal layers like any other unpinned policy.
export const PINNED_DECLARATIONS = new Map([
  [
    "PUBLIC_API_RESPONSE_ADAPTERS",
    "sanctioned provider response adapter table",
  ],
  ["SOURCE_CAPABILITY_RULES", "sanctioned provider capability/adapter table"],
  ["LEGACY_DEFAULT_TARGET_STARTING_URL", "explicit legacy constant"],
  [
    "ATS_PROVIDER_HOST_RULES",
    "sanctioned parsed-host ATS provider metadata taxonomy",
  ],
]);

export const FORBIDDEN_IMPORT_DIRECTIONS = [
  {
    fromPackage: "browser-runtime",
    toPackage: "browser-agent",
    rule: "runtime-to-agent-import",
    reason:
      "browser-runtime must stay lower-level than browser-agent workflow policy (ADR 0007)",
  },
  {
    fromPackage: "browser-agent",
    toPackage: "job-finder",
    rule: "agent-to-orchestrator-import",
    reason:
      "job-finder orchestrates browser-agent; the agent must not depend upward on orchestration",
  },
];

const RULE_BRANDED_IDENTIFIER = "branded-identifier";
const RULE_PROVIDER_HOST_LITERAL = "provider-host-literal";
const RULE_BRANDED_STRING_LITERAL = "branded-string-literal";
export const SOURCE_GENERIC_DISCOVERY_RULES = [
  RULE_BRANDED_IDENTIFIER,
  RULE_PROVIDER_HOST_LITERAL,
  RULE_BRANDED_STRING_LITERAL,
];

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

export function shouldScanSourceFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    SCANNED_SOURCE_PREFIXES.some((prefix) =>
      normalizedPath.startsWith(prefix),
    ) &&
    normalizedPath.endsWith(".ts") &&
    !SOURCE_EXCLUSIONS.some((exclusion) =>
      exclusion.pattern.test(normalizedPath),
    )
  );
}

export function shouldScanImportsForFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  return (
    IMPORT_SCAN_ROOTS.some((prefix) => normalizedPath.startsWith(prefix)) &&
    normalizedPath.endsWith(".ts") &&
    !/\.test\.ts$/.test(normalizedPath)
  );
}

export function packageNameForPath(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  if (normalizedPath.startsWith("packages/browser-agent/src/")) {
    return "browser-agent";
  }
  if (normalizedPath.startsWith("packages/browser-runtime/src/")) {
    return "browser-runtime";
  }
  if (normalizedPath.startsWith("packages/job-finder/src/")) {
    return "job-finder";
  }
  return null;
}

export function splitIdentifierSegments(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

// Matches a brand only when it spans whole identifier segments: some brand
// alias must equal the concatenation of one or more consecutive segments.
// `maxLeverage` ([max, leverage]) and `clever` never match because "lever" is
// not a complete segment run, while `getLinkedInJobs`
// ([get, linked, in, jobs]) matches via linked+in and `KosovaJobs` via
// kosova+job.
export function matchBrandedIdentifier(name) {
  const segments = splitIdentifierSegments(name);
  for (let start = 0; start < segments.length; start += 1) {
    let concatenated = "";
    for (let end = start; end < segments.length; end += 1) {
      concatenated += segments[end];
      if (BRAND_SEGMENT_ALIASES.has(concatenated)) {
        return concatenated;
      }
    }
  }
  return null;
}

function forEachDescendant(node, visit) {
  const walk = (child) => {
    if (visit(child)) {
      ts.forEachChild(child, walk);
    }
  };
  ts.forEachChild(node, walk);
}

function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function identifierNameOrNull(node) {
  if (!node || node.kind !== ts.SyntaxKind.Identifier) {
    return null;
  }
  return node.text ?? null;
}

const IDENTIFIER_KIND_LABELS = new Map([
  [ts.SyntaxKind.FunctionDeclaration, "function"],
  [ts.SyntaxKind.ClassDeclaration, "class"],
  [ts.SyntaxKind.InterfaceDeclaration, "interface"],
  [ts.SyntaxKind.TypeAliasDeclaration, "type alias"],
  [ts.SyntaxKind.EnumDeclaration, "enum"],
  [ts.SyntaxKind.EnumMember, "enum member"],
  [ts.SyntaxKind.VariableDeclaration, "variable"],
  [ts.SyntaxKind.Parameter, "parameter"],
  [ts.SyntaxKind.MethodDeclaration, "method"],
  [ts.SyntaxKind.MethodSignature, "method signature"],
  [ts.SyntaxKind.GetAccessor, "get accessor"],
  [ts.SyntaxKind.SetAccessor, "set accessor"],
  [ts.SyntaxKind.PropertyDeclaration, "property"],
  [ts.SyntaxKind.PropertySignature, "property"],
  [ts.SyntaxKind.PropertyAssignment, "object key"],
  [ts.SyntaxKind.ShorthandPropertyAssignment, "object key"],
]);

export function findBrandedIdentifiers(content) {
  const sourceFile = ts.createSourceFile(
    "scoped.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const pinnedSpans = collectPinnedSpans(sourceFile);
  const isInPinnedSpan = (position) =>
    pinnedSpans.some((span) => position >= span.start && position <= span.end);

  const findings = [];
  forEachDescendant(sourceFile, (node) => {
    const kindLabel = IDENTIFIER_KIND_LABELS.get(node.kind);
    if (kindLabel === undefined) {
      return true;
    }
    const name = identifierNameOrNull(node.name);
    if (name === null) {
      return true;
    }
    const brand = matchBrandedIdentifier(name);
    if (brand === null) {
      return true;
    }
    const start = node.getStart(sourceFile);
    if (isInPinnedSpan(start)) {
      return true;
    }
    findings.push({
      line: lineOf(sourceFile, start),
      rule: RULE_BRANDED_IDENTIFIER,
      kind: kindLabel,
      name,
      brand,
      context: resolveLiteralContext(node),
      token: `${kindLabel}:${name}`,
    });
    return true;
  });
  return findings.sort(
    (left, right) =>
      left.line - right.line || left.name.localeCompare(right.name),
  );
}

function collectPinnedSpans(sourceFile) {
  const spans = [];
  forEachDescendant(sourceFile, (node) => {
    if (node.kind !== ts.SyntaxKind.VariableDeclaration) {
      return true;
    }
    const name = identifierNameOrNull(node.name);
    if (name === null || !PINNED_DECLARATIONS.has(name)) {
      return true;
    }
    spans.push({ name, start: node.getStart(sourceFile), end: node.getEnd() });
    return true;
  });
  return spans;
}

function resolveLiteralContext(node) {
  let current = node.parent;
  while (current) {
    const kind = current.kind;
    const contextKinds = [
      ts.SyntaxKind.FunctionDeclaration,
      ts.SyntaxKind.MethodDeclaration,
      ts.SyntaxKind.GetAccessor,
      ts.SyntaxKind.SetAccessor,
      ts.SyntaxKind.ClassDeclaration,
      ts.SyntaxKind.VariableDeclaration,
    ];
    if (contextKinds.includes(kind)) {
      const name = identifierNameOrNull(current.name);
      if (name !== null) {
        return name;
      }
    }
    current = current.parent;
  }
  return "<module>";
}

function isModuleSpecifierLiteral(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (
    (parent.kind === ts.SyntaxKind.ImportDeclaration ||
      parent.kind === ts.SyntaxKind.ExportDeclaration) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  return (
    parent.kind === ts.SyntaxKind.ExternalModuleReference &&
    parent.moduleSpecifier === node
  );
}

function literalRuleForText(text) {
  if (PROVIDER_HOST_PATTERN.test(text)) {
    return RULE_PROVIDER_HOST_LITERAL;
  }
  if (BRAND_SEGMENT_ALIASES.has(text.trim().toLowerCase())) {
    return RULE_BRANDED_STRING_LITERAL;
  }
  return null;
}

// Folds parenthesized chains of string literals joined by `+` into one string
// so `"green" + "house.io"` cannot dodge host matching by splitting text.
function foldedStringTextOrNull(node) {
  if (!node) {
    return null;
  }
  if (
    node.kind === ts.SyntaxKind.StringLiteral ||
    node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return node.text ?? null;
  }
  if (node.kind === ts.SyntaxKind.ParenthesizedExpression) {
    return foldedStringTextOrNull(node.expression);
  }
  if (
    node.kind === ts.SyntaxKind.BinaryExpression &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldedStringTextOrNull(node.left);
    const right = foldedStringTextOrNull(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

export function findUnpinnedProviderLiterals(content) {
  const sourceFile = ts.createSourceFile(
    "scoped.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const pinnedSpans = collectPinnedSpans(sourceFile);
  const isInPinnedSpan = (position) =>
    pinnedSpans.some((span) => position >= span.start && position <= span.end);

  const findings = [];
  forEachDescendant(sourceFile, (node) => {
    // Type-level string literal unions are out of scope.
    if (node.kind === ts.SyntaxKind.LiteralType) {
      return false;
    }
    if (
      node.kind === ts.SyntaxKind.BinaryExpression &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const folded = foldedStringTextOrNull(node);
      const rule = folded === null ? null : literalRuleForText(folded);
      if (rule !== null) {
        const start = node.getStart(sourceFile);
        if (!isInPinnedSpan(start)) {
          findings.push({
            line: lineOf(sourceFile, start),
            rule,
            context: resolveLiteralContext(node),
            token: folded,
          });
        }
      }
      return true;
    }
    const literalKinds = [
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      ts.SyntaxKind.TemplateHead,
      ts.SyntaxKind.TemplateMiddle,
      ts.SyntaxKind.TemplateTail,
    ];
    if (!literalKinds.includes(node.kind)) {
      return true;
    }
    if (isModuleSpecifierLiteral(node)) {
      return true;
    }
    const text = node.text ?? "";
    const rule = literalRuleForText(text);
    if (rule === null) {
      return true;
    }
    const start = node.getStart(sourceFile);
    if (isInPinnedSpan(start)) {
      return true;
    }
    findings.push({
      line: lineOf(sourceFile, start),
      rule,
      context: resolveLiteralContext(node),
      token: text,
    });
    return true;
  });
  return findings.sort(
    (left, right) =>
      left.line - right.line || left.token.localeCompare(right.token),
  );
}

// Pinned symbols that must stay pure data tables: a const array of plain
// object rows whose keys are plain identifiers and whose values are direct
// literals (strings, numbers, booleans, null, or arrays of those). Anything
// else defeats the point of pinning, so structural misuse fails the gate
// instead of being ratcheted as debt.
export const STRICT_STATIC_DATA_TABLES = new Set(["ATS_PROVIDER_HOST_RULES"]);

const STATIC_SCALAR_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

function strictStaticValueReason(node, role) {
  if (!node) {
    return `${role} is missing`;
  }
  if (node.kind === ts.SyntaxKind.ParenthesizedExpression) {
    return strictStaticValueReason(node.expression, role);
  }
  if (
    node.kind === ts.SyntaxKind.PropertyAccessExpression ||
    node.kind === ts.SyntaxKind.ElementAccessExpression
  ) {
    return strictStaticValueReason(node.expression, role);
  }
  if (STATIC_SCALAR_KINDS.has(node.kind)) {
    return null;
  }
  if (node.kind === ts.SyntaxKind.ArrayLiteralExpression) {
    for (const element of node.elements) {
      if (element.kind === ts.SyntaxKind.SpreadElement) {
        return `${role} must not spread other bindings into the table`;
      }
      const elementReason = strictStaticValueReason(element, `${role} entry`);
      if (elementReason !== null) {
        return elementReason;
      }
    }
    return null;
  }
  if (node.kind === ts.SyntaxKind.ObjectLiteralExpression) {
    for (const property of node.properties) {
      if (property.kind !== ts.SyntaxKind.PropertyAssignment) {
        return `${role} must use plain key/value properties`;
      }
      if (property.name.kind !== ts.SyntaxKind.Identifier) {
        return `${role} keys must be plain identifiers, not computed or quoted names`;
      }
      const brand = matchBrandedIdentifier(property.name.text);
      if (brand !== null) {
        return `${role} key "${property.name.text}" carries brand segment "${brand}"; provider identity belongs in string values`;
      }
      const valueReason = strictStaticValueReason(
        property.initializer,
        `${role} "${property.name.text}"`,
      );
      if (valueReason !== null) {
        return valueReason;
      }
    }
    return null;
  }
  if (node.kind === ts.SyntaxKind.TemplateExpression) {
    return `${role} must be a direct string literal, not template folding`;
  }
  if (node.kind === ts.SyntaxKind.BinaryExpression) {
    return `${role} must be a direct string literal, not concatenation folding`;
  }
  if (
    node.kind === ts.SyntaxKind.CallExpression ||
    node.kind === ts.SyntaxKind.AwaitExpression
  ) {
    return `${role} must be inline static data, not a call result, require, or dynamic import`;
  }
  if (node.kind === ts.SyntaxKind.Identifier) {
    return `${role} must be inline static data, not an alias of another binding`;
  }
  return `${role} must be a direct static literal (found ${ts.SyntaxKind[node.kind]})`;
}

export function findStrictStaticTableMisuses(content) {
  const sourceFile = ts.createSourceFile(
    "scoped.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const misuses = [];
  forEachDescendant(sourceFile, (node) => {
    if (node.kind !== ts.SyntaxKind.VariableDeclaration) {
      return true;
    }
    const name = identifierNameOrNull(node.name);
    if (name === null || !STRICT_STATIC_DATA_TABLES.has(name)) {
      return true;
    }
    const line = lineOf(sourceFile, node.getStart(sourceFile));
    const push = (reason) => misuses.push({ name, line, reason });
    const declarationList = node.parent;
    if (
      !declarationList ||
      declarationList.kind !== ts.SyntaxKind.VariableDeclarationList ||
      (declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      push(`${name} must stay a const binding`);
    }
    if (!node.initializer) {
      push(`${name} must have an inline static array initializer`);
      return true;
    }
    let valueReason = strictStaticValueReason(node.initializer, name);
    if (
      valueReason === null &&
      node.initializer.kind !== ts.SyntaxKind.ArrayLiteralExpression
    ) {
      valueReason = `${name} must be an array literal of static rows`;
    }
    if (valueReason !== null) {
      push(valueReason);
    }
    return true;
  });
  return misuses.sort(
    (left, right) =>
      left.line - right.line || left.reason.localeCompare(right.reason),
  );
}

export function hashFindingToken(rule, token) {
  return createHash("sha256").update(`${rule}\u0000${token}`).digest("hex");
}

export function findingKey(finding) {
  return [finding.rule, finding.file, finding.context, finding.hash].join(
    "\u0000",
  );
}

export function aggregateFindings(findings) {
  const aggregated = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      aggregated.set(key, { ...finding, count: 1 });
    }
  }
  return [...aggregated.values()].sort((left, right) =>
    findingKey(left).localeCompare(findingKey(right)),
  );
}

export function evaluateFindingsAgainstBaseline(findings, baselineEntries) {
  const remaining = new Map();
  for (const entry of baselineEntries) {
    remaining.set(findingKey(entry), entry.count);
  }

  const violations = [];
  for (const finding of findings) {
    const available = remaining.get(findingKey(finding)) ?? 0;
    remaining.set(findingKey(finding), available - finding.count);
    if (available < finding.count) {
      violations.push({
        ...finding,
        reason: available === 0 ? "new occurrence" : "baseline count exceeded",
      });
    }
  }

  const staleEntries = baselineEntries.filter(
    (entry) => (remaining.get(findingKey(entry)) ?? 0) > 0,
  );

  return { violations, staleEntries };
}

export function isExportedSubpath(exportKeys, subpath) {
  if (subpath.length === 0) {
    return exportKeys.includes(".");
  }
  const normalizedSubpath = subpath.startsWith("/") ? `.${subpath}` : subpath;
  for (const rawKey of exportKeys) {
    const key = typeof rawKey === "string" ? rawKey : ".";
    if (!key.includes("*")) {
      if (key === normalizedSubpath) {
        return true;
      }
      continue;
    }
    const pattern = `^${key
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`;
    if (new RegExp(pattern).test(normalizedSubpath)) {
      return true;
    }
  }
  return false;
}

export function scanImportEdges(content) {
  const sourceFile = ts.createSourceFile(
    "imports.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edges = [];
  forEachDescendant(sourceFile, (node) => {
    if (
      node.kind === ts.SyntaxKind.ImportDeclaration ||
      node.kind === ts.SyntaxKind.ExportDeclaration
    ) {
      const specifier = identifierOrString(node.moduleSpecifier);
      if (specifier !== null) {
        edges.push({
          specifier,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          kind:
            node.kind === ts.SyntaxKind.ImportDeclaration
              ? "import"
              : "re-export",
        });
      }
      return true;
    }
    if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
      const specifier = identifierOrString(node.moduleSpecifier);
      if (specifier !== null) {
        edges.push({
          specifier,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          kind: "import-equals",
        });
      }
      return true;
    }
    if (node.kind === ts.SyntaxKind.CallExpression) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall =
        node.expression.kind === ts.SyntaxKind.Identifier &&
        node.expression.text === "require";
      if (!isDynamicImport && !isRequireCall) {
        return true;
      }
      const argument = node.arguments[0];
      if (argument && argument.kind === ts.SyntaxKind.StringLiteral) {
        edges.push({
          specifier: argument.text,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          kind: isDynamicImport ? "dynamic-import" : "require",
        });
      }
      return true;
    }
    return true;
  });
  return edges;
}

function identifierOrString(node) {
  if (node && node.kind === ts.SyntaxKind.StringLiteral) {
    return node.text ?? null;
  }
  return null;
}

export function evaluateImportEdges(
  edges,
  importerPackage,
  exportSubpathIndex,
) {
  if (importerPackage === null) {
    return { deepImportViolations: [], directionFindings: [] };
  }

  const deepImportViolations = [];
  const directionFindings = [];
  const workspacePrefix = "@nestor/";

  for (const edge of edges) {
    if (!edge.specifier.startsWith(workspacePrefix)) {
      continue;
    }
    const rest = edge.specifier.slice(workspacePrefix.length);
    const slashIndex = rest.indexOf("/");
    const targetPackage = slashIndex === -1 ? rest : rest.slice(0, slashIndex);

    if (targetPackage === importerPackage || targetPackage.length === 0) {
      continue;
    }

    if (slashIndex !== -1) {
      const subpath = rest.slice(slashIndex);
      const exportKeys = exportSubpathIndex.get(targetPackage);
      if (exportKeys === undefined || !isExportedSubpath(exportKeys, subpath)) {
        deepImportViolations.push({
          line: edge.line,
          specifier: edge.specifier,
          targetPackage,
          subpath,
          kind: edge.kind,
        });
      }
    }

    for (const direction of FORBIDDEN_IMPORT_DIRECTIONS) {
      if (
        direction.fromPackage === importerPackage &&
        direction.toPackage === targetPackage
      ) {
        directionFindings.push({
          rule: `import-direction:${direction.rule}`,
          file: "",
          context: edge.specifier,
          hash: hashFindingToken(
            `import-direction:${direction.rule}`,
            edge.specifier,
          ),
          count: 1,
          line: edge.line,
          reason: direction.reason,
        });
      }
    }
  }

  return { deepImportViolations, directionFindings };
}

function listGitFiles(args) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Failed to run git ${args.join(" ")} in ${rootDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function listCandidateFiles() {
  return [
    ...new Set([
      ...listGitFiles(["ls-files"]),
      ...listGitFiles(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
}

async function readScopedFile(root, relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export function parseBaseline(baselineJson, baselineLabel) {
  let parsed;
  try {
    parsed = JSON.parse(baselineJson);
  } catch (error) {
    throw new Error(
      `${baselineLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${baselineLabel} must contain an "entries" array.`);
  }
  return entries.map((entry, index) => {
    const label = `${baselineLabel} entry #${index}`;
    for (const field of ["rule", "file", "context", "hash"]) {
      if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
        throw new Error(`${label} is missing string field "${field}".`);
      }
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      throw new Error(`${label} needs an integer "count" >= 1.`);
    }
    return {
      rule: entry.rule,
      file: entry.file,
      context: entry.context,
      hash: entry.hash,
      count: entry.count,
    };
  });
}

async function loadExportSubpathIndex(candidateFiles) {
  const index = new Map();
  const packageJsonPaths = candidateFiles.filter((candidate) =>
    /^packages\/[^/]+\/package\.json$/.test(toPosixPath(candidate)),
  );
  for (const packageJsonPath of packageJsonPaths) {
    const content = await readScopedFile(rootDir, packageJsonPath);
    if (content === null) {
      continue;
    }
    const packageName = toPosixPath(packageJsonPath).split("/")[1];
    let exportsMap;
    try {
      exportsMap = JSON.parse(content).exports;
    } catch {
      exportsMap = undefined;
    }
    const keys = Array.isArray(exportsMap)
      ? exportsMap.map((entry) => (typeof entry === "string" ? entry : "."))
      : exportsMap && typeof exportsMap === "object"
        ? Object.keys(exportsMap)
        : ["."];
    index.set(packageName, keys);
  }
  return index;
}

function formatFindingLine(finding) {
  return `${finding.file}:${finding.line} ${finding.rule} "${finding.token}" in ${finding.context} (${finding.reason})`;
}

async function main() {
  const baselineRelativePath = "scripts/source-generic-baseline.json";
  const baselineContent = await readScopedFile(rootDir, baselineRelativePath);
  if (baselineContent === null) {
    console.error(
      `Missing required ratchet baseline file: ${baselineRelativePath}.`,
    );
    process.exit(1);
  }
  const baselineEntries = parseBaseline(baselineContent, baselineRelativePath);

  const candidateFiles = listCandidateFiles();
  const exportSubpathIndex = await loadExportSubpathIndex(candidateFiles);

  const ratchetedOccurrences = [];
  const pinnedStructureFailures = [];

  for (const relativePath of candidateFiles.filter(shouldScanSourceFile)) {
    const content = await readScopedFile(rootDir, relativePath);
    if (content === null) {
      continue;
    }

    for (const misuse of findStrictStaticTableMisuses(content)) {
      pinnedStructureFailures.push(
        `${relativePath}:${misuse.line} ${misuse.reason}`,
      );
    }

    for (const identifier of findBrandedIdentifiers(content)) {
      ratchetedOccurrences.push({
        rule: identifier.rule,
        file: relativePath,
        context: identifier.context,
        hash: hashFindingToken(identifier.rule, identifier.token),
        token: `${identifier.name} (${identifier.kind}, brand segment "${identifier.brand}")`,
        line: identifier.line,
      });
    }

    for (const literal of findUnpinnedProviderLiterals(content)) {
      ratchetedOccurrences.push({
        rule: literal.rule,
        file: relativePath,
        context: literal.context,
        hash: hashFindingToken(literal.rule, literal.token),
        token: literal.token,
        line: literal.line,
      });
    }
  }

  const deepImportFailures = [];
  const directionFindings = [];

  for (const relativePath of candidateFiles.filter(shouldScanImportsForFile)) {
    const content = await readScopedFile(rootDir, relativePath);
    if (content === null) {
      continue;
    }
    const importerPackage = packageNameForPath(relativePath);
    const edges = scanImportEdges(content);
    const result = evaluateImportEdges(
      edges,
      importerPackage,
      exportSubpathIndex,
    );
    for (const violation of result.deepImportViolations) {
      deepImportFailures.push(
        `${relativePath}:${violation.line} deep import "${violation.specifier}" (${violation.kind}) targets a non-exported subpath of @nestor/${violation.targetPackage}`,
      );
    }
    for (const finding of result.directionFindings) {
      directionFindings.push({
        ...finding,
        file: relativePath,
        token: finding.context,
      });
    }
  }

  const aggregatedOccurrences = aggregateFindings(ratchetedOccurrences);
  const aggregatedDirections = aggregateFindings(directionFindings);
  const ratchetedFindings = [...aggregatedOccurrences, ...aggregatedDirections];
  const { violations: newRatchetViolations, staleEntries } =
    evaluateFindingsAgainstBaseline(ratchetedFindings, baselineEntries);

  const failureSections = [];

  if (pinnedStructureFailures.length > 0) {
    failureSections.push(
      [
        "Pinned sanctioned declarations violated their structural contract.",
        `${[...STRICT_STATIC_DATA_TABLES].join(", ")} must stay a const array of plain static rows: direct literals with plain identifier keys. Aliases, computed or quoted names, spreads, calls, require/dynamic imports, and concatenation/template folding are rejected.`,
        ...pinnedStructureFailures.map((line) => `- ${line}`),
      ].join("\n"),
    );
  }

  if (newRatchetViolations.length > 0) {
    failureSections.push(
      [
        "New or expanded source-generic violations (not in the committed ratchet baseline).",
        "Branded identifiers: use generic names. Provider literals: extend a sanctioned data-driven table behind a pinned symbol instead.",
        ...newRatchetViolations.map(
          (finding) => `- ${formatFindingLine(finding)}`,
        ),
      ].join("\n"),
    );
  }

  if (staleEntries.length > 0) {
    failureSections.push(
      [
        "Stale baseline entries detected. The debt they described is gone; shrink scripts/source-generic-baseline.json by removing them:",
        ...staleEntries.map((entry) => `- ${JSON.stringify(entry)}`),
      ].join("\n"),
    );
  }

  if (deepImportFailures.length > 0) {
    failureSections.push(
      [
        "Deep imports into another package's internal/non-entry source are forbidden.",
        "Add an explicit exports entry to the target package or import its public entrypoint:",
        ...deepImportFailures.map((line) => `- ${line}`),
      ].join("\n"),
    );
  }

  if (failureSections.length > 0) {
    console.error(
      [
        "Source-generic discovery check failed.",
        "Do not add one-source function/type/constant names to shared discovery or browser-agent workflow code.",
        "Use generic helper names plus data-driven adapter tables instead.",
        "",
        ...failureSections.flatMap((section) => section.split("\n")),
      ].join("\n"),
    );
    process.exit(1);
  }

  const excludedLabels = SOURCE_EXCLUSIONS.map(
    (exclusion) => `${exclusion.label} (${exclusion.reason})`,
  ).join("; ");
  console.log(
    `Identifier/literal scope: ${SCANNED_SOURCE_PREFIXES.join(", ")}. Intentional exclusions: ${excludedLabels}.`,
  );
  console.log(
    `Sanctioned pinned symbols: ${[...PINNED_DECLARATIONS.entries()].map(([name, reason]) => `${name} (${reason})`).join("; ")}.`,
  );
  console.log(
    `Import boundary scope: ${IMPORT_SCAN_ROOTS.join(", ")}; directions enforced: ${FORBIDDEN_IMPORT_DIRECTIONS.map((direction) => `${direction.fromPackage}->${direction.toPackage}`).join(", ")}.`,
  );
  console.log(
    `Ratchet baseline: ${baselineRelativePath} tracks ${baselineEntries.reduce((sum, entry) => sum + entry.count, 0)} occurrence(s) across ${baselineEntries.length} entr(y/ies).`,
  );
  console.log("Source-generic discovery checks passed.");
}

function safeRealPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

const invokedDirectly = (() => {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  const modulePath = safeRealPath(fileURLToPath(import.meta.url));
  return modulePath !== null && modulePath === safeRealPath(entryPath);
})();

if (invokedDirectly) {
  await main().catch((error) => {
    console.error("Uncaught error in main:", error);
    process.exit(1);
  });
}
