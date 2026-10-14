# Recruiters.rip Companion

The local career-data app for Recruiters.rip. Version 3.4.2 persists candidate-authorial application writing and target-content trust boundaries while retaining saved career-location corrections and the existing vault format.

## Account and installation

1. Visit https://recruiters.rip, connect your account, and complete the $9.99/month membership checkout.
2. Download the macOS Apple Silicon installer from the website, move **Recruiters.rip Companion.app** to Applications, and open it.
3. Choose **Connect account**. The companion opens `/settings/provider?deviceId=…&publicKey=…&deviceLabel=…` on the website. Complete website pairing, then approve the account in the companion's native confirmation.
4. Install the local Work/Codex plugin or Claude Desktop extension from the companion's settings and start a conversation with Recruiters.rip enabled. The manual MCP command also supports compatible local Codex hosts. Ordinary ChatGPT chats do not inherit a local MCP connection.

AI authentication and inference belong to the user's official Codex/ChatGPT or Claude subscription app. The companion does not accept provider keys or call inference APIs. The user's host app sees content returned by its tools.

## Repository boundary and privacy

This repository owns the Electron app, encrypted local vault, MCP server and launcher, conversation skill, scoring/decision storage, source-preserving CV tools, and CareerCup-style PDF rendering. `recruiters-rip-frontend` owns website authentication, checkout, installer delivery, pairing, and the signed-device proxy. Middleware owns account/device authorization and the paid job feed. There is no server database, backend inference service, website runtime, or sibling-checkout dependency here.

CVs, profile facts, assessments and drafts stay in the local encrypted vault. Fresh job data requires current paid membership; saved local data remains available without payment. Exported PDFs, CSVs and backups are ordinary files: choose a private destination. Do not commit vaults, exports, credentials, certificates, or user data.

Installed identity is intentionally unchanged: app ID `rip.recruiters.companion`, displayed app **Recruiters.rip Companion**, Electron storage/keychain name **Recruiters Companion**, protocol `recruiters-companion://`, and production vault `~/Library/Application Support/Recruiters Companion/device` on macOS. Never reset or relocate that vault during an upgrade.

## CV customization

The companion prepares the application document. It does not ask the candidate to approve each rewrite, layout, or check.

- The host reads the selected job and saved local facts, then writes and saves the tailored CV directly.
- Classic A4 is the default. Modern or Letter is used only when the candidate already asked for it.
- Unsupported numbers are left out. The companion does not ask the candidate to supply or certify them.
- Writing checks stay private and are fixed before export. There is no candidate checklist and no ATS score.
- PDF is the normal export. TXT is available on request. PDF text is checked automatically before the file is saved.

Facts, drafts, and documents remain in the local companion vault. Exporting a document does not submit an application.

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

`src/documents/package.json` declares a CommonJS source boundary because the document build transpiles TypeScript to CommonJS before bundling. Keep that boundary separate from the Electron application's root ES-module package.

## Distribution

```sh
pnpm package:release
```

This creates signed, notarized macOS ARM64 ZIP and DMG artifacts under `dist/release/`, never publishes, and fails rather than claiming signing succeeded without credentials. Supply a Developer ID Application certificate using `CSC_LINK` / `CSC_KEY_PASSWORD`, or its keychain identity using `CSC_NAME`; also supply Apple's API-key notarization credentials (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple-ID credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Keep all credentials outside this repository.

If signing credentials are unavailable, explicitly use `pnpm package:adhoc`. It builds production-origin ZIP and DMG artifacts under `dist/adhoc/` with ad-hoc signing and **no notarization**; Gatekeeper may block them. Do not describe these as notarized releases or silently disable OS protections.

Artifact basenames are `recruiters-rip-companion-3.4.2-mac-arm64.zip` and `.dmg`. The website operator mounts the actual ZIP on its private host volume and sets `COMPANION_INSTALLER_PATH`; `/api/companion/download` serves that file. A private GitHub repository is not a public installer URL.

## Document source and asset notices

The owned document closure in `src/documents/` consists of `candidate-document-codec.ts`, `candidate-document-provenance.ts`, `cv-source-baseline.ts`, `cv-document-layout.ts`, and `career-pdf.ts`. The codec owns the canonical preference-field list; no SQL/helper/service module is imported. Its legacy schema semantics remain on the explicit `ajv-legacy` alias (Ajv 6.12.6), separate from MCP's Ajv 8. TypeScript is an explicit build dependency.

`src/documents/assets/NotoSans-Regular.ttf` is Copyright 2018 The Noto Project Authors, distributed under the SIL Open Font License 1.1 in the adjacent `OFL.txt`; both are included in the app. `job-screening-prompt.txt` preserves the existing screening rubric. The app icon and source were migrated from the JobStash prototype; no separate third-party icon license was supplied. CareerCup is a layout reference linked by the conversation skill, not a bundled CareerCup document or asset. Dependency licenses remain with their npm packages.
