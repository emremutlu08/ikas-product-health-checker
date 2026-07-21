import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The design system is a contract, not a coat of paint.
 *
 * These tests read the declared token values out of `globals.css` and check the two things a
 * stylesheet cannot check itself: that every semantic role a component may reference actually
 * exists, and that the colour pairs the UI is allowed to compose meet WCAG contrast minima.
 * A future palette edit that quietly drops below AA fails here rather than in production.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

function declaredTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

const tokens = declaredTokens();

function hex(name: string): string {
  const value = tokens.get(name);
  if (!value) throw new Error(`design token ${name} is not declared in globals.css`);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`design token ${name} must be a 6-digit hex colour, received "${value}"`);
  }
  return value;
}

function relativeLuminance(colour: string) {
  const channels = colour
    .replace("#", "")
    .match(/../g)!
    .map((pair) => parseInt(pair, 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SEMANTIC_COLOUR_TOKENS = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-sunken",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-border-strong",
  "--color-accent",
  "--color-accent-hover",
  "--color-accent-soft",
  "--color-accent-contrast",
  "--color-critical",
  "--color-critical-surface",
  "--color-warning",
  "--color-warning-surface",
  "--color-success",
  "--color-success-surface",
  "--color-focus-ring",
];

describe("semantic colour roles", () => {
  it("declares every semantic role a component is allowed to reference", () => {
    for (const token of SEMANTIC_COLOUR_TOKENS) {
      expect(() => hex(token), `${token} must be declared`).not.toThrow();
    }
  });

  it("exposes exactly one interaction accent", () => {
    // Hover, soft and contrast are states of the same accent, not additional accents.
    const accentRoles = SEMANTIC_COLOUR_TOKENS.filter((token) => token.startsWith("--color-accent"));

    expect(accentRoles).toEqual([
      "--color-accent",
      "--color-accent-hover",
      "--color-accent-soft",
      "--color-accent-contrast",
    ]);
  });

  it("keeps status colours distinct from the interaction accent", () => {
    const accent = hex("--color-accent");

    for (const status of ["--color-critical", "--color-warning", "--color-success"]) {
      expect(hex(status)).not.toBe(accent);
    }
  });
});

describe("WCAG contrast of the pairs the UI may compose", () => {
  it("renders body text at AAA on both canvas and surface", () => {
    expect(contrast(hex("--color-text"), hex("--color-surface"))).toBeGreaterThanOrEqual(7);
    expect(contrast(hex("--color-text"), hex("--color-canvas"))).toBeGreaterThanOrEqual(7);
  });

  it("renders muted text at AA on canvas, surface, and sunken surface", () => {
    for (const background of ["--color-surface", "--color-canvas", "--color-surface-sunken"]) {
      expect(contrast(hex("--color-text-muted"), hex(background))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("renders accent-on-surface and contrast-on-accent text at AA", () => {
    expect(contrast(hex("--color-accent"), hex("--color-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex("--color-accent-contrast"), hex("--color-accent"))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(
      contrast(hex("--color-accent-contrast"), hex("--color-accent-hover")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex("--color-accent"), hex("--color-accent-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("renders each status colour at AA on its own tinted surface and on the plain surface", () => {
    const statuses = [
      ["--color-critical", "--color-critical-surface"],
      ["--color-warning", "--color-warning-surface"],
      ["--color-success", "--color-success-surface"],
    ] as const;

    for (const [foreground, background] of statuses) {
      expect(contrast(hex(foreground), hex(background))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(foreground), hex("--color-surface"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("meets the 3:1 non-text minimum for the focus ring and for meaningful borders", () => {
    for (const background of ["--color-surface", "--color-canvas"]) {
      expect(contrast(hex("--color-focus-ring"), hex(background))).toBeGreaterThanOrEqual(3);
      expect(contrast(hex("--color-border-strong"), hex(background))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("non-colour scales", () => {
  it("declares a coherent radius scale", () => {
    for (const token of ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"]) {
      expect(tokens.has(token), `${token} must be declared`).toBe(true);
    }
  });

  it("declares a shadow scale", () => {
    for (const token of ["--shadow-card", "--shadow-raised"]) {
      expect(tokens.has(token), `${token} must be declared`).toBe(true);
    }
  });

  it("declares a spacing base and a type scale", () => {
    expect(tokens.has("--spacing")).toBe(true);
    for (const token of ["--text-label", "--text-metric", "--text-title"]) {
      expect(tokens.has(token), `${token} must be declared`).toBe(true);
    }
  });

  it("declares a visible focus ring width rather than relying on the browser default", () => {
    expect(tokens.has("--focus-ring-width")).toBe(true);
  });
});

describe("no leftover prototype palette", () => {
  it("drops the ad-hoc brand tokens the prototype shipped", () => {
    for (const legacy of ["--accent", "--accent-hover", "--focus", "--background", "--foreground"]) {
      expect(tokens.has(legacy), `${legacy} should no longer be declared`).toBe(false);
    }
  });
});
