# CodeMeter

**CodeMeter** is a **dashboard-first** VS Code extension (works in VS Code forks like **Cursor** and **Antigravity**) that provides **project-level insights** into AI coding agent usage/cost by attributing Cursor usage events to the project you were working on at that time.

It supports **cross-IDE continuity**: if you use Cursor for two weeks and then switch to Antigravity, as long as CodeMeter is installed in both IDEs, costs continue to accrue under the same project.

## What it does

- **Tracks project sessions** (active workspace, focus/idle, IDE type)
- **Fetches Cursor usage events** (user-owned auth)
  - Individual accounts via **dashboard session cookie** (`WorkosCursorSessionToken`)
  - Teams/Enterprise via **Admin API key** (Basic Auth)
- **Attributes usage → project** via time overlap with confidence scoring
- **Shows a dashboard** in the Activity Bar (no command-palette workflow required)
- **Budget alerts** per project (monthly budget + thresholds)
- **Manual review**: reassign unattributed / low-confidence events

## Architecture

Monorepo packages:

- `packages/core`: normalized types + attribution + retry/backoff
- `packages/database`: shared cross-IDE local store (append-only JSONL in `~/.codemeter/`)
- `packages/connectors/cursor-dashboard`: dashboard connector (cookie auth)
- `packages/connectors/cursor-admin`: admin connector (API key auth)
- `packages/ide-vscode`: VS Code extension (Activity Bar dashboard)
- `packages/chrome-helper`: Chrome helper extension (no-copy pairing)

## Local persistence (cross-IDE continuity)

CodeMeter stores data in your home directory:

- `~/.codemeter/projects.jsonl`
- `~/.codemeter/sessions.jsonl`
- `~/.codemeter/events.jsonl`
- `~/.codemeter/attributions.jsonl`
- `~/.codemeter/budgets.jsonl`
- `~/.codemeter/sync_state.jsonl`

This is what keeps metrics consistent across VS Code/Cursor/Antigravity.

## Requirements

- Node.js **18+**
- npm **9+**
- VS Code / Cursor / Antigravity (VS Code-compatible IDE)
- Chrome (for optional pairing helper)

## Install + build

From repo root:

```bash
npm install
npm run build
```

## Run the extension (dashboard)

### Option A — Install the packaged VSIX (recommended)

Create the `.vsix`:

```bash
npm --workspace packages/ide-vscode run package
```

Then in VS Code/Cursor/Antigravity:

- Extensions → “…” → **Install from VSIX…**
- Select `packages/ide-vscode/codemeter-0.1.0.vsix`
- Open **Activity Bar → CodeMeter → Dashboard**

### Option B — Run in Extension Development Host (dev workflow)

- Open `packages/ide-vscode/` in VS Code
- Press **F5** (Run Extension)
- In the launched window: Activity Bar → **CodeMeter**

## Connect Cursor (no-copy pairing)

### 1) Load the Chrome helper (unpacked)

- Chrome → `chrome://extensions`
- Enable **Developer mode**
- **Load unpacked** → select `packages/chrome-helper/`

### 2) Pair from the dashboard

- In the IDE: **CodeMeter → Dashboard → “Connect Cursor”**
- This opens a local pairing page at `http://127.0.0.1:<port>/pair`
- In Chrome:
  - open `cursor.com` and ensure you are logged in
  - click the **CodeMeter Helper** extension icon → **Pair now**

The IDE stores the token securely in **VS Code SecretStorage** (never in settings.json).

## Using the dashboard

In the dashboard you can:

- **Refresh usage**
- Select a **project** to see last-7-days metrics + top models
- **Set budget** (monthly USD) and receive alerts
- **Review attribution** and manually reassign events

## Notes / caveats

- Dashboard endpoints are not a guaranteed public API; the connector is isolated in `packages/connectors/`.
- Attribution is time-based; “Unattributed” is expected if usage happens outside an active project session.
- Repository: `https://github.com/bhav09/codemeter`

## Publish (when you’re ready)

Publishing requires accounts/tokens; we do **not** store or commit any secrets.

### 1) VS Code Marketplace

Prereqs:
- A VS Code Marketplace publisher account
- A Personal Access Token (PAT) for `vsce`

Commands (run from repo root):

```bash
cd "/Users/bhavishya/VSC Projects/codemeter"
npm install
npm run build
npm --workspace packages/ide-vscode run package

# publish (requires you to login/configure publisher + token)
cd packages/ide-vscode
vsce publish
```

Notes:
- The publisher name in `packages/ide-vscode/package.json` must match your Marketplace publisher.

### 2) Open VSX (recommended for Antigravity / forks)

Prereqs:
- An Open VSX account + token

```bash
cd "/Users/bhavishya/VSC Projects/codemeter"
npm run build
npm --workspace packages/ide-vscode run package

# Publish the generated vsix (using ovsx)
npx --yes ovsx publish "packages/ide-vscode/codemeter-0.1.0.vsix"
```

## Scripts

- `npm run build`: TypeScript build (project references)
- `npm --workspace packages/ide-vscode run package`: builds a `.vsix`


