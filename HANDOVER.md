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
| Browser identity and native transport | `src/browser-identity.mjs`, `src/install-native.mjs`, `src/native-host.cjs` |
| Chrome panel, page capture and prepared clipboard values | `browser-extension/src/`, `browser-extension/manifest.mjs`, `browser-extension/build.mjs` |
| Durable captured jobs | `src/mcp/job-tools.mjs`, with integrations in matching, application tools and `src/career-browser.mjs` |
| Form snapshots, agent answers and preparation | `src/mcp/form-tools.mjs`, `src/browser-forms.mjs`, `src/decisions/form-mapping.mjs` |
| Matching rubric and policy fingerprints | `src/mcp/matching-contract.mjs`, `src/mcp/matching-tools.mjs` |
| Evidence-bound CVs and document exports | `src/mcp/application-tools.mjs`, `src/documents/` |
| Public release updates | `src/updates.mjs`, `src/update-install.cjs`, `ui/updates.js` |
| Packaging and release metadata | `scripts/package-local.mjs`, `scripts/after-pack.cjs`, `scripts/release-metadata.mjs`, `src/package-release.mjs` |

## Data and inference boundaries

Career records use plain private JSON, not keychain storage or at-rest encryption. The optional OpenAI key is outside `career` and excluded from MCP, extension responses, logs and career exports. The website never receives private career content or provider keys.

Claude/Codex handles job assessments, questions and new application text. Optional OpenAI Decisions requests only choose known values for form fields (Chrome Read page); they never assess jobs. They require bounded requests and context/credential invalidation. Never run live inference in tests or invent unknown answers or membership.

The current career schema remains 2. Captured jobs and form drafts are lazy additions; do not reset existing careers to introduce them. Facts retain subject/employer identity. CV claims retain internal support citations; rendered documents omit that validation metadata.

## Captured jobs

`career.jobs` is durable and independent of the replaceable matching cache. Import uses runtime validation, request/revision receipts and detail/apply URL aliases. Source-page provenance alone is not job identity. A snippet never overwrites a complete original. Changing an original advances ranking context so an in-flight old assessment cannot become current.

Register `createJobTools({store})`. Native capture calls `importCapturedJobs({store,requestId,revision,sourceUrl,jobs})`. `career_job_read` and application creation resolve local IDs without platform access. `career_match_jobs({localOnly:true})` is offline; normal feed calls retain membership enforcement and follow `career.publicationRange` (legacy `prescanPublicationRange` read as fallback; default Past 3 days), returning every job in the window minus blocked jobs and established incompatibilities (`src/mcp/review-queue.mjs`) without a job-count cap. Explicit imports are not publication-filtered, and unknown publication dates stay unknown. The publication slider spans Today through Past 2 weeks; the MCP also accepts past_month and all; middleware returns exact range counts and paged metadata.

Incomplete listing cards are visible but require the full original before assessment/application use (`FULL_AD_REQUIRED`). Ranking resets do not delete captures.

## Chrome and forms

The extension uses a stable native side panel and minimal `nativeMessaging`, `activeTab`, `scripting`, `sidePanel` and `clipboardWrite` permissions. Opening uses Chrome's native action behavior. Missing `tabs.Tab.url` metadata is not itself proof of denied page access: scripting enforces the grant and injected inspection functions validate the actual location. Do not add blanket host permissions to work around test tooling.

External website requests remain limited to status, pairing and opening settings. Capture/form capabilities require the extension's own panel sender. Production and local keys/IDs/hosts come from `BROWSER_IDENTITIES`; preserve the production identity.

The page-inspection functions are self-contained for `chrome.scripting` serialization. They treat page data as untrusted, exclude protected/populated controls from prepared values and bind the document, actual nodes and live schema. Field-aware clipboard assistance remains: focusing an eligible empty control selects its prepared value; native paste, undo and redo belong to the browser. **Review answers** keeps editing and Copy, not a script-driven Fill action. No extension code writes application controls or presses Next/Submit.

The agent reads `career_form_read` and stages text with `career_form_answers_save`; staged answers bind to the snapshot and career evidence. `forms_status` retains attachment, snapshot/field inspection, prepared clipboard values and application identity. Known-value preparation and release do not show a native approval dialog. Preserve exact job/application identity, fact qualifications, contact ownership, context invalidation and block checks across reads, saves and preparation, including after asynchronous work and before private-value release. Unknown/protected answers remain user-controlled. The optional Decisions key serves known-value mapping only.

For an application task, the host creates/reuses the job-bound application, saves and exports current CV/letter PDFs, opens the saved URL with `career_application_open` and inspects the user's own Chrome. It uses its actual computer-use tools for native mouse/keyboard/clipboard input and the native file selector, then verifies retained values, attachment names and the actual page receipt. Companion exposes no browser-input or submission API. Do not reintroduce injected setters/clicks, `page.evaluate`, `element.click`, `form.submit`, `requestSubmit` or direct application network submission. If the host lacks computer-use capability, state that limitation and preserve the usable documents/answers; no JavaScript fallback.

The agent must reread `career_application_context` through Companion before acting on a saved job/application and immediately before the final native Submit action. `JOB_BLOCKED` stops that application even if its tab is already open; never change IDs or use another tool around the block. Reconcile changed career/document context first. Submission requires the candidate's application task, not a document-only request. A click/navigation/generic thanks is not a receipt; rejected, challenged, validation-failed, pending or uncertain results are not successful submissions. No automatic retries, duplicates, fingerprint spoofing or challenge bypass. Native input is an input-compatibility choice, not an anti-detection guarantee.

Companion settings consent governs its own tools, never host/tool permissions. Keep host browser/workspace access rules and prompts intact without adding conversational confirmation ceremony. Native companion approvals remain for account pairing and update installation; there is no companion submit approval.

## Updates and packages

The updater uses only the official repository's actual latest stable published release and validated mac-arm64 assets. It verifies SHA-256, bounds streams and extraction, rejects untrusted redirects/paths, checks bundle identity/version/architecture/signature and replaces only its running installed app. Source/local/unwritable installations use verified manual handoff. No command publishes or changes repository visibility.

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

`pnpm package:adhoc` is the release build: explicitly unnotarized, production-origin, with checksum metadata. There is no Apple Developer ID and `pnpm package:release` is unused. The repository is public; publish each version as a stable GitHub release (ZIP, DMG, Chrome extension ZIP, `SHA256SUMS.txt`) so the in-app updater and the website's `curl | sh` installer discover it, then mirror the ZIPs to the website host and restart its container. Coordinate the frontend's guide with artifact rollout; a legacy hosted pairing ZIP does not provide capture/form support.

For parallel work, keep shared integration files under one owner, assign independent module slices and use separate functional/security review. Workers skip mid-flight gates; run final gates and actual-surface smokes against the integrated result. Report only observed behavior, including any remaining native approval or relaunch verification prerequisite.
