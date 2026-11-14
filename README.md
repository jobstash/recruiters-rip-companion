# Recruiters.rip Companion

Companion keeps your CVs and applications on your computer. Use Codex or Claude to find suitable jobs, tailor your documents and apply for you. Install a ready-made app, build it from the [public source code](https://github.com/jobstash/recruiters-rip-companion), or [run it in a container](#run-in-a-container).


## Start here

You need Companion, a readable CV, and your own Codex or Claude account. The same account and subscription requirements apply whether you download the app or build it from source. Any charges for your AI app are separate. The browser extension is optional.

### 1. Install Companion

Open [Downloads](https://recruiters.rip/downloads) and choose **Mac**, **Windows** or **Linux**, then follow the steps for your computer. Prefer to build it yourself? Use the [one-command source installation](#install-from-source), or [run it in a container](#run-in-a-container) and use it from your browser.

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

When you first ask your AI app to generate a CV, it reviews all your original CVs for achievements, growth and difficult assignments in each role. It reuses what is already known and asks you for missing details. Numbers help when you can substantiate them; qualitative results are fine too.

The result appears in **Me → Master CV**. Edit your contact details, bio and experience there, then choose **Save changes**. You can export the current master as PDF or text. New CV imports trigger another review without discarding your answers or edits. Copies tailored to individual jobs do not overwrite the master.

### 4. Add recruiters.rip to Codex or Claude

In **Settings → AI apps**, follow the steps for one app:

1. If it is missing, choose **Get Codex** or **Get Claude**, install it and sign in. On Linux, these links lead to apps that run in Terminal; follow their official installation guides.
2. **Add recruiters.rip:** choose **Set up**. For Claude this adds recruiters.rip to Claude's settings file (`claude_desktop_config.json`, other entries kept) and installs the recruiters.rip skill in `~/.claude/skills`; for Codex it installs the plugin. The app shows **Added** once its settings include recruiters.rip, and **In use now** while a session that Continue can use is open.
3. **Restart the app** so it loads recruiters.rip: quit Claude completely and reopen it, restart Codex, or start a new Claude Code session. Companion shows this line until that app is in use.
4. **Start a job search:** choose **Continue in Codex** or **Continue in Claude**. Its reviews appear in **Jobs → Reviewed**.

Companion automatically refreshes recruiters.rip skills for configured Claude and Codex installations on every start, including the first start after an update. You do not need **Set up** again after a normal Companion upgrade. Start a new conversation to load changed instructions; an already-open conversation may keep the old skill. If an update fails, Companion names the affected app and explains recovery without blocking your saved work or Jobs.

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

Open **Pipeline**. Every application sits in one column: **Prepared · Applied · Interviewing · Offer · Hired · Closed** (Closed holds rejected and withdrawn ones), each with its count. All six separate lanes fit the default window; narrower windows scroll sideways, and each lane scrolls vertically on its own. A card shows the role, company and where it stands with the date of the last step (**Round 2 · 30 Oct**). Interviewing cards also show **Next interview · 12 Nov** when you have saved a date.

To move a card, drag it to another column, choose **Set status…** on the card, or press **←** / **→** while the card has focus. Moving forward fills in the steps it skips, dated today; moving back undoes steps; moving to **Closed** asks **Rejected** or **Withdrew** on the card, with **Cancel** to keep the current status. **Next round** on an Interviewing card adds an interview round.

Select a card to open it beside the board. **Progress** at the top offers only the next steps (**Mark applied**; then **Interview invite** or **Rejected**; then **Next round**, **Offer** or **Rejected**; then **Accepted** or **Declined**; **Withdrew** where it applies). A step is dated today: set **Date** first, or fix it afterwards with **Change date**; **Undo last step** removes a step recorded by mistake. Below are the history, **Open job**, **Open CV**, **Open letter** and the saved CV and letter text. **Close** or **Esc** returns to the card.

While Interviewing, set **Next interview date (optional)** and choose **Save date** to record a future appointment separately from the history. **Clear date** removes it; saving an empty field also clears it. Advancing to the next round or leaving Interviewing clears the old appointment so it cannot be mistaken for the next interview.

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

## Show career gaps in generated CVs — optional

In **Me → CVs**, tick **Career gap detection**. It is off until you tick it. These choices then appear.

What counts as a gap:

- **From year / To year**: the years to check for gaps. The default is the past ten years.
- **Minimum months**: how long a period without a job must be to count. Three months is the shortest and the default.

How each gap is listed, with the same four parts as a job:

- **Activity**: what you did, such as `Career break`, `Parental leave` or `Full-time study`. It starts as `Career break`.
- **Place** (optional): where, such as a city or country.
- **Time range**: taken from the dates in your CV; you do not type it.
- **Description** (optional): one line about that time. It starts as `Career gap period - private reasons`.

When your AI app next prepares a CV, a period that long between two jobs in your saved CV (or since your last job ended) is listed in **Experience** among your jobs, where its dates fall, laid out like a job: place and activity, the dates, and your description beneath. It has no separate section. The words are exactly what you entered here: your AI app only works out the dates, and does not add an employer, job title or achievements to a gap or count it as work experience. Documents prepared before you changed the setting are refreshed the next time your AI app prepares them. Untick the checkbox to stop showing gaps.

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

## Run in a container

The same Companion, built from this source inside Docker and shown in your browser instead of an app window. You need **Git** and **Docker** with Compose (Docker Desktop includes it); nothing else is installed on your computer. The image is built on your machine from a pinned, patched Node base image. No ready-made image is published.

```sh
git clone https://github.com/jobstash/recruiters-rip-companion.git
cd recruiters-rip-companion
docker compose up -d --build
docker exec recruiters-companion companion url
```

Open the address the last command prints. It carries an access code, and that browser then stays signed in. From there the steps in [Start here](#start-here) are the same: connect your account, import your CV, add recruiters.rip to Codex or Claude, review jobs.

What works differently from the app:

| You want to | In the container |
| --- | --- |
| Import a CV or restore a backup | Choose the file in the browser; it is uploaded to Companion on your own computer. |
| Open a CV or letter, save a backup | The browser opens or downloads the file. |
| Add Codex, Claude or another agent | **Settings → AI apps → Copy prompt**, then paste it into your agent. Its commands start the tools with `docker exec -i recruiters-companion …`, so the container must be running when you use your AI app. Companion cannot open your AI app for you; it copies the message to paste instead. |
| Add the browser extension | **Settings → Browser extensions** shows one command per browser, such as `docker exec recruiters-companion companion browser chrome \| sh`. Run it in a terminal on your computer: it saves the extension to Downloads and lets the browser reach the container. Then load the folder as described there. Mac and Linux only. |
| Update | `git pull`, then `docker compose up -d --build`. Run the browser extension command again so the extension folder matches the new version. **Settings → Updates** tells you when a newer version is published. |
| Stop or remove | `docker compose stop` stops it. `docker compose down` removes the container and keeps your data; adding `-v` deletes your data too. |

Your profile, CVs, jobs and documents live in the Docker volume `companion-data`, not in the source folder, and survive rebuilds. Use **Settings → Backups → Save backup** to keep a copy outside Docker.

<details>
<summary>Container details and limits</summary>

- **Reach:** Companion listens only on this computer (`127.0.0.1:43117`). The page needs the access code, refuses requests that arrive under any other address or from another website, and the container itself runs without root, without extra privileges and with a read-only file system apart from its data volume.
- **Another port or name:** the published port and `RECRUITERS_COMPANION_WEB_PORT` must be the same number, and `RECRUITERS_COMPANION_CONTAINER` must equal the container’s name. Without Compose: `docker build -t recruiters-companion .`, then `docker run -d --name recruiters-companion --init -p 127.0.0.1:43117:43117 -v companion-data:/data recruiters-companion`.
- **Files your AI app exports** are inside the container. The tool result says so and gives the `docker cp` command that copies the file out; **Pipeline → Open CV / Open letter** opens it in the browser.
- **Not available:** the browser extension for browsers on Windows (use the Windows installer), opening Codex or Claude from Companion, **Open backups**, in-place updates, and locking saved work when the computer sleeps or its screen locks. Do not run the container and the installed app for the same browser extension at once: the most recently set-up one receives the extension.
- **Without Docker:** `pnpm install --frozen-lockfile && pnpm build && node src/main.mjs` serves the same browser screens from Node on this computer, with no Electron window.
- **Check a build:** `pnpm smoke:container` builds the image and exercises the browser screens, the AI-app tools over `docker exec` and the browser setup script with throwaway synthetic data.
</details>

## Developer setup

<details>
<summary>Build from source and package extensions</summary>

See [AGENTS.md](AGENTS.md) for ownership and safety boundaries, and [design.md](design.md) for the interface rules.

Use Node 24 or newer and pnpm 10.34.9:

```sh
git clone https://github.com/jobstash/recruiters-rip-companion.git
cd recruiters-rip-companion
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` builds the tools, document engine and browser extensions before opening Electron. Use `pnpm start:local` for isolated development, never a user's vault.

After `pnpm build:runtime`, `node scripts/smoke-host-skills.mjs --codex=/absolute/path/to/codex` exercises automatic skill refresh with real Electron and Codex CLI on macOS or a Linux desktop. It creates disposable HOME, custom host-config and Electron user-data directories, seeds a stale real Codex plugin cache, then checks refresh, an unchanged second boot, an independent host failure and next-boot recovery. It never invokes Companion’s manual Set up, uses no real vault or host configuration, and prints screenshot paths. This is a source-build smoke, not a packaged upgrade or proof that existing AI conversations reload instructions.

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

Each boot refreshes configured Claude skills and Codex plugin files, including installed plugin caches, before accepting AI-app sessions. Unchanged files are left alone; unrelated host settings, sign-in and permissions are preserved. Companion never closes or restarts Claude or Codex.

## Repository boundary and privacy

The settings window's renderer makes no network requests except `<img>` loads of employer logos named by the job catalogue (https only, no referrer, in-memory session without cookies). Nothing private is sent; the logo host learns only that a logo was fetched.

This repository owns the Electron app, Chrome and Firefox extensions, local career/job/form storage, MCP tools, document engine and updater. `recruiters-rip-frontend` owns website authentication, checkout, preview hosting, pairing UI and the signed-device proxy. Middleware authorizes accounts/devices and current paid feed access. Builds and runtime never import a sibling checkout.

Local records use plain `vault.json`, without keychain storage or at-rest encryption. POSIX files/directories use 0600/0700; Windows checks owners and DACLs, allowing only the current user, SYSTEM and Administrators. The connected agent reads career context through MCP. API requests send their stated context directly to OpenAI; form preparation releases selected values to the extension; neither shows an approval dialog. Private career data never leaves this computer for the platform; only catalogue queries and GitHub source/target identities for introduction lookups are sent. Membership gates the platform feed, not captured jobs or saved records. Backups and exported documents are ordinary files; API keys are excluded. Keep vaults, exports, credentials, certificates and user data out of source control.

Installed identity stays `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, storage name **Recruiters Companion**, protocol `recruiters-companion://`. Vault paths are `~/Library/Application Support/Recruiters Companion/device/vault.json` on macOS, `%APPDATA%\\Recruiters Companion\\device\\vault.json` on Windows, and `${XDG_CONFIG_HOME:-~/.config}/Recruiters Companion/device/vault.json` on Linux. Local builds use `local-device`. Never test against real user data.

AppImage launchers retain the installed AppImage path, not its temporary mount. Native and MCP scripts are cached under the private device directory in `bridge-runtime/<version>`. **Save to Downloads** copies the validated unpacked extension to a folder in Downloads that Companion refreshes on later launches; replacing the AppImage does not invalidate the browser's loaded extension path.

AppImage bridge launchers use FUSE, not `APPIMAGE_EXTRACT_AND_RUN`. The bundled runtime's extraction output corrupts native-messaging/stdin-stdout protocols, and concurrent extraction processes share a cleanup directory. The extraction flag is not forwarded to bridge processes.

Account connection returns through a short-lived HTTP listener bound only to `127.0.0.1` on a random port, so source runs and installed apps do not depend on macOS selecting the right custom-protocol handler. The return carries its one-time state and pairing payload in the URL fragment, which the local page removes from browser history before sending a same-origin POST. Foreign origins, rebound hosts, invalid state and replayed requests are rejected. Only native account approval and successful signed platform activation produce success; the browser receives no career data or API key. The listener closes after five minutes, when starting another connection, on OS lock or on quit. Existing `recruiters-companion://` entrypoints remain supported.

## Jobs and the publication window

Start in Codex or Claude with **“Use the recruiters.rip skill to find me a job.”** The skill reads saved recommendations and career context first, then fully assesses every job the companion exposes against its complete advert, in one run and with parallel workers where the app supports them; it never pre-screens jobs from their titles or listing rows, and it starts right after onboarding without asking how many jobs to review. It acts on your task without repeated confirmation questions and asks only for missing material facts. Companion settings govern its own tools, including the saved Decisions key; they do not override your host app's access permissions or safety rules.

**Jobs** has three tabs — **Jobs · Reviewed · Blocked** — each with its live count from `career-list` `counts`. While an account is connected, Companion loads the selected window's jobs itself (at startup, after connecting, on a range change, after Clear reviews and on Retry), so **Jobs** shows the real count and rows before any AI review; saved reviews are kept when the window changes. An empty Jobs list says why, with one action: connect the account, a membership is needed, retry, or choose a longer range. Beside the publication slider sit the handoff actions **Continue in Codex**, **Continue in Claude** (shown for installed hosts; the companion opens a new conversation in its private application workspace with the review prompt filled in — you still send it) and **Copy prompt**. None launches a review by itself. The prompt is `Use the recruiters.rip skill to review the jobs queued for you and show me the best matches.`; the skill supplies the workflow: review the exposed jobs against full adverts, save structured assessments and rerank the top recommendations pairwise.

The slider sets the publication window: **Today, Yesterday, Past 3 days, Past week, Past 2 weeks** (the MCP also accepts `past_month` and `all`). Today/yesterday follow the companion's local calendar; the other dated ranges roll back 3, 7, 14 or 30 days. The selection is saved through IPC `publication-range-set` into `career.publicationRange` (a legacy `prescanPublicationRange` value is read as fallback) and applies to the Jobs list, matching and recommendations. Today or the past 3 days work best because older listings already have many applicants.

`career_match_jobs` returns every job in the window minus blocked jobs minus established incompatibilities minus jobs already assessed under the current profile (`src/mcp/review-queue.mjs`), in catalogue order, and the agent fully assesses each of them. There is no score, threshold or per-job switch; blocking is the only exclusion. Listing-only `screened` verdicts saved by 3.12.8 are ignored, so those jobs return to the queue. Signed `matching_catalogue` requests carry `{publicationRange,since,until,offset?,countOnly?}` and receive exact SQL `total`, transport-paged `jobs`, `nextOffset` and echoed `publicationWindow`; every page is consumed. A comparable stated salary ceiling below the saved minimum is settled by the companion (`below_minimum`).

Cards show the company mark (logo when the catalogue supplies one) and three lines. A reviewed suitable row shows **Fit** on the right; ineligible and open rows have no status column. An ineligible reader shows the exact saved assessment reason once, as its headline, for both current and established incompatibilities. Without a saved reason it omits that verdict block rather than inventing an explanation. There is no generic exclusion subtitle or disclaimer, and all assessment charts use **Fit**. A reviewed assessment keeps its own overall fit, gates, requirements and reason; these presentation choices do not change matching, gating, sorting or stored assessments. In a job reader, each saved requirement has **Add context**: it copies a bounded prompt for the connected agent to create/reuse the application, ask one focused material-gap question, save the answer as a reusable fact and reassess that job. The requirement must exactly match the saved assessment; the Companion never creates an unsupported fact directly.

The optional OpenAI key in **Settings → Form filling** serves one thing: Chrome/Firefox **Read page** known-value mapping (`src/decisions/form-mapping.mjs`, `POST /v1/decisions`). It never assesses jobs. The section states whether a key is saved (by its last four characters and save date) before any control. Enter the key and choose **Save key**; a saved key offers **Replace key** (the old key stays active until the new one is saved) and **Remove key**. Unsaved input clears on save or navigation. Saving a key sends no API request, and normal agent work needs none. Key changes, locks and career-context changes invalidate prepared form values. The vault keeps the key under `prescanCredentials`/`prescanCredentialVersion`. See [Decisions documentation](https://developers.openai.com/api/docs/guides/decisions) and [API reference](https://developers.openai.com/api/reference/resources/decisions).

## Onboarding and companion memory

Basic preferences are required before any review: `careerPaths`, `locations`, `workModes`, `willingToRelocate` and `travel` (`ESSENTIAL_PREFERENCES` in `src/mcp/assessment-policy.mjs`). Until all are answered, `career_match_jobs` and `career_match_batch` fail with `PREFERENCES_REQUIRED` before any catalogue call; the message tells the agent to save career paths itself and lists the questions for the rest. `career_profile_read.missingPreferences` (an `action` for `careerPaths`, a `question` for the others) and `onboarding_status.actions`/`questions` carry the same, and `locallyReady` stays false. The agent saves answers with `career_preferences_update`, so they live in the vault, not in chat or host memory.

`careerPaths` is the single list of directions to search: up to 10 paths `{name, titles, why}`, each with 1–20 concrete titles (seniority variants and common synonyms) and a one-sentence reason citing CV or fact evidence. Path names and the titles within a path must be distinct (case-insensitive). At the first preferences step, and whenever `careerPaths` is missing, the agent reads every CV and saved fact end to end, saves every path with good success chances (current trajectory, step-up, adjacent functions, agency/consultancy/enterprise variants, supported sector pivots, fractional/interim/founder-style roles) without asking and starts the search in the same turn. There is no approval gate on preferences; native approval stays only for account pairing, **Delete CV** and updates. The direction gate passes a job whose remit fits any saved path. `excludedRoles` holds role families to avoid and `notes` only nuance. The former `roles`/`acceptedAlternatives` lists are dropped on startup and restore, so existing profiles are asked for paths once before their next search. Me → **Preferences** shows that exact saved record in Direction, Location, Employment and Work groups; apart from confirmed career paths, it never infers preferences from the CV. Every `career_match_batch` result re-supplies the saved `candidate` (CV, facts, complete preferences) and `profileVersion`, so reviewers in a new session or after compaction assess against the companion's copy.

Job discovery uses only the Recruiters.rip catalogue. The agent never suggests or performs searches on LinkedIn, company careers pages, other job boards or the web; adverts the candidate captures or pastes are still assessed. Thin results mean revisiting career paths and the publication window.

Only one companion process serves a storage directory. Startup claims a kernel-held lock: macOS `O_EXLOCK`, a Linux abstract socket, or a Windows named pipe. Local MCP and native-browser bridges use authenticated Unix sockets on POSIX and deterministic per-directory named pipes on Windows. A second process cannot open a competing in-memory vault; process exit releases the lock.

## GitHub warm introductions


GitHub is optional: `account_github_connect` opens `recruiters.rip/account#github`, where developers link GitHub through Privy. `account_status` reports `platform.github.login` once middleware has synchronized it. Linking supplies the default source for introductions; explicit user or organization sources do not require the candidate's GitHub link. `onboarding_status.github` reports the local skipped/requested state; `career_introductions_update` records only `githubSkipped`.

Warm intros (recruiters.rip connections) query GitHub person/organization → person/organization, independently of jobs, company vacancies, blocklists or publication dates. `career_intro_paths({source?, targets})` accepts endpoints `{login, kind: "user" | "organization"}` and 1–20 targets. Strict GitHub logins are lowercased and deduplicated by kind/login; URLs, job IDs and unknown fields are rejected. The tool forwards only these endpoints to the membership-gated `intro_paths` operation. Middleware resolves an omitted source to the linked GitHub user; an explicit source supports all four user/org combinations.

The agent looks up actual company accounts automatically when presenting recommendations or matches, preparing applications, and up front for every company in an apply run, including local captures. It uses saved GitHub URLs or verified official company/public GitHub metadata, not company-name slugs. For example, [LI.FI's official site](https://li.fi) links to [lifinance](https://github.com/lifinance/). This bounded identity lookup is not external job-board discovery. Direct requests need no job, and the agent never fetches or widens the catalogue/publication window to find a connection. Job-to-target associations remain local; no CV, advert or employment history is sent for introductions.

Results retain `{source, available, asOf, inferred, coverage, targets}` and group paths by target login/kind, not job. Paths preserve target/via identities, verified commit emails, collaboration edges and `warmScore`, with `source` identifying the actual source person and `sourceEvidence`/`targetEvidence` describing organization contributions. An organization-origin route must name the contributor forming the bridge; contribution evidence proves neither employment nor personal acquaintance. `hops: 0`, `tier: "same-person"` is one shared contributor, not a coworker edge or someone to ask to introduce themselves; nullable scores are not a confidence claim.

The skill presents at most three possible introductions per target and drafts asks immediately, without offering first. Default-source drafts are in the candidate's voice; explicit-source drafts identify the person whose route it is, and organization-source drafts are for the named contributor to review/send. Direct requests without a job omit invented vacancy details. The companion never sends messages or attaches a CV. Missing default source (`source: null`, `reason: "github_required"`), unavailable service (`available: false`), unindexed endpoints (`source_not_indexed`/`target_not_indexed`) and indexed queries without routes (`no_paths`) remain distinct. None proves there are no real-life connections.

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

Navigation is **Me / Jobs / Pipeline / Settings / Help**; Me opens by default. Me keeps **Import CV** and **Jobs**, with account/setup guidance when needed, above **Master CV / CVs / Facts / Preferences**. The original CV detail starts with **Delete CV**; a red border distinguishes this destructive action. The master has its own edit/save/export controls. Job-specific files remain with their jobs and applications through **Open CV / Open letter**. Settings has **General / Backups** subtabs: General holds account, app, browser, form and update controls; Backups holds save, preview, restore and folder actions. Manual setup for any agent is one copyable prompt in **AI apps**. Import and restore use native file pickers or the web shell’s upload flow, never renderer-supplied paths. Locked storage, account connection and explicit CV deletion confirmation retain their boundaries. Automatic updates use the saved update preference and safe restart admission, not a per-release approval dialog.

Backup JSON version 2 contains profile records and SHA-256-verified document bytes, limited to 128 MiB per file, 100 profiles and 2,000 saved documents. Original CV files are limited to 5 MiB and saved documents to 12 MiB each. Current career-schema-2 records in version-1 exports remain importable; unsupported career schemas fail rather than passing through the destructive schema upgrade. Missing historical files are disclosed. Restore materializes only each application's current document version, independent of historical-record ordering. Restores retain sign-in, device identity, credentials, other identity archives, while clearing runtime receipts and invalidating stale operations. Failed restores roll back replacements and newly created files without removing preexisting exports.


A job's reader can block the job, every job of its company or every job of its category (classification). Employer comparisons recognize slug/display-name separators, so `flow-traders` and `Flow Traders` match the same block. Blocks are saved locally in `career.blocklist` and survive **Clear reviews**. Discovery, direct job reads, batch fetches, recommendations, assessment archives/exports, reranking and application preparation all enforce the block; an old ID or existing draft is not an exemption. Operations recheck after asynchronous fetches and before releasing prepared form values. The agent rereads `career_application_context` before acting on a saved application and immediately before final submission through its host's computer-use tools. Blocked application work fails with `JOB_BLOCKED`; existing drafts remain stored, and the agent must not bypass the block through another tool. **Blocked** lists exclusions and **Unblock** removes one.

Read [design.md](design.md) before UI work. The companion uses the approved dark/void workspace, upright Instrument Serif headings, Geist reading text, Geist Mono controls and metadata, square ruled surfaces and blended light confined to thin edges. The supplied mirrored-r mark replaces the old slit logo. There are no flat spectrum bands, chromatic status fills, animations or external font requests. Shared values live in `ui/design-tokens.css`; layout and controls live in `ui/settings.css`. Both Geist and Instrument Serif OFL notices ship under `ui/fonts`. Account, vault and MCP permission boundaries are unchanged.

The internal read-only browser uses `kind: jobs`; Jobs pages saved reviews by job ID, and all unavailable and stale rows remain accessible. CVs also keeps previously imported supporting documents accessible and labelled. Browsing performs no inference, feed fetch or data mutation.

For a paired account, **Open account** opens the website without starting pairing again. The browser sign-in instruction is shown only for an unpaired connection attempt and clears when pairing completes. Contextless “Try asking” copy is removed.

## Career facts and outcomes review

Original CVs remain separate evidence. Ordinary job matching can use them immediately; CV generation starts an outcomes review through `career_cv_review_read`. The checkpoint covers the whole active CV source set, including additions, text changes, archival and deletion. An import is never treated as review completion.

`career.roles` gives each employment episode a stable ID, including different roles at the same company. `career_cv_review_save` reconciles those roles, exact source references and the complete `reviewedSourceIds` set. For each role, review outcomes, growth and a complex assignment with its action and result. Existing evidence resolves known facets. Missing facts trigger focused harness questions rather than fabricated metrics. Candidates without employment roles can complete review with projects, education and other supported material.

`career_interview_ask` takes a revision/request ID and a target: `{kind:"cv_review",sourceSetFingerprint}` or `{kind:"application",applicationId}`. Narrative review questions carry `roleId` and a facet. `role_identity` clarifies conflicting employers, titles or dates without resolving achievement facets. The host uses elicitation when available, otherwise the returned chat format. `career_interview_answer` persists literal replies, including explicit unknown or declined responses. Cancellation leaves unanswered work unresolved.

Career facts retain current answers, role attribution, question context and publication restrictions. Corrections supersede earlier evidence. Facts for the same subject in different employment episodes remain distinct. Confidential content is not publishable; ask for a separate safe description or range. Explicit publication permission is recorded from the candidate’s actual reply or form selection, never inferred from silence or an ordinary save.

## Editable master CV

`career_master_cv_read` returns the saved master and derived `missing`, `draft`, `stale` or `ready` status. Readiness requires the current reviewed source set, resolved role facets, valid evidence and the current writing policy. Old content remains readable while it needs review.

`career_master_cv_save` uses career revision, `baseVersion` and `sourceSetFingerprint`. A master contains contact details from the profile, a bio, reverse-chronological experience, and supported optional sections. Claims have stable IDs; experience records carry `roleId`. Master history preserves previous versions.

**Me → Master CV** provides a structured editor, not a JSON field. It supports contact and professional links, headline and bio, roles and outcome bullets, skills, education, languages, certifications, other sections and presentation. Saves retain drafts on errors and require explicit merge choices on conflicts. Polling does not overwrite typing. Lock or account changes clear sensitive editor state.

Manual changes are candidate-authored evidence. Agent regeneration cannot silently overwrite them, change the selected presentation, or restore removed claims from older originals. Tailored copies also respect current corrections and publication constraints. When an agent proposes a change to protected wording, the candidate applies it in the editor.

Master PDF/TXT export is separate from application documents and checks current identity, source set, master version and readiness at publication. The native shell saves a file; the web shell offers a guarded browser download. Unsaved or stale content is not represented as a current export.

## Job-specific CVs and cover letters

1. Create or reuse the exact application with `career_application_create`. Catalogue jobs, complete captured adverts and pasted originals are supported. Identity follows the exact job/URL, never employer and title alone.
2. Read `career_application_context`: current ready master, original sources, role facts, complete job, `jobText`, current bindings and attached forms. `jobText` is the HTML5 visible-text projection; the complete original description remains available.
3. Inventory every skill, duty, qualification and expected outcome. Each requirement has an exact original `phrase`, priority (`crucial`, `important`, `optional`), kind, status (`supported`, `partial`, `missing`), role IDs, support and rationale. Keep the inventory separate from candidate claims.
4. Use supported exact job terms in relevant skills or experience without repeating whole advert sentences. For each role, connect its actual outcomes and difficult-assignment evidence to expectations it genuinely meets. Do not move a metric or capability to another role. Ask material uncertainties through the application-targeted interview and reuse the answers later.
5. Tailor the bio and letter to the employer’s domain and needs with concrete proof. Distinguish demonstrated domain expertise, transferable experience and stated interest. Do not invent enthusiasm, mastery or a progression story. Keep the bio concise and the letter within one readable page or the employer’s explicit limit.
6. `career_application_cv_save` requires `masterVersion`, `contextFingerprint`, requirements, the structured CV and support for headline, summary and other sections. Claims use `{id,text,support}` with `support.sources: [{sourceId,contentHash,quote}]` and/or `support.facts`. Role claims must cite that episode’s evidence. Letter saves use ordered paragraphs with one support object per paragraph and the same application/master bindings.
7. Fix evidence, attribution, number and layout failures before export. Pending application interviews prevent final export; a known missing qualification alone does not require a false claim or make every truthful application impossible.
8. Export current PDFs with `career_application_export`; TXT is available when needed. Stored phrases and TXT retain exact spelling and internal whitespace. PDF line wrapping and extractor normalization can change whitespace, so exact spacing cannot guarantee an ATS score.

The full [Humanizer skill](https://github.com/blader/humanizer) and its MIT license are bundled under `skills/recruiters-rip/references/`. The CV skill requires its complete draft, critique, fact-preservation and rewrite process for the master, tailored CV, bio and letter. The same workflow guide is delivered through MCP to clients without local skills. Style is judged in context; there is no word blacklist or AI-authorship detector. The skill, Humanizer reference and runtime guide participate in the policy fingerprint.

Enabled career breaks are generated from the user’s `activity`, optional `place`, `description`, year window and minimum length. They appear inline in Experience with the same layout as roles and retain their identity as breaks. A disabled setting omits them. Generated copies use the master’s current break entries; the agent cannot turn a break into employment.

Application preparation does not authorize submission. If asked to apply, the host uses its actual browser tools, respects permission and authorship requirements, resolves material questions and reports the observed result. Missing or stale documents are rebuilt from the current master, never retagged as current.

Browser form prose uses `career_form_answers_save` with evidence for each generated `{id,value,support}` answer and current form bindings. Generated prose is not stored as a user-stated fact. Direct user answers from the extension can still save reusable contact details and general topics; changing career evidence retires generated application writing instead of silently rebinding it. Private backup readers preserve saved historical files without weakening public current-document checks.

### Writing and ATS references

- [Harvard Mignone Center: impactful resumes and cover letters](https://careerservices.fas.harvard.edu/resources/hes-create-impactful-resumes-and-cover-letters/): specific, factual, concise achievements and employer-specific examples.
- [Gayle Laakmann McDowell: five resume questions](https://www.gayle.com/blog/2011/08/22/the-5-big-questions-you-need-to-ask-about-your-resume): accomplishment-oriented, scannable bullets. This is published guidance, not a personal review or endorsement.
- [Greenhouse Talent Matching FAQ](https://support.greenhouse.io/hc/en-us/articles/41131616864283-Talent-Matching-Data-Processing-FAQ): exact and semantic matching coexist. No universal regex or whitespace-based ranking guarantee is assumed.


## Matching eval

`eval/` holds a synthetic golden set (4 candidates × 8 jobs with expected decisions, gates, dimension ranges and better/worse pairs) and a deterministic scorer. It runs no inference:

```sh
pnpm eval:prepare --run <name>   # writes eval/runs/<name>/packets/<candidate>.md and manifest.json
# run each packet in a fresh Codex or Claude conversation; save the JSON reply as eval/runs/<name>/responses/<candidate>.json
pnpm eval:score <name> [--baseline <run>]
```

The scorer validates every reply against `assessmentSchema` and the same citation checks as `career_match_save`, derives decisions with the companion's rules and gates on malformed rate (0), hard-gate accuracy (1.0), decision macro-F1 (≥0.80), pairwise accuracy (≥0.85), worst-slice accuracy (≥0.60) and location-twin consistency (1.0); with `--baseline` any gated metric dropping by more than 0.02 also fails. `eval/runs/` is ignored; committed replay fixtures under `eval/fixtures/replay/` keep the scorer under test.

## Build from a fresh clone

Developer builds require Node.js 24+ and pnpm 10.34.9; the supported one-command source installer uses Node.js 24/npm and Git. Native packaging must run on its target OS. Mac ad-hoc packaging uses the system signing tools without an Apple developer account.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

`pnpm test` builds runtime assets first. Tests use temporary synthetic local data; they must not use a real vault or invoke a model. `pnpm start` uses https://recruiters.rip. Only explicit developer commands `pnpm start:local` / `pnpm package:local` select `http://127.0.0.1:3001` and the separate `local-device` directory; no fixture server is bundled.

The `Dockerfile.headless` verification target uses `node:24.22.3-alpine3.24`, builds the runtime and extensions, and runs synthetic MCP authentication, pairing, device-client and private-storage regressions as a non-root user. Run `docker build -f Dockerfile.headless -t companion-headless .` then `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges companion-headless`. This is not a desktop deployment: Electron requires native macOS/Windows or glibc Linux packaging and the existing native smoke gates. No user vault, credentials, dependency directory or generated output is copied into the image.

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

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.14.0), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

Security maintenance: run `pnpm audit` against the locked runtime and packaging dependencies. Release 3.12.27 updates Electron, MCP, Nest, Ajv, esbuild and packaging dependencies; Node 24 is the build baseline. TypeScript stays on 6.0.3 because the document compiler uses `transpileModule`, which TypeScript 7's replacement public API does not provide. The explicit Ajv 6 alias preserves the document codec's schema semantics. pnpm stays on the latest 10.x release to retain the existing package configuration and lockfile contract. Scoped pnpm overrides keep file-type, minimatch and both Undici majors above their advisory fix versions where upstream ranges or pins still select vulnerable releases. Keep these overrides until upstream dependencies select patched versions without them; verify native packaging and source-install/update smoke gates before publishing dependency changes.

The local MCP broker bounds queued messages and aggregate bytes, including while server connection setup is pending, and disconnects unauthenticated sockets when access is revoked. Its socket regressions cover flooding and late connection completion without contacting any service. The public repository's security workflow adds CodeQL security-extended analysis and offline Alpine boundary tests. Hosted Code Quality is a separate service: a disabled setup is not a clean scan and must not be enabled as a paid feature without approval.

Native helper readiness proofs are published by same-directory rename only after the complete 32-byte UTF-8 token is closed. This prevents the strict parent handover validator from seeing a partially written file; Windows publication explicitly omits a BOM and refuses to replace an existing proof. The real native updater smoke remains the release gate for this path.

Release 3.12.28 binds private vault, preferences, document, backup, host-plugin and managed-source reads to the opened file descriptor, preserving regular-file, size, ownership, symlink and Windows ACL checks. Linux desktop executable parsing uses disjoint quoted-token alternatives to avoid exponential backtracking. Native smoke installers stay in a fresh private directory rather than a shared predictable cache; Windows smoke command arguments are encoded as data before PowerShell parses the command.

Publication fails closed unless the exact current main commit has a completed successful security workflow, a full default-branch CodeQL analysis with nonzero analyzed rules, and no open default-branch code-scanning alerts across all pages. It waits at most five minutes for that commit's analysis and performs this check before creating a draft release. Pull-request delta results are not a substitute for the full baseline. Security branches receive full push analyses, and only the main release job receives read access to security events and workflow status.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. UI fonts retain their separate Geist and Instrument Serif OFL notices under `ui/fonts`. The current application icon and mirrored-r logos come from the user-supplied design artifact linked in [design.md](design.md). CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.

## License

Companion is source-available under the [Business Source License 1.1](LICENSE). You may use it for your own job search; offering it as a product or service to others is not permitted. Each version becomes Apache-2.0 on 2030-10-31.
