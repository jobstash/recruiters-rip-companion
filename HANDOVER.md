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
| Chrome panel, page capture and guarded filling | `browser-extension/src/`, `browser-extension/manifest.mjs`, `browser-extension/build.mjs` |
| Durable captured jobs | `src/mcp/job-tools.mjs`, with integrations in matching, application tools and `src/career-browser.mjs` |
| Form snapshots, agent answers and preparation | `src/mcp/form-tools.mjs`, `src/browser-forms.mjs`, `src/decisions/form-mapping.mjs` |
| Matching rubric and policy fingerprints | `src/mcp/matching-contract.mjs`, `src/mcp/matching-tools.mjs` |
| Optional job pre-filtering | `src/prescan/` |
| Evidence-bound CVs and document exports | `src/mcp/application-tools.mjs`, `src/documents/` |
| Public release updates | `src/updates.mjs`, `src/update-install.cjs`, `ui/updates.js` |
| Packaging and release metadata | `scripts/package-local.mjs`, `scripts/after-pack.cjs`, `scripts/release-metadata.mjs`, `src/package-release.mjs` |

## Data and inference boundaries

Career records use plain private JSON, not keychain storage or at-rest encryption. The optional OpenAI key is outside `career` and excluded from MCP, extension responses, logs and career exports. The website never receives private career content or provider keys.

Claude/Codex handles final assessments, questions and new application text. Optional OpenAI Decisions requests only prioritize jobs or choose known values for form fields. They require native data-sharing/billing approval, bounded requests and context/credential invalidation. Never run live inference in tests or invent unknown answers or membership.

The current career schema remains 2. Captured jobs and form drafts are lazy additions; do not reset existing careers to introduce them. Facts retain subject/employer identity. CV claims retain internal support citations; rendered documents omit that validation metadata.

## Captured jobs

`career.jobs` is durable and independent of the replaceable matching cache. Import uses runtime validation, request/revision receipts and detail/apply URL aliases. Source-page provenance alone is not job identity. A snippet never overwrites a complete original. Changing an original advances ranking context so an in-flight old assessment cannot become current.

Register `createJobTools({store})`. Native capture calls `importCapturedJobs({store,requestId,revision,sourceUrl,jobs})`. `career_job_read` and application creation resolve local IDs without platform access. `career_match_jobs({localOnly:true})` is offline; normal feed calls retain membership enforcement and follow `prescanPublicationRange` (default Past 3 days). Explicit imports are not publication-filtered, and unknown publication dates stay unknown. The publication slider spans Today through Whole catalogue; middleware returns exact range counts and paged metadata, and every in-scope pending job is selected without a job-count cap.

Incomplete listing cards are visible but require the full original before assessment/application use (`FULL_AD_REQUIRED`). Ranking resets do not delete captures.

## Chrome and forms

The extension uses a stable native side panel and minimal `nativeMessaging`, `activeTab`, `scripting` and `sidePanel` permissions. Opening uses Chrome's native action behavior. Missing `tabs.Tab.url` metadata is not itself proof of denied page access: scripting enforces the grant and injected functions validate the actual location. Do not add blanket host permissions to work around test tooling.

External website requests remain limited to status, pairing and opening settings. Capture/form capabilities require the extension's own panel sender. Production and local keys/IDs/hosts come from `BROWSER_IDENTITIES`; preserve the production identity.

The page functions are self-contained for `chrome.scripting` serialization. They treat page data as untrusted, exclude protected/populated controls, bind the document and actual nodes, and revalidate live schema and radio membership before filling. Page handlers can synchronously change another control or reject a value, so report retained values rather than setter calls. Never submit, click Next, upload files or fill consent/password/payment/government-ID/demographic controls.

`createBrowserForms` gates private-value release through native approval. The agent reads `career_form_read` and stages text with `career_form_answers_save`; staged answers bind to the snapshot and career evidence. Preserve fact qualifications and contact ownership. Unknown answers remain manual. One optional Decisions key serves pre-filtering and known-value mapping.

## Updates and packages

The updater uses only the official repository's actual latest stable published release and validated mac-arm64 assets. It verifies SHA-256, bounds streams and extraction, rejects untrusted redirects/paths, checks bundle identity/version/architecture/signature and replaces only its running installed app. Source/local/unwritable installations use verified manual handoff. No command publishes or changes repository visibility.

Download, installer handover, launched and confirmed are distinct states. A separate immutable startup confirmation prevents a late helper write from downgrading confirmation. The previous app stays available until new-version startup confirms; failed swaps/launch commands roll back. Installation rejects active paid work and drains accepted writes with `vault.flush()`. The exact pre-filter `isActive()` signal includes draining requests even when its displayed summary is stale.

Inspect packaged artifacts, not just configuration. Electron-builder merges protocol arrays: the after-pack hook clears local `CFBundleURLTypes` before signing, while production retains the real scheme. Native identity and updater helper files must be available under `app.asar.unpacked`. Keep the bundled extension and font licences in the package.

## Verification and release

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm package:local
```

Use synthetic temporary data for real Chrome/native capture, form preparation, stale/hostile DOM cases and updater filesystem checks. A custom Chrome QA profile needs its own native-host registration. Do not overwrite a production registration or relax permission boundaries to make automation pass. Test normal Quit, actual local bundle protocol metadata, signature validity, private-value approval and update startup confirmation.

`pnpm package:adhoc` produces an explicitly unnotarized production-origin build and checksum metadata. `pnpm package:release` requires genuine signing/notarization credentials. Publish the matching app/extension assets separately, then verify official release discovery. Coordinate the frontend's 3.9+ guide with artifact rollout; a legacy hosted pairing ZIP does not provide capture/form support.

For parallel work, keep shared integration files under one owner, assign independent module slices and use separate functional/security review. Workers skip mid-flight gates; run final gates and actual-surface smokes against the integrated result. Report only observed behavior, including any remaining native approval or relaunch verification prerequisite.
