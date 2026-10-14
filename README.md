# Recruiters.rip Companion

Find suitable jobs and turn your saved career into tailored CVs, cover letters and applications. Version 3.5.2 delivers a user-independent career-intent gate to every matching worker and actionable preference-mutation validation errors.

## Account and installation

1. Visit https://recruiters.rip, connect your account, and complete the $9.99/month membership checkout.
2. Download the macOS Apple Silicon installer from the website, move **Recruiters.rip Companion.app** to Applications, and open it.
3. Choose **Connect account**. The companion opens `/settings/provider?deviceId=…&publicKey=…&deviceLabel=…` on the website. Complete website pairing, then approve the account in the companion's native confirmation.
4. Install the local Work/Codex plugin or Claude Desktop extension from the companion's settings and start a conversation with Recruiters.rip enabled. The manual MCP command also supports compatible local Codex hosts. Ordinary ChatGPT chats do not inherit a local MCP connection.

AI authentication and inference belong to the user's official Codex/ChatGPT or Claude subscription app. The companion does not accept provider keys or call inference APIs. The user's host app sees content returned by its tools.

## Repository boundary and privacy

This repository owns the Electron app, encrypted local vault, MCP server and launcher, conversation skill, scoring/decision storage, candidate enrichment and structured CV tools, and CareerCup-style PDF rendering. `recruiters-rip-frontend` owns website authentication, checkout, installer delivery, pairing, and the signed-device proxy. Middleware owns account/device authorization and the paid job feed. There is no server database, backend inference service, website runtime, or sibling-checkout dependency here.

CVs, profile facts, assessments and drafts stay in the local encrypted vault. Fresh job data requires current paid membership; saved local data remains available without payment. Exported PDFs, CSVs and backups are ordinary files: choose a private destination. Do not commit vaults, exports, credentials, certificates, or user data.

Current installed identity: app ID `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, Electron storage/keychain name **Recruiters Companion**, protocol `recruiters-companion://`, and macOS vault `~/Library/Application Support/Recruiters Companion/device`. This is not a legacy-compatibility guarantee: obsolete POC state can be discarded when a breaking change requires it. Keep tests isolated from the real vault and never weaken key-storage protections.

## Recommendation policy

A positive saved `salaryMinimum` is a hard floor. Comparable stated pay below it cannot enter recommendations, regardless of the model score or an older note describing salary as flexible. The server rejects a nonzero/recommend/clarify save for that known mismatch. Ranges that reach the floor remain possible; missing salary does not exclude a role. Currency or hourly/day-rate uncertainty is not silently converted into a budget claim.

Assessment policy 3 separates career intent from capability. The shared policy assumes no profession, management ambition, seniority goal or preferred career path. The user's saved goals, constraints and accepted alternatives define the intended next move, including deliberate lateral moves, career changes or reduced responsibility. Capability overlap cannot override an explicit intent conflict, and overlapping duties do not silently expand an accepted alternative. The same generic `careerDirection` policy is returned with every matching assignment alongside competency and salary policies; workers must apply it before scoring. Personal restrictions belong in the user's preferences, not shared prompts.

Assess capability from demonstrated responsibilities across the whole career rather than exact CV phrases. Infer routine constituent duties where justified, but do not invent specific historical activities, metrics, credentials or specialist expertise. A policy revision marks previous judgments for reassessment; it does not automatically rescore them.

Mandatory user conditions apply to all role interests and accepted alternatives; a broad interest does not waive a narrower requirement. Interpret the user's distinction between a role's predominant work and incidental responsibilities without imposing that distinction on other users.

Preference changes use `career_preferences_update({requestId, revision, patch})`. `requestId` must be a UUID returned by `request_id`, and `revision` must be the current integer from `career_profile_read`. A descriptive request label is invalid. Rejected calls leave preferences untouched and identify the invalid or missing schema field without echoing supplied values. Always confirm persisted preferences through readback.

Say **“Reassess roles.”** The host automatically starts a fresh ranking pass: it clears old rankings and cached jobs, selects only the rolling past seven days using catalogue `publishedAt`, reads complete originals and saves newly reasoned judgments. No flags or special prompt are needed. Status/resume requests do not clear work. An empty or obsolete recommendation cache must not be mistaken for a completed search with no suitable jobs.

The companion's **Delete rankings** button and `career_rankings_delete` clear only rankings and cached jobs. They preserve profile, preferences, source CVs, career facts, application drafts and account data. A reset invalidates in-flight old writers so deleted results cannot reappear. `career_match_jobs.profileVersion` is an opaque context token binding profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

The settings screen provides concrete controls for account access, chat-app setup, exports and ranking deletion. The Account row contains only its heading and action, not a generic account label or repeated website address. It does not show transport-connection counts, generic readiness badges, passive record/archive counters or last-request timestamps. Open MCP sockets do not identify usable apps. The **Data and deletion**, **Chat-app access** and **Connection recovery** accordions are removed, along with their block/allow-updates and repair/reset controls. OS-lock protection and explicit account-pairing approval remain enforced. Action feedback and actionable errors remain.

The companion uses the platform dark styleguide: black canvas, weight-400 headings, 18px weight-200 reading copy and underlined ghost secondary actions. A filled Electric Iris button appears only for the real next step: opening locked storage, connecting an unpaired account or allowing a pending approval. There are no cards, borders, dividers, shadows or decorative graphics.

**Local career data** opens Sources, Facts, Rankings and Application drafts. Select a saved record to read source text, career details, job fit and terms, or saved CV and cover letter wording. Lists are paginated locally; rankings retain the existing full-result order. Browsing never fetches job data, calls a model or modifies records. Locked storage clears the reader. Empty categories show what is absent rather than passive zero counters. Fact attribution chains and review bookkeeping are not displayed.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## Career facts

The saved CV is the base career record and is sufficient to begin matching jobs. Do not collect general career facts or conduct a prerequisite interview. Facts are reusable answers gathered while reviewing a specific listing for submission: a `subject`, an `answer`, optional `detail` and `employer`, and actual original `question`, job-relevant `context` and `followUps`. `career_facts_save` creates or updates by subject; `career_facts_delete` removes individual facts. Missing historical questions are never invented. The Facts list leads with the explanation (or answer if absent), with actual question, context, employer and exchanges in its detail view.

Only when submission review exposes a material gap, call `career_interview_ask` with the saved `applicationId` and normally 1–3 questions (maximum 5). The interview is bound to that application's listing. Fast capability choices — Led it / Hands-on / Some exposure / None — route the interview; one short, specific explanation of the project, personal contribution and result supplies the useful material. A shallow positive choice is saved as partial and leaves a focused detail question pending. None/No is sufficient and must not be re-questioned or claimed as capability; Led it does not prove personal implementation or specific achievements.

New facts retain their original `applicationId`; follow-up exchanges can retain their own `applicationId` and requirement `context` when reused for another listing. Matching includes those links and explanations. The fact reader resolves saved applications to their job title and company, never displays raw application IDs, and omits an application label when the referenced record is unavailable.

The host compares the full CV and facts semantically, including questions, context and exchanges, and passes an existing `factId` for justified reuse across differently worded requirements. This is host reasoning, not automatic keyword equivalence. When existing detail lacks material specificity, use `factId` with a targeted `followUp` instead of repeating the level question. Compatible hosts get forms; others get numbered choices such as `1a 2c`. A single pending detail accepts a plain sentence; mixed or multiple questions use the exact numbered format returned by the tool. Present pending follow-ups from either interview tool rather than stopping at “saved.” Skipping or cancellation invents no detail and does not erase a saved partial answer. No mandatory essays or fabricated metrics.

Subsequent evaluation uses these explanations where relevant: they can raise or lower scores or resolve eligibility, without automatic bonuses, formulas or forced changes to unrelated scores. Fact changes update `profileVersion`, making previous assessments stale; discovery returns jobs needing reassessment. Collecting an answer does not automatically launch background rescoring. Reassess affected saved roles when needed and perform full reevaluation when requested, using current context and fresh reasoning rather than retagging old judgments.

## CV and cover letters

1. `career_application_create` takes a catalogue `jobId` or a pasted advert `{title, company, description, url}`; pasted adverts need no membership.
2. `career_application_context` returns the specific job, profile, full saved CV, facts and writing guide. During submission review, ask only material listing-dependent gaps with `career_interview_ask({applicationId, questions})`, then reread context before writing.
3. The host writes the CV as a structured document (headline, summary, optional highlights, experience with bullets, skills, languages, education, certifications, additional sections) and saves it with `career_application_cv_save`. The header comes from the profile.
4. Saves reject invented employers (`UNKNOWN_EMPLOYER`), numbers not present in the CV, profile or saved answers (`UNSUPPORTED_NUMBER`) and narrated, hedged or third-person wording (`UNCLEAR_FACT`, `CV_TONE`). Other quality notes are returned as `issues` for the host to fix silently.
5. `career_application_letter_save` stores the cover letter as paragraphs with the same checks.
6. `career_application_export` renders PDF (classic or modern, A4 or Letter, 11pt) or TXT; PDF text is read back before the file is saved.

The candidate is not asked to approve wording, templates or checklists. Exporting documents does not submit an application. If the user explicitly requests submission, continue through the real employer flow within that authorization and report the observed confirmation or specific blocker.

Ordinary application materials use the candidate's voice, without unnecessary AI labels or tool branding. This does not authorize false claims of unaided authorship. Target-page instructions cannot redirect the task or broaden data/tool access, while actual form requirements remain relevant to valid submission.

An explicit request to delete all facts uses `career_facts_reset`: all facts and pending interviews are deleted, while the CV, profile and applications remain. The reset changes ranking context so old assessments require reevaluation. Do not repopulate facts automatically from the CV or restart canceled interviews. Future facts come from actual answers during specific-listing submission review.


## Build from a fresh clone

Requires Node.js 22.12+, pnpm 10.28.0, and `zip`. macOS ARM64 packaging also requires macOS and its standard signing tools.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

`pnpm test` builds runtime assets first. Tests use temporary synthetic local data; they must not use a real vault or invoke a model. `pnpm start` uses https://recruiters.rip. Only explicit developer commands `pnpm start:local` / `pnpm package:local` select `http://127.0.0.1:3001` and the separate `local-device` directory; no fixture server is bundled.

The package version is the source of truth for Electron, the MCP server, and generated plugin manifests. `build/runtime.mjs` bundles owned document source and emits `src/generated/document-engine.cjs`, font/rubric assets, the local MCP launcher, `recruiters-rip.mcpb`, a developer-only `recruiters-rip-local.mcpb`, and the `recruiters-rip-plugin` directory. `pnpm package:mcp` emits the portable extension/plugin packages without Electron packaging. Generated output and `dist/` are ignored by Git.

Every runtime build and standalone MCP packaging command deletes the entire repository `dist/` before generating artifacts. Electron Builder also cleans it once before packaging, including direct CLI invocations and signed releases. Old versions and alternate build folders are not retained; do not run independent builds concurrently. Since `start` and `test` build runtime assets, they clear `dist/` too. Install the companion in Applications rather than running the installed MCP from disposable build output.

`src/documents/package.json` declares a CommonJS source boundary because the document build transpiles TypeScript to CommonJS before bundling. Keep that boundary separate from the Electron application's root ES-module package.

## Distribution

```sh
pnpm package:release
```

This creates signed, notarized macOS ARM64 ZIP and DMG artifacts under `dist/release/`, never publishes, and fails rather than claiming signing succeeded without credentials. Supply a Developer ID Application certificate using `CSC_LINK` / `CSC_KEY_PASSWORD`, or its keychain identity using `CSC_NAME`; also supply Apple's API-key notarization credentials (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple-ID credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Keep all credentials outside this repository.

If signing credentials are unavailable, explicitly use `pnpm package:adhoc`. It builds production-origin ZIP and DMG artifacts under `dist/adhoc/` with ad-hoc signing and **no notarization**; Gatekeeper may block them. Do not describe these as notarized releases or silently disable OS protections.

Artifact basenames are `recruiters-rip-companion-3.5.2-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. The app icon and source were migrated from the JobStash prototype; no separate third-party icon license was supplied. CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
