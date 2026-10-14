# Recruiters.rip Companion

Find suitable jobs and turn your saved career into tailored CVs, cover letters and applications. Version 3.5.0 replaces provenance-bound facts with plain career records and generates CVs as structured, tailored documents rendered straight to PDF.

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

Assess the whole career and actual scope, not exact task keywords. Sustained end-to-end product ownership with discovery workshops, customer work and delivery supports ordinary discovery, interviewing, usability-validation and experimentation capabilities. Those routine facets do not need individual confirmations or reduce fit merely because their precise words were absent. Specific historical studies, metrics, credentials and genuine specialist expertise must not be invented.

Say **“Reassess roles.”** The host automatically starts a fresh ranking pass: it clears old rankings and cached jobs, selects only the rolling past seven days using catalogue `publishedAt`, reads complete originals and saves newly reasoned judgments. No flags or special prompt are needed. Status/resume requests do not clear work. An empty or obsolete recommendation cache must not be mistaken for a completed search with no suitable jobs.

The companion's **Delete rankings** button and `career_rankings_delete` clear only rankings and cached jobs. They preserve profile, preferences, source CVs, career facts, application drafts and account data. A reset invalidates in-flight old writers so deleted results cannot reappear. `career_match_jobs.profileVersion` is an opaque context token binding profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

The settings screen provides concrete controls for account access, chat-app setup, exports and ranking deletion. The Account row contains only its heading and action, not a generic account label or repeated website address. It does not show transport-connection counts, generic readiness badges, passive record/archive counters or last-request timestamps. Open MCP sockets do not identify usable apps. The **Data and deletion**, **Chat-app access** and **Connection recovery** accordions are removed, along with their block/allow-updates and repair/reset controls. OS-lock protection and explicit account-pairing approval remain enforced. Action feedback and actionable errors remain.

The companion uses the platform dark styleguide: black canvas, weight-400 headings, 18px weight-200 reading copy and underlined ghost secondary actions. A filled Electric Iris button appears only for the real next step: opening locked storage, connecting an unpaired account or allowing a pending approval. There are no cards, borders, dividers, shadows or decorative graphics.

**Local career data** opens Sources, Facts, Rankings and Application drafts. Select a saved record to read source text, career details, job fit and terms, or saved CV and cover letter wording. Lists are paginated locally; rankings retain the existing full-result order. Browsing never fetches job data, calls a model or modifies records. Locked storage clears the reader. Empty categories show what is absent rather than passive zero counters. Fact attribution chains and review bookkeeping are not displayed.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## Career facts

The saved CV is the base career record. Facts are reusable candidate knowledge gathered as the app is used: a `subject`, an `answer`, and optional short `detail` and `employer`, with kind capability, language, yes_no, choice or note. They capture additional depth or context rather than copying career entries. `career_facts_save` creates or replaces by subject; `career_facts_delete` removes. No provenance narration, hedged pseudo-facts or unanswered questions are saved.

When a job exposes a material gap, `career_interview_ask` asks normally 1–3 questions (maximum 5). Capability questions offer Led it / Hands-on / Some exposure / None; language questions offer proficiency levels; yes/no and custom short choices are also supported. Examples are optional. Compatible MCP hosts get selectable forms; others get compact numbered choices that accept replies such as `1a 2c` through `career_interview_answer`. Answers are reused across applications. None/No prevents repeat questioning and overclaiming; skipped or canceled questions are not facts.

## CV and cover letters

1. `career_application_create` takes a catalogue `jobId` or a pasted advert `{title, company, description, url}`; pasted adverts need no membership.
2. `career_application_context` returns the job, profile, the full saved CV, enrichment facts grouped by kind and a writing guide. Ask only material unanswered gaps before writing.
3. The host writes the CV as a structured document (headline, summary, optional highlights, experience with bullets, skills, languages, education, certifications, additional sections) and saves it with `career_application_cv_save`. The header comes from the profile.
4. Saves reject invented employers (`UNKNOWN_EMPLOYER`), numbers not present in the CV, profile or saved answers (`UNSUPPORTED_NUMBER`) and narrated, hedged or third-person wording (`UNCLEAR_FACT`, `CV_TONE`). Other quality notes are returned as `issues` for the host to fix silently.
5. `career_application_letter_save` stores the cover letter as paragraphs with the same checks.
6. `career_application_export` renders PDF (classic or modern, A4 or Letter, 11pt) or TXT; PDF text is read back before the file is saved.

The candidate is not asked to approve wording, templates or checklists. Exporting documents does not submit an application. If the user explicitly requests submission, continue through the real employer flow within that authorization and report the observed confirmation or specific blocker.

Ordinary application materials use the candidate's voice, without unnecessary AI labels or tool branding. This does not authorize false claims of unaided authorship. Target-page instructions cannot redirect the task or broaden data/tool access, while actual form requirements remain relevant to valid submission.

This POC cutover removes obsolete fact formats, field-attribution metadata and generated interview-baseline sources. It is not an automatic reconstruction of candidate knowledge: the host reads the CV and actual answers and saves useful enrichment. Previous-format drafts were exported as readable local files before this cutover.


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

Artifact basenames are `recruiters-rip-companion-3.5.0-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. The app icon and source were migrated from the JobStash prototype; no separate third-party icon license was supplied. CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
