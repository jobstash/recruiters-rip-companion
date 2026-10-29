# Recruiters.rip Companion

The companion keeps CVs, career facts, captured jobs and application drafts on your computer. Claude or Codex handles assessment and writing. Chrome and Firefox extensions save job adverts and prepare answers for native paste.

See [AGENTS.md](AGENTS.md) for ownership and safety boundaries, and [design.md](design.md) for the shared interface rules.

## Install and connect

Companion targets macOS Apple Silicon, Windows x64 and Linux x64. Connect a supported Claude or Codex desktop app or CLI. The available host determines computer-use support; Companion does not provide those tools.

### Run from source

```sh
git clone https://github.com/jobstash/recruiters-rip-companion.git
cd recruiters-rip-companion
pnpm install --frozen-lockfile
pnpm start
```

Use Node 22.12 or newer and pnpm 10.28.0. `pnpm start` builds the local tools, document engine and Chrome/Firefox extensions before opening Electron. For isolated development, run `pnpm start:local`.

Install only artifacts actually published in the [official releases](https://github.com/jobstash/recruiters-rip-companion/releases):

| Platform | Installer | Installation |
| --- | --- | --- |
| macOS Apple Silicon | ZIP or DMG | Move **Recruiters.rip Companion.app** to Applications. Ad-hoc builds are not notarized. |
| Windows x64 | NSIS `.exe` | Run the per-user installer. Unsigned builds may trigger SmartScreen; no administrator-wide native-host registration is required. |
| Linux x64 | `.AppImage` | Save the file, make it executable and run it in a graphical desktop session. Install the distribution's FUSE 2 compatibility library and allow access to `/dev/fuse`; do not disable the Chromium sandbox globally. |

The website shell installer is for macOS only. Firefox source ZIPs are development builds, not permanently installable signed add-ons.

### Connect your account and AI app

1. Choose **Connect account**. Sign in in the browser window it opens, create the pairing request, and choose **Confirm account on this computer**.
2. In the companion, approve the named account. Current membership enables the platform job feed; captured jobs and saved local records work without feed access.
3. In **Settings → Chat apps**, install the Codex plugin or configure Claude. Detected CLI hosts use an application workspace and a visible terminal; press Enter there to send the prepared request. Desktop hosts open a prefilled conversation. Start a new task with Recruiters.rip enabled after updating the plugin.
4. On **Me**, choose **Import CV**. The companion extracts PDF, DOCX or text locally; your connected agent reads the source and builds the profile.

Model authentication stays in your AI app. Normal setup collects no OpenAI/Anthropic API key or chat login token. The optional Decisions key is entered only in companion settings. Scanned/image-only CVs need readable text; import does not perform model inference or OCR.

## Capture jobs and prepare form values

1. Keep Companion open. In **Settings → Chat apps**, choose the extension folder for your browser.
2. **Chrome 125+:** open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the Chrome folder.
3. **Firefox 128+:** for development, open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, then select `manifest.json` in the Firefox folder. This installation lasts until Firefox closes. Permanent distribution requires a Mozilla-signed XPI; the build command does not obtain signing credentials or publish to AMO.
4. On the job or application tab, click the **rr** toolbar icon. This grants temporary access and opens Chrome's side panel or Firefox's sidebar. Selecting a browser sidebar alone does not grant page access. **Read page** captures public job context and prepares known form answers without all-sites permissions.

Captures appear in **Jobs** before assessment. They live outside the replaceable matching cache and survive ranking resets. Detail/apply URL aliases deduplicate repeat captures; page provenance alone never merges different jobs. A listing card without the full advert remains **Needs full advert**: open the original and capture it before asking for assessment or a CV. Publication dates remain unknown unless the page provides one.

**Read page** uses explicit profile values first, then lets Companion's Decisions API select source-backed contact details from the saved CV and other known answers. It chooses existing text, including supported name components, rather than inventing facts or writing new prose. No approval dialog is shown; credentials stay in Companion. Only details still missing or uncertain become questions. **Save details** stores explicit answers locally for later applications, preserving unrelated profile values. Values typed on an employer's page are not silently collected. Job-specific prose remains the connected agent's work.

When the extension starts a read without a configured Decisions key, Companion opens **Settings → Optional Decisions API** and focuses the key field before any preparation request. After saving the key, choose **Read page** again. With a configured key, preparation and the paid API request run immediately.

Clicking or tabbing into an inspected empty text control puts its prepared answer on the system clipboard; ⌘V and undo are native browser operations. **Review answers** holds secondary edit and copy controls. **For this job** shows the exact application's documents and written-answer status. Personal summaries and cover letters are written by the connected agent for that application, not saved as generic profile details. The default panel omits technical IDs, file paths and repeated failure explanations; populated/protected controls stay manual.

An inspected page is not a prepared page: the panel shows readiness explicitly and hides the answer review until preparation completes. In source builds, panel/worker build IDs must match; an outdated worker offers **Reload extension** rather than displaying a mixture of old behavior and new controls.

Moving between fields by click or Tab refreshes the clipboard for each prepared answer, including multiline text. Element-to-element blur is not treated as leaving the browser window; native paste, undo and redo remain intact. Browser verification covers all seven demo fields in sequence, rather than testing the name alone.

Clicking an already focused empty control refreshes its prepared answer too, including after an agent updates it. Clearing a mistaken paste in an eligible prepared control refreshes the clipboard without changing focus; the next native ⌘V pastes that control's answer. Existing text is never replaced automatically. If a control was already populated when the page was read, clear it and read the page again before preparing its answer.

### Apply with Codex or Claude

1. Ask your connected agent to prepare or apply to a specific job. It creates or reuses that job's saved application, reads the full advert and current career context, and saves and exports the tailored CV and cover letter. Asking for documents alone does not ask it to submit.
2. For applying, the agent opens the saved application link in your own Chrome. It needs its host app's computer-use tools to see the screen and use the mouse, keyboard and file picker. Companion does not provide those tools. If the host lacks them, the agent tells you what is missing; your documents and prepared answers remain available for you to use.
3. Use the black **rr** toolbar icon and **Read page** to prepare known answers. The agent saves job-specific writing in Companion. It enters answers with the host's mouse and keyboard, including ordinary paste from the prepared clipboard, and attaches the exported PDFs through the site's upload button and your computer's file picker. It checks the values and attachment names shown on the page. Unknown or protected answers and security challenges remain yours to handle.
4. Before working on a saved application, and again immediately before clicking the final **Submit**, the agent rereads its current context from Companion. A job you blocked stays blocked, including in an already-open browser tab. Changed documents or answers must be brought up to date before proceeding.
5. If your task includes submitting, the agent uses the host's mouse or keyboard and checks the actual result on the page. A click, navigation or generic thanks message is not a receipt. Rejection, a CAPTCHA problem, validation errors or an unclear result are reported as such, never as a completed application. It does not automatically retry or send a duplicate.

Application input uses ordinary browser controls, not scripts that fill fields, press buttons or send application data directly. This is for input compatibility, not avoiding detection; neither Companion nor native input guarantees acceptance by a site's anti-spam system. Host access permissions still apply.

Decisions selects known values; it does not write application prose. **Prepare this application** opens Claude Code or Codex with a prefilled local request. The user sends that prompt; the agent reads the complete original advert, writes the tailored CV/cover letter and job-specific form answers, and saves them through Companion. The panel refreshes saved status and releases newly ready form values automatically. Opening a host is not reported as generation or submission.

MCP job imports use `career_job_import`; `career_jobs` lists captures. `career_job_read` and `career_application_create({jobId})` resolve local originals without a platform request. Use `career_match_jobs({localOnly:true})` to assess complete captures offline; the selected publication range applies only to platform jobs.

`pnpm build:browser` builds four folders: Chrome `browser-extension/dist/{production,local}` and Firefox `browser-extension/dist/{firefox-production,firefox-local}`. Each build includes fonts and brand assets. Chrome uses `sidePanel`; Firefox uses `sidebarAction` and `browser_specific_settings.gecko.id`. Both use `nativeMessaging`, `activeTab`, `scripting` and `clipboardWrite`, with separate production/local native hosts. Firefox has no website external-message bridge; account pairing uses Companion's loopback flow. To create archives, run `node browser-extension/build.mjs production --browser=chrome --zip` or `--browser=firefox --zip`.

## Public releases and updates

In **Settings → Updates**, choose **Check for updates**, then **Download update** and **Install update**. Checks use the official repository's latest stable published release without a GitHub token. No release means unavailable, not up to date.

The updater selects the exact artifact for the current OS and architecture: `recruiters-rip-companion-<version>-mac-arm64.zip`, `-win-x64.exe`, or `-linux-x64.AppImage`. A GitHub SHA-256 digest or matching `SHA256SUMS.txt` entry is required. `pnpm release:metadata <output-directory>` hashes actual versioned artifacts; publishing remains a separate operator action.

Downloads are bounded and checksum-verified before installation. macOS packaged production installs retain the existing bundle identity/signature checks, native approval, write draining and rollback until the new app confirms startup. Windows hands off the verified NSIS installer; Linux reveals the verified executable AppImage for the user to quit Companion and replace/run it. Installer handoff is not reported as a completed installation. No Windows/Linux in-place self-replacement or signing/notarization claim is made.

Source runs and local-product builds use verified manual installer handoff rather than replacing a checkout or changing product channels. Unwritable installation directories also use the manual path. Neither flow migrates or deletes career data, changes the app/storage identity, or accesses signing credentials. Update state is separate from career storage; local and production receipts are isolated.

## Repository boundary and privacy

The settings window's renderer makes no network requests except `<img>` loads of employer logos named by the job catalogue (https only, no referrer, in-memory session without cookies). Nothing private is sent; the logo host learns only that a logo was fetched.

This repository owns the Electron app, Chrome and Firefox extensions, local career/job/form storage, MCP tools, document engine and updater. `recruiters-rip-frontend` owns website authentication, checkout, preview hosting, pairing UI and the signed-device proxy. Middleware authorizes accounts/devices and current paid feed access. Builds and runtime never import a sibling checkout.

Local records use plain `vault.json`, without keychain storage or at-rest encryption. POSIX files/directories use 0600/0700; Windows checks owners and DACLs, allowing only the current user, SYSTEM and Administrators. The connected agent reads career context through MCP. API requests send their stated context directly to OpenAI; form preparation releases selected values to the extension; neither shows an approval dialog. With the candidate's standing consent, `career_cv_share` sends one CV and its matched roles to JobStash through the signed device relay (see **JobStash profile sharing**); no other career content and no API keys reach the server. Membership gates the platform feed, not captured jobs or saved records. Backups and exported documents are ordinary files; API keys are excluded. Keep vaults, exports, credentials, certificates and user data out of source control.

Installed identity stays `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, storage name **Recruiters Companion**, protocol `recruiters-companion://`. Vault paths are `~/Library/Application Support/Recruiters Companion/device/vault.json` on macOS, `%APPDATA%\\Recruiters Companion\\device\\vault.json` on Windows, and `${XDG_CONFIG_HOME:-~/.config}/Recruiters Companion/device/vault.json` on Linux. Local builds use `local-device`. Never test against real user data.

AppImage launchers retain the installed AppImage path, not its temporary mount. Native and MCP scripts are cached under the private device directory in `bridge-runtime/<version>`. Revealing an unpacked extension copies its validated files to the stable `browser-extensions/chrome` or `browser-extensions/firefox` directory; replacing the AppImage does not invalidate the browser's loaded extension path. Reload the extension after updating its files.

AppImage bridge launchers use FUSE, not `APPIMAGE_EXTRACT_AND_RUN`. The bundled runtime's extraction output corrupts native-messaging/stdin-stdout protocols, and concurrent extraction processes share a cleanup directory. The extraction flag is not forwarded to bridge processes.

Account connection returns through a short-lived HTTP listener bound only to `127.0.0.1` on a random port, so source runs and installed apps do not depend on macOS selecting the right custom-protocol handler. The return carries its one-time state and pairing payload in the URL fragment, which the local page removes from browser history before sending a same-origin POST. Foreign origins, rebound hosts, invalid state and replayed requests are rejected. Only native account approval and successful signed platform activation produce success; the browser receives no career data or API key. The listener closes after five minutes, when starting another connection, on OS lock or on quit. Existing `recruiters-companion://` entrypoints remain supported.

## Jobs and the publication window

Start in Codex or Claude with **“Use the recruiters.rip skill to find me a job.”** The skill reads saved recommendations and career context first, then reviews the jobs the companion exposes. It acts on your task without repeated confirmation questions and asks only for missing material facts. Companion settings govern its own tools, including CV sharing and the saved Decisions key; they do not override your host app's access permissions or safety rules.

**Jobs** has four tabs — **Jobs · Reviewed · Applications · Blocked** — each with its live count from `career-list` `counts`. Beside the publication slider sit the handoff actions **Continue in Codex**, **Continue in Claude** (shown for installed hosts; the companion configures its application workspace and opens a new conversation with the review prompt filled in — you still send it) and **Copy prompt**. None launches a review by itself. The prompt is `Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.`; the skill supplies the workflow: review the exposed jobs against full adverts, save structured assessments and rerank the top recommendations pairwise.

The slider sets the publication window: **Today, Yesterday, Past 3 days, Past week, Past 2 weeks** (the MCP also accepts `past_month` and `all`). Today/yesterday follow the companion's local calendar; the other dated ranges roll back 3, 7, 14 or 30 days. The selection is saved through IPC `publication-range-set` into `career.publicationRange` (a legacy `prescanPublicationRange` value is read as fallback) and applies to matching and recommendations. Today or the past 3 days work best because older listings already have many applicants.

`career_match_jobs` returns every job in the window minus blocked jobs minus established incompatibilities (`src/mcp/review-queue.mjs`), in catalogue order. There is no score, threshold or per-job switch; blocking is the only exclusion. Signed `matching_catalogue` requests carry `{publicationRange,since,until,offset?,countOnly?}` and receive exact SQL `total`, transport-paged `jobs`, `nextOffset` and echoed `publicationWindow`; every page is consumed. A comparable stated salary ceiling below the saved minimum is settled by the companion (`below_minimum`).

Cards show the company mark (logo when the catalogue supplies one) and three lines. A reviewed row shows **Fit** on the right, an ineligible row shows the verdict word, an open row shows nothing there. The reader shows the verdict only for reviewed and ineligible jobs; there is no metadata section. A reviewed assessment keeps its own overall fit, gates, requirements and reason. In a job reader, each saved requirement has **Add context**: it copies a bounded prompt for the connected agent to create/reuse the application, ask one focused material-gap question, save the answer as a reusable fact and reassess that job. The requirement must exactly match the saved assessment; the Companion never creates an unsupported fact directly.

The optional OpenAI key in **Settings → Optional Decisions API** serves one thing: Chrome **Read page** known-value mapping (`src/decisions/form-mapping.mjs`, `POST /v1/decisions`). It never assesses jobs. The section states whether a key is saved (by its last four characters and save date) before any control. Enter the key and choose **Save key**; a saved key offers **Replace key** (the old key stays active until the new one is saved) and **Remove key**. Unsaved input clears on save or navigation. Saving a key sends no API request, and normal agent work needs none. Key changes, locks and career-context changes invalidate prepared form values. The vault keeps the key under `prescanCredentials`/`prescanCredentialVersion`. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

## Onboarding and companion memory

Basic preferences are required before any review: `roles`, `locations`, `workModes`, `willingToRelocate` and `travel` (`ESSENTIAL_PREFERENCES` in `src/mcp/assessment-policy.mjs`). Until all are answered, `career_match_jobs` and `career_match_batch` fail with `PREFERENCES_REQUIRED` before any catalogue call; the message lists the questions. `career_profile_read.missingPreferences` and `onboarding_status.questions` carry the same questions, and `locallyReady` stays false. The agent saves answers with `career_preferences_update`, so they live in the vault, not in chat or host memory. Use `roles` for the intended direction, `acceptedAlternatives` for acceptable adjacent/combined directions, `excludedRoles` for role families to avoid, and `notes` only for nuance. Me → **Preferences** shows that exact saved record in Direction, Location, Employment and Work groups; it never infers preferences from the CV. Every `career_match_batch` result re-supplies the saved `candidate` (CV, facts, complete preferences) and `profileVersion`, so reviewers in a new session or after compaction assess against the companion's copy.

Only one companion process serves a storage directory. Startup claims a kernel-held lock: macOS `O_EXLOCK`, a Linux abstract socket, or a Windows named pipe. Local MCP and native-browser bridges use authenticated Unix sockets on POSIX and deterministic per-directory named pipes on Windows. A second process cannot open a competing in-memory vault; process exit releases the lock.

## JobStash profile sharing

Purpose: JobStash keeps the candidate's CV and CV-derived work history on their JobStash profile, so they are included in direct, peer-to-peer introductions. Extraction and matching happen client side:

1. `career_employment_status` lists each current CV as `needs_extraction`, `ready_to_share` or `shared` (keyed by the CV's content hash). The connected agent reads the CV, extracts employers, titles and `YYYY`/`YYYY-MM` dates, and calls `career_employer_search`. That is the `employer_search` platform operation, which returns up to five JobStash candidates per employer, profiles first.
2. The agent keeps only confident matches and saves them locally with `career_employment_save`. Unmatched employers are dropped and never sent.
3. Consent is asked once (`career_introductions_update({consent})`) and is shown and changeable in **Settings → JobStash profile**. Withdrawing stops future uploads only; anything already on JobStash stays, and consent can be granted again.
4. `career_cv_share` checks consent, CV bytes and matched roles, then sends `POST /device/cv` without a further dialog. The paired device signs the request; the recruiters.rip proxy forwards those bytes unchanged (up to 7.5 MiB). Middleware resolves the existing Privy-linked User from the device, stores the PDF/DOCX or text in the existing JobStash R2 resume bucket, replaces the profile's CV showcase link, and replaces its `CV_EMPLOYMENT` edges in one database transaction. Any unknown entity reference rejects the whole upload; a failed database transaction removes the newly uploaded object. No `candidate_documents` table or new migration is needed on production `main`.
5. GitHub is optional: `account_github_connect` opens `recruiters.rip/account#github`, where developers link GitHub through Privy. `account_status` reports `platform.github.login` once middleware has synchronized it. The link is what makes warm intros possible.
6. **Me → Career** shows the saved matches: employer, title and dates per role, newest first, with **Go to {company}’s profile**. That action sends the saved entity ref to the `employer_profile` platform operation (pairing required, membership not), which returns `{kind, slug, name}`: the Organization or Project `normalizedName` that keys its ecosystem.vision page (a profile resolves through its single linked child; several children or none is a 404). The companion opens `https://ecosystem.vision/organizations/names/<slug>` or `/projects/names/<slug>` and never builds a URL from a display name. Entries whose CV changed since extraction say so until the agent refreshes them.

Warm intros come from the retired IntroPath GitHub collaboration graph. `career_intro_paths({jobIds})` takes up to 10 platform job IDs and sends the `intro_paths` platform operation; middleware requires current paid membership and the owner's linked GitHub login (`github: null` with `reason: "github_required"` otherwise), resolves each job's employer to its linked GitHub organizations, and asks the scorer for the best path per person from the owner into those organizations: direct coworkers (`hops: 1`, `direct`) and people reachable through one shared contact (`hops: 2`, `1-intermediary`). Each path carries GitHub identities (login, name, avatar, profile URL), up to three verified commit emails per person, and the shared organization, overlap end date and repositories per edge as evidence. Only `one_hop_paths` and `two_hop_paths` are read; `three_hop_paths` is never queried. The skill presents at most three paths per job as inferred, not confirmed, and drafts the candidate's own ask for a referral; the companion never sends the message. A scorer outage returns `available: false` with empty paths, and an employer without a linked GitHub organization has empty `orgLogins`.

## Recommendation policy

Every assessment is structured: up to 12 requirements read from the advert before candidate evidence (essential/preferred; demonstrated/transferable/missing/contradicted, with demonstrated and transferable evidence citing a verbatim CV quote or saved fact IDs), three gates (direction, constraints, eligibility: pass/flag/fail), four 0–100 dimensions (direction, capability, scope, preferences), relocation and a reason. The companion, not the model, computes overall fit `round(0.30·direction + 0.25·capability + 0.15·scope + 0.30·preferences)`, the band (strong ≥75, good ≥60, moderate ≥45, weak ≥30, poor) and the decision: any gate fail or contradicted essential requirement → skip; any gate flag or missing essential requirement → clarify; otherwise overall ≥60 → recommend, else skip. `career_match_save` rejects uncited (`UNSUPPORTED_REQUIREMENT`), non-verbatim (`UNKNOWN_QUOTE`) or unknown-fact (`UNKNOWN_FACT`) evidence.

All model-facing matching material — protocol, policies, weights, bands, schemas, tool descriptions and the skill — lives in `src/mcp/matching-contract.mjs` and is fingerprinted as `policyId` (the build writes the skill digest to `src/generated/skill-digest.mjs`). Any change makes saved assessments `needs_review` and saves with an old `policyId` fail with `POLICY_CHANGED`; nothing is rescored automatically.

A positive saved `salaryMinimum` is a hard floor that applies only to adverts stating comparable pay. Comparable stated pay below it cannot enter recommendations; the server rejects a save for that known mismatch unless `gates.constraints` is `fail`. Ranges that reach the floor remain possible. Adverts without stated pay, or with pay in another currency or an unconvertible period, pass the salary condition in agent review: the rubric forbids failing, flagging, marking uncertain or scoring them down for it, because unstated pay is common and excluding it would drop good jobs. Currency or hourly/day-rate uncertainty is never silently converted into a budget claim.

The shared policy separates career intent from capability and assumes no profession, management ambition, seniority goal or preferred career path. The user's saved goals, constraints and accepted alternatives define the intended next move, including deliberate lateral moves, career changes or reduced responsibility. Capability overlap cannot override an explicit intent conflict (a direction gate fail), and overlapping duties do not silently expand an accepted alternative. Personal restrictions belong in the user's preferences, not shared prompts. Capability is assessed from demonstrated responsibilities across the whole career rather than exact CV phrases, without inventing historical activities, metrics, credentials or specialist expertise.

After matching coverage is complete, the coordinator calls `career_rerank_pairs` (the top six current recommendations by overall fit and their unjudged pairs), judges each pair itself and saves the judgments with `career_rerank_save`. `career_recommendations` orders compared rows by pairwise wins (equal counts half), then overall fit, date and ID, followed by uncompared rows. Re-saving an assessment drops its comparisons.

Mandatory user conditions apply to all role interests and accepted alternatives; a broad interest does not waive a narrower requirement. Interpret the user's distinction between a role's predominant work and incidental responsibilities without imposing that distinction on other users.

Preference changes use `career_preferences_update({requestId, revision, patch})`. `requestId` must be a UUID returned by `request_id`, and `revision` must be the current integer from `career_profile_read`. A descriptive request label is invalid. Rejected calls leave preferences untouched and identify the invalid or missing schema field without echoing supplied values. Always confirm persisted preferences through readback.

Say **“Reassess roles.”** The host performs one ranking reset, then reviews again. Discovery uses the selected publication range and complete originals; status/resume requests do not clear work. Default scope is Past 3 days, but explicitly broader scopes are never silently clipped. An empty or obsolete cache is not a completed search with no suitable jobs.

The companion's **Clear reviews** action and `career_rankings_delete` clear rankings, pairwise comparisons and cached jobs. They preserve profile, preferences, CVs, facts, job applications, account data and API credentials. A reset invalidates in-flight writers so deleted results cannot reappear. `career_match_jobs.profileVersion` binds profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

Navigation is **Me / Jobs / Settings / Help**; Me opens by default. Me exposes **Import CV**, **Open exports**, **Export backup** and **Connect your agent** above **CVs / Facts / Preferences / Career**. Preferences makes matching direction and constraints inspectable in the app. Jobs switches between **Jobs**, **Reviewed**, **Applications** and **Blocked**, with the publication slider and the Codex/Claude/Copy prompt handoff above the list. Help shows the starting prompt, a four-step overview, the docs and downloads URLs and the running version. Import uses the existing native picker/extractor and revision-checked source API; it never accepts a renderer path. Settings has separate Account, Chat apps and Optional Decisions API groups, with ChatGPT and Claude nested together. OS-lock protection and account approval remain enforced; the companion retains approval dialogs for pairing and update installation. Browser input permissions belong to the host app.

A job's reader can block the job, every job of its company or every job of its category (classification). Employer comparisons recognize slug/display-name separators, so `flow-traders` and `Flow Traders` match the same block. Blocks are saved locally in `career.blocklist` and survive **Clear reviews**. Discovery, direct job reads, batch fetches, recommendations, assessment archives/exports, reranking and application preparation all enforce the block; an old ID or existing draft is not an exemption. Operations recheck after asynchronous fetches and before releasing prepared form values. The agent rereads `career_application_context` before acting on a saved application and immediately before final submission through its host's computer-use tools. Blocked application work fails with `JOB_BLOCKED`; existing drafts remain stored, and the agent must not bypass the block through another tool. **Blocked** lists exclusions and **Unblock** removes one.

Read [design.md](design.md) before UI work. The companion uses the approved dark/void workspace, upright Instrument Serif headings, Geist reading text, Geist Mono controls and metadata, square ruled surfaces and blended light confined to thin edges. The supplied mirrored-r mark replaces the old slit logo. There are no flat spectrum bands, chromatic status fills, animations or external font requests. Shared values live in `ui/design-tokens.css`; layout and controls live in `ui/settings.css`. Both Geist and Instrument Serif OFL notices ship under `ui/fonts`. Account, vault and MCP permission boundaries are unchanged.

The internal read-only browser uses `kind: jobs`; Jobs pages saved reviews by job ID, and all unavailable and stale rows remain accessible. CVs also keeps previously imported supporting documents accessible and labelled. Browsing performs no inference, feed fetch or data mutation.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## Career facts

The saved CV is the base career record and is sufficient to begin matching jobs. Do not collect general career facts or conduct a prerequisite interview. Facts are reusable answers gathered while reviewing a specific listing for submission: a `subject`, an `answer`, optional `detail` and `employer`, and actual original `question`, job-relevant `context` and `followUps`. `career_facts_save` creates or updates by subject and employer, so the same subject at two employers is two facts; `career_facts_delete` removes individual facts. Record the employer on capability facts that belong to a specific job so CV bullets can cite them. Missing historical questions are never invented. The Facts list leads with the explanation (or answer if absent), with actual question, context, employer and exchanges in its detail view.

The vault career schema is versioned (`CAREER_SCHEMA`). Opening an older schema keeps only CV sources and the profile and discards facts, interviews, applications and matching results; there is no migration.

Only when submission review exposes a material gap, call `career_interview_ask` with the saved `applicationId` and normally 1–3 questions (maximum 5). The interview is bound to that application's listing. Fast capability choices — Led it / Hands-on / Some exposure / None — route the interview; one short, specific explanation of the project, personal contribution and result supplies the useful material. A shallow positive choice is saved as partial and leaves a focused detail question pending. None/No is sufficient and must not be re-questioned or claimed as capability; Led it does not prove personal implementation or specific achievements.

New facts retain their original `applicationId`; follow-up exchanges can retain their own `applicationId` and requirement `context` when reused for another listing. Matching includes those links and explanations. The fact reader resolves saved applications to their job title and company, never displays raw application IDs, and omits an application label when the referenced record is unavailable.

The host compares the full CV and facts semantically, including questions, context and exchanges, and passes an existing `factId` for justified reuse across differently worded requirements. This is host reasoning, not automatic keyword equivalence. When existing detail lacks material specificity, use `factId` with a targeted `followUp` instead of repeating the level question. Compatible hosts get forms; others get numbered choices such as `1a 2c`. A single pending detail accepts a plain sentence; mixed or multiple questions use the exact numbered format returned by the tool. Present pending follow-ups from either interview tool rather than stopping at “saved.” Skipping or cancellation invents no detail and does not erase a saved partial answer. No mandatory essays or fabricated metrics.

Subsequent evaluation uses these explanations where relevant: they can change requirements, gates and dimensions or resolve eligibility, without automatic bonuses or forced changes to unrelated assessments. Fact changes update `profileVersion`, making previous assessments stale; discovery returns jobs needing reassessment. Collecting an answer does not automatically launch background reassessment. Reassess affected saved roles when needed and perform full reevaluation when requested, using current context and fresh reasoning rather than retagging old judgments.

## CV and cover letters

1. `career_application_create` takes a catalogue `jobId`, complete captured job or pasted advert `{title, company, description, url}` and reuses the same exact saved application. Pasted/captured adverts need no catalogue membership. Identity uses job IDs and canonical URL/recognized ATS role routes, never employer/title alone.
2. `career_application_context` returns the full job, profile, saved CV, facts, current assessment, writing guide, `contextFingerprint`, and attached `forms`. Reuse only drafts/exports bound to that current fingerprint and document version. Missing/stale originals and ambiguous job associations stay explicit. During submission review ask only material job-dependent gaps, then reread context.
3. The host plans from the assessment's requirements, then writes the CV as a structured document (headline, summary, optional highlights, experience with bullets, skills, languages, education, certifications, additional sections) and saves it with `career_application_cv_save`. Every highlight and bullet is `{text, support}` citing verbatim CV quotes (`support.cv`) and/or saved fact IDs (`support.facts`). Support stays in the stored draft for validation and never reaches rendered TXT/PDF. The header comes from the profile.
4. Saves reject invented employers (`UNKNOWN_EMPLOYER`), non-verbatim quotes (`UNKNOWN_QUOTE`), unknown facts (`UNKNOWN_FACT`), bullets citing another employer's fact (`MISATTRIBUTED_FACT`), numbers absent from a claim's own cited evidence or, outside claims, from the CV, profile or saved answers (`UNSUPPORTED_NUMBER`) and narrated, hedged or third-person wording (`UNCLEAR_FACT`, `CV_TONE`). Other quality notes are returned as `issues` for the host to fix silently.
5. `career_application_letter_save` stores the cover letter as paragraphs with the same checks.
6. `career_application_export` renders PDF (classic or modern, A4 or Letter, 11pt) or TXT; PDF text is read back before the file is saved.

For an agent-led application, export both current PDFs before `career_application_open({applicationId})` opens its saved URL in the user's default browser. Use Chrome or Firefox with the corresponding extension. Reading the application page links its questions back to that application; the active agent discovers them in `career_application_context.forms`, stages the short personal summary and other narrative answers, and the panel refreshes. Reopening the job reuses current outputs rather than regenerating them.

For a web-led application, **For this job → Prepare this application** creates a durable preparation request. `career_application_preparation_read({preparationId})` supplies the original or exact source link and captured questions. If no full job is saved, the host retrieves that advert, creates the application and calls `career_application_preparation_bind`. It then uses the same document/answer tools as the agent-led path. Narrative answers are bound to the application, exact question/type/options and career context; they cannot leak into another employer's form. The browser exposes current PDFs through **Open**/**Show in folder** for native file selection; no automatic upload is claimed.

Desktop host links carry only the preparation UUID and fixed instructions, never CV text or keys. Claude uses documented `claude://code/new?q=…&folder=…`; the installed ChatGPT/Codex route is `codex://threads/new?prompt=…&path=…&mode=codex`. Both prefill the composer without sending. CLI handoff instead opens a detected terminal with the exact prompt and waits for Enter before starting the interactive host. A product-owned workspace supplies the Companion MCP configuration, preserving normal host trust prompts and unrelated user configuration. Readiness derives from saved, current artifacts and verified local files, not a successful launch. Metadata polling stops when the panel closes or changes page and pauses after twenty minutes until **Read page** resumes it.

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

| Build command | Native runner | Artifacts |
| --- | --- | --- |
| `pnpm package:adhoc` | macOS arm64 | `recruiters-rip-companion-<version>-mac-arm64.zip` and `.dmg`, ad-hoc signed, not notarized |
| `pnpm package:win` | Windows x64 | `recruiters-rip-companion-<version>-win-x64.exe`, per-user NSIS installer |
| `pnpm package:linux` | Linux x64 | `recruiters-rip-companion-<version>-linux-x64.AppImage` |
| `pnpm package:local` | Any supported runner | Isolated unpacked developer app, no production protocol registration |

The CI matrix runs build/check/tests and packaging on each native OS and uploads artifacts without publishing. MCPB and extension ZIP generation use JavaScript archive creation, not an external `zip` command. Package the matching browser source ZIPs with every version; a Firefox ZIP must go through Mozilla signing before it can be offered as a permanent add-on.

Publishing is explicit: commit the root version, tag `v<version>`, gather native runner artifacts, generate/merge their `SHA256SUMS.txt` entries and create a stable GitHub release. The website operator must mount the matching files before advertising downloads. Never reuse an older published version number for new binaries.

`pnpm package:release` uses native release targets. On macOS it still requires a genuine Developer ID Application identity and Apple notarization credentials; `pnpm package:adhoc` is the no-Apple-key route. Windows builds without signing credentials remain unsigned. No command disables operating-system security controls or silently publishes.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
