# Recruiters.rip agent handover

This is an operational snapshot, not proof of production deployment. Read the repository ownership instructions and the relevant `design.md` before changing code. Preserve unrelated work; use synthetic data for verification.

## 1. Start here

Recruiters.rip sells membership for access to fresh job data. The companion keeps the candidate's career records locally and exposes tools to their own Claude or Codex app. That app performs final matching, gap interviews, document writing and authorized applications. Optional companion-managed API pre-scanning is a separate, explicitly approved and separately billed operation.

The latest user-requested code changes were implemented and pushed; distribution archives were built separately:

- Monthly or yearly membership, with 20% off yearly billing.
- Shared partner codes: 100% off forever and 70% off the first month.
- Persistent signed-in navigation and populated Docs and Downloads pages.
- Real WIP companion and Chrome extension ZIPs.
- Push only the recent middleware billing changes, not the unrelated middleware work already in progress.

**Next priority: verify release configuration and deployment, not rebuild these features.** No production deployment or completed live checkout was observed. Creating this handover does not commit or push it automatically.

## 2. Repository map and confirmed revisions

Paths below are relative to this companion checkout; on the current workstation all three repositories are siblings under `/Users/d/Desktop/workspace/jobstash`.

| Repository | Responsibility | Confirmed application/release baseline |
| --- | --- | --- |
| This repository, `recruiters-rip-companion` | Electron app, local vault, MCP tools, skill, document engine, optional pre-scan, app packaging | Application baseline `a7f11f9`; package version `3.8.0`; later handover-only commits are separate |
| `../recruiters-rip-frontend` | Website, Privy sign-in, pricing/checkout UI, Docs, Downloads, account settings, pairing, signed-device proxy | `main` at `5d01878` |
| `../middleware` | Account/device authorization, job feed and Stripe membership verification | **`origin/main` at `b1f14ab3`**, not the current local checkout |

Companion history also includes `5f82d59` (matching/CV/evaluation and plain-vault work) and `70f8aea` (build tooling moved to `scripts/`). The latest frontend commit includes the subscription work as well as navigation/docs/downloads. The latest middleware commit is scoped to billing, tests, its additive migration, operator CLI and configuration/documentation.

### Critical middleware branch distinction

The local middleware working directory is on **`feat/career-agent` at `cd3b1d41`**, now pushed to `origin/feat/career-agent` after the user explicitly asked to publish all pending source work. That commit contains the broader career-agent/MCP/development feature bundle plus its auth/recommendation changes. It was **not merged into production `main`**. Its build and 62 focused billing/workflow/auth tests passed; that is not approval to deploy the whole feature bundle.

The actual production-oriented billing implementation remains **`src/companion/` on `origin/main` at `b1f14ab3`**. The feature branch instead contains the older `src/career-agent/` implementation and a different billing schema/configuration. Do not deploy it as a replacement for main, mix its `CANDIDATE_STRIPE_*` configuration into the main service, or apply its `candidate-stripe-billing.sql` to the released companion tables.

Use a separate main-based worktree for production backend changes:

```sh
# From ../middleware; do not reset or replace the existing feature workspace.
git fetch origin main
git worktree add -b agent/my-billing-task /absolute/new-worktree origin/main
```

Choose a unique branch/path. The temporary `/tmp/recruiters-billing-push` worktree used for the focused billing push was removed. Do not automatically merge the feature branch into main; its wider architecture and integration need deliberate review.

The all-source publication excluded the nested `.middleware-funding-integrity/` worktree, `tsconfig-paths/` agent session/lock files, untracked local `pnpm-lock.yaml` / install-wizard `pnpm-workspace.yaml`, private `dev/career/.local/` state, environment credentials, build output and user exports. Two read-only confidentiality reviews found no blockers in the staged source set. The frontend's generated `next-env.d.ts` also stayed untracked. Those local exclusions must not be force-added later.

During the final sync, the companion's authored handover was missing while README still linked to it. This document was restored from the retained authored content, updated with the committed production migration and branch publication state, and published with README. Application code/version were unchanged by that documentation commit. Recheck current Git state before editing; another agent may have advanced a branch.

## 3. Non-negotiable product and security boundaries

- Preserve app ID `rip.recruiters.companion`, product name `Recruiters.rip Companion`, storage name `Recruiters Companion`, protocol `recruiters-companion`, and the production `device` directory.
- Default product origin is `https://recruiters.rip`. Local-product mode must be explicit and isolated.
- **Never inspect, reset, migrate or use the real user vault as a test fixture.** Native account approval remains required. Website sign-in alone is not device approval.
- Current vault implementation is **plain JSON**, mode 0600 in a user-only directory, with no OS keychain/at-rest encryption. A saved pre-scan key is outside career data but inside that local file. Do not repeat older encryption claims or expose keys through chat, MCP, exports or logs.
- Private CVs, career facts, drafts and provider keys do not go to recruiters.rip servers. The connected AI provider receives tool context; approved API pre-scans send selected career context and full adverts directly to the selected provider.
- No inference in tests or CI, no credential scraping, no fallback web-job search and no fabricated membership. Fresh feed access requires current verified membership, including a genuinely active 100%-discounted subscription. Expiry must not delete saved local work.
- POC compatibility work is not a default requirement. That does **not** authorize discarding paid periods, auth boundaries, credentials or unrelated user work.
- No sibling-repository runtime/build imports. Generated installers, extension ZIPs, generated plugins, secrets and exports are not source-control inputs.
- Do not cancel, charge or create real subscriptions as a test. Partner-code issuance was explicitly authorized; that authorization is not permission for unrelated financial operations.

## 4. Implemented companion behavior

### Matching, facts, documents and evaluation

The approved competitor-informed upgrade is implemented; do not restart the old plan.

- Matching has requirements/evidence, three pass/flag/fail gates, four model-authored dimensions and code-computed overall fit, band and decision. Weights: direction 30%, capability 25%, scope 15%, preferences 30%.
- Requirements are judged from the advert before candidate evidence. Career intent is distinct from ability. Location is classified separately rather than boosting fit dimensions.
- Policy fingerprints include rubric/schema/skill inputs and invalidate stale assessments. Runtime build generates the skill digest.
- The coordinator pairwise-reranks up to six recommendations, at most fifteen comparisons. Re-saving an assessment invalidates its comparisons.
- Facts are keyed by subject plus employer. They remain useful interview answers, not a candidate-facing provenance ceremony.
- CV highlights/bullets carry internal evidence support. Saving rejects unsupported quotes, unknown facts, misattributed employers and numbers absent from the cited evidence. Rendered documents do not expose support metadata.
- Pre-scan asks seven questions and keeps preliminary priorities separate from final assessments. Billing/data sharing require local approval; cancellation and context invalidation remain enforced.
- Golden-set preparation/scoring and deterministic passing/regressed replay fixtures exist. Preparing/scoring packets runs no inference. A live model-quality baseline was not established by these checks.

Primary files:

| Area | Files |
| --- | --- |
| App, storage and account lifecycle | `src/main.mjs`, `src/vault.mjs`, `src/client.mjs` |
| Matching contract and tools | `src/mcp/matching-contract.mjs`, `src/mcp/matching-tools.mjs`, `src/mcp/assessment-policy.mjs` |
| Facts and interviews | `src/mcp/facts.mjs`, `src/mcp/profile-tools.mjs`, `src/mcp/interview.mjs` |
| Application claims and rendering | `src/mcp/application-tools.mjs`, `src/mcp/cv-quality.mjs`, `src/documents/` |
| Pre-scan | `src/prescan/`, `src/mcp/prescan-tools.mjs` |
| Host instructions | `skills/recruiters-rip/SKILL.md`, `skills/recruiters-rip/agents/openai.yaml` |
| App UI | `ui/index.html`, `ui/settings.js`, `ui/settings.css`, `src/career-browser.mjs` |
| Evaluation | `eval/lib.mjs`, `eval/prepare.mjs`, `eval/score.mjs`, `eval/golden/`, `eval/fixtures/replay/` |

Home exposes Import CV, review prompt, exports, backup and pre-scan controls. Navigation is CVs, Facts, Jobs and Job Applications. Jobs combines preliminary/final assessments without duplicating job identity; Settings groups Account, Chat apps and Pre-scan credentials.

Earlier work registered the local MCP with Claude Desktop and Claude Code. Current login/connectivity was not rechecked for this handover. Do not overwrite global host configuration or assume a previously running process is still available.

## 5. Website state and design decisions

Primary frontend files:

- `src/components/product-navigation.tsx` and its CSS: shared Home / Docs / Downloads / Account header, active `aria-current`, visible focus and wrapping 44px targets.
- `src/components/product-shell.tsx`: shared account/product/legal shell. Account sign-out remains in account content.
- `src/components/app-providers.tsx`: Docs, Downloads and legal pages bypass session loading/error screens. Reading instructions does not depend on account-service availability.
- `src/app/docs/page.tsx`: installation, native pairing, Claude/Codex setup, profile, jobs/documents, optional API billing, privacy, membership/discounts, Chrome setup and troubleshooting. Keep `#install` and `#extension` stable.
- `src/app/downloads/`: WIP companion/extension download actions and truthful error/recovery states.
- `src/features/onboarding/setup.tsx`: account, interval selection, checkout, cancellation, installation links, pairing and device revocation. The obsolete private-source npx install command was removed.
- `src/features/landing/`: hero, five-advantage bento and open How does it work? timeline.
- `src/lib/contracts/membership.ts`, `src/lib/server/backend-policy.ts`, `src/app/api/backend/[...path]/route.ts`: strict browser/server billing contracts.
- `src/lib/server/installer.ts`, `src/app/api/companion/download/route.ts`, `src/app/api/extension/download/route.ts`: protected artifact streaming.

Design/copy constraints:

- Dark, square, ruled workspace; bundled Instrument Serif, Geist and Geist Mono. Colour is blended light on thin edges/wires, not chromatic text or filled spectrum bands.
- Benefits present five advantages: own AI/intelligence level, local privacy, ranking catalogue plus user-supplied adverts, profile-grounded CV/cover letter per job, and applying from the user's real computer/connection.
- Benefits show their selling sentences at rest; hover/focus plays one-shot illustrations. Steps use an unframed connected timeline with reserved detail space. Respect reduced motion and touch/narrow layouts. Do not restore eight identical framed cards or abrupt floating subtitles.
- Use **How does it work?**, not How it works. No job count, invented testimonials, unverifiable comparisons or guarantees about ATS/hiring outcomes.
- Fraud language is **Pass the fraud checks**, based on genuine device/connection signals, never evade/bypass claims.
- Membership remains an e-commerce offer. Do not send unpaid buyers to an “Open account” primary purchase CTA instead of checkout. Preserve provider-plan/cancellation captions beside purchase actions.
- Homepage copy stays platform-neutral. Technical installation/download requirements must truthfully describe the build actually supplied; do not claim all-platform installers exist.

## 6. Released billing contract and partner promotions

Use middleware **`origin/main`**, not the dirty local feature branch. Relevant committed files:

- `src/companion/subscription.service.ts`
- `src/companion/stripe-subscription.ts`
- `src/companion/device-execution.protocol.ts`
- `src/companion/subscription.service.spec.ts`, `stripe-subscription.spec.ts`, `subscription.cancel.spec.ts`
- `scripts/sql/companion.sql`, then `scripts/sql/companion-billing-intervals.sql`
- `scripts/candidate-stripe-offers.ts` and its `.spec.ts`

Plans are USD **9.99/month** or **95.90/year**, 20% off twelve monthly payments rounded to cents. The selected interval survives sign-in and OAuth redirects.

HTTP contracts:

- `GET /profile/subscription`: `advanced`, current `price`, `prices.month`, `prices.year`, and optional `subscription` with `status`, `paidUntil`, `cancelledAt`, `checkoutUrl`, `interval`, `provider: "stripe"` and `discount: {percentOff,endsAt}|null`.
- `POST /profile/subscription/checkout`: exactly `{requestId:<UUID>, interval:"month"|"year"}`; returns a verified HTTPS `checkout.stripe.com` URL. Browser-supplied prices, discounts and entitlement flags are rejected.
- `POST /profile/subscription/cancel`: exactly `{requestId:<UUID>}`; returns `{cancelAtPeriodEnd:true,paidUntil,cancelledAt}` after Stripe confirms scheduling. Retries stay bound to the original agreement.
- Keep the **existing `POST /stripe/webhook`** and merchant. No new candidate-only webhook or merchant secret is required on the pushed implementation.

Pending checkout reuse is interval-aware. Existing paid agreements are verified using their own stored checkout/price binding, not the newly configured price IDs. Zero-total invoices qualify only with the verified active subscription, valid discount and matching paid invoice evidence; zero amount by itself is not membership. Coupon `applies_to` must be explicitly expanded/retrieved: Stripe otherwise omits it, even on expanded discounts.

Two shared live Stripe codes were created and read-back verified: **100% forever** for either plan and **70% off the first monthly invoice**. They have no customer restriction or total-redemption cap. Anyone holding them can redeem them. Code strings are intentionally omitted from this tracked document; recover them from the authorized operator conversation or Stripe dashboard, not a public docs page. Do not issue replacements merely because this document omits them.

- Forever discounts renewals of the subscription, not a separate local lifetime-entitlement flag.
- Finite discounts are monthly-product-only, preventing a free/discounted month from waiving a yearly invoice. 70% off USD 9.99 rounds to USD 3.00 for the first month.
- Shared issuance requires `--shared`; customer-specific single-redemption issuance uses `--customer` instead. Never combine those flags.
- Keep codes private; revoke a leaked promotion in Stripe. Never publish usable code strings or Stripe secret keys in source or documentation.

Operator CLI examples, from a clean middleware main worktree:

```sh
node -r ts-node/register scripts/candidate-stripe-offers.ts --help

# Writes real financial configuration: only with explicit authorization.
node -r ts-node/register scripts/candidate-stripe-offers.ts promo \
  --shared --duration forever --percent-off 100 \
  --request-id "$REQUEST_ID" --code "$PARTNER_CODE" --execute

node -r ts-node/register scripts/candidate-stripe-offers.ts promo \
  --shared --duration month --percent-off 70 \
  --request-id "$REQUEST_ID" --code "$FIRST_MONTH_CODE" --execute
```

Use a different UUID per offer and retain the exact UUID/arguments for retries. `setup --execute` provisions/reuses dedicated candidate products/prices; those products already exist in the live merchant from the prior authorized issuance.

## 7. Release configuration still needs verification

**Production SQL migration completed:** the exact `companion-billing-intervals.sql` from `b1f14ab3` was applied and committed on the verified `neodb.jobstash.xyz` / `jobstash` PostgreSQL primary using its existing owner role. Both columns and the validated month/year constraint were checked from a separate connection; `jobstash_app` can read/update them. All four existing subscription rows and every pre-existing column value were preserved, verified by a same-transaction row count and fingerprint under the migration lock. Lock timeout was 5 seconds; statement timeout was 30 seconds. Application deployment, price configuration and artifact hosting were not verified by this SQL operation.

Pushed code is not deployment evidence. Continue with the remaining release configuration:

1. Use middleware `main` containing `b1f14ab3`. The production migration is complete. On another environment, apply `scripts/sql/companion-billing-intervals.sql` after `companion.sql`, before the new service; existing paid periods and owners must remain unchanged.
2. Reuse `STRIPE_API_KEY` and `STRIPE_WEBHOOK_SECRET`. Configure:
   - `STRIPE_CANDIDATE_PRICE_ID=price_1URgfcEolDfUXLWnFjXtk5Yl`
   - `STRIPE_CANDIDATE_YEARLY_PRICE_ID=price_1URgfdEolDfUXLWnq0GWUf9c`
   - `RECRUITERS_PUBLIC_ORIGIN=https://recruiters.rip`
   These price IDs were created/read in the live merchant; confirm the deployment uses the same account/mode. IDs are not secret keys.
3. Preserve existing `/stripe/webhook` signature verification, event routing and account-origin protection. Do not replace them with the obsolete `CANDIDATE_STRIPE_*`/`/webhooks/candidate-stripe` setup from the dirty branch.
4. Publish frontend `5d01878` or later and mount the actual download files read-only. Set `COMPANION_INSTALLER_PATH` and `CHROME_EXTENSION_PATH` to their container paths. Never point them at vaults/source trees or invent a GitHub release/store URL.
5. Verify Docs/Downloads anonymously, account navigation when signed in, monthly/yearly checkout selection, partner-code acceptance, return/status refresh, native pairing approval and protected downloads. A user-authorized real checkout is separate from automated synthetic checks. Do not charge or cancel another user's agreement to verify this release.

The frontend still contains defensive display support for a legacy provider; that is not a reason to migrate or alter the authoritative backend's existing Stripe subscriptions. Some older companion README/MCP copy mentions monthly membership only; use the current website/billing contract for complete pricing, and update that copy only when assigned.

## 8. WIP distribution artifacts

Prepared outside source control at `../recruiters-downloads/`:

| File | Verification recorded |
| --- | --- |
| `recruiters-rip-companion-3.8.0-mac-arm64.zip` | 148,666,983 bytes; SHA-256 `3b27649036415689b23c0a9855e792bf17d6ade88c90bc47894aa06f13ed5090`; ZIP integrity and ad-hoc code-signature verification passed |
| `recruiters-rip-chrome-wip.zip` | 5,624 bytes; SHA-256 `000d83c5cd021b514a7202f0735dabda4fd3428de3c47d3c6223c42f2c808238`; seven-file production closure and native-host identity checked |

The companion ZIP is **ad-hoc signed and not notarized**. Do not describe it as a signed/notarized public release. Current binary packaging is macOS ARM64; a Windows/Intel/Linux installer was not produced. Successful packaging/signature verification did not launch the app against a real vault.

The optional Chrome extension is a **WIP account/native-messaging bridge**, not a job scraper or application bot. Chrome 125+, unpacked installation, no Chrome Web Store listing. It requests native messaging only, connects to `com.recruiters.companion`, and its key derives extension ID `jknkgmnnlnadolphagkhdmdmbgbfiplb`, matching the companion's allowed origin. Installing it alone does not pair an account or connect an AI app.

Extension source used for this package: `../recruiters.rip/browser-extension/`. From an authorized source checkout, build its production output, then use frontend `scripts/package-extension.mjs --source /absolute/production-folder --output /absolute/extension.zip`. The frontend must not acquire a sibling runtime/build dependency.

A local ignored frontend `.env.development.local` was added with absolute paths to the two prepared ZIPs. It is not production configuration. Real file streams were exercised for both archives; sign-in/current-membership checks remain on their HTTP download routes.

## 9. Verification commands and evidence

Run checks only for the slice you own, after implementation. Do not run live inference, mutate a real vault, send email or perform live financial operations in tests.

### Companion

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

Earlier session evidence: 193 tests passed. These were not rerun solely to write this handover. `pnpm package:adhoc` subsequently produced the verified preview; it never publishes. `pnpm package:release` requires real Developer ID/notarization credentials.

**Build hazard:** runtime builds, `start` and `test` clear the repository's entire `dist/`. Do not run independent builds concurrently or run installed MCP tools from disposable build output. The copied files in `../recruiters-downloads/` were kept separately for this reason. Production `pnpm start`/`dev` use the real user data directory and re-register host/protocol launchers; do not use them casually as smoke tests. Read the README's isolated local-product instructions first.

### Frontend

```sh
pnpm -s typecheck
pnpm -s test:run
pnpm -s build
```

Recorded evidence at `5d01878`: typecheck/build passed, **88 tests passed**. Browser checks covered 1440px/390px account navigation, keyboard focus/active routes, Docs anchors, public access despite account-service failure, download 401/402/503 recovery and no horizontal overflow. Generated `next-env.d.ts` is not part of the pushed change. Build emitted Privy/viem dependency warnings; those were not hidden or addressed by this feature.

### Middleware, clean main worktree only

```sh
yarn build
yarn jest --runInBand src/companion scripts/candidate-stripe-offers.spec.ts
```

Recorded evidence at `b1f14ab3`: build passed and **157 tests passed**. A throwaway runtime smoke used a fresh isolated PostgreSQL cluster and synthetic Stripe SDK transport, exercising monthly/yearly 100% invoices, monthly 70%/USD 3.00, old-price survival after config rotation, cancellation and expiry. Migration application succeeded. No live subscription/charge was created by verification. The smoke script, temporary cluster and isolated push worktree were removed.

Live operations were limited to the user's explicit product/price/promotion issuance request and read-back verification. Successful code creation is not proof that the currently deployed checkout is using those products.

## 10. Working with another agent

- Agree ownership by repository and file set. One integration owner runs final gates and commits; workers should not run competing builds, auto-format shared files or push independently.
- Give production backend agents a **clean main worktree**, not the broader `feat/career-agent` workspace. That feature bundle is published separately, not integrated into production. No force-push, reset or automatic main merge.
- Preserve auth, exact-origin/session-generation checks, native approval, paid-feed access and artifact-path protections. Tests must use isolated synthetic state.
- Keep `package.json` the companion version source. Keep generated plugins/installers, local configuration and credentials out of commits.
- The user prefers terse concrete engineering and minimal, product-shaped UI. Show actual state; do not invent capability, readiness, entitlement, rankings or release availability.
- Before calling a change done, exercise its actual surface/path and distinguish observed proof from inference. Update relevant existing README/design/changelog material after the smoke. Push only when requested, and report repository/branch/commit plus any remaining deployment prerequisite.
