---
name: Enclave
description: Compute that cannot see your data — a dark verifier's console in system mono, jade-lit where something is proven.
colors:
  bg: "#070A0F"
  bg-1: "#0B0F16"
  surface: "#0F1620"
  surface-2: "#131C28"
  surface-3: "#172230"
  code-well: "#080C12"
  line: "#1E2937"
  line-soft: "#16202C"
  line-strong: "#566880"
  text: "#E7EEF6"
  text-muted: "#93A1B5"
  text-dim: "#7A8AA0"
  jade: "#2FE6A8"
  jade-2: "#5FF0C0"
  jade-dim: "#1C9C74"
  jade-deep: "#0E3A2C"
  amber: "#FF914D"
  amber-2: "#FFB07A"
  amber-dim: "#B4622F"
  amber-deep: "#3A2014"
  iris: "#8FA2FF"
  danger: "#FF6B6B"
  danger-deep: "#3A1717"
typography:
  display:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "clamp(2rem, 4vw, 2.8rem)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.02em"
  headline:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "clamp(1.7rem, 3vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "1rem"
    fontWeight: 700
    letterSpacing: "0.01em"
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "0.72rem"
    fontWeight: 400
    letterSpacing: "0.22em"
rounded:
  panel: "14px"
  control: "9px"
  field: "8px"
  chip: "7px"
  badge: "5px"
  pill: "999px"
spacing:
  gutter: "24px"
  grid-gap: "16px"
  card-pad: "22px"
  head-gap: "42px"
  section: "84px"
components:
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0.74em 1.15em"
  button-default-hover:
    backgroundColor: "{colors.surface-2}"
  button-primary:
    backgroundColor: "linear-gradient(180deg, rgba(47,230,168,.16), rgba(47,230,168,.06))"
    textColor: "{colors.jade-2}"
    rounded: "{rounded.control}"
    padding: "0.74em 1.15em"
  button-primary-hover:
    backgroundColor: "linear-gradient(180deg, rgba(47,230,168,.24), rgba(47,230,168,.1))"
  input-field:
    backgroundColor: "{colors.code-well}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "0.6em 0.7em"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "22px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.chip}"
    padding: "0.4em 0.65em"
  badge-verified:
    backgroundColor: "{colors.jade-deep}"
    textColor: "{colors.jade}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
---

# Design System: Enclave

## Overview

**Creative North Star: "The Verifier's Console"**

Enclave's interface is an instrument, not a brochure. Every surface behaves like the readout of a machine that is showing you its evidence: near-black layered panels, hairline borders, corner-bracket ticks, live hashes, and a single jade light that comes on only where something is proven. The product's promise is "compute that cannot see your data," and the visual language earns it by looking like the thing doing the attesting — monospace is the product's voice, prose is the only place a human typeface appears, and decoration is limited to what a console would actually emit: glows, grids, and measurement sweeps.

Density is moderate and confident: one 1200px column, generous 84px section rhythm, tight component internals. Nothing floats on drop shadows; depth is tonal, from the `#070A0F` page ground up through five surface tiers to the `#080C12` code wells that sit *below* the page like inspection hatches. Motion is quiet and mechanical — one easing curve, sub-200ms state changes, and a handful of purposeful loops (a drifting silicon grid, a pulsing live dot, a measurement sweep) that all yield to `prefers-reduced-motion`.

The system deliberately rejects: light mode, web fonts, purple gradients, lift shadows, and decorative accent color. It is dark because the subject is a sealed machine; it is mono because the machine is talking.

**Key Characteristics:**
- Dark-only, five-tier tonal depth instead of shadows
- Mono voice: every heading, label, button, and number is system monospace
- Jade is semantic (verified / live / focusable), never decorative
- Corner brackets, hairlines, and dashed borders as instrument chrome
- One easing curve, reduced-motion honored everywhere

## Colors

A near-black blue-green ground carrying one semantic accent family (jade), one warning family (amber), an info blue (iris), and an error red — all used as state, not decoration.

### Primary
- **Jade** (#2FE6A8): the "verified" light. Focus rings, active states, verified badges, live dots, the run button, eyebrow labels, link hovers. Defined in [tokens.css](site/css/src/tokens.css).
- **Bright Jade** (#5FF0C0): primary-button label, code strings, emphasized values.
- **Jade Border** (#1C9C74) and **Jade Fill** (#0E3A2C): the border and background tiers for verified badges and jade panels; glow via `rgba(47,230,168,.14)`.

### Secondary
- **Compute Amber** (#FF914D): the "compute/caution" channel — warnings, caveats, PATCH tags, star ratings (fill #FFB07A), with border tier #B4622F and fill tier #3A2014.

### Tertiary
- **Iris** (#8FA2FF): informational — code keys, schema keys, DNS record types, POST method (#7E9CFF variant).
- **Signal Red** (#FF6B6B): errors, required marks, DELETE; softer #ff8a8a for inline error copy; #3A1717 for danger fills.

### Neutral
- **Void** (#070A0F): page background. **Band** (#0B0F16): alternating sections, wells, thumbnails. **Panel** (#0F1620): default card/panel/button surface. **Panel Raised** (#131C28) and **Panel Top** (#172230): hover surface and toast. **Code Well** (#080C12): terminals, code, inputs — the deepest tier (widely used but untokenized; treat it as a real token).
- **Hairline** (#1E2937), **Hairline Soft** (#16202C), **Hairline Strong** (#566880): default borders, internal dividers, and form-control borders respectively — the strong tier exists to clear WCAG 1.4.11 (≥3:1).
- **Ink** (#E7EEF6), **Ink Muted** (#93A1B5), **Ink Dim** (#7A8AA0): text hierarchy; all hold ≥4.5:1 on every surface tier.

### Named Rules
**The Jade Means Verified Rule.** Jade appears only where something is proven, live, or focused — a verified badge, an attestation step, a focus ring, a running deployment. If a screen is covered in jade, nothing on it reads as verified; scarcity is the semantics.

**The One Gold Rule.** Gold (`rgba(240,185,11,.35)`) exists in exactly one place: the featured app card's border. Never introduce it anywhere else.

## Typography

**Display Font:** system monospace (ui-monospace → SF Mono → JetBrains Mono → Menlo → Consolas)
**Body Font:** system sans (ui-sans-serif → system-ui → Segoe UI → Roboto)
**Label/Mono Font:** same monospace stack — mono *is* the display face

**Character:** The machine speaks mono; humans get sans. Headings, labels, buttons, badges, hashes, and every numeric readout are monospace with tight negative tracking at display sizes and wide uppercase tracking at label sizes. Body prose is quiet system sans at 16px/1.6. No web fonts are loaded — the system stack is a deliberate zero-dependency commitment.

### Hierarchy
- **Display** (600, clamp(2rem,4vw,2.8rem), 1.04, -0.02em): hero H1 only.
- **Headline** (600, clamp(1.7rem,3vw,2.5rem), 1.1, -0.01em): section heads (`.sec-head h2`).
- **Title** (700, ~1rem–1.3rem, 0.01em): card and panel headings; scale steps 1.3 / 1.25 / 1.08 / 1.02 / 1rem by nesting depth.
- **Body** (400, 16px base; components 0.86–0.95rem, 1.5–1.75): sans prose, capped 42–78ch.
- **Label** (0.72rem mono, 0.22em tracking, uppercase, jade): the `.eyebrow` — the signature label, with a 22px gradient rule before it. Sub-labels run 0.66–0.74rem at 0.12–0.14em tracking in Ink Dim.

### Named Rules
**The Mono Voice Rule.** If the product or the machine is speaking — a heading, a status, a hash, a price, a button — it is monospace. Sans is reserved for sentences addressed to a human. Never set prose in mono or a heading in sans.

**The No-Webfont Rule.** System stacks only. Never add `@font-face` or a font CDN.

## Layout

One centered 1200px column (`--maxw`), 24px gutters, `z-index:1` (the body paints fixed background texture at z 0). Sections breathe at 84px vertical (60px ≤640px); section heads carry a 42px bottom margin and cap at 62ch. Prose caps range 42ch (hero lede) to 78ch (docs). Grids are bespoke per surface — 4-up principle cards, auto-fill 300px store grid, 380px+1fr deploy console, 250px+1fr docs rail — and collapse at exactly two real breakpoints: **1000px** (rails stack) and **640px** (single column, tighter rhythm); a few component-local steps (880px header, 560px type) fine-tune between. All queries are `max-width`; the design is desktop-first. Section alternation is a `--bg-1` band with soft hairline top/bottom borders.

## Elevation & Depth

Flat by default. Depth is tonal — Void → Band → Panel → Panel Raised → Panel Top, with Code Wells sunk below the page — plus 1px hairline borders. Hover "lift" is `translateY(-1px…-3px)` with a border-color rise (#33465c / #2b3a4d), never a shadow. Real shadows exist in exactly two vocabularies: jade *glows* that mark verification and life, and a deep-black *poof* under the three floating chrome pieces (hero panel, wallet popover, toast).

### Shadow Vocabulary
- **Primary-button glow** (`0 0 0 1px rgba(47,230,168,.06), 0 10px 30px -12px rgba(47,230,168,.45)`): the one lit button per view.
- **Floating chrome** (`0 30px 80px -40px rgba(0,0,0,.9)` hero panel; `0 30px 60px -28px` popover; `0 20px 50px -20px` toast): reserved for elements genuinely above the page.
- **Verification glows** (`0 0 24–50px -10–24px var(--jade-glow)`): active attestation links, jade icon tiles, list bullets.
- **Focus ring** (`0 0 0 3px rgba(47,230,168,.12)` + jade border on fields; global `:focus-visible` = 2px jade outline, offset 2): the accessibility layer.
- **Active bar** (`inset 3px 0 0 var(--jade)`): selected steps/links — the deliberate non-color state cue (WCAG 1.4.1).

### Named Rules
**The Glow, Not Lift Rule.** Shadows never simulate altitude on resting content. A shadow is either a jade glow (meaning: verified/alive) or black depth under truly floating chrome. Cards at rest are flat.

## Shapes

Rectangles with quiet radii, tiered by size: **14px** panels/cards/modals, **9px** buttons/small tiles, **8px** form fields and sub-panels, **7px** chips and nav pills, **5–6px** badges and micro-controls, **999px** true pills (app badges, meter tracks), **50%** dots. Borders are 1px solid hairlines almost without exception (2px only on active tab underlines and spinner rings; 3px left-accent bars on callouts). **Dashed borders mean provisional or absent**: estimates, empty-state notes, upload dropzones, delisted apps. The signature silhouette is the **corner bracket** — four 12×12 jade L-brackets marking the sealed-enclave panel — echoed by tick marks and hairline-ruled labels (`.block-lbl` with its trailing flex hairline).

## Components

### Buttons
- **Shape:** 9px radius, mono 0.86rem at 0.02em, `.74em 1.15em` padding, inline-flex with a `.55em` gap.
- **Default:** Panel surface, hairline border, Ink text; hover raises surface one tier, border to #33465c, `translateY(-1px)`.
- **Primary:** translucent jade gradient fill, `rgba(47,230,168,.4)` border, Bright Jade label, jade glow shadow; hover deepens both. One per view.
- **Arrow nudge:** the trailing `→` (`.arr`) slides 3px right on hover — a signature micro-interaction.
- **Semantic variants:** `.ok` jade / `.warn` amber / `.danger` soft-red, each as outline + 8% tint fill on hover. **Ghost:** transparent. **Small:** 0.78rem, `.5em .8em`. Disabled: 45% opacity.

### Chips
- **Style:** Panel surface, hairline border, 7px radius, mono 0.72rem, Ink Muted.
- **Status badges** (`.ap-badge`): mono 0.68rem uppercase, 5px radius; jade/iris/amber colorways at ~8% fill + 40% border. **App pills** (`.app-badge`): 999px, Jade Fill background with jade text for verified; neutral/amber/red variants for other states. **HTTP method tags:** 46px-wide 0.6rem/700 tags in GET-jade, POST-blue, PATCH-amber, DELETE-red.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Panel flat, or the signature top-lit gradient `linear-gradient(180deg, var(--surface), #0C131C)`.
- **Shadow Strategy:** none at rest (see Elevation); hover = `translateY(-2/-3px)` + border rise; verified cards get `0 0 0 1px var(--jade-deep) inset`.
- **Border:** 1px Hairline; dashed when delisted/provisional.
- **Internal Padding:** 22px (16–18px on list rows); app cards: 16:9 Band thumbnail over a 16×18px body.

### Inputs / Fields
- **Style:** Code Well background, 1px border lifted to Hairline Strong (#566880) by a global a11y override, 8px radius, mono 0.84rem; labels are mono 0.74rem Ink Muted, 6px below-gap.
- **Focus:** jade border + `0 0 0 3px rgba(47,230,168,.12)` ring.
- **Related controls:** segmented `.seg` buttons (Code Well, 8px, jade-tinted when on), checkboxes via `accent-color: var(--jade)`.

### Navigation
- **Header:** sticky, 64px, `rgba(7,10,15,.72)` + 14px backdrop blur, soft hairline bottom, `view-transition-name: site-header` so it persists across page loads. Centered mono 0.82rem links in 7px pills: Ink Muted → Ink on hover (Panel bg) → jade + 2px jade underline when active. ≤640px it wraps to three rows (brand / wallet / full-width tab row).
- **Footer:** Band background, five columns, mono 0.72rem uppercase column heads in Ink Dim, links hover to jade.

### The Sealed-Enclave Panel (signature)
The hero's live instrument: near-black gradient panel with the system's only true drop shadow, an inset top highlight, a radial vignette, four jade corner brackets at 50% opacity, mono chrome bars top and bottom, a 330px particle canvas periodically swept by a "measurement," and the fleet's real launch-measurement hash rendered in jade. Its idiom — bracketed live evidence with mono chrome — recurs in the attestation chain (jade-glowing linked cards with a 1px gradient connector and sticky code rail), the deployment terminal (0.8rem mono log with jade/amber/iris line states and inline action buttons), and the live-verify widget.

## Do's and Don'ts

### Do:
- **Do** build depth with the tonal ladder (Void → Band → Panel → Raised → Top, wells #080C12) and 1px hairlines; reserve shadows for glows and floating chrome.
- **Do** use the one easing curve `cubic-bezier(.2,.7,.2,1)` (`--ease`) at 0.12–0.2s for state changes, and gate every loop or reveal behind `prefers-reduced-motion` as the existing eight gates do.
- **Do** give form controls the Hairline Strong border (#566880) and jade focus treatment — both exist to pass WCAG 1.4.11/2.4.7; the site holds WCAG 2.1/2.2 AA with axe at zero.
- **Do** pair every color state with a non-color cue: the 3px inset jade bar, a status glyph, an underline.
- **Do** keep labels in the eyebrow idiom — mono, uppercase, 0.12–0.22em tracking — and prose in sans within its 42–78ch caps.
- **Do** use `translateY` + border-rise for hover, and the arrow-nudge on buttons that navigate.

### Don't:
- **Don't** add web fonts, a light theme, or Tailwind utility classes in markup — all three absences are deliberate architecture, not gaps.
- **Don't** use lift shadows on cards, or any shadow that isn't a jade glow or floating-chrome black.
- **Don't** use jade decoratively, gold anywhere but the featured border, or introduce new hues (purple gradients are an explicit anti-reference).
- **Don't** reference `--panel` — it is used by checkout/link/order-status but **never defined**; use `--surface` (and fixing those three files means defining or replacing it, a known quirk).
- **Don't** invent radii or type sizes outside the established tiers (14/9/8/7/6/5/999px; the mono scale above).
- **Don't** style with `!important` or restyle another component's internals; extend by composing the existing classes (`.btn`, `.chip`, `.eyebrow`, `.code`) and tokens.
