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

### 4. Add recruiters.rip to Codex or Claude

In **Settings → AI apps**, follow the steps for one app:

1. If it is missing, choose **Get Codex** or **Get Claude**, install it and sign in. On Linux, these links lead to apps that run in Terminal; follow their official installation guides.
2. **Add recruiters.rip:** choose **Set up**. For Claude this adds recruiters.rip to Claude's settings file (`claude_desktop_config.json`, other entries kept) and installs the recruiters.rip skill in `~/.claude/skills`; for Codex it installs the plugin. The app shows **Added** once its settings include recruiters.rip, and **In use now** while a session that Continue can use is open.
3. **Restart the app** so it loads recruiters.rip: quit Claude completely and reopen it, restart Codex, or start a new Claude Code session. Companion shows this line until that app is in use.
4. **Start a job search:** choose **Continue in Codex** or **Continue in Claude**. Its reviews appear in **Jobs → Reviewed**.

Using another agent (Codex CLI, Claude Code, Cursor)? Choose **Copy prompt** under **Setup prompt for your agent**, paste it into that agent and send. It adds recruiters.rip with this computer's exact paths.

### 5. Review jobs

Open **Jobs** and choose **Continue in Codex** or **Continue in Claude**. Send the prepared message in that app. If a text window opens, press **Enter** there.

Your AI reads your whole CV, saves every career path it supports and asks only where and how you want to work, then explains which jobs fit. See the paths in **Me → Preferences**; tell your AI to change any. You do not need an extra API key or browser extension for this.

<details>
<summary>If your AI app cannot find Companion</summary>

In **Settings → AI apps**, check your app shows **Added**, then start a new conversation. Ask: **Use recruiters.rip to find me a job.** If it still has no recruiters.rip tools, choose **Copy prompt** and send it to any coding agent on this computer.
</details>

### 6. Apply for a job

Choose a job with your AI and ask: **Use recruiters.rip to apply for this job. Use my saved experience, ask about missing facts and save my answers. Tailor my CV and cover letter, fill the form, attach the files and submit. Report the employer’s confirmation or anything left unfinished.**

Your AI handles the application. Find its saved documents again under the job in Companion.

## Track your applications

Open **Pipeline**. Every application sits in one column: **Prepared · Applied · Interviewing · Offer · Hired · Closed** (Closed holds rejected and withdrawn ones), each with its count. A card shows the role, company, where it stands with the date of the last step (**Round 2 · 30 Oct**) and whether its CV and cover letter are saved.

To move a card, drag it to another column, choose **Move to…** on the card, or press **←** / **→** while the card has focus. Moving forward fills in the steps it skips, dated today; moving back undoes steps; moving to **Closed** asks **Rejected** or **Withdrew** on the card. **Next round** on an Interviewing card adds an interview round.

Select a card to open it beside the board. **Progress** at the top offers only the next steps (**Mark applied**; then **Interview invite** or **Rejected**; then **Next round**, **Offer** or **Rejected**; then **Accepted** or **Declined**; **Withdrew** where it applies). A step is dated today: set **Date** first, or fix it afterwards with **Change date**; **Undo last step** removes a step recorded by mistake. Below are the history, **Open job**, **Open CV**, **Open letter** and the saved CV and letter text. **Close** or **Esc** returns to the card.

**Save as applied** in the browser extension marks the job applied. When Codex or Claude submits an application for you and sees the employer's confirmation, it marks it applied; when your saved notes show an application was already sent, it marks it applied with that date; you can also tell it, for example “I applied to tangem” or “I got an interview at tangem”. It records only what it saw or what you said (`career_application_progress_set`). Progress stays on this computer and is part of your backups; it is never sent to recruiters.rip.

## Open a generated CV or letter

Open **Jobs**, select a job, then choose **Open CV** or **Open letter** in its **Job and documents** section. **Open job** sits with them. The same actions are available when you select a card in **Pipeline**. These open saved files; they do not create new documents.

Generated PDFs are saved together in private **Company / Job title** folders, with exact readable basenames **Candidate full name - CV.pdf** and **Candidate full name - COVER LETTER.pdf** (TXT uses the same naming). Names come from the saved candidate and application, never a guessed identity. Unsafe filename characters and reserved device names are sanitized. Folder names are bounded against the complete path length, preserving the candidate filename; an excessively long base path fails explicitly. Distinct applications with colliding names receive readable job-folder suffixes such as **Job title (2)**. Regenerating a document atomically replaces that kind's file in the same application folder; versions and opaque IDs are metadata, not visible filenames.

Document resources use `recruiters://documents/<UUID>.pdf` (or `.txt`), with SHA-256 retained only as integrity metadata. Open, attachment and resource consumers resolve the current application record rather than trusting a supplied file path. Replaced versions and legacy hash-only PDF/TXT resource URIs are unavailable. After a successful export or restore, obsolete generated files are removed without touching imported CVs, facts, applications, credentials, backups or ranking CSVs. Ranking CSV resources retain their distinct content-addressed export format.

Portable backups verify document bytes and rebind them to fresh local document identities and readable paths. Older backup-contained PDFs/TXT can be rebound when the application kind, candidate name, company and job title are present; otherwise the saved draft remains and the missing-file warning requests a new export. Foreign stored paths are never opened.


## Add the browser extension — optional

Use it to save job adverts and help fill application forms. You can find and review jobs without it.

Use Chrome 125 or newer, or Firefox 128 or newer, and keep Companion open. Open **Settings → Browser extensions** and follow the four steps for your browser:

1. **Download:** choose **Save to Downloads**. Companion saves a `Recruiters.rip Chrome extension` or `Recruiters.rip Firefox extension` folder in Downloads and shows it.
2. **Open extensions:** choose the `chrome://extensions` or `about:debugging` link. Companion opens that page in the browser; if it can't, copy the shown address into the browser's address bar.
3. **Set up:** in Chrome, turn on **Developer mode**, choose **Load unpacked** and select the **Recruiters.rip Chrome extension** folder in Downloads. In Firefox, choose **Load Temporary Add-on** and select `manifest.json` in the **Recruiters.rip Firefox extension** folder in Downloads.
4. **Use it:** on a job page, click the **recruiters.rip** icon.

Keep that folder in Downloads: Companion refreshes it when it starts after an update, and the extension reloads itself when the browser is idle and no application work is active. Companion never replaces a folder with the same name that it did not create; rename or remove that folder first. Firefox removes temporary add-ons when it closes, so load it again after restarting Firefox.

### Fill an application

1. Open a job ad or application and click the **rr** toolbar icon. It reads the page and gets saved answers ready.
2. Choose **Prepare application**. Codex or Claude opens with the request; click **Send**, or press **Enter** if a text window opens. Change the app under **Options**.
3. Click an empty answer box and paste with **⌘V** on Mac or **Ctrl+V** on Windows/Linux. For a **Missing** answer, choose **Add**, enter it and **Save**. General answers such as your notice period or expected salary are kept for future applications; anything specific to this job is kept for this application only. Typing a missing general answer into the form itself keeps it too, with **Undo** in the panel.
4. Use **Show CV** to find the file to upload and **Copy intro** for a cover-letter or message box. Check the form and submit it yourself.

Saved answers work without an API key. Extra help choosing saved answers is optional in **Settings → Form filling**, using a separately billed OpenAI API key.

### Apply with Codex or Claude

Your connected AI fills the employer’s form, attaches your documents and submits for you. Ask it to apply to several jobs, or to all prepared ones, and it works through every one without stopping, then reports what it applied to, skipped and could not finish. If a website needs a security check or a field the AI cannot complete, handle that step and ask it to continue. Use the employer’s confirmation to know the application was sent.

## Back up or restore your profile

Open **Settings → Backups**.

- **Save backup** saves your profile, CVs, saved documents, jobs and applications, including their progress, to a file. Choose where to keep it. It is not password-protected, so keep it private.
- **Restore backup** lets you choose a backup file. Check the profile name, contents and any file warnings, then choose **Restore profile** to replace your current profile.
- **Open backups** shows the default backup folder, including the copy saved before a restore.

Restoring replaces the current profile in Companion. Your account connection and API keys stay unchanged. Companion saves a backup of your current profile before replacing it.

You can use a backup on another computer. If a file contains several saved profiles, choose the one you want to restore. Other saved profiles already on this computer are not replaced.

The JSON files created by the earlier **Export backup** action can also be selected. They may not include saved PDFs; the preview explains which files need to be created again. Your saved CV text and original uploaded CV files remain part of the profile.

If the profile changes while you review the backup, select the file again before restoring. An invalid file does not replace your current profile.

## Delete a CV

In **Me → CVs**, open the CV, choose **Delete CV** at the top and confirm the deletion request.

The CV is deleted locally from Companion. Other CVs, applications and backup files stay unchanged.


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

**Settings → Updates → Keep the app up to date** is on by default. Companion checks after startup, on resume when due, and every 30 minutes. It verifies the download, then restarts once nothing is running and recruiters.rip has had no requests or work for 5 minutes. Whether its window is open or you are using the computer doesn't matter. **Check now** checks immediately, **Restart now** installs a downloaded update immediately, and you can turn automatic updates off.

Quitting saves your career data without waiting for background update checks or builds.

The installed version and latest published version are shown separately. A newer local build says it is ahead of the published release; it is never downgraded or incorrectly described as the published version. No release means unavailable, not up to date.

Ready-made installs use the exact Mac arm64 ZIP, Windows x64 NSIS installer or Linux x64 AppImage. Downloads are bounded and SHA-256 verified, with official repository and target checks. Mac replacement covers apps originally installed from ZIP or DMG; Windows installs silently without killing another running app; Linux replaces the actual AppImage, not its temporary mounted folder. The previous installation is retained until the new app confirms startup. Unsafe or unwritable locations explain what needs changing rather than pretending installation succeeded.

Managed source installs fetch the exact published source, install locked dependencies and build a separate version locally before the same safe restart. They do not overwrite developer edits or switch silently to prebuilt binaries. Ordinary unmanaged clones remain under their owner's control.

Automatic-update preferences and receipts live outside career backups. Updates keep the app identity, profile and account connection; they do not reset career data. Mac releases remain ad-hoc signed, not notarized; Windows releases remain unsigned. No update requires an Apple developer key or disables operating-system protections.

## Repository boundary and privacy

The settings window's renderer makes no network requests except `<img>` loads of employer logos named by the job catalogue (https only, no referrer, in-memory session without cookies). Nothing private is sent; the logo host learns only that a logo was fetched.

This repository owns the Electron app, Chrome and Firefox extensions, local career/job/form storage, MCP tools, document engine and updater. `recruiters-rip-frontend` owns website authentication, checkout, preview hosting, pairing UI and the signed-device proxy. Middleware authorizes accounts/devices and current paid feed access. Builds and runtime never import a sibling checkout.

Local records use plain `vault.json`, without keychain storage or at-rest encryption. POSIX files/directories use 0600/0700; Windows checks owners and DACLs, allowing only the current user, SYSTEM and Administrators. The connected agent reads career context through MCP. API requests send their stated context directly to OpenAI; form preparation releases selected values to the extension; neither shows an approval dialog. Private career data never leaves this computer for the platform; only catalogue and introduction lookups by job ID are sent. Membership gates the platform feed, not captured jobs or saved records. Backups and exported documents are ordinary files; API keys are excluded. Keep vaults, exports, credentials, certificates and user data out of source control.

Installed identity stays `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, storage name **Recruiters Companion**, protocol `recruiters-companion://`. Vault paths are `~/Library/Application Support/Recruiters Companion/device/vault.json` on macOS, `%APPDATA%\\Recruiters Companion\\device\\vault.json` on Windows, and `${XDG_CONFIG_HOME:-~/.config}/Recruiters Companion/device/vault.json` on Linux. Local builds use `local-device`. Never test against real user data.

AppImage launchers retain the installed AppImage path, not its temporary mount. Native and MCP scripts are cached under the private device directory in `bridge-runtime/<version>`. **Save to Downloads** copies the validated unpacked extension to a folder in Downloads that Companion refreshes on later launches; replacing the AppImage does not invalidate the browser's loaded extension path.

AppImage bridge launchers use FUSE, not `APPIMAGE_EXTRACT_AND_RUN`. The bundled runtime's extraction output corrupts native-messaging/stdin-stdout protocols, and concurrent extraction processes share a cleanup directory. The extraction flag is not forwarded to bridge processes.

Account connection returns through a short-lived HTTP listener bound only to `127.0.0.1` on a random port, so source runs and installed apps do not depend on macOS selecting the right custom-protocol handler. The return carries its one-time state and pairing payload in the URL fragment, which the local page removes from browser history before sending a same-origin POST. Foreign origins, rebound hosts, invalid state and replayed requests are rejected. Only native account approval and successful signed platform activation produce success; the browser receives no career data or API key. The listener closes after five minutes, when starting another connection, on OS lock or on quit. Existing `recruiters-companion://` entrypoints remain supported.

## Jobs and the publication window

Start in Codex or Claude with **“Use the recruiters.rip skill to find me a job.”** The skill reads saved recommendations and career context first, then fully assesses every job the companion exposes against its complete advert, in one run and with parallel workers where the app supports them; it never pre-screens jobs from their titles or listing rows, and it starts right after onboarding without asking how many jobs to review. It acts on your task without repeated confirmation questions and asks only for missing material facts. Companion settings govern its own tools, including the saved Decisions key; they do not override your host app's access permissions or safety rules.

**Jobs** has three tabs — **Jobs · Reviewed · Blocked** — each with its live count from `career-list` `counts`. While an account is connected, Companion loads the selected window's jobs itself (at startup, after connecting, on a range change, after Clear reviews and on Retry), so **Jobs** shows the real count and rows before any AI review; saved reviews are kept when the window changes. An empty Jobs list says why, with one action: connect the account, a membership is needed, retry, or choose a longer range. Beside the publication slider sit the handoff actions **Continue in Codex**, **Continue in Claude** (shown for installed hosts; the companion opens a new conversation in its private application workspace with the review prompt filled in — you still send it) and **Copy prompt**. None launches a review by itself. The prompt is `Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.`; the skill supplies the workflow: review the exposed jobs against full adverts, save structured assessments and rerank the top recommendations pairwise.

The slider sets the publication window: **Today, Yesterday, Past 3 days, Past week, Past 2 weeks** (the MCP also accepts `past_month` and `all`). Today/yesterday follow the companion's local calendar; the other dated ranges roll back 3, 7, 14 or 30 days. The selection is saved through IPC `publication-range-set` into `career.publicationRange` (a legacy `prescanPublicationRange` value is read as fallback) and applies to the Jobs list, matching and recommendations. Today or the past 3 days work best because older listings already have many applicants.

`career_match_jobs` returns every job in the window minus blocked jobs minus established incompatibilities minus jobs already assessed under the current profile (`src/mcp/review-queue.mjs`), in catalogue order, and the agent fully assesses each of them. There is no score, threshold or per-job switch; blocking is the only exclusion. Listing-only `screened` verdicts saved by 3.12.8 are ignored, so those jobs return to the queue. Signed `matching_catalogue` requests carry `{publicationRange,since,until,offset?,countOnly?}` and receive exact SQL `total`, transport-paged `jobs`, `nextOffset` and echoed `publicationWindow`; every page is consumed. A comparable stated salary ceiling below the saved minimum is settled by the companion (`below_minimum`).

Cards show the company mark (logo when the catalogue supplies one) and three lines. A reviewed row shows **Fit** on the right, an ineligible row shows the verdict word, an open row shows nothing there. The reader shows the verdict only for reviewed and ineligible jobs; there is no metadata section. A reviewed assessment keeps its own overall fit, gates, requirements and reason. In a job reader, each saved requirement has **Add context**: it copies a bounded prompt for the connected agent to create/reuse the application, ask one focused material-gap question, save the answer as a reusable fact and reassess that job. The requirement must exactly match the saved assessment; the Companion never creates an unsupported fact directly.

The optional OpenAI key in **Settings → Form filling** serves one thing: Chrome/Firefox **Read page** known-value mapping (`src/decisions/form-mapping.mjs`, `POST /v1/decisions`). It never assesses jobs. The section states whether a key is saved (by its last four characters and save date) before any control. Enter the key and choose **Save key**; a saved key offers **Replace key** (the old key stays active until the new one is saved) and **Remove key**. Unsaved input clears on save or navigation. Saving a key sends no API request, and normal agent work needs none. Key changes, locks and career-context changes invalidate prepared form values. The vault keeps the key under `prescanCredentials`/`prescanCredentialVersion`. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

## Onboarding and companion memory

Basic preferences are required before any review: `careerPaths`, `locations`, `workModes`, `willingToRelocate` and `travel` (`ESSENTIAL_PREFERENCES` in `src/mcp/assessment-policy.mjs`). Until all are answered, `career_match_jobs` and `career_match_batch` fail with `PREFERENCES_REQUIRED` before any catalogue call; the message tells the agent to save career paths itself and lists the questions for the rest. `career_profile_read.missingPreferences` (an `action` for `careerPaths`, a `question` for the others) and `onboarding_status.actions`/`questions` carry the same, and `locallyReady` stays false. The agent saves answers with `career_preferences_update`, so they live in the vault, not in chat or host memory.

`careerPaths` is the single list of directions to search: up to 10 paths `{name, titles, why}`, each with 1–20 concrete titles (seniority variants and common synonyms) and a one-sentence reason citing CV or fact evidence. Path names and the titles within a path must be distinct (case-insensitive). At the first preferences step, and whenever `careerPaths` is missing, the agent reads every CV and saved fact end to end, saves every path with good success chances (current trajectory, step-up, adjacent functions, agency/consultancy/enterprise variants, supported sector pivots, fractional/interim/founder-style roles) without asking and starts the search in the same turn. There is no approval gate on preferences; native approval stays only for account pairing, **Delete CV** and updates. The direction gate passes a job whose remit fits any saved path. `excludedRoles` holds role families to avoid and `notes` only nuance. The former `roles`/`acceptedAlternatives` lists are dropped on startup and restore, so existing profiles are asked for paths once before their next search. Me → **Preferences** shows that exact saved record in Direction, Location, Employment and Work groups; apart from confirmed career paths, it never infers preferences from the CV. Every `career_match_batch` result re-supplies the saved `candidate` (CV, facts, complete preferences) and `profileVersion`, so reviewers in a new session or after compaction assess against the companion's copy.

Job discovery uses only the Recruiters.rip catalogue. The agent never suggests or performs searches on LinkedIn, company careers pages, other job boards or the web; adverts the candidate captures or pastes are still assessed. Thin results mean revisiting career paths and the publication window.

Only one companion process serves a storage directory. Startup claims a kernel-held lock: macOS `O_EXLOCK`, a Linux abstract socket, or a Windows named pipe. Local MCP and native-browser bridges use authenticated Unix sockets on POSIX and deterministic per-directory named pipes on Windows. A second process cannot open a competing in-memory vault; process exit releases the lock.

## GitHub warm introductions


GitHub is optional: `account_github_connect` opens `recruiters.rip/account#github`, where developers link GitHub through Privy. `account_status` reports `platform.github.login` once middleware has synchronized it. The link is what makes warm intros possible. `onboarding_status.github` reports the local skipped/requested state; `career_introductions_update` records only `githubSkipped`.

Warm intros (recruiters.rip connections) come from recruiters.rip's GitHub collaboration graph. The agent looks them up on its own whenever it works on platform jobs: presenting recommendations or matches, preparing an application, and once up front for every job in an apply run. `career_intro_paths({jobIds})` takes up to 10 platform job IDs and sends the `intro_paths` platform operation; middleware requires current paid membership and the owner's linked GitHub login (`github: null` with `reason: "github_required"` otherwise), resolves each job's employer to its linked GitHub organizations, and asks the scorer for the best path per person from the owner into those organizations: direct coworkers (`hops: 1`, `direct`) and people reachable through one shared contact (`hops: 2`, `1-intermediary`). Each path carries GitHub identities (login, name, avatar, profile URL), up to three verified commit emails per person, and the shared organization, overlap end date and repositories per edge as evidence. Only `one_hop_paths` and `two_hop_paths` are read; `three_hop_paths` is never queried. The skill presents at most three people per job as people the candidate knows at that company, inferred, not confirmed, and drafts the candidate's own ask for a referral right away without offering first; the companion never sends the message. The scorer's `source` label is dropped before the result reaches the agent. A scorer outage returns `available: false` with empty paths, and an employer without a linked GitHub organization has empty `orgLogins`.

## Recommendation policy

Every assessment is structured: up to 12 requirements read from the advert before candidate evidence (essential/preferred; demonstrated/transferable/missing/contradicted, with demonstrated and transferable evidence citing a verbatim CV quote or saved fact IDs), three gates (direction, constraints, eligibility: pass/flag/fail), four 0–100 dimensions (direction, capability, scope, preferences), relocation and a reason. The companion, not the model, computes overall fit `round(0.30·direction + 0.25·capability + 0.15·scope + 0.30·preferences)`, the band (strong ≥75, good ≥60, moderate ≥45, weak ≥30, poor) and the decision: any gate fail or contradicted essential requirement → skip; any gate flag or missing essential requirement → clarify; otherwise overall ≥60 → recommend, else skip. `career_match_save` rejects uncited (`UNSUPPORTED_REQUIREMENT`), non-verbatim (`UNKNOWN_QUOTE`) or unknown-fact (`UNKNOWN_FACT`) evidence.

All model-facing matching material — protocol, policies, weights, bands, schemas, tool descriptions and the skill — lives in `src/mcp/matching-contract.mjs` and is fingerprinted as `policyId` (the build writes the skill digest to `src/generated/skill-digest.mjs`). Any change makes saved assessments `needs_review` and saves with an old `policyId` fail with `POLICY_CHANGED`; nothing is rescored automatically.

A positive saved `salaryMinimum` is a hard floor that applies only to adverts stating comparable pay. Comparable stated pay below it cannot enter recommendations; the server rejects a save for that known mismatch unless `gates.constraints` is `fail`. Ranges that reach the floor remain possible. Adverts without stated pay, or with pay in another currency or an unconvertible period, pass the salary condition in agent review: the rubric forbids failing, flagging, marking uncertain or scoring them down for it, because unstated pay is common and excluding it would drop good jobs. Currency or hourly/day-rate uncertainty is never silently converted into a budget claim.

The shared policy separates career intent from capability and assumes no profession, management ambition, seniority goal or preferred career path. The user's saved career paths, goals and constraints define the intended next move, including deliberate lateral moves, career changes or reduced responsibility; a job is on direction when its remit fits any one saved path. Capability overlap cannot override an explicit intent conflict (a direction gate fail), and overlapping duties do not silently expand a path. Personal restrictions belong in the user's preferences, not shared prompts. Capability is assessed from demonstrated responsibilities across the whole career rather than exact CV phrases, without inventing historical activities, metrics, credentials or specialist expertise.

After matching coverage is complete, the coordinator calls `career_rerank_pairs` (the top six current recommendations by overall fit and their unjudged pairs), judges each pair itself and saves the judgments with `career_rerank_save`. `career_recommendations` orders compared rows by pairwise wins (equal counts half), then overall fit, date and ID, followed by uncompared rows. Re-saving an assessment drops its comparisons.

Mandatory user conditions apply to every career path; a broad interest does not waive a narrower requirement. Interpret the user's distinction between a role's predominant work and incidental responsibilities without imposing that distinction on other users.

Preference changes use `career_preferences_update({requestId, revision, patch})`. `requestId` must be a UUID returned by `request_id`, and `revision` must be the current integer from `career_profile_read`. A descriptive request label is invalid. Rejected calls leave preferences untouched and identify the invalid or missing schema field without echoing supplied values. Always confirm persisted preferences through readback.

Say **“Reassess roles.”** The host performs one ranking reset, then reviews again. Discovery uses the selected publication range and complete originals; status/resume requests do not clear work. Default scope is Past 3 days, but explicitly broader scopes are never silently clipped. An empty or obsolete cache is not a completed search with no suitable jobs.

The companion's **Clear reviews** action and `career_rankings_delete` clear rankings, pairwise comparisons and cached jobs. They preserve profile, preferences, CVs, facts, job applications, account data and API credentials. A reset invalidates in-flight writers so deleted results cannot reappear. `career_match_jobs.profileVersion` binds profile changes and ranking resets; bounded saved-job reassessments can read it as `career_profile_read.matchingProfileVersion`.

Navigation is **Me / Jobs / Settings / Help**; Me opens by default. Me keeps **Import CV** and **Jobs**, with account/setup guidance when needed, above **CVs / Facts / Preferences**. The CV detail starts with **Delete CV**; a red border distinguishes this destructive action. Generated files belong to their jobs and applications through **Open CV / Open letter**, not to a global file button in Me. Settings has **General / Backups** subtabs: General holds account, app, browser, form and update controls; Backups holds save, preview, restore and folder actions. Manual setup for any agent is one copyable prompt in **AI apps**. Import and restore use native file pickers, never renderer-supplied paths. Locked storage, account connection and explicit CV deletion confirmation retain their boundaries. Automatic updates use the saved update preference and safe restart admission, not a per-release approval dialog.

Backup JSON version 2 contains profile records and SHA-256-verified document bytes, limited to 128 MiB per file, 100 profiles and 2,000 saved documents. Original CV files are limited to 5 MiB and saved documents to 12 MiB each. Current career-schema-2 records in version-1 exports remain importable; unsupported career schemas fail rather than passing through the destructive schema upgrade. Missing historical files are disclosed. Restore materializes only each application's current document version, independent of historical-record ordering. Restores retain sign-in, device identity, credentials, other identity archives, while clearing runtime receipts and invalidating stale operations. Failed restores roll back replacements and newly created files without removing preexisting exports.


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

Browser form answers use one native operation, `forms_answer_save` `{requestId, formId, snapshot, fieldId, value, source: 'panel' | 'page'}` (`value: null` undoes), bound to the current prepared snapshot's missing fields and validated against the inspected field. Companion classifies the field from its label (`src/browser-forms.mjs`), never trusting the extension: contact fields (including labels that contain an unambiguous concept such as LinkedIn) go to the profile, general sponsorship and relocation to preferences, and the fixed topics Notice period, Expected compensation, GitHub profile, Portfolio or website and Spoken languages to one generic fact each. Referral-source questions ("How did you hear about this job?") are always answered without a key: the user's own saved answer, else `Recruiters.rip` for text or the closest choice (job board, online, website, other), else the first option; a **Change** in the panel or typing a different answer on the page saves the user's own answer for future applications. Current-location questions ("Where are you currently located?", including custom location pickers, whose saved value is shown to type) use `profile.location` (`note`, or `yes_no`/`choice` for choice fields; no employer or application; re-saving updates it). Read page then fills those fields without an API key. Everything else is saved only as this form's user answer, and text typed on the page that is not generic is never stored. Protected/demographic fields, salary history, references, criminal history and other people's contacts are never stored. A saved answer re-binds current form drafts, application answers and documents to the new career context so other ready answers stay ready, and it does not change `profileVersion` or trigger reassessment.

## CV and cover letters

1. `career_application_create` takes a catalogue `jobId`, complete captured job or pasted advert `{title, company, description, url}` and reuses the same exact saved application. Pasted/captured adverts need no catalogue membership. Identity uses job IDs and canonical URL/recognized ATS role routes, never employer/title alone.
2. `career_application_context` returns the full job, profile, saved CV, facts, current assessment, writing guide, `contextFingerprint`, and attached `forms`. Reuse only drafts/exports bound to that current fingerprint and document version. Missing/stale originals and ambiguous job associations stay explicit. During submission review ask only material job-dependent gaps, then reread context.
3. The host plans from the assessment's requirements, then writes the CV as a structured document (headline, summary, optional highlights, experience with bullets, skills, languages, education, certifications, additional sections) and saves it with `career_application_cv_save`. Every highlight and bullet is `{text, support}` citing verbatim CV quotes (`support.cv`) and/or saved fact IDs (`support.facts`). Support stays in the stored draft for validation and never reaches rendered TXT/PDF. The header comes from the profile.
4. Saves reject invented employers (`UNKNOWN_EMPLOYER`), non-verbatim quotes (`UNKNOWN_QUOTE`), unknown facts (`UNKNOWN_FACT`), bullets citing another employer's fact (`MISATTRIBUTED_FACT`), numbers absent from a claim's own cited evidence or, outside claims, from the CV, profile or saved answers (`UNSUPPORTED_NUMBER`) and narrated, hedged or third-person wording (`UNCLEAR_FACT`, `CV_TONE`). Other quality notes are returned as `issues` for the host to fix silently.
5. `career_application_letter_save` stores the cover letter as paragraphs with the same checks.
6. `career_application_export` renders PDF (classic or modern, A4 or Letter, 11pt) or TXT; PDF text is read back before the file is saved.

For an agent-led application, export both current PDFs before `career_application_open({applicationId})` opens its saved URL in the user's default browser. Use Chrome or Firefox with the corresponding extension. Reading the application page links its questions back to that application; the active agent discovers them in `career_application_context.forms`, stages the short personal summary and other narrative answers, and the panel refreshes. Reopening the job reuses current outputs rather than regenerating them.

For a web-led application, choose an AI app under **For this job**, then **Continue in Codex** or **Continue in Claude** to create a durable preparation request. `career_application_preparation_read({preparationId})` supplies the original or exact source link and captured questions, including labelled button groups such as Ashby's Yes/No. If no full job is saved, the host retrieves that advert, creates the application and calls `career_application_preparation_bind`. It then uses the same document/answer tools as the agent-led path and answers every captured question the CV, saved facts or profile support: written answers from evidenced experience, Yes/No or other choices only when the evidence settles them, eligibility and sponsorship only from explicit saved statements; the rest stay missing. These answers are bound to the application, exact question/type/options and career context; they cannot leak into another employer's form. Agent answers to generic questions (notice period, languages, GitHub, portfolio, compensation) are also kept as the same reusable facts as the user's own answers. The panel shows agent answers as soon as they are saved, with **Choose Yes**-style status for options to click. The browser exposes current PDFs through **Open**/**Show in folder** for native file selection; no automatic upload is claimed.

Desktop host links carry only the preparation UUID and fixed instructions, never CV text or keys. Claude uses documented `claude://code/new?q=…&folder=…`; the installed ChatGPT/Codex route is `codex://threads/new?prompt=…&path=…&mode=codex`. Both prefill the composer without sending. CLI handoff instead opens a detected terminal with the exact prompt and waits for Enter before starting the interactive host. The request uses the connection Set up installed for that app (MCP server `recruiters-rip`: the Codex plugin, Claude's `claude_desktop_config.json` or Claude Code's user scope), which loads in every folder, so nothing asks to approve a workspace; the prompt names that server and, if the session has no recruiters.rip tools, tells the user to choose Set up and restart the app. The application workspace is an empty private folder; Companion removes the workspace-scoped `recruiters-rip-applications` entry earlier versions wrote there. Readiness derives from saved, current artifacts and verified local files, not a successful launch. Metadata polling stops when the panel closes or changes page and pauses after twenty minutes until **Read page** resumes it.

The candidate is not asked to approve wording, templates or checklists. Exporting documents does not submit an application. If the user explicitly requests submission, continue through the real employer flow within that authorization and report the observed confirmation or specific blocker. An apply request covering several jobs runs to completion: saved records decide what was already sent (marked applied with its date), duplicates are applied once, test records are skipped, stale documents are rebuilt, and only a CAPTCHA, a user-owned login, an unsupported required answer, payment or an unconfirmed submit blocks a job; one final table lists applied, skipped and blocked jobs.

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

The package version is the source of truth for Electron, the MCP server, and generated plugin manifests. Build tooling, the app icon and macOS entitlements live in `scripts/`; `build/` is ignored by Git. `scripts/runtime.mjs` bundles owned document source and emits `src/generated/document-engine.cjs`, font/rubric assets, the local MCP launcher and the `recruiters-rip-plugin` directory (whose skill Claude Set up also copies to `~/.claude/skills`). `pnpm package:mcp` emits the plugin without Electron packaging. Generated output and `dist/` are ignored by Git.

Every runtime build and standalone MCP packaging command deletes the entire repository `dist/` before generating artifacts. Electron Builder also cleans it once before packaging, including direct CLI invocations and signed releases. Old versions and alternate build folders are not retained; do not run independent builds concurrently. Since `start` and `test` build runtime assets, they clear `dist/` too. Install the companion in Applications rather than running the installed MCP from disposable build output.

`src/documents/package.json` declares a CommonJS source boundary because the document build transpiles TypeScript to CommonJS before bundling. Keep that boundary separate from the Electron application's root ES-module package.

## Distribution

| Build command | Native runner | Artifacts |
| --- | --- | --- |
| `pnpm package:adhoc` | macOS arm64 | `recruiters-rip-companion-<version>-mac-arm64.zip` and `.dmg`, ad-hoc signed, not notarized |
| `pnpm package:win` | Windows x64 | `recruiters-rip-companion-<version>-win-x64.exe`, per-user NSIS installer |
| `pnpm package:linux` | Linux x64 | `recruiters-rip-companion-<version>-linux-x64.AppImage` |
| `pnpm package:local` | Any supported runner | Isolated unpacked developer app, no production protocol registration |

The native CI matrix builds, checks and packages on Mac, Windows and Linux, then exercises installation and replacement with synthetic profiles. Candidate artifacts pass the current updater's verification and handoff path, launch the expected version, confirm startup and preserve synthetic data. A pinned public binary serves only as a disposable replacement fixture, not an old-version compatibility requirement. Targeted helper regressions cover failed-startup rollback.

After all native gates pass on an eligible main commit, the release job assembles a draft containing the exact source version's installers, browser archives, source installers and SHA-256 sums. It publishes only the complete verified inventory. Runtime/package changes require a version increase; existing public version assets are never overwritten. Documentation-only changes do not republish a version.

Official hosted downloads synchronize verified published releases into an atomically switched directory. A complete validated set becomes visible together; the previous set is retained for recovery. The website's read-only mount points to the stable parent directory, not an individual file or the exchanged directory inode.

`pnpm package:release` still requires genuine signing/notarization credentials for signed Mac packaging; `pnpm package:adhoc` is the no-Apple-key route. Windows builds without signing credentials remain unsigned. A Firefox source ZIP is not a Mozilla-signed permanent add-on. Source installers build locally from the official published commit. No command disables operating-system security controls.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.

## License

Companion is source-available under the [Business Source License 1.1](LICENSE). You may use it for your own job search; offering it as a product or service to others is not permitted. Each version becomes Apache-2.0 on 2030-10-31.
