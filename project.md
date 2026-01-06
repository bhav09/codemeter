# CodeMeter - AI Coding Agent Cost Tracker

## Enhanced Task Brief (ETB)

### 1) User Goal
Build an IDE-agnostic extension that provides project-level insights on AI coding agent usage and costs, using the user's own Cursor authentication (free/paid/enterprise) with optional Chrome helper for seamless token pairing. The extension must maintain continuous cost tracking even when users switch between IDEs (Cursor, VS Code, Antigravity) mid-project.

### 2) Mode: MVP (Architect)
**Reason**: Still an external product, but we are entering “public extension” territory (publishing, broader usage, more data volume). We keep MVP speed, but add stronger safety/observability and more robust storage/sync semantics.

### 3) Code Grounding
**Files to read/modify:**
- `/packages/core/src/types.ts` - normalized usage event types
- `/packages/core/src/attribution.ts` - attribution engine logic
- `/packages/ide-vscode/src/extension.ts` - VS Code extension entry
- `/packages/ide-vscode/src/sessionTracker.ts` - project session tracking
- `/packages/connectors/cursor-dashboard/src/client.ts` - dashboard API client
- `/packages/connectors/cursor-admin/src/client.ts` - admin API client
- `/packages/chrome-helper/src/background.ts` - Chrome extension background
- `/packages/database/src/schema.ts` - local store primitives (JSONL today)
- `/packages/database/src/repositories.ts` - analytics, budgets, sync state
- `/packages/ide-vscode/src/dashboardView.ts` - Activity Bar dashboard UI
- `/packages/ide-vscode/src/sync.ts` - sync engine + incremental fetch
- `/packages/ide-vscode/package.json` - views/commands/packaging metadata
- `/README.md` - user setup/run docs

### 4) Dependency Check
**Core dependencies needed:**
- Local persistence uses an append-only JSONL store in `~/.codemeter/` (portable across VS Code forks)
- `axios` for HTTP requests
- `vscode` for VS Code API
- `chrome-extension` types for browser helper

**Phase 2 dependency decision (TBD):**
- If we re-introduce SQLite: prefer a solution that works with VS Code extension runtime constraints.
  - Alternatives: keep JSONL + add compaction/indexing; use `sql.js` (WASM SQLite); use an embedded DB with prebuilds.
  - We must validate packaging/build stability across Mac/Windows/Linux and VS Code/Cursor forks before committing.

### 5) Safety Audit (MVP)
- **Rate limiting**: Respect Cursor's 1-hour polling limit for usage endpoints
- **Input validation**: Validate all API responses and user inputs
- **Auth security**: Store tokens in VS Code SecretStorage, never in plain text
- **Error handling**: Clear error messages without exposing internal details
- **Data privacy**: Never log full tokens or sensitive user data

**Phase 2 additions:**
- **Sync correctness**: `sync_state.lastFetchedMs` should reflect the newest *observed event timestamp*, not the request end time, to avoid gaps.
- **Idempotency**: ensure event insert + attribution upsert remain safe on retries.
- **Observability**: add minimal structured logs (start/success/failure) for sync + attribution without PII.

### 6) Step-by-step Plan
1. **Schema/Types**: Define normalized usage event and project session types
2. **Database**: Create SQLite schema with migrations
3. **Core Logic**: Implement attribution engine and cost computation
4. **VS Code Extension**: Build extension with session tracking
5. **Connectors**: Implement dashboard and admin API clients
6. **Chrome Helper**: Create browser extension for token pairing
7. **UI**: Build cost dashboard and budget alerts
8. **Testing**: Verify attribution accuracy and rate limit compliance

**Phase 2 (requested “do all of them”) plan:**
1. **Storage driver**: Introduce a `StorageDriver` abstraction in `packages/database` (JSONL driver stays as default). Add optional compaction + lightweight indexes.
2. **Sync correctness**: Change sync-state semantics to “max seen event timestamp”; add UI indicators: last sync time, rate-limited state.
3. **Attribution improvements**: Improve focus/idle tracking by segmenting sessions on state change; better multi-window handling; explicit conflict bucket.
4. **Dashboard UX**: Add cards for Today/7d/Month, token breakdown, top models, unattributed/conflicts counts, cost-per-hour heatmap (MVP version).
5. **Enterprise toggle**: Add dashboard selector for connector mode (dashboard vs admin) and store per-source sync state.
6. **Publishing hygiene**: Add `repository` metadata, LICENSE, icon, and Open VSX publish readiness.

### 7) Acceptance Criteria
- ✅ Extension tracks active project sessions with focus/idle states
- ✅ Fetches usage events from Cursor dashboard (individual) or admin API (enterprise)
- ✅ Attributes usage events to projects with confidence scoring
- ✅ Shows project cost breakdowns (daily/weekly/monthly)
- ✅ Supports budget alerts at 70/85/100% thresholds
- ✅ Chrome helper enables seamless token pairing (no copy/paste)
- ✅ Respects Cursor's rate limits (max 1 poll per hour)
- ✅ Works with free, paid, and enterprise Cursor accounts
- ✅ Maintains continuous cost tracking across IDE switches (Cursor → VS Code → Antigravity)
- ✅ Shared database location accessible by all IDE instances
- ✅ Project identification persists across different IDEs

**Phase 2 acceptance criteria:**
- ✅ Sync-state prevents gaps (no missed events across repeated hourly syncs)
- ✅ Dashboard shows: Today/7d/Month totals, top models, token breakdown, unattributed/conflict buckets
- ✅ Improved session tracking yields higher attribution confidence in common workflows
- ✅ “Connector mode” switch supports teams/admin without code changes
- ✅ Publishing metadata present (repo, license, icon) and artifacts can be built consistently

### 8) Rollout Plan
- **Phase 1**: VS Code marketplace release with dashboard connector
- **Phase 2**: Add Chrome helper for token pairing
- **Phase 3**: Add enterprise admin API support
- **Phase 4**: Publish to Open VSX for Antigravity compatibility

**Phase 5**: Hardening release
- Keep JSONL driver as default until we validate any SQLite approach across platforms.
- Ship dashboard UX + sync correctness improvements behind a feature flag if needed.

---

## Phase 3 ETB Addendum — Branding + Publishing

### 1) User goal
Use the provided CodeMeter logo for the extension and prepare the project to publish the extension artifacts.

### 2) Mode
[MVP] — publishing-ready hygiene (metadata, icon, packaging) with minimal risk.

### 3) Code grounding (files to modify)
- `packages/ide-vscode/package.json` (repository URL + icon fields)
- `packages/ide-vscode/assets/codemeter.png` (replace with user-provided logo)
- `README.md` (publish instructions + links)

### 4) Dependency check
- Use existing tooling already in repo: `vsce` (packaging/publish).
- Optional for Open VSX publishing: `ovsx` (will be installed by user globally or via `npx`).

### 5) Safety audit (MVP)
- No secrets committed; publish tokens must be provided via environment variables or CLI prompts.
- Do not guess repo URLs; use the provided link.

### 6) Step-by-step plan
1. Add the user logo as `packages/ide-vscode/assets/codemeter.png` (PNG required by `vsce`).
2. Set `repository.url` to the real repo (`https://github.com/bhav09/codemeter`) and ensure icon paths are correct.
3. Re-package VSIX and verify warnings are gone.
4. Provide publish steps for:
   - VS Code Marketplace (`vsce publish`)
   - Open VSX (`ovsx publish`)

### 7) Acceptance criteria
- VSIX builds successfully and shows the new icon in Cursor Activity Bar.
- `repository` metadata is set to the GitHub repo.
- README includes publishing instructions and repo link.

### 8) Rollout plan
- Publish to Open VSX first (Antigravity/Cursor ecosystem), then VS Code Marketplace.

---

## ETB Addendum — Fix dashboard view “no data provider registered” + show empty dashboard when no data

### 1) User goal (1 sentence)
Fix CodeMeter in VS Code/Cursor so the **Activity Bar Dashboard always renders** (even with zero data) and the extension **tracks project activity** so attribution has context.

### 2) Mode
[MVP] (Architect) — external users, but this is a **packaging/activation reliability** fix; optimize for the smallest safe change that restores functionality.

### 3) Code grounding (required file reads)
**Files read (this session):**
- `packages/ide-vscode/package.json` (view contributions, activation events, packaging scripts)
- `packages/ide-vscode/src/extension.ts` (activation + provider registration)
- `packages/ide-vscode/src/dashboardView.ts` (webview view provider + empty-state rendering)
- `packages/ide-vscode/src/dashboardWebview.ts` (command-based dashboard panel)
- `packages/ide-vscode/src/sessionTracker.ts` (project session tracking hooks)
- `packages/ide-vscode/src/projectIdentity.ts` (project key computation)
- `packages/ide-vscode/src/sync.ts` (sync + attribution path)
- `packages/database/src/schema.ts` / `packages/database/src/driver.ts` / `packages/database/src/repositories.ts` (local JSONL store + analytics queries)
- `README.md` / `packages/ide-vscode/README.md` (user workflow and expectations)

**Files expected to modify (proposal):**
- `packages/ide-vscode/package.json` (fix build/package so the extension actually loads in production installs)
- `packages/ide-vscode/src/dashboardView.ts` (defensive empty-state: dashboard should render even if DB read fails)
- `packages/ide-vscode/src/sessionTracker.ts` (ensure project “activity” updates keep projects visible even before usage sync)

### 4) Dependency check
**No new runtime dependencies planned.** (Bundling only adds a *dev* dependency.)

Key observation: this repo uses **npm workspaces**, which installs internal packages as symlinks (e.g. `node_modules/@codemeter/database -> ../../packages/database`).
- **Likely impact**: `vsce package` rejects these symlinks with “invalid relative path …”, so packaging fails or produces an extension that can’t resolve modules at runtime—leading to the VS Code/Cursor error: “There is no data provider registered that can provide view data.”

**Alternatives considered:**
- **Bundle the extension** (esbuild/webpack) — **chosen**: avoids workspace symlink issues and makes activation reliable.
- **Include dependencies in VSIX** (remove `--no-dependencies`) — not viable with workspaces symlinks; `vsce` rejects them.

### 5) Safety audit (MVP)
- **Reliability**: dashboard should not crash or show a hard error when storage is empty/unavailable; show an empty dashboard with a small “error” indicator instead.
- **Security**: do not log tokens / secrets; no new telemetry that includes PII.
- **Backwards compatibility**: avoid schema changes; keep existing JSONL stores working as-is.

### 6) Step-by-step plan (must follow this order)
1. **Schema/Types**: no schema changes; confirm dashboard can represent “empty” state with current message shape.
2. **Failing repro step**: package/install the extension and open the CodeMeter activity bar; observe the “no data provider registered” screen.
3. **Implementation logic**:
   - Fix packaging so the extension can load/activate reliably (likely removing `--no-dependencies` and ensuring build emits `dist/extension.js` consistently).
   - Harden dashboard state posting so it renders a blank dashboard when there are zero rows or when reads fail.
   - Make session tracker update project `lastActiveAt` on user activity so the dashboard can show the project list even before any Cursor usage is synced.
4. **Telemetry/logs**: add minimal, non-PII logging around activation failure paths (start/success/failure) to help debug future “blank view” reports.
5. **Build verification**: run the repo build and the VSIX packaging script that exists in the repo.

### 7) Acceptance criteria (definition of done)
- **Dashboard renders** in VS Code and Cursor without the “no data provider registered” screen.
- With a brand new install and no stored events, the dashboard shows a **blank/empty state** (not an error screen).
- Editing in a workspace results in a project appearing in the dashboard (activity is tracked even before usage sync).
- Packaging/build produces a VSIX that loads without missing-module errors.

### 8) Rollout plan (MVP recommended)
- Release as a **patch version**.
- Validate quickly on both VS Code and Cursor:
  - open Activity Bar view
  - ensure empty state renders
  - edit a file and confirm a project appears
  - optionally run “Refresh usage” (should still work if auth is configured)
- If anything regresses, rollback by republishing the prior VSIX (no data migration required).

## Architecture Overview

```
/packages
├── core/                 # Pure logic, no IDE dependencies
│   ├── src/types.ts     # Normalized types
│   ├── src/attribution.ts # Attribution engine
│   └── src/cost.ts      # Cost computation
├── ide-vscode/          # VS Code extension
│   ├── src/extension.ts # Extension entry
│   ├── src/sessionTracker.ts # Project session tracking
│   └── src/pairingServer.ts # Chrome pairing server
├── connectors/
│   ├── cursor-dashboard/ # Individual user connector
│   └── cursor-admin/    # Enterprise connector
├── chrome-helper/       # Browser extension
├── database/           # SQLite schema and migrations
└── protocol/           # Shared message schemas
```

## Development Status

### Current Sprint: Milestone 1 - Core + Local Project Sessions
- [ ] Set up monorepo with TypeScript
- [ ] Implement core types and attribution logic
- [ ] Create local storage schema (append-only JSONL store)
- [ ] Build VS Code extension foundation
- [ ] Add project session tracking

### Next Sprint: Milestone 2 - Dashboard Connector
- [ ] Implement Cursor dashboard connector
- [ ] Add usage event fetching and normalization
- [ ] Build basic cost computation
- [ ] Create simple UI for cost display

## Technical Decisions

### Database Choice: Append-only JSONL store (shared directory)
**Rationale**: Native SQLite bindings (like `better-sqlite3`) can be brittle across Node/Electron versions and can fail to build on some developer machines. JSONL append-only logs in `~/.codemeter/` are portable across VS Code forks and preserve cross-IDE continuity.
**Trade-offs**:
- **Fast vs safe**: JSONL is safer/portable but slower for large datasets (scans/aggregations). Acceptable for MVP volumes; compaction/indexing can be added later.
- **Simple vs flexible**: SQL is more expressive; JSONL requires explicit aggregation code.
- **Short-term vs long-term**: We can reintroduce SQLite via a pluggable storage driver once packaging constraints are validated.

### Attribution Strategy: Time-based with confidence scoring + Cross-IDE continuity
**Rationale**: Cursor doesn't provide project-level data, so we use session tracking + timestamp matching with manual override capability. **Cross-IDE enhancement**: Project sessions persist across IDE switches using shared database and consistent project identification (git remote + workspace path hashing).

### Auth Approach: User-owned credentials
**Rationale**: All requests made from user's machine with their auth, ensuring rate limits belong to them and no proxy server needed.

### Modular Architecture: Separate concerns
**Rationale**: Enables easy porting to other VS Code forks (Cursor, Antigravity) by isolating IDE-specific and platform-specific code.

### Cross-IDE Session Continuity: Shared database + consistent project identification
**Implementation**:
- **Shared Database Location**: Store append-only JSONL logs in user's home directory (`~/.codemeter/`) accessible by all VS Code-based IDEs
- **Consistent Project Keys**: Use git remote URL + workspace path hash for project identification across different IDEs
- **IDE Instance Tracking**: Each IDE instance writes sessions to shared database with unique instance IDs
- **Session Overlap Handling**: When switching IDEs, new session starts with reference to previous IDE's session for seamless continuity
- **Cost Aggregation**: All usage events attributed to project regardless of which IDE was used during event timestamp

## Work Log

### 2026-01-06
- **What changed**: Added TS project references/build wiring; implemented Cursor connectors, VS Code extension (session tracking + pairing + dashboard + budgets/alerts), and Chrome helper extension (MV3) for no-copy token pairing. Switched local storage from SQLite to a shared JSONL log store due to native build constraints.
- **What I learned**: A shared on-disk store is the key enabler for cross-IDE continuity; JSONL is the most portable MVP option across forks.
- **What’s next**: Add conflict/unattributed review UI and implement incremental sync-state based polling with backoff.
- **New risks/tech debt**: Cursor dashboard/admin API response shapes are treated defensively; we may need to adjust normalization once we observe real payloads.

### 2026-01-06 (Phase 2)
- **What changed**: Added `StorageDriver` + JSONL compaction/snapshots; improved sync correctness (high-water mark + lookback + error recording); segmented sessions on focus/idle changes; expanded dashboard (connector mode selection, unattributed summary, cost-by-hour heatmap); added maintenance compaction on a timer.
- **What you learned**: JSONL is workable for MVP if you add compaction/snapshots; sync high-water mark must track observed events to avoid gaps.
- **What’s next**: Publishing hygiene remaining items: add extension icon and set `repository` URL (need your repo URL/icon path). Consider adding more detailed conflict visualization (explicit conflict bucket).
- **New risks/tech debt**: Compaction is best-effort and may race with concurrent writers; acceptable for MVP but should be hardened (file locks or per-kind atomic rename strategy with retries) if data volume grows.

### 2026-01-06 (Phase 2 continued)
- **What changed**: Added per-store compaction lockfiles with stale-lock handling; added derived index snapshot (`index.cost_by_project_by_day`) to speed long-range analytics; dashboard now shows sync health (last sync + last error), conflicts summary, and uses derived index when present.
- **What’s next**: Consider making conflict review fully in-dashboard (not QuickPick). If data volumes grow, further harden compaction with retry/backoff and/or a single “compaction coordinator” lock.

### 2026-01-06 (Phase 3)
- **What changed**: Wired repository metadata to `https://github.com/bhav09/codemeter` and prepared publishing docs; logo is now provided as a PNG and used for both the extension icon and Activity Bar container.
- **What’s next**: After you push code to GitHub, publish to Open VSX and VS Code Marketplace using your tokens.

### 2026-01-06 (Bugfix investigation)
- **What changed**: Investigated the VS Code/Cursor dashboard error “There is no data provider registered that can provide view data.”
- **What I learned**: The view is contributed as a `webview` (`codemeter.dashboard`) and the provider registration exists, so the error most likely happens when the extension fails to load/activate. With npm workspaces, `vsce` can also reject symlinked dependencies during packaging, which breaks activation.
- **What’s next**: Bundle the extension for stable packaging, and ship defensive empty-state + “show usage quickly” behavior (safe initial sync).

### 2026-01-06 (Bugfix implementation)
- **What changed**: Bundled the VS Code extension (esbuild) so packaging works with npm workspaces; dashboard now fail-soft renders even with no data; session tracking updates project activity so projects show immediately; and a best-effort initial sync runs shortly after startup when credentials exist (respecting poll interval).
- **What you learned**: Workspaces + `vsce` packaging require bundling to avoid symlink/module-resolution issues.
- **What’s next**: Publish the new VSIX, then validate in both VS Code and Cursor: open dashboard, edit a file (project appears), and confirm usage appears after initial sync/refresh.