import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  new URL("./globals.css", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const buttonSource = readFileSync(
  new URL("../components/ui/button.tsx", import.meta.url),
  "utf8",
);
const badgeSource = readFileSync(
  new URL("../components/ui/badge.tsx", import.meta.url),
  "utf8",
);
const shellSource = readFileSync(
  new URL(
    "../features/job-finder/components/job-finder-shell.tsx",
    import.meta.url,
  ),
  "utf8",
);

const labelSource = readFileSync(
  new URL("../components/ui/label.tsx", import.meta.url),
  "utf8",
);
const chipSource = readFileSync(
  new URL("../components/ui/chip.tsx", import.meta.url),
  "utf8",
);
const textLinkSource = readFileSync(
  new URL("../components/ui/text-link.tsx", import.meta.url),
  "utf8",
);
const checkboxSource = readFileSync(
  new URL("../components/ui/checkbox.tsx", import.meta.url),
  "utf8",
);
const selectableRowSource = readFileSync(
  new URL("../components/ui/selectable-row.tsx", import.meta.url),
  "utf8",
);
const collectionSearchToolbarSource = readFileSync(
  new URL(
    "../features/job-finder/components/collection-search-toolbar.tsx",
    import.meta.url,
  ),
  "utf8",
);

function readToken(scope: string, token: string): string {
  const value = scope.match(
    new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];

  if (!value) {
    throw new Error(`Missing ${token} in theme scope`);
  }

  return value;
}

function readColorToken(scope: string, token: string): string {
  const hex = scope.match(
    new RegExp(`${token}\\s*:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  const rgba = scope.match(
    new RegExp(`${token}\\s*:\\s*(rgba?\\([^)]+\\))`, "i"),
  )?.[1];

  const value = hex ?? rgba;

  if (!value) {
    throw new Error(`Missing ${token} in theme scope`);
  }

  return value;
}

function readDeclaration(scope: string, property: string): string {
  const value = scope.match(new RegExp(`${property}\\s*:\\s*([^;]+)`))?.[1];

  if (!value) {
    throw new Error(`Missing ${property} declaration`);
  }

  return value.trim();
}

function relativeLuminance(color: string): number {
  const channels = [0, 1, 2].map(
    (index) =>
      Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255,
  );
  const weights = [0.2126, 0.7152, 0.0722] as const;

  return channels.reduce((sum, channel, index) => {
    const linear =
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const weight = weights[index];

    return sum + (weight === undefined ? 0 : linear * weight);
  }, 0);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);

  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

/** Composite a translucent rgb(a) color over an opaque hex surface. */
function composite(translucent: string, background: string): string {
  const match = translucent.match(
    /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/,
  );

  if (!match) {
    return translucent;
  }

  const alpha = Number(match[4] ?? 1);
  const mix = (foreground: number, backing: number) =>
    Math.round(alpha * foreground + (1 - alpha) * backing);

  return `#${[
    mix(Number(match[1]), Number.parseInt(background.slice(1, 3), 16)),
    mix(Number(match[2]), Number.parseInt(background.slice(3, 5), 16)),
    mix(Number(match[3]), Number.parseInt(background.slice(5, 7), 16)),
  ]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Blend an opaque hex color at `alpha` over an opaque hex surface. */
function alphaBlend(hex: string, alpha: number, background: string): string {
  return composite(
    `rgba(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(
      hex.slice(3, 5),
      16,
    )}, ${Number.parseInt(hex.slice(5, 7), 16)}, ${alpha})`,
    background,
  );
}

function themeScope(selector: string): string {
  const normalizedCss = globalsCss.replace(/\r\n/g, "\n");
  const normalizedSelector = selector.replace(/\r\n/g, "\n");
  const start = normalizedCss.indexOf(normalizedSelector);
  const end = normalizedCss.indexOf("\n}", start);

  if (start < 0 || end < 0) {
    throw new Error(`Missing ${selector} theme scope`);
  }

  return normalizedCss.slice(start, end);
}

const LIGHT_THEME = themeScope(':root[data-theme="light"]');
const DARK_THEME = themeScope(':root,\n:root[data-theme="dark"]');
const ROOT_SCOPE = themeScope(":root {");

/**
 * The dark surface ladder, read from the stylesheet instead of copied as hex
 * literals, so every contrast assertion below measures the palette that
 * actually ships. The ladder itself is pinned in "dark surface ladder".
 */
const DK = {
  rail: readToken(DARK_THEME, "--sidebar-bg"),
  background: readToken(DARK_THEME, "--background"),
  surface: readToken(DARK_THEME, "--surface"),
  field: readToken(DARK_THEME, "--field"),
  card: readToken(DARK_THEME, "--card"),
  popover: readToken(DARK_THEME, "--popover"),
  secondary: readToken(DARK_THEME, "--secondary"),
  strong: readToken(DARK_THEME, "--surface-strong"),
  accent: readToken(DARK_THEME, "--accent"),
  navActive: readToken(DARK_THEME, "--nav-active-surface"),
};

// Interior surfaces where status text, badges, and chips actually render.
const LIGHT_SURFACES = {
  canvas: "#e6e8eb",
  toolbar: "#e2e5e9",
  muted: "#e8eaed",
  accent: "#d3dde9",
  panel: "#f6f7f8",
  popover: "#fbfbfc",
};

// Surfaces a focus indicator can sit against, including outer chrome.
const RING_ADJACENT_LIGHT = ["#dfe2e6", ...Object.values(LIGHT_SURFACES)];
const RING_ADJACENT_DARK = [
  DK.background,
  DK.surface,
  DK.card,
  DK.popover,
  DK.secondary,
  DK.accent,
];

describe("global color tokens", () => {
  it("keeps dark muted text at AA contrast on every shared solid surface", () => {
    const mutedForeground = readToken(DARK_THEME, "--muted-foreground");
    const sharedDarkSurfaces = [
      DK.background, // --background
      DK.surface, // --surface / shell
      DK.field, // --surface-muted / field
      DK.card, // --card / panel
      DK.popover, // --popover / muted
      DK.secondary, // --secondary
      DK.strong, // --surface-strong
      DK.accent, // --accent
    ];

    for (const background of sharedDarkSurfaces) {
      expect(
        contrastRatio(mutedForeground, background),
        `${mutedForeground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the light muted text token at AA contrast on shared light surfaces", () => {
    const mutedForeground = readToken(LIGHT_THEME, "--muted-foreground");

    for (const background of Object.values(LIGHT_SURFACES)) {
      expect(
        contrastRatio(mutedForeground, background),
        `${mutedForeground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps light solid-fill foregrounds at AA contrast, including /90 hovers", () => {
    const fills: Array<[string, string]> = [
      ["--primary", "--primary-foreground"],
      ["--primary-fill", "--primary-fill-foreground"],
      ["--active", "--active-foreground"],
      ["--positive", "--positive-foreground"],
      ["--destructive", "--destructive-foreground"],
      ["--critical", "--critical-foreground"],
    ];

    for (const [fillToken, foregroundToken] of fills) {
      const fill = readToken(LIGHT_THEME, fillToken);
      const foreground = readToken(LIGHT_THEME, foregroundToken);
      const hovered = alphaBlend(fill, 0.9, LIGHT_SURFACES.popover);

      expect(
        contrastRatio(foreground, fill),
        `${foregroundToken} on ${fillToken}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(foreground, hovered),
        `${foregroundToken} on ${fillToken}/90 over popover`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps dark solid-fill foregrounds at AA contrast, including /90 hovers", () => {
    const fills: Array<[string, string]> = [
      ["--primary", "--primary-foreground"],
      ["--primary-fill", "--primary-fill-foreground"],
      ["--active", "--active-foreground"],
      ["--positive", "--positive-foreground"],
      ["--destructive", "--destructive-foreground"],
      ["--critical", "--critical-foreground"],
    ];

    for (const [fillToken, foregroundToken] of fills) {
      const fill = readToken(DARK_THEME, fillToken);
      const foreground = readToken(DARK_THEME, foregroundToken);
      const hovered = alphaBlend(fill, 0.9, DK.card);

      expect(
        contrastRatio(foreground, fill),
        `dark ${foregroundToken} on ${fillToken}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(foreground, hovered),
        `dark ${foregroundToken} on ${fillToken}/90 over card`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dark filled primary readable as a filled control, not a disabled chip", () => {
    // Dogfood round two: the dark "primary" CTA sat close enough to the
    // panels and to --secondary that reviewers read Approve resume /
    // Apply / Finish in the open browser as disabled. That was fixed by a
    // pale #8fa6c6 slab at ~7:1 against the panels, which then read as the
    // glare the person called "too much". The filled action now lives on
    // --primary-fill: a mid steel-blue behind white text. It is identified
    // as the one filled control by hue plus a 3:1 fill boundary against
    // every surface it renders on, including --secondary beside it.
    const fill = readToken(DARK_THEME, "--primary-fill");
    const foreground = readToken(DARK_THEME, "--primary-fill-foreground");
    const secondary = readToken(DARK_THEME, "--secondary");
    const carrierSurfaces = [
      DK.card, // --card / --surface-panel
      DK.surface, // --surface
      DK.popover, // --popover
      DK.secondary, // --secondary
      DK.strong, // --surface-strong (studio next-step bar)
    ];

    for (const background of carrierSurfaces) {
      expect(
        contrastRatio(fill, background),
        `dark --primary-fill on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }

    expect(
      contrastRatio(fill, secondary),
      "dark --primary-fill must not read as the secondary chip",
    ).toBeGreaterThanOrEqual(3);

    for (const [label, backing] of [
      ["fill", fill],
      ["/90 hover over card", alphaBlend(fill, 0.9, DK.card)],
    ] as const) {
      expect(
        contrastRatio(foreground, backing),
        `dark --primary-fill-foreground on the ${label}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // Restrained steel family: keep the blue channel leading without
    // drifting into a saturated neon accent.
    for (const color of [fill, readToken(DARK_THEME, "--primary")]) {
      const [red, green, blue] = [1, 3, 5].map((offset) =>
        Number.parseInt(color.slice(offset, offset + 2), 16),
      ) as [number, number, number];

      expect(blue, `${color} stays blue-led`).toBeGreaterThan(green);
      expect(green, `${color} stays blue-led`).toBeGreaterThan(red);
      expect(
        blue - red,
        `${color} stays a restrained steel, not neon`,
      ).toBeLessThanOrEqual(100);
    }
  });

  it("keeps light status text tokens at AA contrast on interior surfaces and tinted chips", () => {
    const statusTokens: Array<[string, number | null]> = [
      ["--primary", 0.15], // default badge fill is bg-primary/15
      ["--destructive", 0.15],
      ["--critical", 0.15],
      ["--warning-text", 0.09],
      ["--success-text", 0.1],
      ["--info-text", 0.1],
      ["--positive", null],
    ];

    for (const [token, tintAlpha] of statusTokens) {
      const foreground = readToken(LIGHT_THEME, token);

      for (const [surfaceName, surface] of Object.entries(LIGHT_SURFACES)) {
        expect(
          contrastRatio(foreground, surface),
          `${token} on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(4.5);

        if (tintAlpha !== null) {
          const tintedFill =
            token === "--warning-text"
              ? composite(
                  readColorToken(LIGHT_THEME, "--warning-surface"),
                  surface,
                )
              : token === "--success-text"
                ? composite(
                    readColorToken(LIGHT_THEME, "--success-surface"),
                    surface,
                  )
                : token === "--info-text"
                  ? composite(
                      readColorToken(LIGHT_THEME, "--info-surface"),
                      surface,
                    )
                  : alphaBlend(foreground, tintAlpha, surface);

          expect(
            contrastRatio(foreground, tintedFill),
            `${token} on tinted fill over ${surfaceName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps the selected sidebar destination distinguishable from the rail in both themes", () => {
    // Round-three review measured the light active row at rgb(227,229,233)
    // against a rgb(230,233,235) rail: a ~1% delta, so only a 2px bar told the
    // user which page they were on. In light the selected fill owns the state
    // at >= 3:1. In dark a 3:1 fill against a near-black rail has to be a
    // mid-grey slab (#5a6878 was), which was the loudest shape on screen; the
    // dark state is carried by the accent bar (>= 3:1 against both the rail
    // and the fill), the accent icon and the bolder label, over a fill that is
    // a visible step but not a slab.
    for (const [themeName, scope, canvas, fillFloor] of [
      ["light", LIGHT_THEME, "#e6e8eb", 3],
      ["dark", DARK_THEME, DK.background, 1.2],
    ] as const) {
      const rail = composite(
        readColorToken(scope, "--shell-header-bg"),
        canvas,
      );
      const surface = readColorToken(scope, "--nav-active-surface");
      const foreground = readColorToken(scope, "--nav-active-foreground");
      const bar = readColorToken(scope, "--nav-active-bar");

      expect(
        contrastRatio(surface, rail),
        `${themeName} --nav-active-surface against the sidebar rail`,
      ).toBeGreaterThanOrEqual(fillFloor);
      if (themeName === "dark") {
        // Dark only: the bar is the state carrier there. The light bar is
        // drawn on its dark fill and never touches the rail.
        expect(
          contrastRatio(bar, rail),
          `${themeName} --nav-active-bar against the sidebar rail`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(
        contrastRatio(foreground, surface),
        `${themeName} --nav-active-foreground on the selected fill`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(bar, surface),
        `${themeName} --nav-active-bar against the selected fill`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the focus ring at 3:1 non-text contrast against adjacent surfaces in both themes", () => {
    const lightRing = readColorToken(LIGHT_THEME, "--ring");
    const darkRing = readColorToken(DARK_THEME, "--ring");

    for (const background of RING_ADJACENT_LIGHT) {
      expect(
        contrastRatio(composite(lightRing, background), background),
        `light ${lightRing} next to ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }

    for (const background of RING_ADJACENT_DARK) {
      expect(
        contrastRatio(composite(darkRing, background), background),
        `dark ${darkRing} next to ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("renders owned primitives with a full-strength focus ring", () => {
    for (const [name, source] of [
      ["button.tsx", buttonSource],
      ["badge.tsx", badgeSource],
    ] as const) {
      expect(
        source,
        `${name} should use focus-visible:ring-2 focus-visible:ring-ring`,
      ).toContain("focus-visible:ring-2 focus-visible:ring-ring");
      expect(
        source,
        `${name} should not dilute the ring with opacity`,
      ).not.toMatch(/focus-visible:ring-(?:ring|destructive)\/\d/);
    }
  });

  it("keeps dark status tokens at AA contrast so light fixes never regress dark", () => {
    const darkSurfaces = Object.values({
      background: DK.background,
      surface: DK.surface,
      field: DK.field,
      card: DK.card,
      popover: DK.popover,
      secondary: DK.secondary,
      strong: DK.strong,
      accent: DK.accent,
    });
    const statusScopes: Array<[string, ReadonlySet<string>]> = [
      ["--muted-foreground", new Set()],
      ["--destructive", new Set()],
      ["--critical", new Set()],
      ["--positive", new Set()],
      // Accent and surface-strong are transient hover fills; static
      // text-primary never renders on them.
      ["--primary", new Set([DK.accent, DK.strong])],
    ];

    for (const [token, excluded] of statusScopes) {
      const foreground = readToken(DARK_THEME, token);

      for (const background of darkSurfaces) {
        if (excluded.has(background)) {
          continue;
        }

        expect(
          contrastRatio(foreground, background),
          `dark ${token} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    const softTextOnTint: Array<[string, string]> = [
      ["--warning-text", "--warning-surface"],
      ["--success-text", "--success-surface"],
      ["--info-text", "--info-surface"],
    ];

    for (const [textToken, surfaceToken] of softTextOnTint) {
      const foreground = readToken(DARK_THEME, textToken);
      const tintedSurface = readColorToken(DARK_THEME, surfaceToken);

      for (const background of [DK.card, DK.popover]) {
        expect(
          contrastRatio(foreground, composite(tintedSurface, background)),
          `dark ${textToken} on ${surfaceToken} over ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("semantic status token separation", () => {
  // Success and info were byte-identical in both themes (one steel-blue
  // family), collapsing ready/success callouts into informational ones.
  // These pins keep every status family on its own hue with AA-readable
  // text, matching the contract documented in globals.css.
  function channelTriplet(hex: string): [number, number, number] {
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
  }

  function assertHueDominance(
    themeName: string,
    token: string,
    hex: string,
    dominant: "red" | "green" | "blue",
  ): void {
    const [red, green, blue] = channelTriplet(hex);
    const channels = { red, green, blue };

    for (const [channel, value] of Object.entries(channels)) {
      if (channel === dominant) {
        continue;
      }

      expect(
        channels[dominant] - value,
        `${themeName} ${token} (${hex}) must stay ${dominant}-dominant`,
      ).toBeGreaterThanOrEqual(12);
    }
  }

  const STATUS_SURFACES_DARK = [
    DK.background,
    DK.surface,
    DK.field,
    DK.card,
    DK.popover,
    DK.secondary,
    DK.strong,
    DK.accent,
  ];

  it("never lets success duplicate the info family in either theme", () => {
    for (const [themeName, scope] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      for (const part of ["border", "surface", "text"] as const) {
        expect(
          readColorToken(scope, `--success-${part}`),
          `${themeName} --success-${part} must not duplicate --info-${part}`,
        ).not.toBe(readColorToken(scope, `--info-${part}`));
      }
    }

    // Exact pins guard the agreed restrained palette (sage green, no neon).
    expect(readToken(DARK_THEME, "--success-text")).toBe("#96c4a0");
    expect(readColorToken(DARK_THEME, "--success-surface")).toBe(
      "rgba(150, 196, 160, 0.1)",
    );
    expect(readColorToken(DARK_THEME, "--success-border")).toBe(
      "rgba(150, 196, 160, 0.28)",
    );
    expect(readToken(LIGHT_THEME, "--success-text")).toBe("#28563a");
    expect(readColorToken(LIGHT_THEME, "--success-surface")).toBe(
      "rgba(40, 86, 58, 0.1)",
    );
    expect(readColorToken(LIGHT_THEME, "--success-border")).toBe(
      "rgba(40, 86, 58, 0.34)",
    );
  });

  it("keeps each status family on its own hue channel", () => {
    const hueRoles: Array<[string, "red" | "green" | "blue"]> = [
      ["--success-text", "green"],
      ["--positive", "green"],
      ["--info-text", "blue"],
      ["--warning-text", "red"],
      ["--destructive", "red"],
      ["--critical", "red"],
    ];

    for (const [themeName, scope] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      for (const [token, dominant] of hueRoles) {
        assertHueDominance(themeName, token, readToken(scope, token), dominant);
      }
    }
  });

  it("keeps the five status text tokens mutually distinct in both themes", () => {
    const statusTokens = [
      "--success-text",
      "--info-text",
      "--warning-text",
      "--destructive",
      "--critical",
    ];

    for (const [themeName, scope] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      const values = statusTokens.map((token) => readToken(scope, token));

      expect(
        new Set(values).size,
        `${themeName} status tokens must not collapse into one value`,
      ).toBe(statusTokens.length);
    }
  });

  it("keeps success callout text at AA contrast on shared surfaces and its own tint in both themes", () => {
    const cases: Array<[string, string, readonly string[], number]> = [
      ["dark", DARK_THEME, STATUS_SURFACES_DARK, 0.12],
      ["light", LIGHT_THEME, Object.values(LIGHT_SURFACES), 0.1],
    ];

    for (const [themeName, scope, surfaces, tintAlpha] of cases) {
      const text = readToken(scope, "--success-text");
      const [red, green, blue] = channelTriplet(text);
      const tint = `rgba(${red}, ${green}, ${blue}, ${tintAlpha})`;

      for (const background of surfaces) {
        expect(
          contrastRatio(text, background),
          `${themeName} --success-text on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(text, composite(tint, background)),
          `${themeName} --success-text on success tint over ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("aligns the ready/positive accent with the success family at AA fill contrast", () => {
    // Every --positive consumer expresses success/ready semantics
    // (submitted/interview/offer/ready badges, safeguard-clear callouts,
    // positive timeline events); selected/active styling stays on
    // --primary/--active. The accent therefore shares the success sage
    // family instead of duplicating the primary blue one.
    expect(readToken(DARK_THEME, "--positive")).toBe("#96c4a0");
    expect(readToken(LIGHT_THEME, "--positive")).toBe("#28563a");

    for (const [themeName, scope] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      const fill = readToken(scope, "--positive");
      const foreground = readToken(scope, "--positive-foreground");
      const hovered = alphaBlend(fill, 0.9, LIGHT_SURFACES.popover);

      for (const other of [
        readToken(scope, "--info-text"),
        readToken(scope, "--warning-text"),
        readToken(scope, "--destructive"),
        readToken(scope, "--critical"),
      ]) {
        expect(
          fill,
          `${themeName} --positive must not duplicate ${other}`,
        ).not.toBe(other);
      }

      expect(
        contrastRatio(foreground, fill),
        `${themeName} --positive-foreground on --positive`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(foreground, hovered),
        `${themeName} --positive-foreground on --positive/90 over popover`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("keyboard focus ring discipline", () => {
  // Tailwind compiles ring-ring/30 and ring-ring/40 to
  // `--tw-ring-color: color-mix(in oklab, var(--ring) 30%, transparent)`
  // inside the utilities layer; those composite to ~1.5-1.9:1 against the
  // interior surfaces. The unlayered rule below re-asserts the established
  // token at full strength at focus time (that token is pinned above 3:1
  // by "keeps the focus ring at 3:1 non-text contrast...").
  function focusRingEnforcement(): RegExpMatchArray | null {
    return globalsCss.match(
      /\[class\*="ring-ring"\]\)\s*:\s*is\(:focus-visible,\s*:focus-within\)\s*\{(?<body>[^}]*)\}/,
    );
  }

  it("keeps ring-ring focus states bound to the full-strength ring token", () => {
    expect(
      focusRingEnforcement(),
      "globals.css must force ring-ring focus states to var(--ring)",
    ).not.toBeNull();
  });

  it("enforces the ring color without diluting it again", () => {
    const body = focusRingEnforcement()?.groups?.body ?? "";

    expect(body).toMatch(/^\s*--tw-ring-color:\s*var\(--ring\);\s*$/);
    expect(
      body,
      "the override must stay layer-beating, not !important",
    ).not.toMatch(/!important/);
    expect(
      body,
      "the override must not re-introduce an alpha-diluted ring color",
    ).not.toMatch(/color-mix|rgba?\(|\/\d+/);
  });
});

describe("editable field versus read-only well tokens", () => {
  it("preserves the read-only well colors exactly in both themes", () => {
    expect(readToken(DARK_THEME, "--surface-well")).toBe("#191c20");
    expect(readToken(DARK_THEME, "--surface-well-border")).toBe("#32373e");
    expect(readToken(LIGHT_THEME, "--surface-well")).toBe("#eef0f2");
    expect(readToken(LIGHT_THEME, "--surface-well-border")).toBe("#b1b8bf");
  });

  it("keeps the editable field fill with a softened resting boundary that hover restores", () => {
    expect(readToken(DARK_THEME, "--field")).toBe("#17191d");
    expect(readToken(LIGHT_THEME, "--field")).toBe("#fcfcfd");
    // The resting border was softened from the r15 values (#677480 dark,
    // #7a828b light, both >=3:1) because fields read as heavy outlined boxes.
    // It now sits one step above the inert panel band (2.74:1 dark, 2.79:1
    // light on the card) so the ladder panel < field < control holds, and the
    // former values return on hover, so every interacted state clears 3:1.
    expect(readToken(DARK_THEME, "--field-border")).toBe("#58606a");
    expect(readToken(LIGHT_THEME, "--field-border")).toBe("#8e969f");
    expect(readToken(DARK_THEME, "--field-border-hover")).toBe("#6a737d");
    expect(readToken(LIGHT_THEME, "--field-border-hover")).toBe("#7a828b");

    // Focus remains the strongest field state.
    expect(readToken(DARK_THEME, "--field-focus-border")).toBe("#8aa6d6");
    expect(readToken(LIGHT_THEME, "--field-focus-border")).toBe("#3a5274");
  });

  it("decouples the focused field fill from card and popover surfaces", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      const focusedFill = readToken(theme, "--field-strong");

      expect(focusedFill).not.toBe(readToken(theme, "--card"));
      expect(focusedFill).not.toBe(readToken(theme, "--popover"));
      expect(
        contrastRatio(readToken(theme, "--foreground"), focusedFill),
      ).toBeGreaterThanOrEqual(4.5);
    }

    expect(readToken(DARK_THEME, "--field-strong")).toBe("#20242a");
    expect(readToken(LIGHT_THEME, "--field-strong")).toBe("#ffffff");
  });
});

describe("global typography sources", () => {
  it("ships zero remote font imports so the renderer makes no font network requests", () => {
    expect(globalsCss).not.toMatch(/@import\s+url\(/i);
    expect(globalsCss).not.toMatch(/https?:\/\//i);
    expect(globalsCss).toMatch(/@import\s+"tailwindcss"/);
  });

  it("resolves body and headline through native sans stacks with platform fallbacks", () => {
    for (const token of ["--font-body", "--font-headline"]) {
      const stack = readDeclaration(ROOT_SCOPE, token);

      expect(stack, `${token} needs a macOS native face`).toContain(
        "-apple-system",
      );
      expect(stack, `${token} needs the Chromium native face`).toContain(
        "BlinkMacSystemFont",
      );
      expect(stack, `${token} needs a Windows native face`).toContain(
        '"Segoe UI"',
      );
      expect(stack, `${token} must end in the sans generic`).toMatch(
        /sans-serif$/,
      );
      expect(stack, `${token} must not reference remote families`).not.toMatch(
        /IBM Plex|Inter|\bArial\b/i,
      );
    }

    expect(readDeclaration(ROOT_SCOPE, "--font-body")).toBe(
      readDeclaration(ROOT_SCOPE, "--font-headline"),
    );
  });

  it("resolves mono through a native monospace stack covering macOS, Windows, and Linux", () => {
    const stack = readDeclaration(ROOT_SCOPE, "--font-mono");

    expect(stack).toContain('"SFMono-Regular"');
    expect(stack).toContain("Menlo");
    expect(stack).toContain("Consolas");
    expect(stack).toContain('"Liberation Mono"');
    expect(stack.endsWith("monospace")).toBe(true);
    expect(stack).not.toMatch(/IBM Plex/i);
    expect(stack).not.toBe(readDeclaration(ROOT_SCOPE, "--font-body"));
  });

  it("keeps body, headline, and mono consumers bound to the shared variables", () => {
    expect(globalsCss).toMatch(
      /body\s*\{[^}]*font-family:\s*var\(--font-body\)/,
    );
    expect(globalsCss).toMatch(
      /\bh1\s*\{[^}]*font-family:\s*var\(--font-headline\)/,
    );
    expect(globalsCss).toMatch(
      /\bh2\s*\{[^}]*font-family:\s*var\(--font-headline\)/,
    );
    expect(globalsCss).toMatch(
      /\.label-mono-xs\s*\{[^}]*font-family:\s*var\(--font-mono\)/,
    );
    expect(globalsCss).toMatch(
      /\.card-heading-sm\s*\{[^}]*font-family:\s*var\(--font-mono\)/,
    );
    expect(globalsCss).toMatch(/--font-sans:\s*var\(--font-body\)/);
    expect(globalsCss).toMatch(/--font-display:\s*var\(--font-headline\)/);
    expect(globalsCss).toMatch(/--font-mono:\s*var\(--font-mono\)/);
  });
});

describe("page header grammar tokens", () => {
  it("defines the shared header stack spacing contract once", () => {
    expect(readDeclaration(DARK_THEME, "--gap-page-header-aux")).toBe("0.5rem");
    expect(readDeclaration(DARK_THEME, "--gap-page-header-body")).toBe(
      "0.75rem",
    );
  });

  it("binds the page title and description type to existing tokens", () => {
    for (const token of [
      "--text-page-title-compact",
      "--text-page-description-compact",
      "--tracking-page-title-compact",
    ]) {
      expect(readDeclaration(DARK_THEME, token), token).toBeTruthy();
    }
  });
});

describe("shell grid breakpoint contract", () => {
  // The shell component hides the compact route strip and shows the sidebar
  // through min-[1440px] Tailwind variants, while the grid itself switches
  // through these media queries. The stale [1120,1440) regime (grid wide at
  // 1120, variants wide at 1440) collapsed the compact route strip to ~8px
  // at native 125% zoom (physical 1440 -> CSS 1152); these pins keep the
  // two sides from drifting apart again.
  function shellGridMediaQueries(): string[] {
    return Array.from(
      globalsCss.matchAll(/@media([^{]+)\{\s*\.job-finder-shell-grid/g),
    )
      .map((match) => match[1]?.trim())
      .filter((query): query is string => query !== undefined);
  }

  it("keeps exactly two shell-grid bands partitioned at the 1440/1439 CSS px bound", () => {
    expect(shellGridMediaQueries()).toEqual([
      "(min-width: 1440px)",
      "(min-width: 640px) and (max-width: 1439px)",
    ]);
  });

  it("keeps every desktop shell breakpoint variant on the same 1440px bound", () => {
    const desktopVariants = [
      ...new Set(
        Array.from(shellSource.matchAll(/min-\[(\d+)px\]:/g)).map((match) =>
          Number(match[1]),
        ),
      ),
    ].filter((pixels) => pixels >= 1024);

    expect(desktopVariants).toEqual([1440]);
  });

  it("never resurrects the stale 1120/1119px shell-grid bounds", () => {
    expect(globalsCss).not.toMatch(/(?:min-width|max-width):\s*11(?:20|19)px/);
  });
});

describe("cascade layer discipline", () => {
  // An unlayered rule beats every layered rule regardless of specificity, so a
  // bare `h1 { font-size: … }` written outside a layer outranks the
  // `text-(length:--text-page-title-compact)` utility a page title carries.
  // That is what forced an `!` important modifier onto the Resume Studio
  // title. Element defaults must stay inside `@layer base`.
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
        if (source[cursor] === "{") {
          depth += 1;
        } else if (source[cursor] === "}") {
          depth -= 1;
        }
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

  const skippedAtRules = new Set(["@layer", "@keyframes", "@theme"]);

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

      if (block.prelude.length === 0) {
        continue;
      }

      selectors.push(
        ...block.prelude
          .split(",")
          .map((selector) => selector.trim())
          .filter((selector) => selector.length > 0),
      );
    }

    return selectors;
  }

  function readBaseLayerBody(source: string): string {
    return readBlocks(source)
      .filter((block) => block.prelude === "@layer base")
      .map((block) => block.body)
      .join("\n");
  }

  it("keeps every bare element rule inside a cascade layer", () => {
    const unlayeredElementSelectors = collectUnlayeredSelectors(
      stripCssComments(globalsCss),
    ).filter((selector) => /^[a-zA-Z]/.test(selector));

    expect(
      unlayeredElementSelectors,
      "element rules outside a layer beat every Tailwind utility; move them into @layer base",
    ).toEqual([]);
  });

  it("keeps the heading and document defaults in @layer base", () => {
    const baseLayer = readBaseLayerBody(stripCssComments(globalsCss));

    for (const selector of ["html,", "body {", "h1 {", "h2 {", "strong {"]) {
      expect(baseLayer, `${selector} must live in @layer base`).toContain(
        selector,
      );
    }
  });
});

/**
 * The published type scale.
 *
 * Before this contract existed only h1 and h2 carried a size, so h3-h6 fell
 * through Tailwind preflight's `font-size: inherit` and rendered at whatever
 * their container happened to be: H2 appeared at 12 distinct sizes and H3 at
 * 9, with confirmed level inversions on Settings, Studio, Safeguards,
 * Shortlisted, Find jobs, Applications and Profile. Fields inherited the same
 * way and rendered at 17-19px against 11px labels.
 */
describe("published type scale", () => {
  function readRem(token: string): number {
    const value = readDeclaration(DARK_THEME, token);
    const rem = value.match(/^([\d.]+)rem$/)?.[1];
    const px = value.match(/^([\d.]+)px$/)?.[1];

    if (rem !== undefined) {
      return Number(rem) * 16;
    }

    if (px !== undefined) {
      return Number(px);
    }

    throw new Error(`${token} is not a plain rem/px length: ${value}`);
  }

  it("keeps the heading levels strictly monotonic", () => {
    const h1 = readRem("--text-heading-1");
    const h2 = readRem("--text-heading-2");
    const h3 = readRem("--text-heading-3");
    const h4 = readRem("--text-heading-4");

    expect(h1).toBeGreaterThan(h2);
    expect(h2).toBeGreaterThan(h3);
    expect(h3).toBeGreaterThan(h4);
    expect([h1, h2, h3, h4]).toEqual([24, 19, 16, 14]);
  });

  it("renders field content at body size", () => {
    expect(readDeclaration(DARK_THEME, "--text-field")).toBe(
      "var(--text-body)",
    );
    expect(readRem("--text-body")).toBeCloseTo(14.72, 5);
  });

  it("gives every heading level an explicit size and weight in @layer base", () => {
    const baseLayer = globalsCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("@layer base {")
      .slice(1)
      .join("\n");

    for (const [selector, token] of [
      ["h1", "--text-heading-1"],
      ["h2", "--text-heading-2"],
      ["h3", "--text-heading-3"],
      ["h4,\n  h5,\n  h6", "--text-heading-4"],
    ] as const) {
      const rule = baseLayer.match(
        new RegExp(`(?:^|\\n)  ${selector} \\{([^}]*)\\}`),
      )?.[1];

      expect(rule, `${selector} must be declared in @layer base`).toBeTruthy();
      expect(rule).toContain(`font-size: var(${token})`);
      expect(rule).toContain("font-weight: 600");
    }

    const paragraphRules = [
      ...baseLayer.matchAll(/(?:^|\n) {2}p \{([^}]*)\}/g),
    ].map((match) => match[1] ?? "");

    expect(
      paragraphRules.some((rule) =>
        rule.includes("font-size: var(--text-body)"),
      ),
      "p must carry the body size in @layer base",
    ).toBe(true);
  });

  it("pins field size instead of letting `font: inherit` pull the parent size", () => {
    const fieldRule = globalsCss.match(
      /\n {2}input,\n {2}select,\n {2}textarea \{([^}]*)\}/,
    )?.[1];

    expect(fieldRule, "fields need their own base rule").toBeTruthy();
    expect(fieldRule).toContain("font-size: var(--text-field)");
    expect(
      globalsCss,
      "fields must no longer take their size from the parent",
    ).not.toContain("  input,\n  select,\n  textarea {\n    font: inherit;");
  });

  it("keeps the page title fixed rather than viewport-derived", () => {
    // A vw-derived clamp made the title land on a different size per route
    // (24 vs 24.5), so it visibly shifted while navigating.
    const pageTitle = readDeclaration(DARK_THEME, "--text-page-title-compact");

    expect(pageTitle).toBe("var(--text-heading-1)");
    expect(pageTitle).not.toContain("vw");
  });

  it("holds every label-family token at the 11px floor", () => {
    for (const token of [
      "--text-eyebrow",
      "--text-field-label",
      "--text-label",
      "--text-tiny",
      "--text-label-mono-xs",
      "--text-card-heading-sm",
      "--text-count",
    ]) {
      expect(readRem(token), token).toBeGreaterThanOrEqual(11);
    }
  });

  it("keeps owned primitives off literal font sizes", () => {
    for (const [name, source] of [
      ["label", labelSource],
      ["badge", badgeSource],
      ["chip", chipSource],
    ] as const) {
      expect(source, `${name} must use a scale token`).not.toMatch(
        /text-\[\d+px\]/,
      );
    }

    expect(labelSource).toContain("text-(length:--text-field-label)");
  });

  it("never lets an unlayered rule set a font size", () => {
    // An unlayered rule beats every Tailwind utility, so a bare font-size
    // outside a layer cannot be overridden by the component that owns the
    // element.
    const withoutLayers = globalsCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@layer\s+\w+\s*\{[\s\S]*?\n\}/g, "");

    expect(withoutLayers).not.toContain("font-size:");
  });
});

/**
 * Secondary and outline controls have no fill difference from the surface they
 * sit on, so their border is the entire boundary and has to clear the WCAG
 * 2.4.11 3:1 non-text floor. It previously sat at 2.48:1 on a light panel,
 * 2.15:1 on the light canvas and 2.90:1 in dark.
 */
describe("control boundary contrast", () => {
  const DARK_INTERIOR = [
    DK.card,
    DK.background,
    DK.secondary,
    DK.popover,
    DK.surface,
  ];
  const LIGHT_INTERIOR = [
    "#f6f7f8",
    "#e6e8eb",
    "#e2e5e9",
    "#fbfbfc",
    "#eceef1",
  ];

  it("clears 3:1 for the control boundary on every interior surface", () => {
    for (const [theme, surfaces] of [
      [DARK_THEME, DARK_INTERIOR],
      [LIGHT_THEME, LIGHT_INTERIOR],
    ] as const) {
      const border = readToken(theme, "--border-strong");

      for (const surface of surfaces) {
        expect(contrastRatio(border, surface), surface).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
  });

  it("publishes the control token as the single alias of that boundary", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      expect(readDeclaration(theme, "--control-border")).toBe(
        "var(--border-strong)",
      );
    }
  });

  it("routes outline and secondary buttons through the control token", () => {
    expect(buttonSource).toContain("outline:");
    expect(buttonSource).toMatch(
      /outline:\s*\n?\s*"border border-\(--control-border\)/,
    );
    expect(buttonSource).toMatch(
      /secondary:\s*\n?\s*"border border-\(--control-border\)/,
    );
    expect(
      buttonSource,
      "panel chrome is not a control boundary",
    ).not.toContain("border-(--surface-panel-border)");
  });

  it("keeps inert chrome quieter than the control boundary", () => {
    for (const [theme, surface] of [
      [DARK_THEME, DK.card],
      [LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const control = contrastRatio(
        readToken(theme, "--border-strong"),
        surface,
      );

      for (const token of [
        "--surface-panel-border",
        "--surface-well-border",
        "--border-subtle",
      ]) {
        expect(
          contrastRatio(readToken(theme, token), surface),
          token,
        ).toBeLessThan(control);
      }
    }
  });
});

/**
 * A disabled control used to keep the enabled `secondary` fill and differ only
 * by a label colour step to `--muted-foreground` - the app's ordinary
 * secondary text colour - so disabled `Add note` was pixel identical to an
 * enabled `Save` beside it.
 */
describe("disabled control state", () => {
  it("drops the fill instead of reusing an enabled surface", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      expect(readDeclaration(theme, "--disabled-surface")).toBe("transparent");
    }
  });

  it("never marks disabled with a body-text colour", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      const disabled = readToken(theme, "--disabled-foreground");

      expect(disabled).not.toBe(readToken(theme, "--muted-foreground"));
      expect(disabled).not.toBe(readToken(theme, "--foreground"));
      expect(disabled).not.toBe(readToken(theme, "--foreground-soft"));
    }
  });

  it("keeps the disabled label legible on the surfaces it renders on", () => {
    for (const [theme, surfaces] of [
      [DARK_THEME, [DK.card, DK.background, DK.popover]],
      [LIGHT_THEME, ["#f6f7f8", "#e6e8eb", "#fbfbfc"]],
    ] as const) {
      const disabled = readToken(theme, "--disabled-foreground");

      for (const surface of surfaces) {
        expect(
          contrastRatio(disabled, surface),
          `${disabled} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("binds the button disabled treatment to the disabled tokens", () => {
    for (const state of ["disabled", "aria-disabled"]) {
      expect(buttonSource).toContain(`${state}:bg-(--disabled-surface)`);
      expect(buttonSource).toContain(`${state}:text-(--disabled-foreground)`);
      expect(buttonSource).toContain(`${state}:border-(--disabled-border)`);
    }

    expect(buttonSource).not.toContain("disabled:bg-secondary");
    expect(buttonSource).not.toContain("disabled:text-muted-foreground");
  });
});

/**
 * Text-only controls were links by hue alone at 1.94:1 (light) and 1.32:1
 * (dark) against adjacent body text, and two link idioms coexisted. Hue can
 * never be the sole carrier at those ratios, so the underline is always
 * painted.
 */
describe("link affordance", () => {
  it("always paints the underline rather than revealing it on hover", () => {
    const linkVariant = buttonSource.match(/link: "([^"]*)"/)?.[1];

    expect(linkVariant).toBeTruthy();
    expect(linkVariant).toContain("underline");
    expect(linkVariant).not.toContain("hover:underline");
    expect(textLinkSource).toContain("underline decoration-from-font");
    expect(textLinkSource).not.toContain("hover:underline");
  });

  it("gives links their own token in both themes", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      expect(readToken(theme, "--link")).toBeTruthy();
      expect(readToken(theme, "--link-hover")).toBeTruthy();
    }
  });

  it("keeps link text at AA on the surfaces it renders on", () => {
    for (const [theme, surfaces] of [
      [DARK_THEME, [DK.card, DK.background, DK.popover]],
      [LIGHT_THEME, ["#f6f7f8", "#e6e8eb", "#fbfbfc"]],
    ] as const) {
      for (const token of ["--link", "--link-hover"]) {
        const link = readToken(theme, token);

        for (const surface of surfaces) {
          expect(
            contrastRatio(link, surface),
            `${token} ${link} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

/**
 * Scrollbar thumbs were the only "there is more" cue on the screens that clip
 * content, and rendered at 1.61-1.66:1 in dark and 1.24-1.47:1 in light.
 */
describe("scrollbar visibility", () => {
  it("keeps the thumb at 3:1 against the surfaces it scrolls over", () => {
    for (const [theme, surfaces] of [
      [DARK_THEME, [DK.background, DK.card, DK.popover]],
      [LIGHT_THEME, ["#e6e8eb", "#f6f7f8", "#fbfbfc"]],
    ] as const) {
      const thumb = readColorToken(theme, "--scrollbar-thumb");

      for (const surface of surfaces) {
        expect(
          contrastRatio(composite(thumb, surface), surface),
          `${thumb} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

/**
 * Section dividers were invisible at 1x (light 1.42:1, dark 1.35:1) and are
 * the only separation between named sections.
 */
describe("divider visibility", () => {
  it("raises the divider tokens above the level they were invisible at", () => {
    // Dark dividers sit lower than light ones on purpose: on a near-black
    // card a 1.7:1 grey line reads as a bright rule (every list row and panel
    // edge outlined), and the dark surface ladder already separates panels by
    // fill. 1.35:1 is still a visible hairline on the card.
    for (const [theme, surface, floor] of [
      [DARK_THEME, DK.card, 1.35],
      [LIGHT_THEME, "#f6f7f8", 1.7],
    ] as const) {
      for (const token of ["--border-subtle", "--border"]) {
        expect(
          contrastRatio(readToken(theme, token), surface),
          `${token} on ${surface}`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});

/**
 * Round-three contrast review (r15), non-text layer.
 *
 * Two independent reviewers sampled the built app pixel by pixel. Text passed
 * everywhere in both themes; every failure was a boundary or a state
 * indicator drawn below the WCAG 2.2 1.4.11 3:1 non-text floor:
 *
 *  - the unchecked checkbox outline at 1.85:1 (dark) - the primary control
 *    for enabling a job source and picking a work mode;
 *  - the selected Find jobs density segment marked by a 1.10:1 fill;
 *  - every light editable control bounded by --field-border at 2.91:1 on the
 *    card and 2.54:1 on the canvas, with a 1.05:1 fill fallback;
 *  - the light selected list row, whose strongest channel was 1.78:1;
 *  - the Safeguards boundary card painted the canvas colour (1.00:1).
 *
 * A sixth reported item - panels, cards and disclosures bounded at 2.11:1
 * (dark) / 2.00:1 (light) by --surface-panel-border - was reclassified after
 * r18 rather than fixed. 1.4.11 binds boundaries that identify a COMPONENT or
 * its STATE; a panel outline, a card edge and a row divider are inert
 * structure. Raising that token to 3:1 made 78 single-edge consumers render
 * as rules and light Find jobs read as a ruled table, so it now sits in a
 * floor-and-ceiling band instead, and layering is expected to carry
 * structure. The control, field, selected and focus boundaries below keep
 * their 3:1 floors unchanged.
 *
 * State fills stay deliberately subtle: the density segment (1.10:1) and the
 * selected row (1.28:1) are identified by their ring and bar, which do clear
 * 3:1. An indicator at 3:1 is the requirement; a loud fill is not.
 *
 * Each pair below names the exact surfaces the reviewers measured.
 */
describe("non-text boundary and state contrast (r15)", () => {
  // Every fill a `border border-(--surface-panel-border)` box is actually
  // drawn on, not only the opaque page containers. Derived from the fills
  // that co-occur with that border in the renderer (`bg-card`,
  // `bg-(--surface-panel)`, `bg-(--surface-panel-raised)`, `bg-(--input)`,
  // `bg-secondary`, `bg-(--surface-overlay-strong)`, `bg-background/NN`),
  // plus the selected-row fill a panel box can nest in.
  const DARK_CONTAINER_SURFACES = {
    canvas: DK.background,
    shell: DK.surface,
    card: DK.card,
    popover: DK.popover,
    secondary: DK.secondary,
    "surface-strong": DK.strong,
    "overlay-strong over card": composite("rgba(0, 0, 0, 0.24)", DK.card),
  };
  const LIGHT_CONTAINER_SURFACES = {
    canvas: "#e6e8eb",
    card: "#f6f7f8",
    popover: "#fbfbfc",
    raised: "#eceef1",
    secondary: "#e2e5e9",
    "surface-strong": "#d3dde9",
    "overlay-strong over card": composite("rgba(24, 24, 22, 0.08)", "#f6f7f8"),
  };

  /**
   * The inert-chrome band for --surface-panel-border.
   *
   * A floor, because a panel edge that cannot be seen is not structure; and a
   * CEILING, because this token is not a control boundary and must never be
   * raised into one again. The ceiling is expressed against --field-border
   * rather than as a number, so it tracks the control tokens automatically.
   */
  const PANEL_BOUNDARY_FLOOR = 2;
  /**
   * The dark floor is lower than light's. Dark panels are separated by the
   * surface ladder (canvas < card < popover), so their edge only has to be
   * findable; at the former 2:1 floor every panel, card and row divider on a
   * near-black canvas was a bright outline, the "too much contrast" the
   * person reported. 1.25:1 against the lightest surface a panel box nests in
   * (--surface-strong) keeps the edge visible there, and it is ~1.5-1.7:1
   * against the card and canvas where most panels sit.
   */
  const PANEL_BOUNDARY_FLOOR_DARK = 1.25;
  /**
   * The hard ceiling. 3:1 is the control-boundary floor, so an inert panel
   * edge must stay strictly under it: reaching 3:1 is definitionally
   * reclassifying this token as a component boundary, which is the exact
   * regression this band exists to prevent.
   */
  const PANEL_BOUNDARY_CEILING = 3;

  const DARK_FIELD_SURFACES = {
    canvas: DK.background,
    card: DK.card,
    field: DK.field,
    input: DK.popover,
  };
  const LIGHT_FIELD_SURFACES = {
    canvas: "#e6e8eb",
    card: "#f6f7f8",
    field: "#fcfcfd",
    input: "#f0f2f4",
    muted: "#e8eaed",
    toolbar: "#e2e5e9",
  };

  it("bounds the unchecked checkbox with the control boundary, not the divider token", () => {
    // The checked state is a solid --primary fill, so the unchecked box is
    // identified by its outline alone: --border measured 1.98:1 on the dark
    // card and 1.85:1 on the dark --input fill.
    expect(checkboxSource).toContain("border border-(--control-border)");
    expect(
      checkboxSource,
      "the resting checkbox outline must not fall back to the divider token",
    ).not.toMatch(/border border-border\b/);

    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, DARK_FIELD_SURFACES],
      ["light", LIGHT_THEME, LIGHT_FIELD_SURFACES],
    ] as const) {
      const boundary = readToken(theme, "--border-strong");

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect(
          contrastRatio(boundary, surface),
          `${themeName} checkbox outline on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("marks the selected density segment with a 3:1 boundary instead of a 1.10:1 fill", () => {
    // The grouped Find jobs control stripped the button border (`border-0`)
    // and relied on the `secondary` fill alone, which sits 1.10:1 from the
    // unselected track.
    //
    // Previously this pinned a per-call-site ring in
    // `collection-search-toolbar.tsx`:
    //   expect(collectionSearchToolbarSource).toMatch(
    //     /ring-1 ring-inset ring-\(--control-border\)/);
    //   … measuring `--border-strong` against the unselected segment.
    // The density switcher is the shared `SegmentedControl` now (it was
    // written three ways inside that one file), so the boundary moved with it
    // and the pin follows the control rather than one of its call sites. The
    // selected channel is that component's `inset 0 -2px var(--primary)` bar
    // beside the fill — hue is never the sole carrier either way.
    //
    // The floor is unchanged at 3:1 and the measured margin is larger, not
    // smaller: --primary against the unselected segment is 6.727:1 dark /
    // 7.419:1 light (the retired --border-strong ring was 3.994:1 / 3.883:1),
    // and against its own --secondary fill 6.114:1 / 6.297:1 (was 3.63:1 /
    // 3.296:1).
    const segmentedControlSource = readFileSync(
      new URL("../components/ui/segmented-control.tsx", import.meta.url),
      "utf8",
    );

    expect(segmentedControlSource).toMatch(
      /shadow-\[inset_0_-2px_0_var\(--primary\)\]/,
    );
    // The retired per-call-site copy must not come back.
    expect(collectionSearchToolbarSource).not.toMatch(
      /ring-1 ring-inset ring-\(--control-border\)/,
    );

    for (const [themeName, theme, unselected] of [
      // The unselected segment is a ghost button: the surface behind the
      // group shows through.
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const selectedBar = readToken(theme, "--primary");
      const selectedFill = readToken(theme, "--secondary");

      expect(
        contrastRatio(selectedBar, unselected),
        `${themeName} selected density bar against the unselected segment`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(selectedBar, selectedFill),
        `${themeName} selected density bar against its own fill`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the inert panel boundary visible without turning it into a rule", () => {
    // Not a 3:1 assertion: 1.4.11 governs component and state boundaries,
    // which live on --control-border / --field-border / --row-selected-bar.
    // This token bounds panels, cards, dividers and disclosures - structure,
    // not state - and 78 single-edge consumers render it, so a 3:1 value
    // reads as a ruled table rather than as layered surfaces.
    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, DARK_CONTAINER_SURFACES],
      ["light", LIGHT_THEME, LIGHT_CONTAINER_SURFACES],
    ] as const) {
      const border = readToken(theme, "--surface-panel-border");
      const card = themeName === "dark" ? DK.card : "#f6f7f8";
      const fieldBoundary = contrastRatio(
        readToken(theme, "--field-border"),
        card,
      );

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrastRatio(border, surface);

        expect(
          ratio,
          `${themeName} --surface-panel-border on ${surfaceName} (band floor)`,
        ).toBeGreaterThanOrEqual(
          themeName === "dark"
            ? PANEL_BOUNDARY_FLOOR_DARK
            : PANEL_BOUNDARY_FLOOR,
        );
        // The ceiling, asserted on every surface rather than only the card:
        // this is what stops the token being raised back to control strength.
        expect(
          ratio,
          `${themeName} --surface-panel-border on ${surfaceName} (band ceiling: inert chrome, never a 3:1 component boundary)`,
        ).toBeLessThan(PANEL_BOUNDARY_CEILING);
      }

      // And it stays under the control tokens in relative terms too, so the
      // published ladder panel < field < control cannot invert.
      expect(
        contrastRatio(border, card),
        `${themeName} --surface-panel-border must stay quieter than --field-border`,
      ).toBeLessThan(fieldBoundary);
    }
  });

  it("clears 3:1 for the hovered and focused field boundary on every surface a field sits on", () => {
    // The resting border is deliberately softened below 3:1 (see globals.css)
    // and carries a shadow and a lighter fill instead; the boundary the
    // person interacts with, hover and focus, must still clear the 3:1
    // non-text floor everywhere a field sits, and the resting border must
    // not drift into invisibility.
    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, DARK_FIELD_SURFACES],
      ["light", LIGHT_THEME, LIGHT_FIELD_SURFACES],
    ] as const) {
      const hoverBorder = readToken(theme, "--field-border-hover");
      const focusBorder = readToken(theme, "--field-focus-border");
      const restingBorder = readToken(theme, "--field-border");

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect(
          contrastRatio(hoverBorder, surface),
          `${themeName} --field-border-hover on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(focusBorder, surface),
          `${themeName} --field-focus-border on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(restingBorder, surface),
          `${themeName} resting --field-border on ${surfaceName} (softened, never invisible)`,
        ).toBeGreaterThanOrEqual(2.3);
      }
    }
  });

  it("gives the selected list row an accent bar at 3:1 in both themes", () => {
    // --nav-active-bar is drawn on the dark --nav-active-surface fill. Reused
    // on --surface-strong by SelectableRow it left the light selected row at
    // 1.39:1 against its own fill and 1.78:1 against its neighbours, with a
    // 1.28:1 tint as the only other channel.
    expect(selectableRowSource).toContain(
      "inset_3px_0_0_0_var(--row-selected-bar)",
    );
    expect(
      selectableRowSource,
      "the row bar must not reuse the sidebar's nav token",
    ).not.toContain("var(--nav-active-bar)");

    for (const [themeName, theme, neighbour] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const bar = readToken(theme, "--row-selected-bar");
      const selectedFill = readToken(theme, "--surface-strong");

      expect(
        contrastRatio(bar, selectedFill),
        `${themeName} --row-selected-bar against the selected row fill`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(bar, neighbour),
        `${themeName} --row-selected-bar against an unselected row`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the boundary ladder monotonic: panel < field < control", () => {
    // Raising these tokens must not collapse the documented hierarchy or
    // overtake --border-strong, which "keeps inert chrome quieter than the
    // control boundary" also pins.
    for (const [themeName, theme, card] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const panel = contrastRatio(
        readToken(theme, "--surface-panel-border"),
        card,
      );
      const field = contrastRatio(readToken(theme, "--field-border"), card);
      const control = contrastRatio(readToken(theme, "--border-strong"), card);

      expect(panel, `${themeName} panel < field`).toBeLessThan(field);
      expect(field, `${themeName} field < control`).toBeLessThan(control);
    }
  });

  it("does not regress the boundary and state tokens that already passed", () => {
    // Reviewer-verified good values. These are recorded at their measured
    // floors so a later token sweep cannot quietly lower them.
    const floors: ReadonlyArray<
      readonly [string, string, string, string, number]
    > = [
      ["dark --primary on card", DARK_THEME, "--primary", DK.card, 6.69],
      ["light --primary on card", LIGHT_THEME, "--primary", "#f6f7f8", 6.5],
      // Dark carries the selected destination on the bar (see "keeps the
      // selected sidebar destination distinguishable"), so the rail floor
      // moves to the bar and the fill keeps only a visible step.
      [
        "dark --nav-active-bar on rail",
        DARK_THEME,
        "--nav-active-bar",
        DK.rail,
        3,
      ],
      [
        "light --nav-active-surface on rail",
        LIGHT_THEME,
        "--nav-active-surface",
        "#e6e8eb",
        3,
      ],
      [
        "dark --nav-active-bar on the selected fill",
        DARK_THEME,
        "--nav-active-bar",
        DK.navActive,
        3,
      ],
      [
        "light --nav-active-bar on the selected fill",
        LIGHT_THEME,
        "--nav-active-bar",
        "#3a5274",
        3,
      ],
      [
        "dark --border-strong on card",
        DARK_THEME,
        "--border-strong",
        DK.card,
        // Lowered from 3.99 on purpose: outline controls read as bright boxes
        // on the dark card. 3.7 on the card keeps >= 3:1 on every interior
        // surface, which "clears 3:1 for the control boundary" enforces.
        3.7,
      ],
      [
        "light --border-strong on card",
        LIGHT_THEME,
        "--border-strong",
        "#f6f7f8",
        3.88,
      ],
      ["dark --link on card", DARK_THEME, "--link", DK.card, 6.5],
      ["light --link on card", LIGHT_THEME, "--link", "#f6f7f8", 6.5],
    ];

    for (const [label, theme, token, surface, floor] of floors) {
      expect(
        contrastRatio(readToken(theme, token), surface),
        label,
      ).toBeGreaterThanOrEqual(floor);
    }

    // --control-border stays the published alias of --border-strong, so
    // pointing the checkbox and density ring at it cannot drift.
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      expect(readDeclaration(theme, "--control-border")).toBe(
        "var(--border-strong)",
      );
    }
  });
});

/**
 * PKG-02 — the token and primitive floor.
 *
 * The legibility lane measured a set of colours the file above never
 * enumerated: --foreground-soft, --headline-secondary, placeholder text, the
 * `opacity-NN` disabled composite, the switch's own parts, the progress track,
 * the tab indicators, the scrims, the sticky-bar edges and every `token/NN`
 * alpha. Each group below closes one of those gaps. Surfaces are shared with
 * the groups above rather than redefined per test.
 */
const DARK_CONTROL_SURFACES = {
  canvas: DK.background,
  surface: DK.surface,
  card: DK.card,
  popover: DK.popover,
  secondary: DK.secondary,
  "surface-strong": DK.strong,
};
const LIGHT_CONTROL_SURFACES = {
  canvas: "#e6e8eb",
  surface: "#dfe2e6",
  card: "#f6f7f8",
  popover: "#fbfbfc",
  secondary: "#e2e5e9",
  "surface-strong": "#d3dde9",
};
const DARK_FIELD_FILLS = {
  field: DK.field,
  "field-strong": DK.strong,
  input: DK.popover,
};
const LIGHT_FIELD_FILLS = {
  field: "#fcfcfd",
  "field-strong": "#ffffff",
  input: "#f0f2f4",
};

const textareaSource = readFileSync(
  new URL("../components/ui/textarea.tsx", import.meta.url),
  "utf8",
);
const switchSource = readFileSync(
  new URL("../components/ui/switch.tsx", import.meta.url),
  "utf8",
);
const tabsSource = readFileSync(
  new URL("../components/ui/tabs.tsx", import.meta.url),
  "utf8",
);
const progressBarSource = readFileSync(
  new URL("../components/ui/progress-bar.tsx", import.meta.url),
  "utf8",
);
const panelSource = readFileSync(
  new URL("../components/ui/panel.tsx", import.meta.url),
  "utf8",
);
const separatorSource = readFileSync(
  new URL("../components/ui/separator.tsx", import.meta.url),
  "utf8",
);
const statusBadgeSource = readFileSync(
  new URL(
    "../features/job-finder/components/status-badge.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("text tokens the legibility lane found unpinned", () => {
  // --foreground-soft carries the majority of Job Finder's secondary body
  // text (badge `outline`/`status` labels, list meta lines) and
  // --headline-secondary every h2/h3 in @layer base, yet neither had a single
  // contrast assertion: a token sweep could have moved either one freely.
  it.each([
    ["--foreground-soft", 4.5],
    ["--headline-secondary", 4.5],
  ])("keeps %s at AA on every surface it renders on", (token, floor) => {
    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, DARK_CONTROL_SURFACES],
      ["light", LIGHT_THEME, LIGHT_CONTROL_SURFACES],
    ] as const) {
      const value = readToken(theme, token);

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect(
          contrastRatio(value, surface),
          `${themeName} ${token} on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("keeps placeholder text at AA on every field fill, resting and focused", () => {
    // Placeholders render --muted-foreground on --field / --field-strong /
    // --input, none of which were in the muted-text surface list.
    for (const [themeName, theme, fills] of [
      ["dark", DARK_THEME, DARK_FIELD_FILLS],
      ["light", LIGHT_THEME, LIGHT_FIELD_FILLS],
    ] as const) {
      const placeholder = readToken(theme, "--muted-foreground");

      for (const [fillName, fill] of Object.entries(fills)) {
        expect(
          contrastRatio(placeholder, fill),
          `${themeName} placeholder on ${fillName}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/**
 * The disabled composite.
 *
 * `button.tsx` adopted the three --disabled-* tokens and pinned them; every
 * other primitive still composited fill AND text at 50%, so a disabled field
 * lost its content and its boundary at once while a disabled button beside it
 * stayed readable - two disabled treatments ~2:1 apart on one screen.
 */
describe("disabled control composite (PKG-02)", () => {
  const OWNED_PRIMITIVES = [
    ["textarea.tsx", () => textareaSource],
    ["checkbox.tsx", () => checkboxSource],
    ["switch.tsx", () => switchSource],
    ["tabs.tsx", () => tabsSource],
    ["label.tsx", () => labelSource],
  ] as const;

  it.each(OWNED_PRIMITIVES)(
    "%s never marks a disabled state with an opacity wash",
    (_name, read) => {
      // Covers the peer-disabled: and group-data-[disabled=true]: spellings
      // too - the wash was the same wash whichever variant reached it.
      expect(read()).not.toMatch(/disabled[^\s"]*:opacity-(?!100\b)\d/);
    },
  );

  it.each(OWNED_PRIMITIVES)(
    "%s binds the disabled treatment to the shared tokens",
    (name, read) => {
      const source = read();

      expect(source, `${name} must recolour disabled text`).toContain(
        "text-(--disabled-foreground)",
      );

      // A label owns no fill and no border, so the text token is the whole of
      // its disabled idiom; every other primitive binds all three.
      if (name === "label.tsx") {
        return;
      }

      expect(source, `${name} must drop the disabled fill`).toContain(
        "bg-(--disabled-surface)",
      );
      expect(source, `${name} must carry the disabled boundary`).toContain(
        "border-(--disabled-border)",
      );
    },
  );

  it("keeps a disabled placeholder off the enabled muted text colour", () => {
    expect(textareaSource).toContain(
      "disabled:placeholder:text-(--disabled-foreground)",
    );
  });

  it("keeps disabled text at AA on the surfaces and field fills it renders on", () => {
    // Previously pinned on card / canvas / popover only, where it passed; it
    // measured 4.36:1 (dark --surface-strong) and 4.11:1 (light
    // --surface-strong) on the surfaces this adds.
    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, { ...DARK_CONTROL_SURFACES, ...DARK_FIELD_FILLS }],
      [
        "light",
        LIGHT_THEME,
        { ...LIGHT_CONTROL_SURFACES, ...LIGHT_FIELD_FILLS },
      ],
    ] as const) {
      const disabled = readToken(theme, "--disabled-foreground");

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect(
          contrastRatio(disabled, surface),
          `${themeName} --disabled-foreground on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("makes --disabled-border a boundary that stays quieter than an enabled one", () => {
    // The fill is dropped, so this border is the disabled control's entire
    // shape: at 1.40-1.80:1 it was not a shape at all. It must clear the 3:1
    // non-text floor and still lose to --border-strong on every surface, so a
    // disabled control can never outrank an enabled one.
    for (const [themeName, theme, surfaces] of [
      ["dark", DARK_THEME, DARK_CONTROL_SURFACES],
      ["light", LIGHT_THEME, LIGHT_CONTROL_SURFACES],
    ] as const) {
      const disabled = readToken(theme, "--disabled-border");
      const enabled = readToken(theme, "--border-strong");

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        if (surfaceName === "surface" || surfaceName === "surface-strong") {
          // Not in the required set: --border-strong itself only reaches
          // 3.03:1 on the light --surface-strong, so requiring both bounds
          // there has no window. Card / canvas / popover / secondary are the
          // surfaces a disabled control actually renders on.
          continue;
        }

        expect(
          contrastRatio(disabled, surface),
          `${themeName} --disabled-border on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(disabled, surface),
          `${themeName} --disabled-border must stay quieter than --border-strong on ${surfaceName}`,
        ).toBeLessThan(contrastRatio(enabled, surface));
      }
    }
  });
});

describe("switch track and thumb (LEG-05, LEG-06)", () => {
  it("bounds the track with the control token instead of the divider token", () => {
    expect(switchSource).toContain("border border-(--control-border)");
    expect(
      switchSource,
      "--border is Separator's token; a switch is a control",
    ).not.toMatch(/border-border\b/);
    expect(
      switchSource,
      "the unchecked track fill must move off --border too",
    ).not.toContain("data-[state=unchecked]:bg-border");
    expect(switchSource).toContain("data-[state=unchecked]:bg-input");
    expect(switchSource).toContain(
      "data-[state=checked]:bg-primary-fill-foreground",
    );
    // --border stays exactly what it was: the Separator fill.
    expect(separatorSource).toContain("bg-border");
  });

  it("clears 3:1 for the thumb against BOTH track states in both themes", () => {
    // Only the checked-vs-unchecked TRACK delta cleared 3:1 before; the
    // control's own parts measured 1.79 (dark) / 2.20 (light) thumb-on-track,
    // so the switch read as a solid block rather than as a thumb in a track.
    for (const [themeName, theme] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      // The thumb takes the foreground of the fill under it, because no one
      // thumb colour clears 3:1 against both an --input track and a --primary
      // one: in dark the two requirements have no overlapping solution.
      const checkedThumb = readToken(theme, "--primary-fill-foreground");
      const uncheckedThumb = readToken(theme, "--foreground-soft");
      const checkedTrack = readToken(theme, "--primary-fill");
      const uncheckedTrack = readToken(theme, "--input");

      expect(
        contrastRatio(checkedThumb, checkedTrack),
        `${themeName} thumb on the checked track`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(uncheckedThumb, uncheckedTrack),
        `${themeName} thumb on the unchecked track`,
      ).toBeGreaterThanOrEqual(3);
      // The two track states must still be distinguishable from each other.
      expect(
        contrastRatio(checkedTrack, uncheckedTrack),
        `${themeName} checked vs unchecked track`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the thumb visible once the disabled track loses its fill", () => {
    expect(switchSource).toContain(
      "group-disabled/switch:bg-(--disabled-border)",
    );

    for (const [themeName, theme, card] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      expect(
        contrastRatio(readToken(theme, "--disabled-border"), card),
        `${themeName} disabled thumb through the emptied track`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("progress meter and tab indicators", () => {
  it("gives the progress track a 3:1 boundary so an empty meter still reads", () => {
    // The track fill is 1.12:1 (dark) / 1.28:1 (light) from the card, and
    // raising it to 3:1 would push the --primary fill BELOW 3:1 against the
    // track (both pairs top out at 2.59:1 on one luminance axis). The
    // boundary carries the visibility instead.
    expect(progressBarSource).toContain(
      "shadow-[inset_0_0_0_1px_var(--control-border)]",
    );

    for (const [themeName, theme, card] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const boundary = readToken(theme, "--border-strong");
      const track = composite(
        readColorToken(theme, "--surface-progress-track"),
        card,
      );

      expect(
        contrastRatio(boundary, track),
        `${themeName} progress boundary against its own track`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrastRatio(boundary, card),
        `${themeName} progress boundary against the card`,
      ).toBeGreaterThanOrEqual(3);
      // Recorded, not required: the data channel keeps its separation from
      // the track, which is what raising the track fill would have cost.
      // The meter paints --primary-fill (progress-bar.tsx), a non-text data
      // channel, so it carries the 3:1 non-text floor against its track.
      expect(
        contrastRatio(readToken(theme, "--primary-fill"), track),
        `${themeName} progress fill against its track`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives the line tab indicator a weight step it cannot get from colour", () => {
    // --primary on the list's --surface-panel-border measures 2.64:1 (dark)
    // and 2.79:1 (light). Both tokens are pinned elsewhere, so the indicator
    // is 2px against the 1px rule it sits on rather than a hairline.
    expect(tabsSource).toContain(
      "group-data-[orientation=horizontal]/tabs:after:h-0.5",
    );
    expect(tabsSource).not.toContain(
      "group-data-[orientation=horizontal]/tabs:after:h-px",
    );
    expect(tabsSource).toContain("border-b-2");

    for (const [themeName, theme] of [
      ["dark", DARK_THEME],
      ["light", LIGHT_THEME],
    ] as const) {
      const indicator = readToken(theme, "--primary");

      // Recorded: this is the ratio that forced the weight step. The calmer
      // dark palette dropped the panel edge, which lifted the dark indicator
      // past 3:1 (light still sits under it), so the 2px step stays for light
      // and is harmless in dark.
      expect(
        contrastRatio(indicator, readToken(theme, "--surface-panel-border")),
        `${themeName} line indicator on the list edge`,
      )[themeName === "light" ? "toBeLessThan" : "toBeGreaterThanOrEqual"](3);
      // The `default` variant draws its indicator on the list fill, where it
      // does clear the floor without a weight step of its own.
      expect(
        contrastRatio(indicator, readToken(theme, "--muted")),
        `${themeName} default indicator on the list fill`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * Every colour derived by compositing a token at `token/NN`.
 *
 * These never appear in a theme scope, so nothing measured them. The tinted
 * badges are the ones that carry meaning, and their `/65` boundary was
 * measured for the warning family alone and inherited untested by the rest.
 */
describe("token/NN derived colours", () => {
  const TINTED_TONES = [
    ["primary", "--primary"],
    ["destructive", "--destructive"],
    ["critical", "--critical"],
    ["positive", "--positive"],
  ] as const;

  // Tinted badge borders take their alpha from --badge-border-alpha, a
  // per-theme percentage, so the same class renders 75% in light and 40% in
  // dark.
  function borderAlpha(source: string, tone: string, theme: string): number {
    if (!source.includes(`border-${tone}/(--badge-border-alpha)`)) {
      throw new Error(
        `Missing border-${tone}/(--badge-border-alpha) in the badge sources`,
      );
    }

    const value = theme.match(/--badge-border-alpha\s*:\s*(\d+)%/)?.[1];

    if (!value) {
      throw new Error("Missing --badge-border-alpha in theme scope");
    }

    return Number(value) / 100;
  }

  it("keeps every tinted badge boundary visible on its own tint, at 3:1 in light", () => {
    // A badge is an inert label: its text (>= 4.5:1 below) carries the
    // status. Light keeps the 3:1 edge that stopped its chips reading as
    // tinted text runs. Dark only needs a findable edge: at 3:1 every row of
    // a dark list wore a bright coloured outline.
    const sources = `${badgeSource}\n${statusBadgeSource}`;

    for (const [themeName, theme, card, edgeFloor] of [
      ["dark", DARK_THEME, DK.card, 1.5],
      ["light", LIGHT_THEME, "#f6f7f8", 3],
    ] as const) {
      for (const [tone, token] of TINTED_TONES) {
        const color = readToken(theme, token);
        const tint = alphaBlend(color, 0.15, card);
        const border = alphaBlend(
          color,
          borderAlpha(sources, tone, theme),
          tint,
        );

        expect(
          contrastRatio(border, tint),
          `${themeName} border-${tone} on its own /15 tint`,
        ).toBeGreaterThanOrEqual(edgeFloor);
        expect(
          contrastRatio(color, tint),
          `${themeName} ${tone} label on its own /15 tint`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      // The warning chip fills with its own surface token rather than an
      // alpha of the text colour.
      const warningText = readToken(theme, "--warning-text");
      const warningTint = composite(
        readColorToken(theme, "--warning-surface"),
        card,
      );
      const warningBorder = alphaBlend(
        warningText,
        borderAlpha(statusBadgeSource, "warning", theme),
        warningTint,
      );

      expect(
        contrastRatio(warningBorder, warningTint),
        `${themeName} border-warning on the warning chip fill`,
      ).toBeGreaterThanOrEqual(edgeFloor);
    }
  });

  it("records the positive tone on its own tint in both themes", () => {
    // LEG-12: the `positive` StatusBadge ("Ready", "Approved") was the one
    // tinted chip passed `tintAlpha: null` above, so it had no tint assertion
    // at all. It passes at 6.27 / 6.23 - recorded rather than left uncovered.
    for (const [themeName, theme, card, floor] of [
      // Dark re-recorded at 6.0 after the card moved to #1d2025.
      ["dark", DARK_THEME, DK.card, 6.0],
      ["light", LIGHT_THEME, "#f6f7f8", 6.2],
    ] as const) {
      const positive = readToken(theme, "--positive");

      expect(
        contrastRatio(positive, alphaBlend(positive, 0.15, card)),
        `${themeName} --positive on its own tint`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("keeps a bare tint below the state floor so it is never the sole carrier", () => {
    // `bg-primary/10` and `bg-primary/15` composite to 1.16-1.28:1 against
    // the surface behind them. They are legitimate as a tint under a border
    // or ring; this records that they can never BE the state channel.
    for (const [themeName, theme, card] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      const primary = readToken(theme, "--primary");

      for (const alpha of [0.1, 0.15]) {
        expect(
          contrastRatio(alphaBlend(primary, alpha, card), card),
          `${themeName} bg-primary/${alpha * 100} against the card`,
        ).toBeLessThan(3);
      }
    }
  });

  it("moves the inert badge boundary off the divider token", () => {
    // LEG-06: `secondary`/`outline`/`section`/`status` used --border as their
    // sole edge against fills 1.10-1.18:1 from the card, measuring 1.60-1.80.
    // A badge is inert, so it takes the inert-chrome token (pinned in its own
    // 2:1-3:1 band above), not the 3:1 control token.
    expect(badgeSource).not.toMatch(/border-border\b/);
    expect(badgeSource).toContain("border-(--surface-panel-border)");
  });
});

describe("scrim and sticky-edge separation (LEG-08)", () => {
  it("records that a dark scrim cannot separate an overlay on its own", () => {
    // Dimming a near-black canvas does almost nothing: the dialog surface sits
    // 1.30:1 from the scrimmed page in dark against 1.76:1 in light. The
    // overlay shell must therefore carry its own boundary and shadow; the
    // scrim is an attention cue, not the separation channel. Recorded here so
    // the overlay packages inherit the measurement rather than re-deriving it.
    const darkDimmed = composite(
      readColorToken(DARK_THEME, "--modal-scrim"),
      DK.background,
    );
    const lightDimmed = composite(
      readColorToken(LIGHT_THEME, "--modal-scrim"),
      "#e6e8eb",
    );

    expect(
      contrastRatio(readToken(DARK_THEME, "--popover"), darkDimmed),
      "dark overlay surface against the scrimmed page",
    ).toBeLessThan(3);
    expect(
      contrastRatio(readToken(LIGHT_THEME, "--popover"), lightDimmed),
      "light overlay surface against the scrimmed page",
    ).toBeLessThan(3);

    // What the scrim must not do is get weaker: it is the only dimming cue.
    for (const [themeName, theme, floor] of [
      ["dark", DARK_THEME, 0.7],
      ["light", LIGHT_THEME, 0.2],
    ] as const) {
      const alpha = Number(
        readColorToken(theme, "--modal-scrim").match(
          /rgba?\([^)]*,\s*([\d.]+)\)/,
        )?.[1] ?? 0,
      );

      expect(alpha, `${themeName} --modal-scrim alpha`).toBeGreaterThanOrEqual(
        floor,
      );
    }
  });

  it("proves a sticky bar's fill is not its edge, and which token can be", () => {
    // --shell-header-bg is the canvas colour at .97, so a sticky header
    // composites to 1.00-1.04:1 against the page scrolling under it: the fill
    // separates nothing and the edge has to be a border. `border-border/15`,
    // the spelling the shell files reach for, composites BELOW even the inert
    // band, while the inert token itself clears it.
    for (const [themeName, theme, canvas] of [
      ["dark", DARK_THEME, DK.background],
      ["light", LIGHT_THEME, "#e6e8eb"],
    ] as const) {
      const headerFill = composite(
        readColorToken(theme, "--shell-header-bg"),
        canvas,
      );

      expect(
        contrastRatio(headerFill, canvas),
        `${themeName} sticky header fill against the page`,
      ).toBeLessThan(1.1);
      expect(
        contrastRatio(
          alphaBlend(readToken(theme, "--border"), 0.15, canvas),
          canvas,
        ),
        `${themeName} border-border/15 is not a usable sticky edge`,
      ).toBeLessThan(2);
      // Dark: the header and rail are now one step darker than the canvas,
      // so the fill helps a little and the inert edge sits at ~1.66:1.
      expect(
        contrastRatio(readToken(theme, "--surface-panel-border"), canvas),
        `${themeName} --surface-panel-border is a usable sticky edge`,
      ).toBeGreaterThanOrEqual(themeName === "dark" ? 1.6 : 2);
    }
  });
});

describe("read-only well as a published primitive", () => {
  it("exposes the well tokens as a Panel tone instead of a bg-background/NN", () => {
    // `bg-background/NN` is a literal no-op on the canvas (1.00:1) and
    // 1.04-1.08:1 on a card, and ~118 sites spell a recessed block that way.
    // The well tokens already exist and are pinned exactly above; this makes
    // them reachable as one variant.
    expect(panelSource).toContain(
      'well: "border-(--surface-well-border) bg-(--surface-well)"',
    );

    // A well is a fill AND a boundary; the boundary is what makes the recess
    // readable, since the fill itself is deliberately a small step from the
    // panel. `bg-background/NN` supplies neither.
    for (const [themeName, theme, card] of [
      ["dark", DARK_THEME, DK.card],
      ["light", LIGHT_THEME, "#f6f7f8"],
    ] as const) {
      expect(
        contrastRatio(readToken(theme, "--surface-well-border"), card),
        `${themeName} well boundary out-carries its own fill`,
      ).toBeGreaterThan(
        contrastRatio(readToken(theme, "--surface-well"), card),
      );
    }
  });
});

describe("interview overlay token scope", () => {
  it('publishes an empty :root[data-overlay="interview"] scope for the overlay package', () => {
    // The Interview overlays fork the palette in component source, which puts
    // their surfaces outside every measurement in this file. This is the seam
    // that ends the fork. It must exist and must stay EMPTY here: declaring a
    // value in this package would change rendering the overlay package has not
    // asked for.
    const scope = globalsCss.match(
      /:root\[data-overlay="interview"\]\s*\{(?<body>[\s\S]*?)\}/,
    );

    expect(scope, "the overlay scope must exist").not.toBeNull();
    expect(
      (scope?.groups?.body ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim(),
      "the scope must declare nothing until the overlay package fills it",
    ).toBe("");
  });
});

describe("dark surface ladder", () => {
  it("keeps chrome at or below the canvas, and content rising above it", () => {
    // The person's report: "darker color on main containers compared to the
    // sidebar". The rail was mixed 9% toward --primary and was the lightest
    // large surface on screen. The rule now: rail (chrome) <= canvas < card
    // < popover, so the eye lands on the main column and raised surfaces
    // read as raised.
    const header = composite(
      readColorToken(DARK_THEME, "--shell-header-bg"),
      DK.background,
    );

    expect(relativeLuminance(DK.rail)).toBeLessThanOrEqual(
      relativeLuminance(DK.background),
    );
    expect(relativeLuminance(header)).toBeLessThanOrEqual(
      relativeLuminance(DK.background),
    );
    expect(relativeLuminance(DK.background)).toBeLessThan(
      relativeLuminance(DK.card),
    );
    expect(relativeLuminance(DK.card)).toBeLessThan(
      relativeLuminance(DK.popover),
    );
    // A visible step between the canvas and a panel, so panels do not need a
    // bright outline to be found.
    expect(contrastRatio(DK.card, DK.background)).toBeGreaterThanOrEqual(1.1);
  });

  it("paints the rail from a token instead of tinting it toward the accent", () => {
    expect(globalsCss).toMatch(
      /\[data-job-finder-sidebar\]\s*\{\s*background:\s*var\(--sidebar-bg\);/,
    );
    expect(readDeclaration(DARK_THEME, "--sidebar-bg")).not.toContain(
      "--primary",
    );
    // Rail icons are neutral in dark; only the selected row spends the accent.
    expect(readDeclaration(DARK_THEME, "--sidebar-icon-fg")).toBe(
      "var(--muted-foreground)",
    );
    expect(readDeclaration(DARK_THEME, "--sidebar-icon-fg-active")).toBe(
      "var(--primary)",
    );
  });
});
