---
name: Obsidian Terminal
colors:
  surface: '#0f131b'
  surface-dim: '#0f131b'
  surface-bright: '#353941'
  surface-container-lowest: '#0a0e15'
  surface-container-low: '#181c23'
  surface-container: '#1c2027'
  surface-container-high: '#262a32'
  surface-container-highest: '#31353d'
  on-surface: '#dfe2ed'
  on-surface-variant: '#bbcabf'
  inverse-surface: '#dfe2ed'
  inverse-on-surface: '#2d3038'
  outline: '#86948a'
  outline-variant: '#3c4a42'
  surface-tint: '#4edea3'
  primary: '#4edea3'
  on-primary: '#003824'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#006c49'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d3'
  on-secondary-container: '#00424e'
  tertiary: '#ffb2b7'
  on-tertiary: '#67001b'
  tertiary-container: '#ff7886'
  on-tertiary-container: '#780021'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#ffdadb'
  tertiary-fixed-dim: '#ffb2b7'
  on-tertiary-fixed: '#40000d'
  on-tertiary-fixed-variant: '#92002a'
  background: '#0f131b'
  on-background: '#dfe2ed'
  surface-variant: '#31353d'
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-xl-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.015em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-lg:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-lg: 1.5rem
  margin: 1rem
  margin-md: 1.5rem
  margin-lg: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

The design system projects mathematical discipline, high-stakes precision, and institutional-grade analytics. It is engineered for proprietary traders, quantitative analysts, and serious retail operators who demand immediate clarity over decorative clutter. 

The aesthetic is Modern Technical Minimalism infused with subtle dark Glassmorphism. The interface communicates speed, rigor, and poise through:
- Pitch-black obsidian surfaces accented with low-contrast borders.
- Laser-sharp optical weight distribution with tabular figures.
- High-contrast, glowing financial status indicators (emerald green for yield, carmine rose for drawdown).
- Electric cyan focus anchors that signify actionable analytical states without causing visual fatigue during long sessions.

## Colors

The palette is tuned specifically for deep dark mode execution:

- **Primary (`#10B981` / Emerald):** Signifies positive yield, executed long orders, capital growth, and affirmative metric badges. Use `#34D399` for hover states and chart line glows; use `rgba(16, 185, 129, 0.12)` for filled badge backgrounds.
- **Secondary (`#06B6D4` / Cyan):** Institutional focus, active tab pills, current execution points, interactive sliders, and primary terminal telemetry. Use `rgba(6, 182, 212, 0.15)` for ambient hover fields.
- **Tertiary (`#F43F5E` / Rose Carmine):** Negative P&L, stop-loss execution, drawdowns, and systemic risk alerts. Never washed out; balanced with high luminance for instantaneous legibility against dark slate. Use `rgba(244, 63, 94, 0.12)` for contextual alerts.
- **Neutral (`#090D14` / Pure Obsidian):** Baseline canvas. Complemented by `#0D131F` (panel layer 1), `#131B2B` (panel layer 2 / elevated cards), and `#202B3E` (divider lines, subtle borders).
- **Text & Foreground:** Neutral-50 (`#F8FAFC`) for primary financial data and titles; Slate-400 (`#94A3B8`) for secondary metrics and labels; Slate-600 (`#475569`) for disabled states, axis ticks, and muted table headers.

## Typography

Typography establishes an unwavering hierarchy separating analytical meta-information from mission-critical financial values:

- **JetBrains Mono (Label & Numerical Metrics):** Mandatory for all prices, strike rates, timestamps, percentages, volume figures, and tabular ledger rows. Tabular alignment (`tnum` / `zero`) ensures shifting figures do not cause horizontal layout shifts.
- **Inter (Body & System Controls):** Handles user entries, descriptive notes, execution logs, and interface utility copy with crisp optical clarity.
- **Plus Jakarta Sans (Headings & Portfolios):** Adds modern executive elegance to high-level account balances, workspace titles, and analytical module headers.

## Layout & Spacing

The layout is built upon a dense, responsive 12-column modular grid designed for uninterrupted data consumption:

- **Desktop (1440px+):** Fluid 12-column matrix with `1.5rem` gutters. Multi-pane structure with a fixed left analytical dock (64px collapsed, 240px expanded), central charting canvas (spans 8 columns), and an execution journal/order book rail (spans 4 columns).
- **Tablet (768px - 1023px):** 8-column layout. Chart module stacks above performance grids; secondary analytics collapse into drawer panels.
- **Mobile (<768px):** Single-column stacked feed with sticky bottom summary strips for open positions and cumulative day P&L.
- **Spacing Rhythm:** Internal card structures adhere to compact 4px base intervals (`0.25rem` to `1rem`) to keep information density tight, minimizing the need to scroll.

## Elevation & Depth

Visual hierarchy is constructed through tonal layering, dark glassmorphism, and neon luminous edges rather than high-offset drop shadows:

- **Base Layer (L0 - Background):** `#090D14` solid canvas.
- **Surface Layer (L1 - Panels & Data Grids):** Semi-translucent `#0D131F` at 85% opacity with a `16px` backdrop-filter blur and a 1px border of `rgba(32, 43, 62, 0.6)`.
- **Raised Layer (L2 - Hovered Rows, Active Metric Cards):** `#131B2B` with a 1px border of `rgba(6, 182, 212, 0.3)` or `rgba(16, 185, 129, 0.3)` for winning trades.
- **Overlay Layer (L3 - Dropdowns, Trade Modals):** `#162032` with an ambient glow shadow: `0 8px 32px -4px rgba(0, 0, 0, 0.75), 0 0 1px 1px rgba(255, 255, 255, 0.08)`.
- **Glow Accents:** Positive trade indicators radiate a faint phosphor halo (`0 0 12px rgba(16, 185, 129, 0.2)`), while negative warnings emit a subtle red pulse (`0 0 12px rgba(244, 63, 94, 0.2)`).

## Shapes

The design system employs a refined, technical Soft radius system (`0.25rem` to `0.5rem`). Sharp precision is favored over playful curves:

- **Base Components (Buttons, Input Fields, Badges):** `rounded` (`0.25rem` / `4px`) conveys an instrumented, machined control feel.
- **Cards & Data Tables:** `rounded-lg` (`0.5rem` / `8px`) provides clean edge definitions between packed grid slots.
- **Floating Modals & Flyouts:** `rounded-xl` (`0.75rem` / `12px`) softens structural boundaries without sacrificing the terminal aesthetic.
- **Pill Exception:** Status indicators (e.g., "MARKET OPEN", "+4.2% ROI") utilize full pill radii (`9999px`) to immediately distinguish state tags from interactive buttons.

## Components

### Buttons
- **Primary Execution:** Background `emerald-500` (`#10B981`), foreground `#090D14`, bold weight, font `Inter`. Subtle inner top highlight `1px inset rgba(255, 255, 255, 0.2)`. Hover: `#34D399` with `box-shadow: 0 0 16px rgba(16, 185, 129, 0.35)`.
- **Destructive / Sell:** Background `rose-500` (`#F43F5E`), foreground `#FFFFFF`. Hover: `#FB7185` with `box-shadow: 0 0 16px rgba(244, 63, 94, 0.35)`.
- **Ghost / Neutral:** Background `rgba(19, 27, 43, 0.6)`, border `1px solid rgba(32, 43, 62, 0.8)`, text `slate-300`. Hover brings border to `slate-400` and text to `slate-100`.

### Cards & Analytical Containers
- Built on `L1 Glass`. Includes an integrated 1px header divider line.
- Card titles render in `label-sm` JetBrains Mono, uppercase, color `slate-400`, accompanied by a secondary mini-indicator icon.
- Hover states on clickable trade cards reveal an edge highlight gradient running along the left border (Emerald for profit, Rose for loss, Cyan for neutral/open).

### Metric Badges & P&L Tags
- **Profit Pill:** Background `rgba(16, 185, 129, 0.12)`, border `1px solid rgba(16, 185, 129, 0.3)`, text `#34D399`, typography `label-sm`. Prefixed with `+`.
- **Loss Pill:** Background `rgba(244, 63, 94, 0.12)`, border `1px solid rgba(244, 63, 94, 0.3)`, text `#FB7185`, typography `label-sm`. Prefixed with `-`.
- **Neutral / Breakeven:** Background `rgba(148, 163, 184, 0.08)`, border `1px solid rgba(148, 163, 184, 0.2)`, text `slate-300`.

### Input Fields & Selectors
- Background `#0A0E17`, border `1px solid rgba(32, 43, 62, 0.9)`, text `slate-100`, placeholder `slate-600`.
- Font: `JetBrains Mono` for quantity/price entry; `Inter` for trade notes and strategy tags.
- Focus state: Border transitions to `cyan-500` (`#06B6D4`) with `box-shadow: 0 0 0 1px #06B6D4, 0 0 12px rgba(6, 182, 212, 0.2)`.

### Data Grids & Log Tables
- Table headers: Uppercase `label-sm`, tracking `0.05em`, color `slate-500`, background `rgba(9, 13, 20, 0.7)`.
- Rows: Alternating micro-striping (`transparent` vs `rgba(255, 255, 255, 0.015)`). Bottom border `1px solid rgba(32, 43, 62, 0.35)`.
- Numeric data cells must always utilize `font-feature-settings: "tnum"` with right-alignment.
- Row hover: Smooth illumination with `rgba(6, 182, 212, 0.04)`.

### Checkboxes & Segmented Controls
- Checkboxes: 16px square, `rounded` (2px), border `1px solid slate-600`. Checked state: Fill `cyan-500`, checkmark dark slate.
- Timeframe segmented tabs (`1D`, `1W`, `1M`, `YTD`): Container in `#0A0E17` with `space-xs` padding. Active tab: `#131B2B` with a subtle white keyline border and crisp text contrast.
