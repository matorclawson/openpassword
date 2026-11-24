// packages/brand/src/tokens.ts
//
// Single source of truth for the Sovereign Agents / Prof Rod brand universe.
//
// Colors are stored as HSL *triples* ("24 85% 55%") so they can be consumed
// as CSS variables (hsl(var(--primary))) across any app in the monorepo.
// Tailwind presets, Remotion components, and raw CSS all derive from here.
//
// When the Prof Rod brand document lands, we can add a `profrod` namespace
// alongside the shared tokens without breaking apps/web.

/** HSL triple without the hsl() wrapper, e.g. "24 85% 55%". */
export type HSLTriple = string;

// Extracted to satisfy sonarjs/no-duplicate-string
const WARM_CREAM = "42 30% 97%"; // #FAF7F0
const NEAR_BLACK = "30 10% 15%"; // #2A2520

/**
 * Raw color triples — the canonical values.
 * All consumers (web CSS vars, school Tailwind config, Remotion) read from here.
 */
export const colorTokens = {
  // ── Neutrals ─────────────────────────────────────────────────────────────
  background: WARM_CREAM,
  foreground: NEAR_BLACK,
  card: "40 25% 95%", // #F5F1E8 card cream
  cardForeground: NEAR_BLACK,
  popover: WARM_CREAM,
  popoverForeground: NEAR_BLACK,
  muted: "35 20% 90%",
  mutedForeground: "30 8% 38%", // warm gray
  border: "35 20% 85%", // #DDD5C8 warm border
  input: "35 20% 85%",
  ring: "24 85% 55%",

  // ── Brand primaries ──────────────────────────────────────────────────────
  primary: "24 85% 55%", // #E8621A atomic orange
  primaryForeground: WARM_CREAM,
  secondary: "175 45% 42%", // #3D9990 retro teal
  secondaryForeground: WARM_CREAM,
  accent: "45 70% 50%", // #D4A017 golden brass
  accentForeground: NEAR_BLACK,
  destructive: "0 70% 50%",
  destructiveForeground: WARM_CREAM,

  // ── Extended palette (nature/architecture) ────────────────────────────────
  cream: WARM_CREAM,
  warmWhite: "40 40% 98%",
  terracotta: "15 60% 50%", // #CC5C30
  navy: "224 35% 25%", // #2A3557
  sage: "135 22% 48%", // #5E9470
} as const;

export type ColorTokenKey = keyof typeof colorTokens;

/**
 * Typography tokens.
 */
export const fontTokens = {
  display: '"Space Grotesk", system-ui, sans-serif',
  serif: '"Source Serif 4", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
} as const;

/**
 * Radius tokens (root --radius is 0.75rem; derived sizes live in Tailwind).
 */
export const radiusTokens = {
  base: "0.75rem",
} as const;

/**
 * Shadow tokens — use as CSS variable values.
 */
export const shadowTokens = {
  soft: "0 2px 10px -3px hsl(30 10% 15% / 0.08)",
  card: "0 4px 20px -8px hsl(30 10% 15% / 0.12)",
  elevated: "0 12px 40px -12px hsl(30 10% 15% / 0.18)",
  glow: "0 0 40px -10px hsl(24 85% 55% / 0.45)",
} as const;

/**
 * Gradient tokens — expressed as CSS gradient strings.
 * Hero gradient is warm cream → soft brass; used for section backgrounds.
 */
export const gradientTokens = {
  hero: `linear-gradient(135deg, hsl(${colorTokens.background}) 0%, hsl(${colorTokens.card}) 100%)`,
  brass: `linear-gradient(135deg, hsl(${colorTokens.accent}) 0%, hsl(${colorTokens.primary}) 100%)`,
  sunset: `linear-gradient(180deg, hsl(${colorTokens.primary}) 0%, hsl(${colorTokens.terracotta}) 100%)`,
} as const;

/**
 * Aggregate export. Consumers that just want "all tokens" use this.
 * The existing `brandTokens` export is preserved for backward compat with
 * any consumer already using tokens.ts from @sa/brand.
 */
export const brandTokens = {
  fonts: fontTokens,
  colors: {
    background: `hsl(${colorTokens.background})`,
    foreground: `hsl(${colorTokens.foreground})`,
    primary: `hsl(${colorTokens.primary})`,
    secondary: `hsl(${colorTokens.secondary})`,
    accent: `hsl(${colorTokens.accent})`,
    muted: `hsl(${colorTokens.muted})`,
  },
  shadows: shadowTokens,
  radius: {
    base: radiusTokens.base,
    xl: "1.25rem",
  },
} as const;
