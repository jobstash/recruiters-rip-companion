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
- Navigation is **Me / Jobs / Settings / Help**; Me opens by default. Me is everything about the user: the action row (Import CV, Open exports, Export backup, Connect your agent, and Connect account for job access only while unpaired) above the **CVs / Facts / Career** browser. **Career** lists the work history the agent extracted from current CVs and confidently matched to JobStash: one plain row per role (employer as the title; mono summary `Title` then `Mar 2021 – Jan 2024`, `Present` for a current role, `Not stated` for a missing date), newest first, identical roles shown once. Its reader shows Employment (Company, Title, Dates), Inferred from CV (the CV name, plus `CV changed since extraction` when the CV hash moved) and one secondary **Go to {company}’s profile** button; the companion resolves the saved entity ref through the signed relay to the ecosystem.vision page key (`organizations/names/<normalizedName>` or `projects/names/<normalizedName>`) and opens it in the default browser, never a guessed name URL. An employer without an unambiguous page reports `{company} has no public ecosystem.vision page yet.` in the list status. Unmatched employers never appear; the empty state says the agent extracts and links them. Jobs holds ranked jobs, applications and the block list. Settings holds account, chat apps, the optional Decisions API and updates. Help is static and truthful: the exact starting prompt (`Use the recruiters.rip skill to find me a job.`) in a selectable `pre.command`, a four-step how-it-works (connect account → optional pre-filter → agent review → tailor and apply), the docs and downloads URLs as plain `code` text (CSP forbids navigation) and the running package version from state. No marketing copy. Never present a copied prompt as an executing model.
- Jobs is a dedicated full-height tab. Its toolbar holds a three-way **Ranked | Applications | Blocked** segmented control (`aria-pressed` buttons styled like the Me category buttons), the collapsed Optional job pre-filtering disclosure (running scans expand it to expose status and cancellation), the labelled native **Sort jobs** select (**Rank**, default, or **Newest first**), Clear job assessments and Copy review prompt. Ranked is the jobs list; Applications and Blocked reuse the same list + reader, and while either is active the pre-filter disclosure, the Surfaced block, sort and Clear are hidden and disabled. The empty Ranked state points to the connected agent, not mandatory API setup. Below the toolbar a fixed two-pane grid (list `minmax(400px, 1fr)`, reader the rest) fills the remaining height: records scroll inside the list column, the Previous/Next bar is pinned at the column's foot and never moves between loading, loaded and end-of-list states, and the reader column is always rendered. On wide screens Next/Previous auto-opens the first record of the new page while focus stays on the list; with nothing open the reader says **Select a job** or **Select an application**. Narrow screens stack list then reader with Back to list. Sorting covers the whole saved union before pagination. The list status line reads `1–25 of 1,342 · 48 sent to the agent`.
- Pinned pagination is a CSS contract, independent of the renderer: `main` (flex 1, `min-height: 0`) → `#settings` (`height: 100%`) → `.career-view` (`height: 100%`, grid) → `.career-browser` (grid `auto minmax(0, 1fr)`) → `.career-panes` (grid item, stretched, `min-height: 0`; never `height: 100%`, which would measure the browser including its toolbar) → `.career-list` (grid `auto auto minmax(0, 1fr) auto`, `overflow: hidden`). Every list child is placed on an explicit `grid-row` (surface 1, status head 2, retry and records 3, pagination 4) because `hidden` children leave the grid; implicit placement would hand the records the `auto` row, grow them to content height and push the pagination bar past the clipped column on tall windows. Only `(max-width: 479px)` or `(max-height: 639px)` switch the column to natural height and page scrolling.
- **Surfaced to your agent** (`#career-surface`) is the single control that decides which unreviewed jobs the MCP exposes to the agent; it is a score threshold, not a job count, so the user bounds the agent's inference volume directly. A ruled block at the head of the Ranked list column holds the uppercase mono caption, a native `input[type=range]` (`#career-minimum-score`, 0–100, step 1, labelled **Minimum pre-filter score**, `aria-valuetext` `Minimum score 60`) beside the current value as a 32px tabular mono number, and the live sentence `48 of 1,342 jobs will be sent to the agent` (`All 1,342 jobs will be sent` only when no pre-filter exists; the total counts catalogue jobs without a current review). After a profile change the old ranking still applies and the sentence adds `· ranked before your profile changed; pre-filter again to update`. The number follows the thumb on `input`; the threshold is saved once on `change` (`prescan-threshold`), and a failed save restores the saved value and explains in the list status. Without the basic preferences the pre-filter scope line says to tell the agent the target roles, locations, work modes, relocation and travel, instead of a generic failure.
- The pre-filter exists only to rank jobs for the next expensive agent evaluation, so its per-job score is never shown; the only pre-filter number in the interface is the threshold itself. What a card answers is whether the job is **in the next run**. Inclusion is user-owned: a job is included when its pre-filter score is at least the minimum (default 60) or when the user switched it on; a per-job switch overrides the threshold either way and the reader's **Reset to minimum score** returns the job to the rule. Unscored jobs are excluded unless switched on. Without any current pre-scan every job is included. Decisions (pre-filter) scores and agent review scores are different scales and never share a control, a list or a chart.
- Card anatomy (`li.career-card`): the record button holds three plain lines with 20px/24px padding and 8px gaps — role title (Geist 15/500); `company · Published 17 Oct 2026` (company ink-2, date ink); one Geist Mono 12px smoke line of facts joined by ` · ` (seniority, salary, city or location · work mode, commitment, classification), ellipsised to a single line, missing values omitted. No chips, boxes, uppercase or colour fills. The 128px right column is a sibling of the button, never nested inside it, wide enough for `In next run` to sit on one line beside its square: a reviewed job shows only the overall fit as a 24px tabular Geist Mono number with the 10px caption `Fit` (`Fit · out of date` when stale; no decision text, no dimensions); a pre-filtered or unscored job shows a native checkbox drawn as a 20px ruled square (`aria-label` "Include {title} in the next agent run", Space toggles, clicks never open the record) captioned `In next run`, plus `manual` when the user overrode the threshold and, for unscored jobs, the reason there is no rank: Advert unavailable / Declined / Too large / Not pre-filtered. The **Rank** sort lists current reviews by fit, then pre-filtered jobs by rank, then unscored; an `li.career-cutoff` ruled divider (ink top rule, mono caption `Below minimum score 60 · not sent to the agent`, a **Change** text button that focuses the slider) sits before the first job ranked below the minimum. The reader opens with a **Next run** group (`Included` / `Excluded`, `(manual)` when overridden, Reset to minimum score) for every non-reviewed job and otherwise keeps its sections; it never shows a score for a job no agent has reviewed. A reviewed job's **Fit** section is a horizontal bar chart (`div.career-chart`): one row per value — Overall first, then Direction, Capability, Scope, Preferences — with a 12px mono smoke label, a 12px track ruled in facet carrying an ink fill as wide as the score (ink for Overall, ink-2 for dimensions; CanvasText under forced colours), and the value right-aligned in tabular mono. No colour, no animation. Rows keep 44px hit areas, visible focus, `aria-current` on the open record and an aria-label summarising title, company, fit or rank and inclusion, and date. Captures are visible before review; incomplete cards show Needs full advert in the reader's Capture section rather than inventing an original or score.
- Blocking is user-owned and local. Every job reader carries a **Block from evaluation** group (after Next run) of secondary buttons: **Block this job**, **Block all {company} jobs** and **Block all {category} jobs**, the last two only when the job states a company or classification. A blocked job leaves the Ranked list, its counts, the pre-filter and everything the MCP exposes; the refresh keeps the page, focuses the first record and prefixes the list status with `Blocked Example Labs`. **Blocked** lists one plain row per block (label; mono summary `Company · 2 saved jobs`) with a sibling **Remove** text button; its reader shows Type, Saved jobs blocked and Added plus **Remove block**. Removal restores matching jobs and reports `Unblocked …`. The empty state says how to block. No colour marks a blocked state.
- Settings contains Account, JobStash profile, Chat apps, Optional Decisions API and Updates. **Account** holds the pairing line and button, then a **GitHub** app-row that exists only while paired. Its state comes from the platform `status` call (middleware's synchronized copy of the Privy link), never from a local flag: `Checking your GitHub link…`, `Linked as @login. JobStash can match your open-source work to you.` with **Manage on recruiters.rip**, `Not linked. Optional: …` with **Link GitHub** (opens `/account#github`, then says to come back), or the offline / reconnect line. Because the website links instantly but the platform learns of it through a webhook, the row re-reads status whenever the window regains focus and polls briefly after a link attempt. **JobStash profile** (`#sharing-settings`) shows one truthful status line (`CV sharing is on since 20 Oct 2026. Each upload still asks for your approval.` or `CV sharing is off.`; the purpose is explained by the agent at consent time, not repeated here), an optional caption `Last shared {CV} · N roles · {date}`, and one secondary button **Allow CV sharing** / **Stop sharing**. Stopping blocks future uploads only. No cost text: sharing has none. The CV upload approval names JobStash, the CV, the matched role count and employers, and the purpose. Chat apps provides agent installation/manual configuration and opens the bundled same-version Chrome extension folder. Keep the ruled/nested app-row layout. **Optional Decisions API** has no disclosure: its first line is the state, in body type, and the controls follow from it. No key: `No API key saved. Job pre-filtering is off until you add an OpenAI API key.`, the **OpenAI API key** field and primary **Save key**. Key saved: `API key saved on 20 Oct 2026. Job pre-filtering can run.` with **Replace key …ab12** / **Remove key …ab12** and no field; the buttons carry the key hint so the action names what it acts on. Replacing: `The key …ab12 stays active until you save a new one.`, the **New OpenAI API key** field, **Save new key** and **Cancel** (focus returns to Replace). Locked storage shows the unlock line only. The key hint is its last four characters; the secret never reaches the renderer. One optional OpenAI key serves job pre-filtering and known-value form mapping; no generic provider selector. Navigation and save clear unsaved input and a pending replacement. Do not add decorative status badges, duplicate subtitles or persistent billing prose.
- Decisions pre-filtering covers every eligible job within the selected publication period, excluding only current successful Decisions results unless refreshed. Never add a job-count control or scan cap to the pre-filter itself: the **Minimum pre-filter score** bounds the agent's next run, not what gets pre-filtered. A seven-position native slider offers Today, Yesterday, Past 3 days, Past week, Past 2 weeks, Past month and Whole catalogue; default to the saved selection or Past 3 days. Keep its current label visible and expose it as `aria-valuetext`. Explain briefly that recent listings offer better interview prospects and older listings are more likely stale or zombie jobs, without invented probabilities. Commit the selection only on change, cancel any current scan, persist it locally and refresh the middleware-backed count/cost without automatically starting work. Preview reads catalogue metadata and cached results without provider calls, authorization or career-data mutation; invalidate it when context or publication period changes. Start recomputes the scope before approval and scans only that approved snapshot. Concurrency and protocol batch sizes throttle work, not catalogue coverage.
- API approvals name destination, provider/model, shared data classes and separate API billing. Decisions approval shows the actual job count and **Cost ESTIMATE**; form-mapping approval keeps its input-token base rate. Keep essentials in the approval rather than repeated settings paragraphs. Native approval remains required before dispatch or releasing form values. Saving a key never starts work; a missing key never blocks ordinary agent work or deterministic form preparation.
- The scope line is the single pre-filter status: **N jobs in scope · M to pre-filter · ~US$0.31** before a run, **N jobs in scope · all pre-filtered** afterwards; `· K blocked` follows the scope count when the user blocked catalogue jobs, which are never pre-filtered. Costs use two decimals. Cancel is visible only while a scan is starting or running; progress (**Pre-filtering 719/1,342 · US$0.22**, blocked jobs excluded from the total) appears only then. A finished run shows no repeated summary, status label or token/request totals; stopped, failed or stale runs show one recovery line. Never substitute a locally truncated list length for the middleware scope total.
- UI copy is action-first: concise labels, actual state and a direct recovery action. Do not add repeated disclaimers about spending caps, preliminary results, sent-request billing or retained data to controls, approvals, statuses or errors. Keep technical behavior documented here and in the README rather than repeating it throughout the interface.
- Locked storage explains what is inaccessible and offers the actual unlock action. Approval uses a square dialog, readable request details, cancel-first focus and a distinct allow action. Do not remove or weaken native approval to simplify the design.
- Account pairing returns to a one-time loopback browser page using the same bundled styles, fonts and logo. Its states are returning, awaiting native approval, connected and not completed; connected appears only after approval and platform activation succeed. No custom-protocol launch or installed browser extension is required for this return. Removing the fragment from browser history and rendering only success/failure must not expose career records or credentials.
- The Chrome extension uses a stable dark side panel with Capture jobs and Inspect form as its primary actions. Capture/save and prepare/review/copy/fill are distinct user actions. Use existing fonts/tokens, square ruled groups, 44px targets and visible keyboard focus. Page content is text, never executable markup. Never imply API completion, submission or installation from a copied prompt or browser handoff.
- Form suggestions remain reviewable and selectable. Unknown, populated, protected and unsupported fields stay manual. A changed document/control/radio group invalidates filling; no submit/Next clicks or file uploads. New prose comes from the connected agent, not Decisions. Consent is concise and names the destination rather than dumping the career corpus.
- Updates shows the actual package version, Check / Download / Install actions and real progress. No public release is distinct from current; verified download, helper launch and new-version confirmation are separate states. Require native installation approval and preserve local data/identity. Local/source/manual installation limits and errors must be actionable, never fake success. Local bundles must not claim the production URL scheme.

## Verification before shipping

Render the actual surfaces, not just component previews. Check wide and narrow screens, keyboard focus, long role/company labels, empty records, disabled controls, errors, approval and pre-scan states. Confirm local fonts load, logos are current, no stale palette remains, no horizontal page overflow and no text is hidden by the architectural mark. Exercise real UI event paths with isolated synthetic data where authentication or private career data is involved. Never test by mutating a user's vault, granting membership, charging a payment or running paid inference.

Token values and design rules are mirrored in both independently owned repositories. Update both deliberately when the approved system changes; do not introduce cross-repository imports or a second styling convention.
