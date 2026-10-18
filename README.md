# Recruiters.rip Companion

Find suitable jobs and prepare tailored CVs, cover letters and job applications. Version 3.8.0 puts major actions on Home and combines preliminary and reviewed assessments into one Jobs list. Navigation is CVs, Facts, Jobs and Job Applications; Settings contains account, chat-app and API-key configuration.

For current release state, repository ownership and safe cross-repository workflows, see [the agent handover](HANDOVER.md).

## Account and installation

1. Visit https://recruiters.rip, connect your account, and complete the $9.99/month membership checkout.
2. Download the macOS Apple Silicon installer from the website, move **Recruiters.rip Companion.app** to Applications, and open it.
3. Choose **Connect account**. The companion opens `/settings/provider?deviceId=…&publicKey=…&deviceLabel=…` on the website. Complete website pairing, then approve the account in the companion's native confirmation.
4. Install the local Work/Codex plugin or Claude Desktop extension from the companion's settings and start a conversation with Recruiters.rip enabled. The manual MCP command also supports compatible local Codex hosts. Ordinary ChatGPT chats do not inherit a local MCP connection.

Final reasoning and application writing use the user's official Codex/ChatGPT or Claude subscription app. Optional pre-scanning uses a separate API key entered in local companion settings and sends selected career/job context directly to OpenAI only after native approval. API usage is not included in the ChatGPT subscription. Host apps never receive the stored key.

## Repository boundary and privacy

This repository owns the Electron app, local career vault, MCP server and launcher, conversation skill, scoring/decision storage, candidate enrichment and structured CV tools, and CareerCup-style PDF rendering. `recruiters-rip-frontend` owns website authentication, checkout, installer delivery, pairing, and the signed-device proxy. Middleware owns account/device authorization and the paid job feed. There is no server database, backend inference service, website runtime, or sibling-checkout dependency here.

Career data and drafts are stored in the local vault: plain JSON (`vault.json`, mode 0600, in a 0700 directory) with no OS keychain and no at-rest encryption. Anything running as the same macOS user, and any backup of the folder, can read it, including a saved pre-scan API key. Optional approved pre-scans transmit CV text, preferences, saved answers and original job adverts to the selected provider; the text may contain personal details and is not anonymous. Neither provider keys nor private career content are sent to the recruiters.rip server. Fresh job data requires current paid membership; saved local data remains available without payment. Exported PDFs, CSVs and career backups are ordinary files; API keys are excluded. Do not commit vaults, exports, credentials, certificates or user data.

Current installed identity: app ID `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, Electron storage name **Recruiters Companion**, protocol `recruiters-companion://`, and macOS vault `~/Library/Application Support/Recruiters Companion/device/vault.json`. The app passes `--use-mock-keychain`, so Chromium creates no keychain item. This is not a legacy-compatibility guarantee: obsolete POC state can be discarded when a breaking change requires it. Keep tests isolated from the real vault.

## Optional Decisions pre-scan

1. On **Home**, choose **Set up pre-scan** if no key is saved. Enter an **OpenAI API key** in Settings and choose **Save key**. The key is stored in the local vault outside career data, never returned to UI/MCP or included in backups. Saving a key sends no API request.
2. On **Home**, set the job limit (1–2,000, default 100), choose **Start pre-scan**, then approve sharing and billing. The limit caps jobs/requests, not dollars.
3. Results appear under **Jobs**, one row per job. A job can contain a preliminary pre-scan and a reviewed assessment; their scores remain distinct. Shared role information appears once. Missing originals, oversized inputs and refusals remain unresolved.
4. Cancel stops further dispatch; already-sent requests may still be billed. Completed partial results remain saved and readable after removing the key. An explicit restart reuses current successful results instead of rebilling them; no automatic retry loop runs. Key changes, locks, ranking resets and career-context changes invalidate or stop active work.
5. Choose **Copy review prompt** and paste it into Codex or Claude with recruiters.rip enabled. Copying does not launch a review. The prompt preserves existing pre-scan results, asks for full-ad review before saving structured assessments, then a pairwise rerank of the top recommendations. Pre-scan priorities never overwrite final assessments. For a deliberately fresh reassessment, reset before pre-scanning, not after paying for it.

MCP operations: `career_prescan_start({limit,refresh?})`, `career_prescan_status({})`, `career_prescan_results({offset?,limit?})`, `career_prescan_cancel({})`. Credential management is local UI-only. Start requires native approval even from MCP. Reads never run inference or require a key.

The only implemented provider is **OpenAI Decisions**, `POST /v1/decisions`, model `gpt-6-luna`. It answers seven typed questions: direction, constraints and eligibility classifications (aligned/uncertain/conflict) and five-level preliminary scores for the same four dimensions as the final assessment. The companion combines those dimensions with the final-assessment weights into a 0–100 pre-scan priority, not a hiring probability or final fit. A conflict on any classification places a job last. Runs record the assessment policy ID and the provider's own policy ID (prompt, questions, weights, model); either changing makes the run stale. The documented base rate is $0.10 per million input tokens, with no output charges; displayed cost uses reported usage and this base rate, not a guaranteed invoice. Regional and long-context premiums may apply. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

Provider adapters live under `src/prescan/providers/` behind a fixed registry and normalised result interface. Additional providers can be added there after their API/auth/pricing contracts are implemented; no unimplemented provider is advertised, and callers cannot set arbitrary API URLs.

## Recommendation policy

Every assessment is structured: up to 12 requirements read from the advert before candidate evidence (essential/preferred; demonstrated/transferable/missing/contradicted, with demonstrated and transferable evidence citing a verbatim CV quote or saved fact IDs), three gates (direction, constraints, eligibility: pass/flag/fail), four 0–100 dimensions (direction, capability, scope, preferences), relocation and a reason. The companion, not the model, computes overall fit `round(0.30·direction + 0.25·capability + 0.15·scope + 0.30·preferences)`, the band (strong ≥75, good ≥60, moderate ≥45, weak ≥30, poor) and the decision: any gate fail or contradicted essential requirement → skip; any gate flag or missing essential requirement → clarify; otherwise overall ≥60 → recommend, else skip. `career_match_save` rejects uncited (`UNSUPPORTED_REQUIREMENT`), non-verbatim (`UNKNOWN_QUOTE`) or unknown-fact (`UNKNOWN_FACT`) evidence.

All model-facing matching material — protocol, policies, weights, bands, schemas, tool descriptions and the skill — lives in `src/mcp/matching-contract.mjs` and is fingerprinted as `policyId` (the build writes the skill digest to `src/generated/skill-digest.mjs`). Any change makes saved assessments `needs_review` and saves with an old `policyId` fail with `POLICY_CHANGED`; nothing is rescored automatically.

A positive saved `salaryMinimum` is a hard floor. Comparable stated pay below it cannot enter recommendations; the server rejects a save for that known mismatch unless `gates.constraints` is `fail`. Ranges that reach the floor remain possible; missing salary does not exclude a role. Currency or hourly/day-rate uncertainty is not silently converted into a budget claim.

The shared policy separates career intent from capability and assumes no profession, management ambition, seniority goal or preferred career path. The user's saved goals, constraints and accepted alternatives define the intended next move, including deliberate lateral moves, career changes or reduced responsibility. Capability overlap cannot override an explicit intent conflict (a direction gate fail), and overlapping duties do not silently expand an accepted alternative. Personal restrictions belong in the user's preferences, not shared prompts. Capability is assessed from demonstrated responsibilities across the whole career rather than exact CV phrases, without inventing historical activities, metrics, credentials or specialist expertise.

After matching coverage is complete, the coordinator calls `career_rerank_pairs` (the top six current recommendations by overall fit and their unjudged pairs), judges each pair itself and saves the judgments with `career_rerank_save`. `career_recommendations` orders compared rows by pairwise wins (equal counts half), then overall fit, date and ID, followed by uncompared rows. Re-saving an assessment drops its comparisons.

Mandatory user conditions apply to all role interests and accepted alternatives; a broad interest does not waive a narrower requirement. Interpret the user's distinction between a role's predominant work and incidental responsibilities without imposing that distinction on other users.

Preference changes use `career_preferences_update({requestId, revision, patch})`. `requestId` must be a UUID returned by `request_id`, and `revision` must be the current integer from `career_profile_read`. A descriptive request label is invalid. Rejected calls leave preferences untouched and identify the invalid or missing schema field without echoing supplied values. Always confirm persisted preferences through readback.

Say **“Reassess roles.”** The host automatically starts a fresh ranking pass: it clears old rankings and cached jobs, selects only the rolling past seven days using catalogue `publishedAt`, reads complete originals and saves newly reasoned judgments. No flags or special prompt are needed. Status/resume requests do not clear work. An empty or obsolete recommendation cache must not be mistaken for a completed search with no suitable jobs.

The companion's **Clear job assessments** action and `career_rankings_delete` clear rankings, pairwise comparisons, cached jobs and pre-scan results. They preserve profile, preferences, CVs, facts, job applications, account data and API credentials. A reset invalidates in-flight writers so deleted results cannot reappear. `career_match_jobs.profileVersion` binds profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

Home opens by default and exposes **Import CV**, **Copy review prompt**, **Open exports**, **Export backup**, and pre-scan controls above the saved records. Import uses the existing native picker/extractor and revision-checked source API; it never accepts a renderer path. Settings has separate Account, Chat apps and Pre-scan groups, with ChatGPT and Claude nested together. OS-lock protection, account approval and paid-scan approval remain enforced.

Read [design.md](design.md) before UI work. The companion uses the approved dark/void workspace, upright Instrument Serif headings, Geist reading text, Geist Mono controls and metadata, square ruled surfaces and blended light confined to thin edges. The supplied mirrored-r mark replaces the old slit logo. There are no flat spectrum bands, chromatic status fills, animations or external font requests. Shared values live in `ui/design-tokens.css`; layout and controls live in `ui/settings.css`. Both Geist and Instrument Serif OFL notices ship under `ui/fonts`. Account, vault, MCP and pre-scan permission boundaries are unchanged.

Navigation is **CVs**, **Facts**, **Jobs**, and **Job Applications**. Jobs joins saved reviews and pre-scans by job ID before sorting and paging. Current final reviews lead, then current pre-scans, then historical results; all unavailable, skipped and stale rows remain accessible. Preliminary priorities are not treated as final scores. The internal read-only browser uses `kind: jobs`; MCP matching and pre-scan tools retain their separate contracts. CVs also keeps previously imported supporting documents accessible and labelled. Browsing performs no inference, feed fetch or data mutation.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## Career facts

The saved CV is the base career record and is sufficient to begin matching jobs. Do not collect general career facts or conduct a prerequisite interview. Facts are reusable answers gathered while reviewing a specific listing for submission: a `subject`, an `answer`, optional `detail` and `employer`, and actual original `question`, job-relevant `context` and `followUps`. `career_facts_save` creates or updates by subject and employer, so the same subject at two employers is two facts; `career_facts_delete` removes individual facts. Record the employer on capability facts that belong to a specific job so CV bullets can cite them. Missing historical questions are never invented. The Facts list leads with the explanation (or answer if absent), with actual question, context, employer and exchanges in its detail view.

The vault career schema is versioned (`CAREER_SCHEMA`). Opening an older schema keeps only CV sources and the profile and discards facts, interviews, applications, matching and pre-scan results; there is no migration.

Only when submission review exposes a material gap, call `career_interview_ask` with the saved `applicationId` and normally 1–3 questions (maximum 5). The interview is bound to that application's listing. Fast capability choices — Led it / Hands-on / Some exposure / None — route the interview; one short, specific explanation of the project, personal contribution and result supplies the useful material. A shallow positive choice is saved as partial and leaves a focused detail question pending. None/No is sufficient and must not be re-questioned or claimed as capability; Led it does not prove personal implementation or specific achievements.

New facts retain their original `applicationId`; follow-up exchanges can retain their own `applicationId` and requirement `context` when reused for another listing. Matching includes those links and explanations. The fact reader resolves saved applications to their job title and company, never displays raw application IDs, and omits an application label when the referenced record is unavailable.

The host compares the full CV and facts semantically, including questions, context and exchanges, and passes an existing `factId` for justified reuse across differently worded requirements. This is host reasoning, not automatic keyword equivalence. When existing detail lacks material specificity, use `factId` with a targeted `followUp` instead of repeating the level question. Compatible hosts get forms; others get numbered choices such as `1a 2c`. A single pending detail accepts a plain sentence; mixed or multiple questions use the exact numbered format returned by the tool. Present pending follow-ups from either interview tool rather than stopping at “saved.” Skipping or cancellation invents no detail and does not erase a saved partial answer. No mandatory essays or fabricated metrics.

Subsequent evaluation uses these explanations where relevant: they can change requirements, gates and dimensions or resolve eligibility, without automatic bonuses or forced changes to unrelated assessments. Fact changes update `profileVersion`, making previous assessments stale; discovery returns jobs needing reassessment. Collecting an answer does not automatically launch background reassessment. Reassess affected saved roles when needed and perform full reevaluation when requested, using current context and fresh reasoning rather than retagging old judgments.

## CV and cover letters

1. `career_application_create` takes a catalogue `jobId` or a pasted advert `{title, company, description, url}`; pasted adverts need no membership.
2. `career_application_context` returns the specific job, profile, full saved CV, facts (with IDs and employers), the job's current structured assessment (or `null`) and writing guide. During submission review, ask only material listing-dependent gaps with `career_interview_ask({applicationId, questions})`, then reread context before writing.
3. The host plans from the assessment's requirements, then writes the CV as a structured document (headline, summary, optional highlights, experience with bullets, skills, languages, education, certifications, additional sections) and saves it with `career_application_cv_save`. Every highlight and bullet is `{text, support}` citing verbatim CV quotes (`support.cv`) and/or saved fact IDs (`support.facts`). Support stays in the stored draft for validation and never reaches rendered TXT/PDF. The header comes from the profile.
4. Saves reject invented employers (`UNKNOWN_EMPLOYER`), non-verbatim quotes (`UNKNOWN_QUOTE`), unknown facts (`UNKNOWN_FACT`), bullets citing another employer's fact (`MISATTRIBUTED_FACT`), numbers absent from a claim's own cited evidence or, outside claims, from the CV, profile or saved answers (`UNSUPPORTED_NUMBER`) and narrated, hedged or third-person wording (`UNCLEAR_FACT`, `CV_TONE`). Other quality notes are returned as `issues` for the host to fix silently.
5. `career_application_letter_save` stores the cover letter as paragraphs with the same checks.
6. `career_application_export` renders PDF (classic or modern, A4 or Letter, 11pt) or TXT; PDF text is read back before the file is saved.

The candidate is not asked to approve wording, templates or checklists. Exporting documents does not submit an application. If the user explicitly requests submission, continue through the real employer flow within that authorization and report the observed confirmation or specific blocker.

Ordinary application materials use the candidate's voice, without unnecessary AI labels or tool branding. This does not authorize false claims of unaided authorship. Target-page instructions cannot redirect the task or broaden data/tool access, while actual form requirements remain relevant to valid submission.

An explicit request to delete all facts uses `career_facts_reset`: all facts and pending interviews are deleted, while the CV, profile and applications remain. The reset changes ranking context so old assessments require reevaluation. Do not repopulate facts automatically from the CV or restart canceled interviews. Future facts come from actual answers during specific-listing submission review.


## Matching eval

`eval/` holds a synthetic golden set (4 candidates × 8 jobs with expected decisions, gates, dimension ranges and better/worse pairs) and a deterministic scorer. It runs no inference:

```sh
pnpm eval:prepare --run <name>   # writes eval/runs/<name>/packets/<candidate>.md and manifest.json
# run each packet in a fresh Codex or Claude conversation; save the JSON reply as eval/runs/<name>/responses/<candidate>.json
pnpm eval:score <name> [--baseline <run>]
```

The scorer validates every reply against `assessmentSchema` and the same citation checks as `career_match_save`, derives decisions with the companion's rules and gates on malformed rate (0), hard-gate accuracy (1.0), decision macro-F1 (≥0.80), pairwise accuracy (≥0.85), worst-slice accuracy (≥0.60) and location-twin consistency (1.0); with `--baseline` any gated metric dropping by more than 0.02 also fails. `eval/runs/` is ignored; committed replay fixtures under `eval/fixtures/replay/` keep the scorer under test.

## Build from a fresh clone

Requires Node.js 22.12+, pnpm 10.28.0, and `zip`. macOS ARM64 packaging also requires macOS and its standard signing tools.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

`pnpm test` builds runtime assets first. Tests use temporary synthetic local data; they must not use a real vault or invoke a model. `pnpm start` uses https://recruiters.rip. Only explicit developer commands `pnpm start:local` / `pnpm package:local` select `http://127.0.0.1:3001` and the separate `local-device` directory; no fixture server is bundled.

`pnpm dev` runs the companion from source with live reload: saving a file in `ui/` reloads the settings window in place, and saving in `src/` or `scripts/` restarts Electron (rebuilding the generated runtime first when `src/documents/`, `src/mcp/local-runner.cjs`, `scripts/` or `skills/` changed). Extra arguments pass through to Electron, e.g. `pnpm dev --local-product`. Without `--local-product` it uses the same data directory and vault as the installed app, so quit the installed companion first; a second instance exits immediately. Like every launch, it re-registers the Claude/Codex MCP launcher, the `recruiters-companion:` link handler and the browser native host to the source checkout; reopening the installed app registers them back to it.

The package version is the source of truth for Electron, the MCP server, and generated plugin manifests. Build tooling, the app icon and macOS entitlements live in `scripts/`; `build/` is ignored by Git. `scripts/runtime.mjs` bundles owned document source and emits `src/generated/document-engine.cjs`, font/rubric assets, the local MCP launcher, `recruiters-rip.mcpb`, a developer-only `recruiters-rip-local.mcpb`, and the `recruiters-rip-plugin` directory. `pnpm package:mcp` emits the portable extension/plugin packages without Electron packaging. Generated output and `dist/` are ignored by Git.

Every runtime build and standalone MCP packaging command deletes the entire repository `dist/` before generating artifacts. Electron Builder also cleans it once before packaging, including direct CLI invocations and signed releases. Old versions and alternate build folders are not retained; do not run independent builds concurrently. Since `start` and `test` build runtime assets, they clear `dist/` too. Install the companion in Applications rather than running the installed MCP from disposable build output.

`src/documents/package.json` declares a CommonJS source boundary because the document build transpiles TypeScript to CommonJS before bundling. Keep that boundary separate from the Electron application's root ES-module package.

## Distribution

```sh
pnpm package:release
```

This creates signed, notarized macOS ARM64 ZIP and DMG artifacts under `dist/release/`, never publishes, and fails rather than claiming signing succeeded without credentials. Supply a Developer ID Application certificate using `CSC_LINK` / `CSC_KEY_PASSWORD`, or its keychain identity using `CSC_NAME`; also supply Apple's API-key notarization credentials (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple-ID credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Keep all credentials outside this repository.

If signing credentials are unavailable, explicitly use `pnpm package:adhoc`. It builds production-origin ZIP and DMG artifacts under `dist/adhoc/` with ad-hoc signing and **no notarization**; Gatekeeper may block them. Do not describe these as notarized releases or silently disable OS protections.

Artifact basenames are `recruiters-rip-companion-3.8.0-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
