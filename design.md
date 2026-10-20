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

- The website uses dark/void surfaces throughout, the reversed logo and ruled Home / Docs / Downloads / Account navigation. Active routes use one ink-outline frame and semibold text, not stacked underlines. The independently owned frontend records its complete website screen rules in its own `design.md`.
- Public Docs is a task-led reference: install, connect an AI app, import a CV, capture jobs, prepare applications and fill forms. Use readable prose, exact controls, short steps, concrete prompts and an index; avoid marketing panels, repeated disclaimers and setup subtitles. Preserve `#install`, `#connect` and `#extension` deep links.
- Downloads is a compact list of actual distribution files, with short setup steps and collapsed file details. Plugins installed from the companion are not download rows. Published release/availability and permission state must stay truthful.
- Authentication, billing, pairing and signed-device boundaries belong to the website and middleware; loading, pending and error states never imply completion. Career data and provider keys stay off the website. Final reasoning belongs to the user's AI app; optional approved API usage remains separately billed.

### Companion

- Dark/void workspace by default. Compact ruled top navigation with the supplied reversed lockup.
- Home opens by default with **CVs / Facts / Jobs / Job Applications**. Jobs combines captured originals, preliminary results and reviewed assessments into one row per job. Captures are visible before review; incomplete cards say Needs full advert rather than inventing an original or score. Narrow layouts retain back-to-list navigation.
- Major actions belong above the fold on Home: Import CV, Copy review prompt, Connect your agent, Open exports and Export backup. Optional job pre-filtering is a collapsed disclosure by default; running scans expand it to expose status and cancellation. The empty Jobs state points to the connected agent, not mandatory API setup. Never present a copied prompt as an executing model.
- Settings contains Account, Chat apps, Optional Decisions API and Updates. Chat apps provides agent installation/manual configuration and opens the bundled same-version Chrome extension folder. Keep the ruled/nested app-row layout. One optional OpenAI key serves job pre-filtering and known-value form mapping; no generic provider selector. Collapse, navigation and save clear unsaved input. Do not add decorative status badges, duplicate subtitles or persistent billing prose.
- Decisions pre-filtering covers every eligible job within the selected publication period, excluding only current successful Decisions results unless refreshed. Never add a job-count control, scan cap or fixed shortlist cutoff. A seven-position native slider offers Today, Yesterday, Past 3 days, Past week, Past 2 weeks, Past month and Whole catalogue; default to the saved selection or Past 3 days. Keep its current label visible and expose it as `aria-valuetext`. Explain briefly that recent listings offer better interview prospects and older listings are more likely stale or zombie jobs, without invented probabilities. Commit the selection only on change, cancel any current scan, persist it locally and refresh the middleware-backed count/cost without automatically starting work. Show the current job count and rough **Cost ESTIMATE US$…** beside Start before approval. Preview reads catalogue metadata and cached results without provider calls, authorization or career-data mutation; invalidate it when context or publication period changes. Start recomputes the scope before approval and scans only that approved snapshot. Concurrency and protocol batch sizes throttle work, not catalogue coverage.
- API approvals name destination, provider/model, shared data classes and separate API billing. Decisions approval shows the actual job count and **Cost ESTIMATE**; form-mapping approval keeps its input-token base rate. Keep essentials in the approval rather than repeated settings paragraphs. Native approval remains required before dispatch or releasing form values. Saving a key never starts work; a missing key never blocks ordinary agent work or deterministic form preparation.
- Preview and Decisions approval distinguish the middleware's total jobs in the selected publication scope from new Decisions requests when cached successes make those counts differ: **N jobs in scope · M to pre-filter · Cost ESTIMATE US$…**. When the counts match, show one job count. Never substitute a locally truncated list length for the middleware scope total.
- UI copy is action-first: concise labels, actual state and a direct recovery action. Leave idle progress empty. Do not add repeated disclaimers about spending caps, preliminary results, sent-request billing or retained data to controls, approvals, statuses or errors. Keep technical behavior documented here and in the README rather than repeating it throughout the interface.
- Locked storage explains what is inaccessible and offers the actual unlock action. Approval uses a square dialog, readable request details, cancel-first focus and a distinct allow action. Do not remove or weaken native approval to simplify the design.
- Account pairing returns to a one-time loopback browser page using the same bundled styles, fonts and logo. Its states are returning, awaiting native approval, connected and not completed; connected appears only after approval and platform activation succeed. No custom-protocol launch or installed browser extension is required for this return. Removing the fragment from browser history and rendering only success/failure must not expose career records or credentials.
- The Chrome extension uses a stable dark side panel with Capture jobs and Inspect form as its primary actions. Capture/save and prepare/review/copy/fill are distinct user actions. Use existing fonts/tokens, square ruled groups, 44px targets and visible keyboard focus. Page content is text, never executable markup. Never imply API completion, submission or installation from a copied prompt or browser handoff.
- Form suggestions remain reviewable and selectable. Unknown, populated, protected and unsupported fields stay manual. A changed document/control/radio group invalidates filling; no submit/Next clicks or file uploads. New prose comes from the connected agent, not Decisions. Consent is concise and names the destination rather than dumping the career corpus.
- Updates shows the actual package version, Check / Download / Install actions and real progress. No public release is distinct from current; verified download, helper launch and new-version confirmation are separate states. Require native installation approval and preserve local data/identity. Local/source/manual installation limits and errors must be actionable, never fake success. Local bundles must not claim the production URL scheme.

## Verification before shipping

Render the actual surfaces, not just component previews. Check wide and narrow screens, keyboard focus, long role/company labels, empty records, disabled controls, errors, approval and pre-scan states. Confirm local fonts load, logos are current, no stale palette remains, no horizontal page overflow and no text is hidden by the architectural mark. Exercise real UI event paths with isolated synthetic data where authentication or private career data is involved. Never test by mutating a user's vault, granting membership, charging a payment or running paid inference.

Token values and design rules are mirrored in both independently owned repositories. Update both deliberately when the approved system changes; do not introduce cross-repository imports or a second styling convention.
