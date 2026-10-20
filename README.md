# Recruiters.rip Companion

The companion keeps CVs, career facts, captured jobs and application drafts on your computer. Claude or Codex handles assessment and writing. The Chrome extension saves job adverts and prepares reviewed values for application forms.

See [AGENTS.md](AGENTS.md) for ownership and safety boundaries, and [design.md](design.md) for the shared interface rules.

## Install and connect

The desktop preview supports macOS on Apple Silicon. Use Claude Desktop or ChatGPT desktop with local Work/Codex support.

### Run from source

```sh
git clone https://github.com/jobstash/recruiters-rip-companion.git
cd recruiters-rip-companion
pnpm install --frozen-lockfile
pnpm start
```

Use Node 22.12 or newer and pnpm 10.28.0. `pnpm start` builds the local tools, document engine and Chrome extension before opening Electron. For the isolated development product, run `pnpm start:local`.

Packaged builds are distributed through published releases in the [official repository](https://github.com/jobstash/recruiters-rip-companion/releases). Move **Recruiters.rip Companion.app** to Applications and open it. An ad-hoc preview is unnotarized; production release packaging requires the signing and notarization credentials described below.

### Connect your account and AI app

1. Choose **Connect account**. Sign in in the browser window it opens, create the pairing request, and choose **Confirm account on this computer**.
2. In the companion, approve the named account. Current membership enables the platform job feed; captured jobs and saved local records work without feed access.
3. In **Settings → Chat apps**, choose **Install ChatGPT plugin** or **Install Claude extension**. Start a new local task or conversation with Recruiters.rip enabled.
4. On Home, choose **Import CV**. The companion extracts PDF, DOCX or text locally; your connected agent reads the source and builds the profile.

Model authentication stays in your AI app. Normal setup collects no OpenAI/Anthropic API key or chat login token. The optional Decisions key is entered only in companion settings. Scanned/image-only CVs need readable text; import does not perform model inference or OCR.

## Capture jobs and prepare form values

1. In **Settings → Chat apps → Chrome extension**, choose **Open extension folder**.
2. In Chrome 125+, open **Extensions → Manage extensions**, enable **Developer mode**, choose **Load unpacked**, and select that folder.
3. Open an advert or listing page, click the Recruiters.rip toolbar icon, choose **Capture jobs**, select the entries and choose **Save selected jobs**.

Captures appear in **Jobs** before assessment. They live outside the replaceable matching cache and survive ranking resets. Detail/apply URL aliases deduplicate repeat captures; page provenance alone never merges different jobs. A listing card without the full advert remains **Needs full advert**: open the original and capture it before asking for assessment or a CV. Publication dates remain unknown unless the page provides one.

For an application page, choose **Inspect form → Prepare values** and approve sharing with that destination in the companion. Review, edit and select values, then copy or fill them. Populated, protected and unsupported controls remain manual. Navigation, replaced controls or changed radio groups invalidate the inspected target; the extension never clicks Submit or uploads a file.

Optional Decisions mapping chooses from known profile values, qualified saved answers and agent-staged text. It does not write new application prose. Use **Copy agent prompt for unanswered text** to let the connected agent read the form with `career_form_read` and save answers with `career_form_answers_save`, then prepare again. Staged answers are bound to the form snapshot and current career evidence.

MCP job imports use `career_job_import`; `career_jobs` lists captures. `career_job_read` and `career_application_create({jobId})` resolve local originals without a platform request. Use `career_match_jobs({localOnly:true})` to assess complete captures offline; the selected publication range applies only to platform jobs.

Build unpacked extensions with `pnpm build:browser`. Production and local builds have separate IDs/native hosts and use only `nativeMessaging`, `activeTab`, `scripting` and `sidePanel`. Source, fonts and brand assets close over this repository; no sibling checkout is needed.

## Public releases and updates

In **Settings → Updates**, choose **Check for updates**, then **Download update** and **Install update**. Checks use the official repository's latest stable published release without a GitHub token. No release means unavailable, not up to date.

The release must contain `recruiters-rip-companion-<version>-mac-arm64.zip` with a GitHub SHA-256 digest or a matching entry in `SHA256SUMS.txt`. After packaging, `pnpm release:metadata <output-directory>` generates the checksum file from the actual root-package-version ZIP and optional DMG. Publishing is a separate operator action; build commands never publish or change repository visibility.

Downloads are bounded and verified before installation. A packaged production app requests native approval, rejects installation while paid work is active, drains accepted mutations and vault writes, stages the signed bundle and replaces only its own installed app. The helper retains the previous app until the new version confirms startup and rolls back failed swaps/launch commands. An unconfirmed launch is not reported as installed.

Source runs and local-product builds use verified manual installer handoff rather than replacing a checkout or changing product channels. Unwritable installation directories also use the manual path. Neither flow migrates or deletes career data, changes the app/storage identity, or accesses signing credentials. Update state is separate from career storage; local and production receipts are isolated.

## Repository boundary and privacy

This repository owns the Electron app, Chrome extension, local career/job/form storage, MCP tools, document engine and updater. `recruiters-rip-frontend` owns website authentication, checkout, preview hosting, pairing UI and the signed-device proxy. Middleware authorizes accounts/devices and current paid feed access. Builds and runtime never import a sibling checkout.

Local records use plain `vault.json` (0600) in a private directory (0700), without keychain storage or at-rest encryption. The connected agent reads career context through MCP. Approved API requests send their stated context directly to OpenAI; approved form preparation releases selected values to the extension. The recruiters.rip server receives neither career content nor API keys. Membership gates the platform feed, not captured jobs or saved records. Backups and exported documents are ordinary files; API keys are excluded. Keep vaults, exports, credentials, certificates and user data out of source control.

Current installed identity: app ID `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, Electron storage name **Recruiters Companion**, protocol `recruiters-companion://`, and macOS vault `~/Library/Application Support/Recruiters Companion/device/vault.json`. The app passes `--use-mock-keychain`, so Chromium creates no keychain item. This is not a legacy-compatibility guarantee: obsolete POC state can be discarded when a breaking change requires it. Keep tests isolated from the real vault.

Account connection returns through a short-lived HTTP listener bound only to `127.0.0.1` on a random port, so source runs and installed apps do not depend on macOS selecting the right custom-protocol handler. The return carries its one-time state and pairing payload in the URL fragment, which the local page removes from browser history before sending a same-origin POST. Foreign origins, rebound hosts, invalid state and replayed requests are rejected. Only native account approval and successful signed platform activation produce success; the browser receives no career data or API key. The listener closes after five minutes, when starting another connection, on OS lock or on quit. Existing `recruiters-companion://` entrypoints remain supported.

## Optional Decisions pre-scan

Start in Codex or Claude with **“Use the recruiters.rip skill to find me a job.”** The skill reads saved recommendations, career context and Decisions status first. If fresh catalogue review is needed, it recommends Decisions setup before reading full adverts or launching subscription workers. Missing keys are entered only in companion settings. The agent shows the full pending job count and **Cost ESTIMATE** before requesting sharing/billing approval. A blocked, cancelled or failed scan does not silently fall back to bulk LLM review. Subscription-only catalogue review requires an explicit opt-out and an agreed scope.

Pre-filtering has **no hard job-count cap**. The publication slider sets the scope: **Today, Yesterday, Past 3 days, Past week, Past 2 weeks, Past month, Whole catalogue**. Today/yesterday follow the companion's local calendar; the other dated ranges roll back 3, 7, 14 or 30 days. Whole catalogue has no lower date cutoff. The selected range also applies to final matching and recommendations, not just the preview. Current successful Decisions results are reused. Metadata pagination, concurrency and protocol batches control throughput, not coverage. The subscription app reviews promising jobs in that order without a fixed shortlist cutoff.

1. On Home, expand **Optional job pre-filtering**. To configure its shared key, open **Settings → Optional Decisions API → Configure OpenAI Decisions API**, enter your OpenAI key and choose **Save Decisions key**. This same optional key supports known-value form mapping; normal agent work needs none. Unsaved input clears on save, collapse or navigation. Saving a key sends no API request.
2. Choose the publication range with the slider. Companion requests the range's exact scope count from middleware and shows how many jobs still need Decisions alongside **Cost ESTIMATE**. Choose **Start pre-filtering**, then approve sharing and billing for that snapshot. There is no job-limit input. Changing the range stops active work without starting another scan.
3. Results appear under **Jobs**, one row per job. A job can contain a preliminary pre-scan and a reviewed assessment; their scores remain distinct. Shared role information appears once. Missing originals, oversized inputs and refusals remain unresolved.
4. Cancel stops further dispatch; already-sent requests may still be billed. Completed partial results remain saved and readable after removing the key. An explicit restart reuses current successful results instead of rebilling them; no automatic retry loop runs. Key changes, locks, ranking resets and career-context changes invalidate or stop active work.
5. Choose **Copy review prompt** and paste it into Codex or Claude with recruiters.rip enabled. Copying does not launch a review. The prompt preserves existing pre-scan results, asks for full-ad review before saving structured assessments, then a pairwise rerank of the top recommendations. Pre-scan priorities never overwrite final assessments. For a deliberately fresh reassessment, reset before pre-scanning, not after paying for it.

The controls and native approval show the number of jobs going through Decisions and a rough **Cost ESTIMATE**. The estimate uses a previous input-token average where available, otherwise a rough per-job assumption, multiplied by the provider's input-token rate. Native approval retains the provider/model, shared data classes and separate API billing facts without extra disclaimer copy.

MCP operations: `career_prescan_range_set({publicationRange})`, `career_prescan_preview({publicationRange?,refresh?})`, `career_prescan_start({publicationRange?,refresh?})`, `career_prescan_status({})`, `career_prescan_results({offset?,limit?})`, `career_prescan_cancel({})`. Range changes persist locally and never start inference. Preview fetches middleware catalogue metadata without provider calls or persistent career changes; start recomputes the scope before native approval and scans that snapshot. Signed `matching_catalogue` requests carry `{publicationRange,since,until,offset?,countOnly?}` and receive exact SQL `total`, transport-paged `jobs`, `nextOffset` and echoed `publicationWindow`. Every metadata page is consumed; transport/result pagination never caps scan coverage. Credential management remains local UI-only.

The only implemented provider is **OpenAI Decisions**, `POST /v1/decisions`, model `gpt-6-luna`. It answers seven typed questions: direction, constraints and eligibility classifications (aligned/uncertain/conflict) and five-level preliminary scores for the same four dimensions as the final assessment. The companion combines those dimensions with the final-assessment weights into a 0–100 pre-scan priority, not a hiring probability or final fit. A conflict on any classification places a job last. Runs record the assessment policy ID and the provider's own policy ID (prompt, questions, weights, model); either changing makes the run stale. The documented base rate is $0.10 per million input tokens, with no output charges; running/completed **Cost ESTIMATE** uses reported usage and this rate. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

Provider adapters live under `src/prescan/providers/` behind a fixed registry and normalised result interface. Additional providers can be added there after their API/auth/pricing contracts are implemented; no unimplemented provider is advertised, and callers cannot set arbitrary API URLs.

## Recommendation policy

Every assessment is structured: up to 12 requirements read from the advert before candidate evidence (essential/preferred; demonstrated/transferable/missing/contradicted, with demonstrated and transferable evidence citing a verbatim CV quote or saved fact IDs), three gates (direction, constraints, eligibility: pass/flag/fail), four 0–100 dimensions (direction, capability, scope, preferences), relocation and a reason. The companion, not the model, computes overall fit `round(0.30·direction + 0.25·capability + 0.15·scope + 0.30·preferences)`, the band (strong ≥75, good ≥60, moderate ≥45, weak ≥30, poor) and the decision: any gate fail or contradicted essential requirement → skip; any gate flag or missing essential requirement → clarify; otherwise overall ≥60 → recommend, else skip. `career_match_save` rejects uncited (`UNSUPPORTED_REQUIREMENT`), non-verbatim (`UNKNOWN_QUOTE`) or unknown-fact (`UNKNOWN_FACT`) evidence.

All model-facing matching material — protocol, policies, weights, bands, schemas, tool descriptions and the skill — lives in `src/mcp/matching-contract.mjs` and is fingerprinted as `policyId` (the build writes the skill digest to `src/generated/skill-digest.mjs`). Any change makes saved assessments `needs_review` and saves with an old `policyId` fail with `POLICY_CHANGED`; nothing is rescored automatically.

A positive saved `salaryMinimum` is a hard floor. Comparable stated pay below it cannot enter recommendations; the server rejects a save for that known mismatch unless `gates.constraints` is `fail`. Ranges that reach the floor remain possible; missing salary does not exclude a role. Currency or hourly/day-rate uncertainty is not silently converted into a budget claim.

The shared policy separates career intent from capability and assumes no profession, management ambition, seniority goal or preferred career path. The user's saved goals, constraints and accepted alternatives define the intended next move, including deliberate lateral moves, career changes or reduced responsibility. Capability overlap cannot override an explicit intent conflict (a direction gate fail), and overlapping duties do not silently expand an accepted alternative. Personal restrictions belong in the user's preferences, not shared prompts. Capability is assessed from demonstrated responsibilities across the whole career rather than exact CV phrases, without inventing historical activities, metrics, credentials or specialist expertise.

After matching coverage is complete, the coordinator calls `career_rerank_pairs` (the top six current recommendations by overall fit and their unjudged pairs), judges each pair itself and saves the judgments with `career_rerank_save`. `career_recommendations` orders compared rows by pairwise wins (equal counts half), then overall fit, date and ID, followed by uncompared rows. Re-saving an assessment drops its comparisons.

Mandatory user conditions apply to all role interests and accepted alternatives; a broad interest does not waive a narrower requirement. Interpret the user's distinction between a role's predominant work and incidental responsibilities without imposing that distinction on other users.

Preference changes use `career_preferences_update({requestId, revision, patch})`. `requestId` must be a UUID returned by `request_id`, and `revision` must be the current integer from `career_profile_read`. A descriptive request label is invalid. Rejected calls leave preferences untouched and identify the invalid or missing schema field without echoing supplied values. Always confirm persisted preferences through readback.

Say **“Reassess roles.”** The host resolves Decisions setup/approval, then performs one ranking reset before any paid pre-filtering. Discovery uses the selected publication range and complete originals; status/resume requests do not clear work. Default scope is Past 3 days, but explicitly broader scopes are never silently clipped. An empty or obsolete cache is not a completed search with no suitable jobs.

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

Artifact basenames are `recruiters-rip-companion-<package.json version>-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. Publish the matching production Chrome extension ZIP with it. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
