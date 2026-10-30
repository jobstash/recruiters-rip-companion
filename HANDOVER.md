# Recruiters.rip maintainer handover

Read [AGENTS.md](AGENTS.md), [design.md](design.md) and the relevant [README](README.md) workflow before editing. Package version comes only from `package.json`. A source change or successful package build is not proof of publication or production deployment.

## Ownership

This checkout owns Electron, the Chrome extension, local career/job/form storage, MCP tools, the conversation skill, document rendering and release updates. The frontend owns account sign-in, checkout, website Docs/Downloads, pairing UI and the signed-device proxy. Middleware authorizes accounts/devices and current paid job-feed access. Do not import sibling source at build/runtime, deploy unrelated services or perform payment/database operations from this project.

Preserve `rip.recruiters.companion`, **Recruiters.rip Companion**, **Recruiters Companion**, `recruiters-companion` and the production `device` directory. Production uses `https://recruiters.rip`; local mode has separate data, browser identity, native host and update receipts. Never test with a user's real vault.

## Architecture map

| Area | Entry points |
| --- | --- |
| Electron lifecycle, permissions and settings IPC | `src/main.mjs`, `src/preload.cjs`, `ui/` |
| Local persistence and mutation receipts | `src/vault.mjs`, `src/mcp/state.mjs`, `src/mcp/scope.mjs` |
| Browser identity and native transport | `src/browser-identity.mjs`, `src/install-native.mjs`, `src/native-host.cjs`, `src/platform-runtime.cjs` |
| Chrome/Firefox panel, page capture and prepared clipboard values | `browser-extension/src/`, `browser-extension/manifest.mjs`, `browser-extension/build.mjs` |
| Durable captured jobs | `src/mcp/job-tools.mjs`, with integrations in matching, application tools and `src/career-browser.mjs` |
| Form snapshots, agent answers and preparation | `src/mcp/form-tools.mjs`, `src/browser-forms.mjs`, `src/decisions/form-mapping.mjs` |
| Matching rubric and policy fingerprints | `src/mcp/matching-contract.mjs`, `src/mcp/matching-tools.mjs` |
| Evidence-bound CVs and document exports | `src/mcp/application-tools.mjs`, `src/documents/` |
| Public release updates | `src/updates.mjs`, `src/update-install.cjs`, `ui/updates.js` |
| Packaging and release metadata | `scripts/package-local.mjs`, `scripts/after-pack.cjs`, `scripts/release-metadata.mjs`, `src/package-release.mjs` |

## Data and inference boundaries

Career records use plain private JSON, not keychain storage or at-rest encryption. The optional OpenAI key is outside `career` and excluded from MCP, extension responses, logs and career exports. The website never receives private career content or provider keys.

Claude/Codex handles job assessments, questions and new application text. Optional OpenAI Decisions requests choose known form values through Chrome or Firefox Read page; they never assess jobs. Keep requests bounded and context/credential-bound. Never run live inference in tests or invent unknown answers or membership.

The current career schema remains 2. Captured jobs and form drafts are lazy additions; do not reset existing careers to introduce them. Facts retain subject/employer identity. CV claims retain internal support citations; rendered documents omit that validation metadata.

## Captured jobs

`career.jobs` is durable and independent of the replaceable matching cache. Import uses runtime validation, request/revision receipts and detail/apply URL aliases. Source-page provenance alone is not job identity. A snippet never overwrites a complete original. Changing an original advances ranking context so an in-flight old assessment cannot become current.

Register `createJobTools({store})`. Native capture calls `importCapturedJobs({store,requestId,revision,sourceUrl,jobs})`. `career_job_read` and application creation resolve local IDs without platform access. `career_match_jobs({localOnly:true})` is offline; normal feed calls retain membership enforcement and follow `career.publicationRange` (legacy `prescanPublicationRange` read as fallback; default Past 3 days), returning every job in the window minus blocked jobs and established incompatibilities (`src/mcp/review-queue.mjs`) without a job-count cap. Explicit imports are not publication-filtered, and unknown publication dates stay unknown. The publication slider spans Today through Past 2 weeks; the MCP also accepts past_month and all; middleware returns exact range counts and paged metadata.

Incomplete listing cards are visible but require the full original before assessment/application use (`FULL_AD_REQUIRED`). Ranking resets do not delete captures.

## Browsers and platform bridges

Chrome 125+ uses a native side panel; Firefox 128+ uses a sidebar and a module background page. The toolbar gesture grants `activeTab`; opening a sidebar selector alone does not. Both builds use minimal `nativeMessaging`, `activeTab`, `scripting` and `clipboardWrite` permissions; Chrome also uses `sidePanel`. Document identity is checked with browser document IDs where available and an inspection-bound per-document token otherwise. Do not add all-sites access to make tests pass.

Chrome website requests remain limited to status, pairing and settings. Firefox has no external website-message bridge and uses Companion's loopback pairing. Panel senders must match `runtime.getURL()` so Firefox's dynamic `moz-extension` UUID is not confused with its fixed add-on ID. `BROWSER_IDENTITIES` preserves Chrome IDs and adds production/local Gecko IDs. Native-host argv validates the actual browser origin or Firefox manifest path/add-on ID; never relabel a Firefox caller as Chrome.

`platform-runtime.cjs` owns OS storage roots, restricted launch environments, platform launchers and authenticated local transport. Windows uses per-user DACL-protected configuration and channel-separated named pipes; POSIX uses private Unix sockets, with a bounded private fallback for overlong paths. Clients must authenticate the server before forwarding credentials or application data; a successful named-pipe connection alone is not trust. Native registration is per-user: Chromium-family manifest directories and Firefox's Mozilla native-manifest directory on POSIX, HKCU native-host registry keys on Windows. Registration is not proof an extension is installed or connected.

The page-inspection functions are self-contained for `chrome.scripting` serialization. They treat page data as untrusted, exclude protected/populated controls from prepared values and bind the document, actual nodes and live schema. Field-aware clipboard assistance remains: focusing an eligible empty control selects its prepared value; native paste, undo and redo belong to the browser. **Edit answers** keeps editing and Copy, not a script-driven Fill action. No extension code writes application controls or presses Next/Submit.

The agent reads `career_form_read` and stages text with `career_form_answers_save`; staged answers bind to the snapshot and career evidence. `forms_status` retains attachment, snapshot/field inspection, prepared clipboard values and application identity. Known-value preparation and release do not show a native approval dialog. Preserve exact job/application identity, fact qualifications, contact ownership, context invalidation and block checks across reads, saves and preparation, including after asynchronous work and before private-value release. Unknown/protected answers remain user-controlled. The optional Decisions key serves known-value mapping only.

For an application task, the host creates/reuses the job-bound application, exports current CV/letter PDFs, and opens the saved URL with `career_application_open` in the OS default browser. Use Chrome or Firefox with its matching extension. Actual host computer-use tools provide mouse/keyboard/clipboard and file selection; Companion exposes no browser-input or submission API. Verify retained values, attachment names and the actual receipt. Never reintroduce injected control writes/clicks or direct application POSTs. If host capability is missing, preserve usable documents/answers and report that limitation.

The agent must reread `career_application_context` through Companion before acting on a saved job/application and immediately before the final native Submit action. `JOB_BLOCKED` stops that application even if its tab is already open; never change IDs or use another tool around the block. Reconcile changed career/document context first. Submission requires the candidate's application task, not a document-only request. A click/navigation/generic thanks is not a receipt; rejected, challenged, validation-failed, pending or uncertain results are not successful submissions. No automatic retries, duplicates, fingerprint spoofing or challenge bypass. Native input is an input-compatibility choice, not an anti-detection guarantee.

Companion settings consent governs its own tools, never host/tool permissions. Keep host browser/workspace access rules and prompts intact without adding conversational confirmation ceremony. Native companion approvals remain for account pairing and update installation; there is no companion submit approval.

## Updates and packages

The updater reads only the official repository's actual latest stable release and exact mac-arm64 ZIP, win-x64 EXE or linux-x64 AppImage assets. It verifies SHA-256, bounds downloads and rejects untrusted URLs. macOS installed-app replacement keeps bundle identity/version/architecture/signature checks and rollback; Windows starts a verified installer and Linux reveals its verified executable AppImage for manual replacement. Source/local/unwritable installations use verified manual handoff. Installer launch never means installation completed. No build command publishes.

Download, installer handover, launched and confirmed are distinct states. A separate immutable startup confirmation prevents a late helper write from downgrading confirmation. The previous app stays available until new-version startup confirms; failed swaps/launch commands roll back. Installation rejects active paid work and drains accepted writes with `vault.flush()`.

Inspect packaged artifacts, not just configuration. Electron-builder merges protocol arrays: the after-pack hook clears local `CFBundleURLTypes` before signing, while production retains the real scheme. Native identity and updater helper files must be available under `app.asar.unpacked`. Keep the bundled extension and font licences in the package.

## Verification and release

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm package:local
```

Use synthetic temporary data for real Chrome/native capture, form preparation, stale/hostile DOM cases and updater filesystem checks. Exercise host-native mouse/keyboard/paste/file selection on a synthetic local form and check trusted input events and retained values; do not substitute injected writes for that smoke or submit real applications. A custom Chrome QA profile needs its own native-host registration. Do not overwrite a production registration or relax permission boundaries to make automation pass. Test normal Quit, actual local bundle protocol metadata, signature validity, context/block-gated private-value release and update startup confirmation.

Native build commands are `pnpm package:adhoc` on macOS arm64 (unnotarized), `pnpm package:win` on Windows x64 (NSIS), and `pnpm package:linux` on Linux x64 (AppImage). CI runs gates and packaging on native runners, then uploads artifacts; publication remains explicit. Gather version-matched installers, browser ZIPs and checksums before a stable GitHub release and website rollout. Firefox source ZIPs are temporary development installations until AMO signs an XPI. No Apple Developer ID, Windows signing certificate or AMO credential is presumed.

For parallel work, keep shared integration files under one owner, assign independent module slices and use separate functional/security review. Workers skip mid-flight gates; run final gates and actual-surface smokes against the integrated result. Report only observed behavior, including any remaining native approval or relaunch verification prerequisite.
