# Recruiters.rip Companion

A Node package that connects your own AI subscription app to local career tools. No Electron app, browser extension, provider API key or paid npm account is needed.

## One-command setup

Install **Node.js 22.12 or newer** (including npm) and Git, then run:

```sh
npx --yes github:jobstash/recruiters-rip-companion
```

**Distribution note:** the repository is currently private. This command needs GitHub repository access until a public source/package is released. Use a published commit or release tag for reproducible installs; do not describe a private repository as accessible to everyone.

Setup keeps its runtime in your user account, opens controls in your browser, and continues in the background after you close the terminal. No administrator privileges are needed.

1. Choose **Set up Codex** or **Set up Claude Desktop**. Codex is installed if missing. Its skill and MCP connection are registered automatically. Claude Desktop's settings are merged with its other servers; its career instructions are delivered by the local MCP connection. Restart Claude after setup.
2. Choose **Sign in with ChatGPT** if needed, or sign in inside Claude. The official app owns your AI login and subscription. The companion does not perform inference or collect provider credentials.
3. Choose **Connect account**, sign in on recruiters.rip and pair this device. Follow **Confirm account on this computer**, then approve the named account in your local controls. Membership gates fresh jobs; your saved work remains available without membership.
4. Start a new conversation in your AI app and ask **“Use Recruiters.rip. Help me find jobs that match my experience.”** When your AI app asks for your CV, the local controls open a file chooser.

Ordinary ChatGPT web chats do not inherit a local MCP connection. Use Codex or Claude Desktop. A configured connection is not evidence that a conversation has used its tools; the controls show actual active connections.

## Controls

Run the same command again to open your controls. Append an action when useful:

```sh
npx --yes github:jobstash/recruiters-rip-companion status
npx --yes github:jobstash/recruiters-rip-companion stop
npx --yes github:jobstash/recruiters-rip-companion start
npx --yes github:jobstash/recruiters-rip-companion pause
npx --yes github:jobstash/recruiters-rip-companion resume
```

The browser controls also provide pause/resume, lock, stop, account connection/disconnection, CV selection, career backups and PDF/CSV downloads. Pause prevents local mutations while retaining reads; lock disconnects tools and persists until explicitly unlocked. Supported OS session lock signals also lock the tools. AI usage is controlled by the AI app, not by pausing this companion.

Stopping closes local connections. A later AI-app connection can start the installed process again. There is no login daemon, public tunnel or listening network interface other than loopback. The installed runtime is retained outside the temporary npx cache, so clearing that cache does not break AI-app configuration.

## Existing desktop data

On macOS, quit the old desktop companion before setup. The first run reads its `vault.bin` using **Recruiters Companion Safe Storage** in Keychain and creates `vault.node.bin` encrypted with AES-256-GCM and a new OS-protected key. It preserves identity, pairing, sources, facts, assessments, drafts, receipts and archives. The original file is never overwritten. Approve Keychain access if macOS asks. Never run the old app and Node companion at the same time.

New installations use macOS Keychain, Windows Credential Manager, or Linux Secret Service. Linux requires an unlocked persistent Secret Service; there is no plaintext or volatile key fallback. Automatic transfer of older Linux/Windows Electron vault formats is not supported: setup stops rather than replacing existing data. The previously distributed desktop build was macOS Apple Silicon.

Source documents and career state stay local. Tool results are visible to the user's chosen AI provider. Backups and exported PDFs/CSVs are ordinary files; save them privately. Device disconnection archives existing career data locally instead of exposing it to the next account.

## Development and packaging

```sh
npm ci
npm run check
npm test
npm pack
```

Git installations run `prepare`, compiling the owned document engine and packaging its font/license, scoring rubric and conversation skill. Runtime installation uses the shrinkwrap and excludes development packages; no Electron dependency is shipped. The package has one executable, `recruiters`. `recruiters mcp` is strictly an MCP standard-input/output connection; progress goes to stderr, never the protocol stream.

Tests use temporary synthetic vaults and injected key storage. They never inspect a user's actual vault or run inference. `--local-product` uses the isolated `local-device` directory and `http://127.0.0.1:3001`; it does not supply authentication or payment fixtures.

Website changes in `recruiters-rip-frontend` must be deployed with this release for the loopback pairing return and Node setup instructions. Existing desktop deep links remain supported by the website during the transition.

The Noto Sans font in `src/documents/assets` remains under its accompanying SIL Open Font License. The shared document implementation, evidence and review rules remain unchanged.
