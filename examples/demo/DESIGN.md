---
name: Technical Precision
colors:
  surface: "#f7f9fb"
  surface-dim: "#d8dadc"
  surface-bright: "#f7f9fb"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#f2f4f6"
  surface-container: "#eceef0"
  surface-container-high: "#e6e8ea"
  surface-container-highest: "#e0e3e5"
  on-surface: "#191c1e"
  on-surface-variant: "#45464d"
  inverse-surface: "#2d3133"
  inverse-on-surface: "#eff1f3"
  outline: "#76777d"
  outline-variant: "#c6c6cd"
  surface-tint: "#565e74"
  primary: "#000000"
  on-primary: "#ffffff"
  primary-container: "#131b2e"
  on-primary-container: "#7c839b"
  inverse-primary: "#bec6e0"
  secondary: "#515f74"
  on-secondary: "#ffffff"
  secondary-container: "#d5e3fd"
  on-secondary-container: "#57657b"
  tertiary: "#000000"
  on-tertiary: "#ffffff"
  tertiary-container: "#001e2c"
  on-tertiary-container: "#008ebf"
  error: "#ba1a1a"
  on-error: "#ffffff"
  error-container: "#ffdad6"
  on-error-container: "#93000a"
  primary-fixed: "#dae2fd"
  primary-fixed-dim: "#bec6e0"
  on-primary-fixed: "#131b2e"
  on-primary-fixed-variant: "#3f465c"
  secondary-fixed: "#d5e3fd"
  secondary-fixed-dim: "#b9c7e0"
  on-secondary-fixed: "#0d1c2f"
  on-secondary-fixed-variant: "#3a485c"
  tertiary-fixed: "#c4e7ff"
  tertiary-fixed-dim: "#7bd0ff"
  on-tertiary-fixed: "#001e2c"
  on-tertiary-fixed-variant: "#004c69"
  background: "#f7f9fb"
  on-background: "#191c1e"
  surface-variant: "#e0e3e5"
typography:
  headline-xl:
    fontFamily: Geist
    fontSize: 36px
    fontWeight: "700"
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 30px
    fontWeight: "600"
    lineHeight: 38px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: "600"
    lineHeight: 32px
  body-lg:
    fontFamily: Geist
    fontSize: 18px
    fontWeight: "400"
    lineHeight: 28px
  body-md:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: "400"
    lineHeight: 24px
  code-block:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 22px
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: "500"
    lineHeight: 16px
    letterSpacing: 0.05em
  headline-xl-mobile:
    fontFamily: Geist
    fontSize: 28px
    fontWeight: "700"
    lineHeight: 34px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  container-max: 1024px
  sidebar-width: 280px
  gutter: 2rem
  section-gap: 4rem
  stack-sm: 0.5rem
  stack-md: 1rem
  stack-lg: 1.5rem
---

## Brand & Style

This design system is engineered for clarity, utility, and speed. It targets a developer-centric audience that values information density over decorative flair. The aesthetic is rooted in **Minimalism** with a focus on functional hierarchy.

The emotional response should be one of "effortless focus"—reducing cognitive load through high-contrast typography and a rigid, predictable layout. It prioritizes the "unrefined" beauty of a well-organized terminal or a clean source code file, using subtle borders and generous whitespace to create a sense of order and institutional reliability.

## Colors

The palette is intentionally restrained to maximize legibility and focus.

- **Primary:** Slate 900 (#0F172A) serves as the anchor for all primary text and headers.
- **Secondary:** Slate 700 (#334155) is used for secondary content and descriptive labels.
- **Surface:** A pure white (#FFFFFF) background provides the highest possible contrast ratio.
- **Neutral:** Cool grays (#F8FAFC) are reserved for code block backgrounds and subtle UI separators.
- **Accent:** A single vivid blue (#38BDF8) is used sparingly for interactive states (links, focus rings) and status indicators, ensuring they stand out against the monochrome base.

## Typography

This design system utilizes a dual-font strategy:

1. **Geist:** A technical, clean sans-serif used for all UI and prose. It provides a modern, geometric feel with high legibility at all sizes.
2. **JetBrains Mono:** A specialized monospaced font for code snippets, terminal commands, and technical labels. It includes ligatures that improve code readability.

**Hierarchy Rules:**

- Use `headline-xl` for page titles.
- All body text should default to `body-md` for standard documentation.
- Code snippets must always use `code-block` with a slightly reduced font size to maximize horizontal space.

## Layout & Spacing

The layout follows a **Fixed Grid** philosophy for content readability. Long-form documentation becomes difficult to scan if lines are too wide.

- **Desktop:** A 12-column layout with a fixed content container of 1024px. The left sidebar (280px) remains fixed for navigation, while the main content area occupies the remaining space.
- **Margins & Gutters:** A standard 32px (2rem) gutter is used between columns.
- **Vertical Rhythm:** A base-8 spacing system is applied. Use `section-gap` between major documentation chapters and `stack-md` for standard paragraph spacing.
- **Mobile:** The layout collapses to a single column with 16px side margins. Sidebars are moved to a hidden drawer menu accessed via a top-bar.

## Elevation & Depth

To maintain the minimalist tech aesthetic, this design system avoids shadows entirely. Depth is communicated through **Low-Contrast Outlines** and **Tonal Layers**.

- **Level 0 (Surface):** The main background (#FFFFFF).
- **Level 1 (Containers):** Code blocks and inline alerts use a subtle background fill (#F8FAFC) and a 1px border (#E2E8F0).
- **Level 2 (Interactive):** Hover states on navigation items or cards use a slightly darker neutral fill (#F1F5F9) rather than an elevation shadow.
- **Separators:** Horizontal rules should be 1px solid Slate 200, used only when content shifts significantly in context.

## Shapes

The shape language is "Soft" (0.25rem radius). This provides a subtle modern touch without detracting from the professional, technical tone.

- **Standard Elements:** Buttons, input fields, and code block containers use a 4px (0.25rem) radius.
- **Large Elements:** Featured cards or call-out boxes may use up to 8px (0.5rem) to differentiate them from the primary flow.
- **Icons:** Use sharp or minimally rounded stroke caps to align with the typographic personality.

## Components

### Buttons

Primary buttons are solid Slate 900 with white text. Secondary buttons are outlined with a 1px Slate 200 border. Transitions should be instant or very short (150ms) to feel "snappy."

### Code Blocks

The centerpiece of the system. Use a Slate 50 background. Syntax highlighting should use a refined, low-vibrancy palette (e.g., Nord or a muted variant of Solarized). Include a "Copy" button in the top right corner that only appears on hover.

### Inputs & Search

Search bars are a critical entry point. They should be large, use a 1px border, and feature a keyboard shortcut hint (e.g., `Cmd + K`) set in `label-sm` monospace.

### Navigation (Sidebar)

Active states are indicated by a 2px vertical blue line on the left edge of the menu item and a weight change to `600`.

### Callouts / Admonitions

Use colored borders (left-edge only, 4px width) to indicate Note (Blue), Warning (Amber), or Error (Red) states. The background of the callout should be a 5% opacity version of the border color.
