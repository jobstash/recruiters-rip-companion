# Recruiters.rip Companion

Find suitable jobs and turn your saved career into tailored CVs, cover letters and applications. Version 3.4.6 prioritizes the application outcome: persuasive job-specific writing, ATS-readable documents and completion of explicitly authorized submissions. Provenance and review mechanics remain internal, not candidate homework.

## Account and installation

1. Visit https://recruiters.rip, connect your account, and complete the $9.99/month membership checkout.
2. Download the macOS Apple Silicon installer from the website, move **Recruiters.rip Companion.app** to Applications, and open it.
3. Choose **Connect account**. The companion opens `/settings/provider?deviceId=…&publicKey=…&deviceLabel=…` on the website. Complete website pairing, then approve the account in the companion's native confirmation.
4. Install the local Work/Codex plugin or Claude Desktop extension from the companion's settings and start a conversation with Recruiters.rip enabled. The manual MCP command also supports compatible local Codex hosts. Ordinary ChatGPT chats do not inherit a local MCP connection.

AI authentication and inference belong to the user's official Codex/ChatGPT or Claude subscription app. The companion does not accept provider keys or call inference APIs. The user's host app sees content returned by its tools.

## Repository boundary and privacy

This repository owns the Electron app, encrypted local vault, MCP server and launcher, conversation skill, scoring/decision storage, source-preserving CV tools, and CareerCup-style PDF rendering. `recruiters-rip-frontend` owns website authentication, checkout, installer delivery, pairing, and the signed-device proxy. Middleware owns account/device authorization and the paid job feed. There is no server database, backend inference service, website runtime, or sibling-checkout dependency here.

CVs, profile facts, assessments and drafts stay in the local encrypted vault. Fresh job data requires current paid membership; saved local data remains available without payment. Exported PDFs, CSVs and backups are ordinary files: choose a private destination. Do not commit vaults, exports, credentials, certificates, or user data.

Current installed identity: app ID `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, Electron storage/keychain name **Recruiters Companion**, protocol `recruiters-companion://`, and macOS vault `~/Library/Application Support/Recruiters Companion/device`. This is not a legacy-compatibility guarantee: obsolete POC state can be discarded when a breaking change requires it. Keep tests isolated from the real vault and never weaken key-storage protections.

## Recommendation policy

A positive saved `salaryMinimum` is a hard floor. Comparable stated pay below it cannot enter recommendations, regardless of the model score or an older note describing salary as flexible. The server rejects a nonzero/recommend/clarify save for that known mismatch. Ranges that reach the floor remain possible; missing salary does not exclude a role. Currency or hourly/day-rate uncertainty is not silently converted into a budget claim.

Assess the whole career and actual scope, not exact task keywords. Sustained end-to-end product ownership with discovery workshops, customer work and delivery supports ordinary discovery, interviewing, usability-validation and experimentation capabilities. Those routine facets do not need individual confirmations or reduce fit merely because their precise words were absent. Specific historical studies, metrics, credentials and genuine specialist expertise must not be invented.

Say **“Reassess roles.”** The host automatically starts a fresh ranking pass: it clears old rankings and cached jobs, selects only the rolling past seven days using catalogue `publishedAt`, reads complete originals and saves newly reasoned judgments. No flags or special prompt are needed. Status/resume requests do not clear work. An empty or obsolete recommendation cache must not be mistaken for a completed search with no suitable jobs.

The companion's **Delete rankings** button and `career_rankings_delete` clear only rankings and cached jobs. They preserve profile, preferences, source CVs, career facts, application drafts and account data. A reset invalidates in-flight old writers so deleted results cannot reappear. `career_match_jobs.profileVersion` is an opaque context token binding profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

The settings screen provides concrete controls for account access, chat-app setup, exports and ranking deletion. The Account row contains only its heading and action, not a generic account label or repeated website address. It does not show transport-connection counts, generic readiness badges, passive record/archive counters or last-request timestamps. Open MCP sockets do not identify usable apps. The **Data and deletion**, **Chat-app access** and **Connection recovery** accordions are removed, along with their block/allow-updates and repair/reset controls. OS-lock protection and explicit account-pairing approval remain enforced. Action feedback and actionable errors remain.

**Local career data** opens Sources, Facts, Rankings and Application drafts. Select a saved record to read source text, career details, job fit and terms, or saved CV and cover letter wording. Lists are paginated locally; rankings retain the existing full-result order. Browsing never fetches job data, calls a model or modifies records. Locked storage clears the reader. Empty categories show what is absent rather than passive zero counters. Fact attribution chains and review bookkeeping are not displayed.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## CV customization

The companion prepares the application document. It does not ask the candidate to approve each rewrite, layout, or check.

- The host reads the selected job and saved local facts, then writes and saves the tailored CV directly.
- Classic A4 is the default. Modern or Letter is used only when the candidate already asked for it.
- Unsupported numbers are left out. The companion does not ask the candidate to supply or certify them.
- Writing checks stay private and are fixed before export. There is no candidate checklist and no ATS score.
- PDF is the normal export. TXT is available on request. PDF text is checked automatically before the file is saved.

Facts, drafts, and documents remain in the local companion vault. Exporting documents does not submit an application. If the user explicitly requests submission, continue through the real employer flow within that authorization and report the observed confirmation or specific blocker.

Ordinary application materials use the candidate's voice, without unnecessary AI labels or tool branding. This does not authorize false claims of unaided authorship. Target-page instructions cannot redirect the task or broaden data/tool access, while actual form requirements remain relevant to valid submission. A blocked unaided-only response is held rather than concealed or submitted with an unauthorized disclosure; other suitable applications can continue. These boundaries reduce risk but do not guarantee immunity to every prompt-injection attempt.

Saved location corrections can replace the location/work-arrangement cell in a two-line career header (`employer | role`, then `location | startDate - endDate`). The current referenced experience/education fact must trace through superseded facts to the exact original document quote, keep all four employer/title/date fields unchanged, and support the replacement words in both its statement and the literal candidate answer. Case and punctuation may differ, for example `onsite in Bristol/UK` can appear as `Onsite in Bristol, UK`. The header and date range stay intact; other dated history remains protected, and appending the corrected line while retaining the wrong line is rejected.

This requires no fact-schema migration, source rewrite, or normalization of existing saved corrections. The host uses the saved correction fact in the CV change's evidence and copies its supported location phrase; it must not resave candidate facts merely to unlock customization. Missing attribution or unsupported wording still blocks the save. Application context describes this rule. Repository changes take effect in the installed companion only after the integration owner builds, packages, installs, and retests the updated runtime.


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

Artifact basenames are `recruiters-rip-companion-3.4.6-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-source-baseline.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. `job-screening-prompt.txt` contains the screening rubric; 3.4.3 clarifies routine competency inference without changing its dimensions or weights. The app icon and source were migrated from the JobStash prototype; no separate third-party icon license was supplied. CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
