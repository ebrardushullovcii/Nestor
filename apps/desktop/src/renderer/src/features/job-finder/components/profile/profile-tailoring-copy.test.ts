import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RESUME_APPROACH_OPTIONS,
  STRONG_REWRITE_WARNING,
  TAILORING_MODE_DESCRIPTIONS,
} from "./profile-tailoring-copy";

const FORBIDDEN_MORALIZING =
  /\b(lie|lies|lying|liar|dishonest|unethical|fraud)\b/i;

const AGGRESSIVE_COPY_SURFACES = [
  "./profile-tailoring-copy.ts",
  "../../screens/review-queue/resume-claim-confirmation-panel.tsx",
  "../../screens/review-queue/resume-workspace-editor-panel.tsx",
] as const;

describe("aggressive tailoring user copy", () => {
  it("states the first-interview purpose without calling the stretches lies", () => {
    const exported = [
      ...RESUME_APPROACH_OPTIONS.map(
        (option) => `${option.label} ${option.description}`,
      ),
      ...Object.values(TAILORING_MODE_DESCRIPTIONS),
      STRONG_REWRITE_WARNING,
    ].join("\n");

    expect(STRONG_REWRITE_WARNING).toMatch(/first interview/);
    expect(exported).not.toMatch(FORBIDDEN_MORALIZING);

    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const relative of AGGRESSIVE_COPY_SURFACES) {
      const source = readFileSync(path.join(here, relative), "utf8");
      expect(source, relative).not.toMatch(FORBIDDEN_MORALIZING);
    }
  });
});
