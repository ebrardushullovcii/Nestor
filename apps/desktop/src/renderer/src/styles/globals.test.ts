import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The design-token contract for "Paper and pine".
 *
 * Every value is read from globals.css, never copied here, so these checks
 * measure the palette that ships. Floors (WCAG 2.x contrast):
 *   body text >= 7:1, secondary text >= 4.5:1,
 *   control boundaries and focus >= 3:1, skeleton blocks >= 1.2:1.
 * Scales: seven type sizes, four radii, three elevations.
 */

const globalsCss = readFileSync(
  new URL("./globals.css", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const RENDERER_ROOT = fileURLToPath(new URL("..", import.meta.url));

function themeScope(selector: string): string {
  const start = globalsCss.indexOf(selector);
  const end = globalsCss.indexOf("\n}", start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing ${selector} theme scope`);
  }
  return globalsCss.slice(start, end);
}

const SCOPES = {
  dark: themeScope(':root,\n:root[data-theme="dark"]'),
  light: themeScope(':root[data-theme="light"]'),
} as const;
type Theme = keyof typeof SCOPES;
const THEMES: readonly Theme[] = ["light", "dark"];
const ROOT_SCOPE = themeScope(":root {");

function token(theme: Theme, name: string): string {
  const value = SCOPES[theme].match(
    new RegExp(`\\n\\s*${name}\\s*:\\s*(#[0-9a-f]{6})\\s*;`, "i"),
  )?.[1];
  if (!value) {
    throw new Error(`Missing hex ${name} in the ${theme} theme`);
  }
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(
    (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const raw =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return (raw * 60 + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Surfaces text sits on, by role. */
const TEXT_SURFACES = [
  "--background",
  "--card",
  "--popover",
  "--surface",
  "--surface-panel",
  "--surface-panel-raised",
  "--surface-well",
  "--secondary",
  "--muted",
  "--accent",
  "--sidebar-bg",
  "--shell-header-bg",
  "--nav-active-surface",
  "--accent-tint",
  "--field",
] as const;

/** Surfaces a control or focus ring sits on. */
const CONTROL_SURFACES = [
  "--background",
  "--card",
  "--popover",
  "--surface-panel",
  "--surface-panel-raised",
  "--sidebar-bg",
  "--field",
] as const;

function expectFloor(
  theme: Theme,
  foreground: string,
  surfaces: readonly string[],
  floor: number,
) {
  for (const surface of surfaces) {
    const ratio = contrast(token(theme, foreground), token(theme, surface));
    expect(
      ratio,
      `${theme} ${foreground} on ${surface} is ${ratio.toFixed(2)}:1, floor ${floor}:1`,
    ).toBeGreaterThanOrEqual(floor);
  }
}

describe("palette: contrast floors", () => {
  for (const theme of THEMES) {
    it(`keeps body text at 7:1 on every surface (${theme})`, () => {
      for (const body of [
        "--foreground",
        "--card-foreground",
        "--popover-foreground",
        "--secondary-foreground",
        "--accent-foreground",
        "--nav-active-foreground",
        "--text-headline",
        "--headline-primary",
      ]) {
        expectFloor(theme, body, TEXT_SURFACES, 7);
      }
    });

    it(`keeps secondary text at 4.5:1 on every surface (${theme})`, () => {
      for (const secondary of [
        "--foreground-soft",
        "--muted-foreground",
        "--link",
        "--primary",
      ]) {
        expectFloor(theme, secondary, TEXT_SURFACES, 4.5);
      }
    });

    it(`keeps disabled labels legible (${theme})`, () => {
      expectFloor(theme, "--disabled-foreground", CONTROL_SURFACES, 4.5);
    });

    it(`keeps control boundaries and focus at 3:1 (${theme})`, () => {
      for (const boundary of [
        "--border-strong",
        "--control-border-hover",
        "--field-border-hover",
        "--field-focus-border",
        "--ring",
        "--nav-active-bar",
        "--row-selected-bar",
      ]) {
        expectFloor(theme, boundary, CONTROL_SURFACES, 3);
      }
      // The active bar and the focus ring also read on the tint under them.
      expectFloor(theme, "--nav-active-bar", ["--nav-active-surface"], 3);
      expectFloor(theme, "--row-selected-bar", ["--surface-strong"], 3);
    });

    it(`keeps an idle field findable but not heavy: about 3:1 where fields sit (${theme})`, () => {
      const fieldSurfaces = [
        "--card",
        "--surface-panel",
        "--surface-panel-raised",
        "--popover",
        "--field",
      ];
      expectFloor(theme, "--field-border", fieldSurfaces, 3);
      const onCard = contrast(
        token(theme, "--field-border"),
        token(theme, "--card"),
      );
      expect(onCard, `${theme} field border on the card`).toBeLessThan(3.6);
    });

    it(`marks the chosen segment with a 3:1 edge on its track (${theme})`, () => {
      expectFloor(
        theme,
        "--segment-thumb-border",
        ["--segment-track", "--card", "--surface-panel"],
        3,
      );
    });

    it(`tints the current destination visibly against the sidebar (${theme})`, () => {
      const ratio = contrast(
        token(theme, "--nav-active-surface"),
        token(theme, "--sidebar-bg"),
      );
      expect(ratio, `${theme} nav tint`).toBeGreaterThanOrEqual(1.12);
    });

    it(`keeps the filled action readable in every state (${theme})`, () => {
      for (const fill of [
        "--primary-fill",
        "--primary-fill-hover",
        "--primary-fill-pressed",
      ]) {
        const ratio = contrast(
          token(theme, "--primary-fill-foreground"),
          token(theme, fill),
        );
        expect(ratio, `${theme} label on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
      // The fill is a shape of its own against the panels it sits on.
      expectFloor(theme, "--primary-fill", ["--card", "--background"], 3);
    });

    it(`keeps skeleton blocks visible against their surface (${theme})`, () => {
      for (const surface of ["--card", "--surface-panel", "--background"]) {
        const ratio = contrast(
          token(theme, "--skeleton"),
          token(theme, surface),
        );
        expect(ratio, `${theme} skeleton on ${surface}`).toBeGreaterThanOrEqual(
          1.2,
        );
      }
    });

    it(`keeps dividers quiet: hairlines never compete with controls (${theme})`, () => {
      for (const hairline of [
        "--border",
        "--border-subtle",
        "--surface-panel-border",
        "--surface-well-border",
      ]) {
        const ratio = contrast(token(theme, hairline), token(theme, "--card"));
        expect(ratio, `${theme} ${hairline}`).toBeLessThan(2);
        expect(ratio, `${theme} ${hairline} is still visible`).toBeGreaterThan(
          1.1,
        );
        expect(
          contrast(token(theme, "--border-strong"), token(theme, "--card")),
        ).toBeGreaterThan(ratio);
      }
    });
  }
});

describe("palette: one accent, one meaning per status", () => {
  it("uses the same pine accent hue in both themes", () => {
    const hues = THEMES.flatMap((theme) => [
      hue(token(theme, "--primary")),
      hue(token(theme, "--primary-fill")),
      hue(token(theme, "--ring")),
      hue(token(theme, "--nav-active-bar")),
    ]);
    for (const value of hues) {
      expect(
        hueDistance(value, 170),
        `accent hue ${value.toFixed(0)}`,
      ).toBeLessThanOrEqual(10);
    }
  });

  it("keeps neutrals warm, not slate", () => {
    for (const theme of THEMES) {
      for (const neutral of [
        "--background",
        "--card",
        "--secondary",
        "--foreground-soft",
      ]) {
        const hex = token(theme, neutral);
        const r = Number.parseInt(hex.slice(1, 3), 16);
        const b = Number.parseInt(hex.slice(5, 7), 16);
        expect(r, `${theme} ${neutral} leans warm`).toBeGreaterThanOrEqual(b);
      }
    }
  });

  for (const theme of THEMES) {
    it(`gives each status family its own hue and a readable tint (${theme})`, () => {
      const families = {
        success: ["--success-text", "--success-surface"],
        warning: ["--warning-text", "--warning-surface"],
        info: ["--info-text", "--info-surface"],
        danger: ["--destructive", "--danger-surface"],
      } as const;
      const hues = Object.entries(families).map(([name, [text, tint]]) => {
        expect(
          contrast(token(theme, text), token(theme, tint)),
          `${theme} ${name} text on its tint`,
        ).toBeGreaterThanOrEqual(4.5);
        expectFloor(theme, text, ["--card", "--background", "--popover"], 4.5);
        return [name, hue(token(theme, text))] as const;
      });
      for (const [nameA, hueA] of hues) {
        for (const [nameB, hueB] of hues) {
          if (nameA >= nameB) continue;
          expect(
            hueDistance(hueA, hueB),
            `${theme} ${nameA} vs ${nameB}`,
          ).toBeGreaterThanOrEqual(30);
        }
      }
      // Badge tones alias the families instead of keeping their own values.
      expect(token(theme, "--positive")).toBe(token(theme, "--success-text"));
      expect(token(theme, "--active")).toBe(token(theme, "--info-text"));
      expect(token(theme, "--critical")).toBe(token(theme, "--destructive"));
    });

    it(`draws fit as a pine meter that takes no status hue (${theme})`, () => {
      const meter = token(theme, "--fit-meter");
      expect(
        hueDistance(hue(meter), 170),
        `fit meter hue ${hue(meter).toFixed(0)}`,
      ).toBeLessThanOrEqual(10);
      for (const status of [
        "--success-text",
        "--warning-text",
        "--info-text",
        "--destructive",
      ]) {
        expect(
          hueDistance(hue(meter), hue(token(theme, status))),
          `${theme} fit meter vs ${status}`,
        ).toBeGreaterThanOrEqual(30);
      }
      // Filled and empty marks are told apart by shape (a dot vs a ring) and
      // both clear the non-text floor on a row, open or not.
      for (const mark of ["--fit-meter", "--fit-meter-empty"]) {
        expectFloor(
          theme,
          mark,
          ["--card", "--surface-panel", "--surface-strong"],
          3,
        );
      }
    });

    it(`draws each Home stage in its own colour, offer in success (${theme})`, () => {
      const stages = [
        "--chart-waiting",
        "--chart-heard-back",
        "--chart-assessment",
        "--chart-interview",
        "--chart-offer",
        "--chart-closed",
      ].map((name) => token(theme, name));
      expect(new Set(stages).size).toBe(stages.length);
      expect(
        hueDistance(
          hue(token(theme, "--chart-offer")),
          hue(token(theme, "--success-text")),
        ),
      ).toBeLessThanOrEqual(15);
      // No stage borrows a status hue: info blue means Apply at work,
      // amber the person's turn, red a failure.
      for (const stage of [
        "--chart-heard-back",
        "--chart-assessment",
        "--chart-interview",
      ])
        for (const status of ["--info-text", "--warning-text", "--critical"])
          expect(
            hueDistance(hue(token(theme, stage)), hue(token(theme, status))),
          ).toBeGreaterThan(30);
      // Assessment and Interview are two stages on the board: two hues.
      expect(
        hueDistance(
          hue(token(theme, "--chart-assessment")),
          hue(token(theme, "--chart-interview")),
        ),
      ).toBeGreaterThan(40);
      // Every segment is a visible shape on the card: 3:1 by its fill, or,
      // for the quiet Closed segment, by its edge.
      expectFloor(theme, "--chart-waiting", ["--card"], 3);
      expectFloor(theme, "--chart-closed-edge", ["--card"], 3);
      for (const stage of [
        "--chart-heard-back",
        "--chart-assessment",
        "--chart-interview",
      ])
        expectFloor(theme, stage, ["--card"], 3);
    });
  }

  it("keeps the dark resume desk dark while the paper stays light", () => {
    expect(luminance(token("dark", "--surface-desk"))).toBeLessThan(
      luminance(token("dark", "--background")),
    );
    expect(globalsCss).toMatch(
      /--resume-preview-frame: var\(--surface-desk\);/,
    );
  });

  it("holds the palette to a small set of literal colours", () => {
    const hexes = new Set(
      (globalsCss.match(/#[0-9a-f]{6}\b/gi) ?? []).map((hex) =>
        hex.toLowerCase(),
      ),
    );
    expect(hexes.size, [...hexes].join(" ")).toBeLessThanOrEqual(85);
    const perTheme = THEMES.map(
      (theme) =>
        new Set(
          (SCOPES[theme].match(/#[0-9a-f]{6}\b/gi) ?? []).map((hex) =>
            hex.toLowerCase(),
          ),
        ).size,
    );
    for (const count of perTheme) {
      expect(count).toBeLessThanOrEqual(45);
    }
  });
});

describe("type scale", () => {
  const ALLOWED_PX = [12, 13, 14, 16, 19, 24, 30];

  function remToPx(value: string): number {
    const rem = value.match(/^([\d.]+)rem$/)?.[1];
    if (!rem) throw new Error(`not a rem value: ${value}`);
    return Number(rem) * 16;
  }

  it("re-points Tailwind's text sizes onto the seven-step scale", () => {
    const theme = globalsCss.slice(
      globalsCss.indexOf("@theme {"),
      globalsCss.indexOf("@theme inline"),
    );
    const sizes = [
      ...theme.matchAll(/--text-(xs|sm|base|lg|xl|2xl):\s*([\d.]+rem);/g),
    ];
    expect(sizes.map((match) => match[1])).toEqual([
      "xs",
      "sm",
      "base",
      "lg",
      "xl",
      "2xl",
    ]);
    for (const match of sizes) {
      expect(ALLOWED_PX).toContain(remToPx(match[2] ?? ""));
    }
  });

  it("keeps every text role token on the scale", () => {
    const roles = [
      ...ROOT_SCOPE.matchAll(/\n\s*(--text-[a-z0-9-]+):\s*([\d.]+rem);/g),
    ];
    expect(roles.length).toBeGreaterThan(15);
    const used = new Set<number>();
    for (const [, name, value] of roles) {
      const px = remToPx(value ?? "");
      expect(ALLOWED_PX, `${name} = ${px}px`).toContain(px);
      used.add(px);
    }
    expect([...used].sort((a, b) => a - b)).toEqual(ALLOWED_PX);
  });

  it("keeps headings strictly monotonic and titles lightly tracked", () => {
    const read = (name: string) =>
      remToPx(
        ROOT_SCOPE.match(new RegExp(`${name}:\\s*([\\d.]+rem)`))?.[1] ?? "",
      );
    expect(read("--text-heading-1")).toBeGreaterThan(read("--text-heading-2"));
    expect(read("--text-heading-2")).toBeGreaterThan(read("--text-heading-3"));
    expect(read("--text-heading-3")).toBeGreaterThan(read("--text-heading-4"));
    expect(ROOT_SCOPE).toMatch(/--tracking-page-title: -0\.02em;/);
  });

  it("ships zero remote font imports and native font stacks", () => {
    expect(globalsCss).not.toMatch(/@import\s+url\(/);
    expect(globalsCss).not.toMatch(/@font-face/);
    expect(ROOT_SCOPE).toMatch(/--font-body:\s*\n\s*-apple-system/);
    expect(ROOT_SCOPE).toMatch(/--font-mono: "SFMono-Regular"/);
  });

  it("pins field content to the field token instead of the parent size", () => {
    expect(globalsCss).toMatch(
      /input,\n\s*select,\n\s*textarea \{\n\s*font-family: inherit;\n\s*font-size: var\(--text-field\);/,
    );
  });
});

describe("radius and elevation scales", () => {
  it("publishes four radii and maps Tailwind's names onto them", () => {
    const radii = new Set(
      [...ROOT_SCOPE.matchAll(/--radius-[a-z]+:\s*([\d.]+rem);/g)].map(
        (match) => match[1],
      ),
    );
    expect([...radii].sort()).toEqual(["0.25rem", "0.375rem", "0.625rem"]);
    const theme = globalsCss.slice(
      globalsCss.indexOf("@theme {"),
      globalsCss.indexOf("@theme inline"),
    );
    for (const match of theme.matchAll(/--radius-[a-z0-9]+:\s*([\d.]+rem);/g)) {
      expect(["0.25rem", "0.375rem", "0.625rem"]).toContain(match[1]);
    }
  });

  it("publishes three elevations and maps every shadow utility onto them", () => {
    for (const theme of THEMES) {
      expect(SCOPES[theme]).toMatch(/--elevation-raised:/);
      expect(SCOPES[theme]).toMatch(/--elevation-overlay:/);
    }
    const inline = globalsCss.slice(globalsCss.indexOf("@theme inline"));
    for (const size of ["2xs", "xs", "sm", "md", "lg", "xl", "2xl"]) {
      expect(inline).toMatch(
        new RegExp(`--shadow-${size}: var\\(--elevation-(raised|overlay)\\);`),
      );
    }
  });
});

describe("one focus ring, one disclosure, one selection marker", () => {
  it("defines the focus ring as a 2px accent outline with an offset", () => {
    expect(globalsCss).toMatch(
      /@utility focus-ring \{\n\s*&:focus-visible \{\n\s*outline: 2px solid var\(--ring\);\n\s*outline-offset: 2px;/,
    );
  });

  it("re-asserts the full-strength ring over diluted ring utilities", () => {
    expect(globalsCss).toMatch(
      /:where\(\[class\*="ring-ring"\]\):is\(:focus-visible, :focus-within\) \{\n\s*--tw-ring-color: var\(--ring\);/,
    );
  });

  it("replaces the browser's disclosure triangle with the app chevron", () => {
    expect(globalsCss).toMatch(
      /summary::-webkit-details-marker \{\n\s*display: none;/,
    );
    expect(globalsCss).toMatch(
      /details\[open\] > summary:not\(\.list-none\):not\(\[data-slot\]\)::before \{\n\s*transform: rotate\(90deg\);/,
    );
  });

  it("draws selection markers inside the box", () => {
    expect(globalsCss).toMatch(
      /@utility selected-bar \{\n\s*box-shadow: inset 2px 0 0 0 var\(--row-selected-bar\);/,
    );
    expect(globalsCss).toMatch(
      /@utility selected-underline \{\n\s*box-shadow: inset 0 -2px 0 0 var\(--primary\);/,
    );
  });
});

describe("cascade layer discipline", () => {
  function stripCssComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  interface CssBlock {
    prelude: string;
    body: string;
  }

  function readBlocks(source: string): CssBlock[] {
    const blocks: CssBlock[] = [];
    let prelude = "";
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === ";") {
        prelude = "";
        index += 1;
        continue;
      }
      if (character !== "{") {
        prelude += character;
        index += 1;
        continue;
      }
      let depth = 1;
      let cursor = index + 1;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      blocks.push({
        prelude: prelude.trim(),
        body: source.slice(index + 1, cursor - 1),
      });
      prelude = "";
      index = cursor;
    }
    return blocks;
  }

  // A custom variant's body is a template for utilities, not a rule.
  const skippedAtRules = new Set([
    "@custom-variant",
    "@layer",
    "@keyframes",
    "@theme",
    "@utility",
  ]);

  function collectUnlayeredSelectors(source: string): string[] {
    const selectors: string[] = [];
    for (const block of readBlocks(source)) {
      if (block.prelude.startsWith("@")) {
        const atRule = block.prelude.split(/[\s(]/)[0] ?? "";
        if (!skippedAtRules.has(atRule)) {
          selectors.push(...collectUnlayeredSelectors(block.body));
        }
        continue;
      }
      if (block.prelude.length === 0) continue;
      selectors.push(
        ...block.prelude
          .split(",")
          .map((selector) => selector.trim())
          .filter((selector) => selector.length > 0),
      );
    }
    return selectors;
  }

  it("keeps every bare element rule inside a cascade layer", () => {
    const unlayered = collectUnlayeredSelectors(
      stripCssComments(globalsCss),
    ).filter((selector) => /^[a-zA-Z]/.test(selector));
    expect(unlayered).toEqual([]);
  });

  it("never lets an unlayered rule set a font size", () => {
    const unlayeredBodies = readBlocks(stripCssComments(globalsCss))
      .filter((block) => !block.prelude.startsWith("@"))
      .map((block) => block.body);
    for (const body of unlayeredBodies) {
      expect(body).not.toMatch(/font-size:/);
    }
  });
});

describe("interview overlay token scope", () => {
  it('publishes an empty :root[data-overlay="interview"] scope', () => {
    const scope = themeScope(':root[data-overlay="interview"]');
    expect(scope.replace(/\/\*[\s\S]*?\*\//g, "")).toMatch(
      /^:root\[data-overlay="interview"\] \{\s*$/,
    );
  });
});

/**
 * Job Finder source discipline: the renderer outside the parked Live
 * Assistant module uses scale tokens only.
 */
function listSources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "live-assistant" || entry === "node_modules") continue;
      out.push(...listSources(path));
    } else if (/\.(tsx?|css)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const JOB_FINDER_SOURCES = listSources(RENDERER_ROOT).map((path) => ({
  path: relative(RENDERER_ROOT, path),
  source: readFileSync(path, "utf8"),
}));

describe("Job Finder source discipline", () => {
  it("uses no arbitrary text sizes, radii or shadows", () => {
    const offenders: string[] = [];
    for (const { path, source } of JOB_FINDER_SOURCES) {
      for (const match of source.matchAll(
        /\b(text-\[[\d.]+(?:px|rem|em)\]|rounded(?:-[a-z]{1,2})?-\[(?!inherit)[^\]]+\]|shadow-\[[^\]]+\])/g,
      )) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses no tracked capitals or monospace labels", () => {
    const offenders: string[] = [];
    for (const { path, source } of JOB_FINDER_SOURCES) {
      if (path.endsWith(".css")) continue;
      for (const match of source.matchAll(
        /className=[{"`][^>]*?["`\s](uppercase|tracking-\[0?\.\d+em\])["`\s]/g,
      )) {
        offenders.push(`${path}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("references only declared custom properties", () => {
    const declared = new Set<string>();
    for (const match of globalsCss.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) {
      declared.add(match[1] ?? "");
    }
    for (const { source } of JOB_FINDER_SOURCES) {
      // Inline style objects, `setProperty` calls and named constants all
      // declare a property at runtime.
      for (const match of source.matchAll(
        /["'`[]\s*(--[a-z][a-z0-9-]*)["'`]|(--[a-z][a-z0-9-]*)\s*:/g,
      )) {
        declared.add(match[1] ?? match[2] ?? "");
      }
    }
    const runtime =
      /^--(tw|radix|color|text-(xs|sm|base|lg|xl|2xl)|shadow|radius|font|animate|spacing|breakpoint|default)/;
    const missing = new Set<string>();
    for (const { path, source } of JOB_FINDER_SOURCES) {
      for (const match of source.matchAll(
        /(?:var\(|-\()(--[a-z][a-z0-9-]*)/g,
      )) {
        const name = match[1] ?? "";
        if (!declared.has(name) && !runtime.test(name)) {
          missing.add(`${path}: ${name}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
