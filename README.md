# Recruiters.rip Companion

Companion keeps your CVs and applications on your computer. Use Codex or Claude to find suitable jobs, tailor your documents and apply for you. Install a ready-made app or build it from the [public source code](https://github.com/jobstash/recruiters-rip-companion).


## Start here

You need Companion, a readable CV, and your own Codex or Claude account. The same account and subscription requirements apply whether you download the app or build it from source. Any charges for your AI app are separate. The browser extension is optional.

### 1. Install Companion

Open [Downloads](https://recruiters.rip/downloads) and choose **Mac**, **Windows** or **Linux**, then follow the steps for your computer. Prefer to build it yourself? Use the [one-command source installation](#install-from-source).

| Computer | Install the app |
| --- | --- |
| Mac with an M1 chip or newer | Open the download, move **Recruiters.rip Companion** to **Applications**, then open it. |
| Windows 10 or newer | Open the downloaded installer, follow its steps, then open **Recruiters.rip Companion** from Start. |
| Linux | In the downloaded file’s properties, allow it to run as a program, then open it. |

The Windows and Linux downloads are for 64-bit Intel or AMD computers.

<details>
<summary>If your computer will not open the app</summary>

- **Mac:** Apple has not checked this app. If you trust the download, open **System Settings → Privacy & Security → Open Anyway**. Keep security protections turned on.
- **Windows:** you may see a warning because the publisher has not been verified. Check that the file came from recruiters.rip or its [official releases](https://github.com/jobstash/recruiters-rip-companion/releases). On a work computer, ask the person who manages it.
- **Linux:** a desktop with windows and menus is required. Follow your Linux version’s instructions for FUSE 2 and any missing software named in the error, or ask someone who supports your computer. Keep the app in a permanent folder.
</details>

### 2. Connect your account

1. In Companion, choose **Connect account**.
2. Sign in in the browser, choose **Connect account**, then **Open Companion**.
3. Back in Companion, check the named account and choose **Allow this action**.

Wait for Companion to show that the account is connected. If it stays pending, start **Connect account** again and use the same website account.

### 3. Import your CV

In **Companion → Me**, choose **Import CV** and select a PDF, Word document or text file. Use a document with selectable text, not a scanned image.

### 4. Connect Codex or Claude

1. In **Settings → AI apps**, choose Codex or Claude. You only need one.
2. If it is missing, choose **Get Codex** or **Get Claude**, install it and sign in. On Linux, these links lead to apps that run in Terminal; follow their official installation guides.
3. Back in Companion, choose **Set up** and follow the instructions for your installed app.
4. Enable recruiters.rip in your AI app when asked, then start a new task or conversation. Keep Companion open.

### 5. Review jobs

Open **Jobs** and choose **Continue in Codex** or **Continue in Claude**. Send the prepared message in that app. If a text window opens, press **Enter** there.

Answer any questions about your experience, roles and locations. Your AI saves those preferences and explains which jobs fit. You do not need an extra API key or browser extension for this.

<details>
<summary>If your AI app cannot find Companion</summary>

Keep Companion open. In **Settings → AI apps**, follow the instructions for your app, then start a new conversation with recruiters.rip enabled. Ask: **Use recruiters.rip to find me a job.**

Choose **Continue in Codex** or **Continue in Claude**, then send the message there. Companion will show **Connected now** when the connection is working.
</details>

### 6. Apply for a job

Choose a job with your AI and ask: **Use recruiters.rip to apply for this job. Use my saved experience, ask about missing facts and save my answers. Tailor my CV and cover letter, fill the form, attach the files and submit. Report the employer’s confirmation or anything left unfinished.**

Your AI handles the application. Find its saved documents again under the job in Companion.

## Open a generated CV or letter

Open **Jobs**, select a job, then choose **Open CV** or **Open letter** in its **Job and documents** section. **Open job** sits with them. The same actions are available when you select an item under **Applications**. These open saved files; they do not create new documents.

Generated PDFs are saved together in private **Company / Job title** folders, with exact readable basenames **Candidate full name - CV.pdf** and **Candidate full name - COVER LETTER.pdf** (TXT uses the same naming). Names come from the saved candidate and application, never a guessed identity. Unsafe filename characters and reserved device names are sanitized. Folder names are bounded against the complete path length, preserving the candidate filename; an excessively long base path fails explicitly. Distinct applications with colliding names receive readable job-folder suffixes such as **Job title (2)**. Regenerating a document atomically replaces that kind's file in the same application folder; versions and opaque IDs are metadata, not visible filenames.

Document resources use `recruiters://documents/<UUID>.pdf` (or `.txt`), with SHA-256 retained only as integrity metadata. Open, attachment and resource consumers resolve the current application record rather than trusting a supplied file path. Replaced versions and legacy hash-only PDF/TXT resource URIs are unavailable. After a successful export or restore, obsolete generated files are removed without touching imported CVs, facts, applications, credentials, backups or ranking CSVs. Ranking CSV resources retain their distinct content-addressed export format.

Portable backups verify document bytes and rebind them to fresh local document identities and readable paths. Older backup-contained PDFs/TXT can be rebound when the application kind, candidate name, company and job title are present; otherwise the saved draft remains and the missing-file warning requests a new export. Foreign stored paths are never opened.


## Add the browser extension — optional

Use it to save job adverts and help fill application forms. You can find and review jobs without it.

Use Chrome 125 or newer, or Firefox 128 or newer. Keep Companion open. If your version includes the extension, open **Settings → Browser extensions** and choose **Open folder** for your browser. Otherwise, check availability on [Downloads](https://recruiters.rip/downloads#extension).

Use the folder opened by Companion once so future app updates can refresh it. These managed extensions reload when the browser is idle and no application work is active. A separately unzipped archive or an old app-bundle folder needs a one-time move to the managed folder; it cannot update itself. Firefox’s temporary-loading requirement still applies.

<details>
<summary>Chrome</summary>

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the Chrome folder Companion opened.
4. Open a job page and choose **recruiters.rip** from Chrome’s **Extensions** menu, or click its **rr** icon.
</details>

<details>
<summary>Firefox</summary>

1. Open `about:debugging` and choose **This Firefox**.
2. Choose **Load Temporary Add-on**.
3. Select `manifest.json` in the Firefox folder Companion opened.
4. Open a job page and choose **recruiters.rip** from Firefox’s **Extensions** menu, or click its **rr** icon.

You will need to load this version again after closing Firefox.
</details>

### Fill an application

1. Open a job ad or application and click the **rr** toolbar icon. It reads the page and gets saved answers ready.
2. Choose **Prepare application**. Codex or Claude opens with the request; click **Send**, or press **Enter** if a text window opens. Change the app under **Options**.
3. Click an empty answer box and paste with **⌘V** on Mac or **Ctrl+V** on Windows/Linux. If details are missing, enter them and choose **Save details**.
4. Use **Show CV** to find the file to upload and **Copy intro** for a cover-letter or message box. Check the form and submit it yourself.

Saved answers work without an API key. Extra help choosing saved answers is optional in **Settings → Form filling**, using a separately billed OpenAI API key.

### Apply with Codex or Claude

Your connected AI fills the employer’s form, attaches your documents and submits for you. If a website needs a security check or a field the AI cannot complete, handle that step and ask it to continue. Use the employer’s confirmation to know the application was sent.

## Back up or restore your profile

Open **Settings → Backups**.

- **Save backup** saves your profile, CVs, saved documents, jobs and applications to a file. Choose where to keep it. It is not password-protected, so keep it private.
- **Restore backup** lets you choose a backup file. Check the profile name, contents and any file warnings, then choose **Restore profile** to replace your current profile.
- **Open backups** shows the default backup folder, including the copy saved before a restore.

Restoring replaces the current profile in Companion. Your account connection, API keys and CV sharing choice stay unchanged. Companion saves a backup of your current profile before replacing it.

You can use a backup on another computer. If a file contains several saved profiles, choose the one you want to restore. Other saved profiles already on this computer are not replaced.

The JSON files created by the earlier **Export backup** action can also be selected. They may not include saved PDFs; the preview explains which files need to be created again. Your saved CV text and original uploaded CV files remain part of the profile.

If the profile changes while you review the backup, select the file again before restoring. An invalid file does not replace your current profile.

## Delete a CV

In **Me → CVs**, open the CV, choose **Delete CV** at the top and confirm the deletion request.

If it was shared with JobStash, its shared copies are removed before it is deleted from Companion. If JobStash cannot confirm removal, the CV stays in Companion so you can try again. Other CVs, applications and backup files stay unchanged.

Use the account that shared the CV. Older uploads without a recorded owner need ownership verification before JobStash can remove them. **Stop sharing** in **Settings → CV sharing** prevents future uploads; it does not delete a shared copy.

## Install from source

Install **Git** and **Node.js 24 with npm**, then run one command for your computer. It clones the published source, installs dependencies, builds locally and opens Companion. No Apple developer key is needed.

**Mac or Linux**

```sh
curl -fsSL https://github.com/jobstash/recruiters-rip-companion/releases/latest/download/install-source.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/jobstash/recruiters-rip-companion/releases/latest/download/install-source.ps1 | iex
```

Review the [repository and installer scripts](https://github.com/jobstash/recruiters-rip-companion/tree/main/scripts) before running them. Source installation builds on your computer; it does not substitute a downloaded installer.

Managed source installs receive automatic updates from published source releases. Each update builds in a separate folder, retains the previous version for recovery and keeps your profile in place. Local source changes pause replacement rather than being overwritten. An ordinary developer clone is not silently adopted or reset; use this installer for managed updates.

## Developer setup

<details>
<summary>Build from source and package extensions</summary>

See [AGENTS.md](AGENTS.md) for ownership and safety boundaries, and [design.md](design.md) for the interface rules.

Use Node 22.12 or newer and pnpm 10.28.0:

```sh
git clone https://github.com/jobstash/recruiters-rip-companion.git
cd recruiters-rip-companion
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the tools, document engine and browser extensions before opening Electron. Use `pnpm start:local` for isolated development, never a user's vault.

`pnpm build:browser` builds Chrome `browser-extension/dist/{production,local}` and Firefox `browser-extension/dist/{firefox-production,firefox-local}`. Create upload archives with `node browser-extension/build.mjs production --browser=chrome --zip` or `--browser=firefox --zip`. Firefox permanent distribution requires Mozilla signing.

Chrome uses `sidePanel`; Firefox uses `sidebarAction`. Both use `nativeMessaging`, `activeTab`, `scripting` and `clipboardWrite`; production and local identities remain separate. Account connection returns through Companion, not through a browser extension.

Job capture uses `career_job_import` and `career_jobs`. Complete local originals can be reviewed with `career_match_jobs({localOnly:true})` without catalogue access. Native paste and Undo remain browser operations; the extension never injects field writes, upload actions or submission clicks.
</details>


## Public releases and updates

**Settings → Updates → Keep the app up to date** is on by default. Companion checks after startup, on resume when due, and every six hours. It verifies the download, then waits for active work to finish and a quiet, unfocused computer before restarting. **Check now** checks immediately; you can turn automatic updates off.

Quitting saves your career data without waiting for background update checks or builds.

The installed version and latest published version are shown separately. A newer local build says it is ahead of the published release; it is never downgraded or incorrectly described as the published version. No release means unavailable, not up to date.

Ready-made installs use the exact Mac arm64 ZIP, Windows x64 NSIS installer or Linux x64 AppImage. Downloads are bounded and SHA-256 verified, with official repository and target checks. Mac replacement covers apps originally installed from ZIP or DMG; Windows installs silently without killing another running app; Linux replaces the actual AppImage, not its temporary mounted folder. The previous installation is retained until the new app confirms startup. Unsafe or unwritable locations explain what needs changing rather than pretending installation succeeded.

Managed source installs fetch the exact published source, install locked dependencies and build a separate version locally before the same safe restart. They do not overwrite developer edits or switch silently to prebuilt binaries. Ordinary unmanaged clones remain under their owner's control.

Automatic-update preferences and receipts live outside career backups. Updates keep the app identity, profile and account connection; they do not reset career data. Mac releases remain ad-hoc signed, not notarized; Windows releases remain unsigned. No update requires an Apple developer key or disables operating-system protections.

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

The optional OpenAI key in **Settings → Form filling** serves one thing: Chrome/Firefox **Read page** known-value mapping (`src/decisions/form-mapping.mjs`, `POST /v1/decisions`). It never assesses jobs. The section states whether a key is saved (by its last four characters and save date) before any control. Enter the key and choose **Save key**; a saved key offers **Replace key** (the old key stays active until the new one is saved) and **Remove key**. Unsaved input clears on save or navigation. Saving a key sends no API request, and normal agent work needs none. Key changes, locks and career-context changes invalidate prepared form values. The vault keeps the key under `prescanCredentials`/`prescanCredentialVersion`. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

## Onboarding and companion memory

Basic preferences are required before any review: `roles`, `locations`, `workModes`, `willingToRelocate` and `travel` (`ESSENTIAL_PREFERENCES` in `src/mcp/assessment-policy.mjs`). Until all are answered, `career_match_jobs` and `career_match_batch` fail with `PREFERENCES_REQUIRED` before any catalogue call; the message lists the questions. `career_profile_read.missingPreferences` and `onboarding_status.questions` carry the same questions, and `locallyReady` stays false. The agent saves answers with `career_preferences_update`, so they live in the vault, not in chat or host memory. Use `roles` for the intended direction, `acceptedAlternatives` for acceptable adjacent/combined directions, `excludedRoles` for role families to avoid, and `notes` only for nuance. Me → **Preferences** shows that exact saved record in Direction, Location, Employment and Work groups; it never infers preferences from the CV. Every `career_match_batch` result re-supplies the saved `candidate` (CV, facts, complete preferences) and `profileVersion`, so reviewers in a new session or after compaction assess against the companion's copy.

Only one companion process serves a storage directory. Startup claims a kernel-held lock: macOS `O_EXLOCK`, a Linux abstract socket, or a Windows named pipe. Local MCP and native-browser bridges use authenticated Unix sockets on POSIX and deterministic per-directory named pipes on Windows. A second process cannot open a competing in-memory vault; process exit releases the lock.

## JobStash profile sharing

Purpose: JobStash keeps the candidate's CV and CV-derived work history on their JobStash profile, so they are included in direct, peer-to-peer introductions. Extraction and matching happen client side:

1. `career_employment_status` lists each current CV as `needs_extraction`, `ready_to_share` or `shared` (keyed by the CV's content hash). The connected agent reads the CV, extracts employers, titles and `YYYY`/`YYYY-MM` dates, and calls `career_employer_search`. That is the `employer_search` platform operation, which returns up to five JobStash candidates per employer, profiles first.
2. The agent keeps only confident matches and saves them locally with `career_employment_save`. Unmatched employers are dropped and never sent.
3. Consent is controlled in **Settings → CV sharing**. Withdrawing stops future uploads only; anything already on JobStash stays, and consent can be granted again. The agent does not add a separate consent question to onboarding.
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

Navigation is **Me / Jobs / Settings / Help**; Me opens by default. Me keeps **Import CV** and **Jobs**, with account/setup guidance when needed, above **CVs / Facts / Preferences / Career**. The CV detail starts with **Delete CV**; a red border distinguishes this destructive action. Generated files belong to their jobs and applications through **Open CV / Open letter**, not to a global file button in Me. Settings has **General / Backups** subtabs: General holds account, app, browser, sharing, form and update controls; Backups holds save, preview, restore and folder actions. Manual connection details stay under **Advanced**. Import and restore use native file pickers, never renderer-supplied paths. Locked storage, account connection and explicit CV deletion confirmation retain their boundaries. Automatic updates use the saved update preference and safe restart admission, not a per-release approval dialog.

Backup JSON version 2 contains profile records and SHA-256-verified document bytes, limited to 128 MiB per file, 100 profiles and 2,000 saved documents. Original CV files are limited to 5 MiB and saved documents to 12 MiB each. Current career-schema-2 records in version-1 exports remain importable; unsupported career schemas fail rather than passing through the destructive schema upgrade. Missing historical files are disclosed. Restore materializes only each application's current document version, independent of historical-record ordering. Restores retain sign-in, device identity, credentials, other identity archives and current sharing consent, while clearing runtime receipts and invalidating stale operations. Failed restores roll back replacements and newly created files without removing preexisting exports. Shared-CV references remain untrusted provenance for server-authorized deletion, not permission or proof of current sharing.

CV removal uses signed `POST /device/cv/delete` with an immutable `documentId`. The server establishes ownership; the client retains the CV until all recorded copies confirm erasure. New upload IDs are recorded before sending, and storage-level deletion fences stop delayed writes from restoring deleted bytes. The middleware migration and coordinated writer deployment described in its README are required before the online part is available. Backups cannot confer ownership of another account's shared CV.

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

For a web-led application, choose an AI app under **For this job**, then **Continue in Codex** or **Continue in Claude** to create a durable preparation request. `career_application_preparation_read({preparationId})` supplies the original or exact source link and captured questions. If no full job is saved, the host retrieves that advert, creates the application and calls `career_application_preparation_bind`. It then uses the same document/answer tools as the agent-led path. Narrative answers are bound to the application, exact question/type/options and career context; they cannot leak into another employer's form. The browser exposes current PDFs through **Open**/**Show in folder** for native file selection; no automatic upload is claimed.

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

Developer builds require Node.js 22.12+ and pnpm 10.28.0; the supported one-command source installer uses Node.js 24/npm and Git. Native packaging must run on its target OS. Mac ad-hoc packaging uses the system signing tools without an Apple developer account.

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

The native CI matrix builds, checks and packages on Mac, Windows and Linux, then exercises installation and upgrade with synthetic profiles. Candidate artifacts pass the real updater verification/handoff path and must launch the expected version, confirm startup and preserve synthetic data. The legacy Mac case uses the published 3.10 controller and helper with a narrowly scoped launch-environment adapter for test-profile isolation; it does not claim unmodified legacy launch arguments. Native startup-failure rollback is covered by targeted helper regressions, not claimed from the successful-upgrade smoke alone.

After all native gates pass on an eligible main commit, the release job assembles a draft containing the exact source version's installers, browser archives, source installers and SHA-256 sums. It publishes only the complete verified inventory. Runtime/package changes require a version increase; existing public version assets are never overwritten. Documentation-only changes do not republish a version.

Official hosted downloads synchronize verified published releases into an atomically switched directory. A complete validated set becomes visible together; the previous set is retained for recovery. The website's read-only mount points to the stable parent directory, not an individual file or the exchanged directory inode.

`pnpm package:release` still requires genuine signing/notarization credentials for signed Mac packaging; `pnpm package:adhoc` is the no-Apple-key route. Windows builds without signing credentials remain unsigned. A Firefox source ZIP is not a Mozilla-signed permanent add-on. Source installers build locally from the official published commit. No command disables operating-system security controls.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
