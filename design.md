# recruiters.rip design system

Required for every product UI change. This document replaces the previous Warm Bone, flat-spectrum, mint/rose status system. It governs the companion and the account/setup website; their source repositories remain independently buildable.

## Source and precedence

- Approved artifact: [recruiters.rip design system](https://claude.ai/artifact/8PZTo24Gv7onffw9MngADm), retrieved 15 October 2026.
- Downloaded source: the current author-written `README.md`, `tokens.json`, component bundle and previews, seven font files and current `assets/Logos` files. The complete download also contains generated component API cards.
- The artifact's generated `tokens.css`, `manifest.json` and some generated API descriptions still contain the previous design. Do not copy those stale values. Current `tokens.json` and the author-written brand rules take precedence. The sample bundle repeats azure at the end of its dispersion declaration; use violet as the fifth stop, as specified by the current palette and brand rules.
- Runtime tokens live in `ui/design-tokens.css` here and `src/app/design-tokens.css` in the website. Their values must agree. Fonts and logos are local assets, not remote dependencies.
- The supplied bundle targets a React global. The website adapts the supplied components to its existing React implementation; the companion uses equivalent semantic HTML. Neither app loads a second framework or imports its sibling at build/runtime.

## Visual principle

**Dark ground, clear surfaces, light at the edge.** Structure comes from fine rules, not rounded tiles, coloured panels or drop shadows. All text ranges left. Colour appears only where a thin edge catches light. This is not frosted-card styling: do not add generic backdrop blur, gradient fields, opaque coloured bands or decorative animation.

Three voices have distinct jobs:

- **Instrument Serif:** upright headlines, section headings and panel titles, never smaller than 28px.
- **Geist Mono:** navigation, buttons, labels, metadata, code and numbers.
- **Geist:** reading copy and field content.

No italics, emoji, decorative serial numbers, centred headlines or chromatic body/link/status text. Keep the brand lowercase: **recruiters.rip**. Product capabilities, privacy claims and status labels must remain true; the artifact's examples are not evidence of features such as direct introductions or an employer posting flow.

## Colour tokens

| Token | Day | Dark | Use |
| --- | --- | --- | --- |
| `color-canvas` | `#f4f7fc` | `#0a0b0e` | Page ground |
| `color-surface` | `#ffffff` | `#14161b` | Necessary elevated reading/control surfaces |
| `color-facet` | `#dfe5ee` | `#272b34` | Decorative hairline structure |
| `color-ink` | `#0e0f12` | `#f4f7fc` | Primary text, logos, actions, strong rules |
| `color-ink-2` | `#2a2e36` | `#e3e8f0` | Secondary reading text |
| `color-smoke` | `#656c78` | `#9aa3b1` | Readable muted text |
| `color-dust` | `#a3aab5` | `#5c6370` | Disabled text and placeholders only |
| `color-void` | `#0a0b0e` | `#0a0b0e` | Fixed dark ground |
| `color-light` | `#f4f7fc` | `#f4f7fc` | Fixed reversed ink |

The semantic surface aliases are `surface-canvas`, `surface-card` and `surface-facet`. Do not use the old warm-bone, obsidian, flare, pearl or rose/mint-ink tokens.

### Dispersion

Five stops, in this exact order, blended in OKLab:

| Token | Value |
| --- | --- |
| `color-disperse-red` | `oklch(0.76 0.15 15)` |
| `color-disperse-amber` | `oklch(0.85 0.13 70)` |
| `color-disperse-green` | `oklch(0.86 0.15 150)` |
| `color-disperse-azure` | `oklch(0.80 0.12 250)` |
| `color-disperse-violet` | `oklch(0.78 0.12 295)` |

Use `--rr-dispersion` horizontally and `--rr-dispersion-v` vertically. They are allowed on 1px edges, rules, active-navigation underlines, hover borders and the architectural mark's rim. They are never large-area fills, discrete colour bands, single-hue states or coloured logo fills. A focused input may use a 2px dispersion rule. Azure at 35–45% is allowed for selection and focused-input/lit-edge halos. On a dark ground, a lit rule can emit a static blurred copy of itself; it does not emit on the day theme.

A headline may emphasize at most one word with upright red/azure fringes. The word remains ink, not gradient-filled text. Dispersion is decoration; focus and selection must also have a clear monochrome/text/ARIA signal.

## Typography

| Role | Family | Size / line height | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display | Instrument Serif | 112px / .92 | 400 | -.025em |
| Small display | Instrument Serif | 72px / .95 | 400 | -.02em |
| Heading | Instrument Serif | 40px / 1.05 | 400 | -.01em |
| Panel heading | Instrument Serif | 28px / 1.15 | 400 | normal |
| Lede | Geist | 20px / 1.4 | 400 | normal |
| Body | Geist | 16px / 1.5 | 400 | normal |
| Dense body | Geist | 14px / 1.5 | 400 | normal |
| Label | Geist Mono | 12px / 1.33 | 500 | .08em, uppercase |
| Metadata | Geist Mono | 13px / 1.6 | 400 | .02em |
| Code | Geist Mono | 14px / 1.6 | 400 | normal |
| Statistic | Geist Mono | 56px / 1 | 400 | -.03em, tabular |

Responsive headings may scale down below the display tiers to fit narrow screens, but serif text remains at least 28px. Dense metadata is not a miniature serif heading. Ordinary prose and privacy disclosures remain Geist, not monospace. Font files are bundled under `ui/fonts` here and `public/fonts` on the website. Keep Geist and Instrument Serif OFL notices with their files. Never load fonts from Google or another third-party host at runtime.

## Layout and shape

- 8px base scale: 8, 16, 24, 32, 40, 64, 80 and 120px.
- Content maximum: 1200px. The content container is centred; text inside it is not.
- Section gap: 80px. Related blocks: 40px. Sibling gap: 16px. Card padding and ordinary grid gutters: 24px.
- Feature entries form a ruled grid without gaps. Do not confuse a CSS page layout with a data grid; actual tabular grids/heatmaps use AG Grid.
- Cards, panels, inputs, dialogs and ledgers: square. Buttons and tags: 2px radius. Circular radii are reserved for genuine status dots.
- Hairlines are 1px. Strong ink rules mark the beginning of a ledger or field. Low-contrast facet rules are structural decoration, not the only boundary identifying an interactive control.
- No lifted-card shadows. The current shadow tokens permit keyboard focus, input halos and dark-only edge glow; `shadow-light-glow` is reserved for a splash and is not a general surface effect.
- Nothing animates. No moving light, hover transforms, pulsing status, shimmer, smooth-scroll animation or layout transitions.

## Shared components and states

### Brand

Use the supplied mirrored Instrument Serif **r** paths. The two feet meet at one point; no extra plinth, slit, line, frame or colour is added. Use current `recruiters-rip-mark.svg`/`-reversed.svg` and lockup assets. Do not redraw the mark using another font. Keep clear space of half the mark's height, minimum mark height 12px; use the supplied favicon cut below 24px. The application icon is the light mark on void. A large architectural mark can have an 8% body and a thin dispersion rim on a dark hero, behind and clear of the content.

### Actions

One primary task per action group: ink fill and canvas text. Secondary buttons are transparent with an ink outline. Low-emphasis actions are text buttons. Mono labels, 44px minimum control height, wrapping rather than clipping at narrow widths. Hover lights the edge, not the whole control. Disabled controls have dust text, no filled background, no hover lighting and `cursor: not-allowed`.

Keyboard focus is a 2px canvas gap followed by a solid 2px ink ring. Never replace it with colour alone. Keep focus visible inside clipped/scrolling containers. Links remain ink; a thin dispersion underline may indicate interaction.

### Fields

A visible label, transparent field and bottom ink rule, not a rounded filled box. Preserve semantic input types, password masking, bounds and validation. Focus uses the two-pixel dispersion rule plus an azure halo and a visible high-contrast keyboard indicator. Native selects keep usable options. Errors have explicit text and `role="alert"`; colour is not an error message.

### Lists, readers and status

Career records are a master/detail list, not a custom table engine. Keep full-result ordering before pagination and readable narrow-screen navigation. Current tabs/records use `aria-current`/`aria-pressed`, text weight and a thin edge or rule, never a mint panel. Do not change data or ranking semantics to match a mockup.

State labels come from actual account, membership, device, lock, request or pre-scan state. Retain loading, empty, error, partial, stale, cancelled and disabled states. Do not infer membership, successful pairing, model completion or permission from the visual design. Notifications remain readable and announced with appropriate status/alert semantics.

## Screen designs

### Website

- Day/clear-ice page, with at most one dark section, normally the hero. Do not create adjacent dark bands.
- Ruled navigation with the real account path. Keep the complete hero mark inside its own region above the facts, with 12px internal clearance for its rim/glow and a 40px gap to metadata. Never crop the mark, oversize it beyond its region, or layer it behind text. Hide it at 860px and below. Check containment and non-overlap at 1440, 1280, 1024, 900, 860 and 390px.
- Primary **Get hired** uses existing sign-in/setup. **How does it work?** links to the actual section. No invented hiring-team route or unavailable posting action.
- The product conversation is explicitly an illustrative example, not live customer data. Capabilities use ruled entries. How-it-works content is unnumbered. Price and supported facts use a mono ledger.
- Login, account setup, membership return, device pairing and device revocation share the same controls and type roles. Loading/unknown/error states never imply success. Preserve original callback parameters, auth, billing and signed-device boundaries.
- Explain subscription-model final review separately from optional, separately billed API pre-scanning. Do not claim that the website receives CVs or provider keys.

### Companion

- Dark/void workspace by default. Compact ruled top navigation with the supplied reversed lockup.
- Home opens by default with **CVs / Facts / Jobs / Job Applications**. Jobs is one list with one row per job, combining distinct preliminary and reviewed assessments without duplicating role information. Narrow layouts retain back-to-list navigation.
- Major actions belong above the fold on Home: Import CV, pre-scan start/limit/cancel, Copy review prompt, Open exports and Export backup. Missing credentials route the action directly to key setup. Never bury operational actions in configuration or present a copy action as an executing model.
- Settings contains Account, Chat apps and Pre-scan credentials. Top-level groups have a heading column and clear section rules; ChatGPT and Claude are nested rows without the same dividing rule. No decorative subtitles, duplicate category headings, 'Open record' captions or explanatory eyebrows. Keep only necessary status, input constraints, errors and consent copy.
- Pre-scan disclosure is concise and explicit: data goes to OpenAI, API billing is separate, the job limit is not a spending cap, and sent requests may still be billed after cancellation. Full approval is mandatory before dispatch. Saving a key never starts a scan.
- Locked storage explains what is inaccessible and offers the actual unlock action. Approval uses a square dialog, readable request details, cancel-first focus and a distinct allow action. Do not remove or weaken native approval to simplify the design.

## Verification before shipping

Render the actual surfaces, not just component previews. Check wide and narrow screens, keyboard focus, long role/company labels, empty records, disabled controls, errors, approval and pre-scan states. Confirm local fonts load, logos are current, no stale palette remains, no horizontal page overflow and no text is hidden by the architectural mark. Exercise real UI event paths with isolated synthetic data where authentication or private career data is involved. Never test by mutating a user's vault, granting membership, charging a payment or running paid inference.

Token values and design rules are mirrored in both independently owned repositories. Update both deliberately when the approved system changes; do not introduce cross-repository imports or a second styling convention.
