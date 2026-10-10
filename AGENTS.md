# Companion ownership

- Own the Node companion, encrypted local career vault, local MCP tools, conversation skill, document codec/baseline/layout/PDF source and Git/npm package here. No Electron runtime or installer.
- Website authentication, checkout, pairing UI and signed-device proxy belong to `recruiters-rip-frontend`. Middleware authorizes devices and current paid job-feed access. No sibling imports or server inference dependencies.
- Preserve storage/keychain name `Recruiters Companion` and production `device` directory. Never inspect, mutate, reset or migrate a user's actual vault as a test. Test only temporary synthetic data and injected key storage.
- Production defaults to `https://recruiters.rip`; `--local-product` is explicit and isolated. Pairing opens `/settings/provider` with public device information and a one-time loopback return. Explicit confirmation in authenticated local controls is required before activation.
- Keep CVs, facts, scores and drafts local. New feed access requires real membership; unpaid users retain saved data. Never manufacture authentication or entitlements, add payment fixtures to production or request provider keys.
- Reasoning and AI authentication belong to the user's official subscription app. Do not add API inference, model SDKs, automated live scoring or fallback web-job search. Preserve scoring, evidence, continuity and CV review gates.
- Local control API binds only to 127.0.0.1, authenticates every action and rejects foreign origins/hosts. MCP uses an authenticated local socket; only one vault writer runs. Browser file selection is explicit and bounded; no arbitrary model-supplied file reads.
- `package.json` is the version source. `npm-shrinkwrap.json` pins installation. `prepare` builds Git installs. Generated output, credentials, installers, vaults and exports are not source-control inputs. Document source and font/license must build from this clone alone.
- Gates: `npm ci`, `npm run check`, `npm test`, and an install from a packed artifact or Git source in a temporary directory. Tests never use real inference, account pairing, keychain data or modify existing AI-app settings.
- Keep setup/control copy concrete. No fabricated success, hidden failures, generic retry buttons or remote career uploads.
