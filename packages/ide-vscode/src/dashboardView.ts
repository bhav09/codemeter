import * as vscode from 'vscode';
import { AnalyticsRepository, ProjectRepository, SyncStateRepository } from '@codemeter/database';

type DashboardMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'connectCursor' }
  | { type: 'disconnectCursor' }
  | { type: 'setBudget' }
  | { type: 'reviewAttribution' }
  | { type: 'selectProject'; projectKey: string }
  | { type: 'setConnectorMode'; mode: 'cursor-dashboard' | 'cursor-admin' };

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codemeter.dashboard';

  private view?: vscode.WebviewView;
  private selectedProjectKey: string | null = null;
  private connectorMode: 'cursor-dashboard' | 'cursor-admin';
  private lastUiError: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly actions: {
      refresh: (mode: 'cursor-dashboard' | 'cursor-admin') => Promise<void>;
      connectCursor: () => Promise<void>;
      disconnectCursor: () => Promise<void>;
      setBudget: () => Promise<void>;
      reviewAttribution: () => Promise<void>;
    }
  ) {
    this.connectorMode = (context.globalState.get('connectorMode') as any) || 'cursor-dashboard';
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage(async (msg: DashboardMessage) => {
      try {
        if (msg?.type === 'ready') {
          await this.postState();
          return;
        }
        if (msg?.type === 'selectProject') {
          this.selectedProjectKey = msg.projectKey || null;
          return;
        }
        if (msg?.type === 'setConnectorMode') {
          this.connectorMode = msg.mode;
          await this.context.globalState.update('connectorMode', msg.mode);
          return;
        }
        if (msg?.type === 'refresh') return await this.actions.refresh(this.connectorMode);
        if (msg?.type === 'connectCursor') return await this.actions.connectCursor();
        if (msg?.type === 'disconnectCursor') return await this.actions.disconnectCursor();
        if (msg?.type === 'setBudget') return await this.actions.setBudget();
        if (msg?.type === 'reviewAttribution') return await this.actions.reviewAttribution();
      } finally {
        await this.postState();
      }
    });

    webviewView.webview.html = this.renderHtml(webviewView.webview);
  }

  async refresh(): Promise<void> {
    await this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.view) return;

    const now = Date.now();
    const dayStart = now - 24 * 60 * 60 * 1000;
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    const monthStart = startOfMonthMs(now);

    let projects: any[] = [];
    let byProjectToday: any[] = [];
    let byProjectWeek: any[] = [];
    let byProjectMonth: any[] = [];
    let unattributedWeek: any = { totalCents: 0, eventCount: 0 };
    let conflictsWeek: any = { totalCents: 0, eventCount: 0 };
    let syncState: any = null;
    let selectedMetricsWeek: any = null;
    let selectedHeatmapWeek: any = null;

    // Get current workspace info
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentWorkspace = workspaceFolders?.[0]?.name ?? null;
    const currentWorkspacePath = workspaceFolders?.[0]?.uri?.fsPath ?? null;

    try {
      projects = new ProjectRepository().getAll();
      const analytics = new AnalyticsRepository();

      byProjectToday = analytics.getCostTotalsByProject(dayStart, now);
      byProjectWeek = analytics.getCostTotalsByProject(weekStart, now);
      byProjectMonth = analytics.getCostTotalsByProject(monthStart, now);
      unattributedWeek = analytics.getUnattributedSummary(weekStart, now);
      conflictsWeek = analytics.getConflictSummary(weekStart, now);

      const syncRepo = new SyncStateRepository();
      syncState = syncRepo.get(this.connectorMode === 'cursor-admin' ? 'cursor-admin' : 'cursor-dashboard');

      this.lastUiError = null;
    } catch (e: any) {
      this.lastUiError = String(e?.message || e);
    }

    const defaultProjectKey =
      this.selectedProjectKey ??
      projects[0]?.projectKey ??
      (byProjectWeek.find((r: any) => r.projectKey !== 'unattributed')?.projectKey ?? null);
    this.selectedProjectKey = defaultProjectKey;

    try {
      if (defaultProjectKey) {
        const analytics = new AnalyticsRepository();
        selectedMetricsWeek = analytics.getProjectMetrics(defaultProjectKey, weekStart, now);
        selectedHeatmapWeek = analytics.getHourlyHeatmap(defaultProjectKey, weekStart, now);
      }
    } catch (e: any) {
      this.lastUiError = this.lastUiError ?? String(e?.message || e);
      selectedMetricsWeek = null;
      selectedHeatmapWeek = null;
    }

    const sessionTokenSet = Boolean(await this.context.secrets.get('cursor.sessionToken'));

    await this.view.webview.postMessage({
      type: 'state',
      now,
      sessionTokenSet,
      connectorMode: this.connectorMode,
      syncState,
      unattributedWeek,
      conflictsWeek,
      selectedProjectKey: defaultProjectKey,
      selectedMetricsWeek,
      selectedHeatmapWeek,
      projects,
      currentWorkspace,
      currentWorkspacePath,
      totals: {
        today: byProjectToday,
        week: byProjectWeek,
        month: byProjectMonth
      },
      uiError: this.lastUiError
    });
  }

  private renderHtml(_webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
        font-size: 12px;
        color: var(--vscode-foreground, #d4d4d4);
        background: var(--vscode-sideBar-background, transparent);
        padding: 12px;
        line-height: 1.4;
      }

      /* Card styles */
      .card {
        background: var(--vscode-editor-background, rgba(30,30,30,0.5));
        border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
        border-radius: 6px;
        padding: 12px;
        margin-bottom: 12px;
      }

      /* Header section */
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      }
      .logo { font-weight: 700; font-size: 14px; color: var(--vscode-foreground); }
      .logo span { color: #3b82f6; }

      /* Status badge */
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 11px;
        font-weight: 500;
      }
      .status.connected { background: rgba(34,197,94,0.15); color: #22c55e; }
      .status.disconnected { background: rgba(239,68,68,0.15); color: #ef4444; }
      .status-dot { width: 6px; height: 6px; border-radius: 50%; }
      .status.connected .status-dot { background: #22c55e; }
      .status.disconnected .status-dot { background: #ef4444; }

      /* Workspace info */
      .workspace-card {
        background: linear-gradient(135deg, rgba(59,130,246,0.1) 0%, rgba(139,92,246,0.1) 100%);
        border: 1px solid rgba(59,130,246,0.2);
      }
      .workspace-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
      .workspace-name { font-size: 14px; font-weight: 600; color: var(--vscode-foreground); word-break: break-all; }
      .workspace-path { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; word-break: break-all; }

      /* Button row */
      .btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
      .btn {
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 500;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .btn-primary {
        background: #3b82f6;
        color: #fff;
      }
      .btn-primary:hover { background: #2563eb; }
      .btn-secondary {
        background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1));
        color: var(--vscode-button-secondaryForeground, #d4d4d4);
      }
      .btn-secondary:hover { background: rgba(255,255,255,0.15); }
      .btn-danger {
        background: rgba(239,68,68,0.15);
        color: #ef4444;
      }
      .btn-danger:hover { background: rgba(239,68,68,0.25); }

      /* Selects */
      .select-group { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
      .select-wrapper { flex: 1; min-width: 120px; }
      .select-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
      select {
        width: 100%;
        padding: 6px 8px;
        font-size: 11px;
        background: var(--vscode-dropdown-background, #3c3c3c);
        color: var(--vscode-dropdown-foreground, #d4d4d4);
        border: 1px solid var(--vscode-dropdown-border, rgba(255,255,255,0.1));
        border-radius: 4px;
        cursor: pointer;
      }
      select:focus { outline: 1px solid #3b82f6; border-color: #3b82f6; }

      /* Stats grid */
      .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
      .stat-card {
        background: var(--vscode-editor-background, rgba(30,30,30,0.5));
        border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
        border-radius: 6px;
        padding: 10px;
        text-align: center;
      }
      .stat-value { font-size: 16px; font-weight: 700; color: var(--vscode-foreground); }
      .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

      /* Sync info */
      .sync-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(59,130,246,0.1);
        border-radius: 4px;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 12px;
      }
      .sync-bar.error { background: rgba(239,68,68,0.1); }

      /* Section header */
      .section-header {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin: 16px 0 8px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .section-header::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--vscode-widget-border, rgba(255,255,255,0.1));
      }

      /* Heatmap */
      .heatmap {
        display: grid;
        grid-template-columns: repeat(24, 1fr);
        gap: 2px;
        margin-bottom: 12px;
      }
      .heatmap-cell {
        height: 20px;
        border-radius: 3px;
        background: rgba(59,130,246,0.1);
        transition: transform 0.1s ease;
      }
      .heatmap-cell:hover { transform: scale(1.1); }

      /* Table */
      table { width: 100%; border-collapse: collapse; }
      th {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
      }
      th.num { text-align: right; }
      td {
        padding: 10px 6px;
        font-size: 12px;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.05));
      }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      tr:hover td { background: rgba(255,255,255,0.02); }
      .empty-row { color: var(--vscode-descriptionForeground); font-style: italic; }

      /* Metrics row */
      .metrics-row { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
      .metric { display: flex; align-items: center; gap: 4px; }
      .metric-value { color: var(--vscode-foreground); font-weight: 600; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="logo">Code<span>Meter</span></div>
      <div id="authStatus" class="status disconnected">
        <span class="status-dot"></span>
        <span>Not Connected</span>
      </div>
    </div>

    <div id="workspaceCard" class="card workspace-card">
      <div class="workspace-label">Current Workspace</div>
      <div id="workspaceName" class="workspace-name">Loading...</div>
      <div id="workspacePath" class="workspace-path"></div>
    </div>

    <div class="btn-row">
      <button id="refresh" class="btn btn-primary">↻ Sync Usage</button>
      <button id="connect" class="btn btn-secondary">Connect Cursor</button>
      <button id="budget" class="btn btn-secondary">Set Budget</button>
    </div>

    <div class="btn-row">
      <button id="review" class="btn btn-secondary">Review Attribution</button>
      <button id="disconnect" class="btn btn-danger">Disconnect</button>
    </div>

    <div class="select-group">
      <div class="select-wrapper">
        <div class="select-label">Connector</div>
        <select id="connectorMode">
          <option value="cursor-dashboard">Individual</option>
          <option value="cursor-admin">Teams/Enterprise</option>
        </select>
      </div>
      <div class="select-wrapper">
        <div class="select-label">Workspace</div>
        <select id="projectSelect">
          <option value="">(no workspaces)</option>
        </select>
      </div>
    </div>

    <div id="syncBar" class="sync-bar">
      <span>⏱</span>
      <span id="syncText">Last sync: Never</span>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div id="statToday" class="stat-value">$0.00</div>
        <div class="stat-label">Today</div>
      </div>
      <div class="stat-card">
        <div id="statWeek" class="stat-value">$0.00</div>
        <div class="stat-label">This Week</div>
      </div>
      <div class="stat-card">
        <div id="statMonth" class="stat-value">$0.00</div>
        <div class="stat-label">This Month</div>
      </div>
    </div>

    <div class="metrics-row">
      <div class="metric">Unattributed: <span id="unattributedVal" class="metric-value">$0.00</span></div>
      <div class="metric">Conflicts: <span id="conflictsVal" class="metric-value">$0.00</span></div>
    </div>

    <div class="section-header">Activity Heatmap (7 days)</div>
    <div id="heatmap" class="heatmap"></div>

    <div class="section-header">Cost Breakdown - Last 7 Days</div>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Confidence</th></tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="4" class="empty-row">No data yet. Click "Sync Usage" to fetch data.</td></tr>
      </tbody>
    </table>

    <div class="section-header">This Month</div>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Confidence</th></tr>
      </thead>
      <tbody id="tableBodyMonth">
        <tr><td colspan="4" class="empty-row">No data yet.</td></tr>
      </tbody>
    </table>

    <script nonce="${nonce}">
      (function() {
        var vscode = acquireVsCodeApi();
        function $(id) { return document.getElementById(id); }
        function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }
        function fmtPct(x) { return Math.round(x * 100) + '%'; }
        function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

        function sumCents(arr) {
          var total = 0;
          (arr || []).forEach(function(r) { total += r.totalCents || 0; });
          return total;
        }

        function renderTable(rows, targetId, projects) {
          var pmap = {};
          (projects || []).forEach(function(p) { pmap[p.projectKey] = p; });
          var html = (rows || []).map(function(r) {
            var name = r.projectKey === 'unattributed' ? 'Unattributed' : ((pmap[r.projectKey] && pmap[r.projectKey].displayName) || r.projectKey);
            return '<tr><td>' + esc(name) + '</td><td class="num">' + fmtMoney(r.totalCents || 0) + '</td><td class="num">' + (r.eventCount || 0) + '</td><td class="num">' + fmtPct(r.avgConfidence || 0) + '</td></tr>';
          }).join('');
          $(targetId).innerHTML = html || '<tr><td colspan="4" class="empty-row">No data yet. Click "Sync Usage".</td></tr>';
        }

        function renderProjectSelect(projects, selectedKey) {
          var opts = (projects || []).map(function(p) {
            var sel = p.projectKey === selectedKey ? 'selected' : '';
            return '<option value="' + esc(p.projectKey) + '" ' + sel + '>' + esc(p.displayName) + '</option>';
          }).join('');
          $('projectSelect').innerHTML = opts || '<option value="">(no workspaces)</option>';
        }

        function renderHeatmap(h) {
          var el = $('heatmap');
          if (!h || !h.hourTotalsCents || !h.hourTotalsCents.length) {
            var empty = '';
            for (var i = 0; i < 24; i++) { empty += '<div class="heatmap-cell" title="' + i + ':00 - $0.00"></div>'; }
            el.innerHTML = empty;
            return;
          }
          var max = Math.max.apply(null, [1].concat(h.hourTotalsCents));
          el.innerHTML = h.hourTotalsCents.map(function(c, i) {
            var opacity = (0.15 + (c / max) * 0.85).toFixed(2);
            return '<div class="heatmap-cell" title="' + i + ':00 - ' + fmtMoney(c) + '" style="background: rgba(59,130,246,' + opacity + ');"></div>';
          }).join('');
        }

        function renderSyncState(s) {
          var bar = $('syncBar');
          var text = $('syncText');
          if (!s) {
            text.textContent = 'Last sync: Never - Click "Sync Usage" to fetch data';
            bar.className = 'sync-bar';
            return;
          }
          var last = s.lastSyncAtMs ? new Date(s.lastSyncAtMs).toLocaleString() : 'Unknown';
          if (s.lastError) {
            text.textContent = 'Last sync: ' + last + ' - Error: ' + s.lastError;
            bar.className = 'sync-bar error';
          } else {
            text.textContent = 'Last sync: ' + last;
            bar.className = 'sync-bar';
          }
        }

        window.addEventListener('message', function(event) {
          var msg = event.data;
          if (!msg || msg.type !== 'state') return;

          // Auth status
          var authEl = $('authStatus');
          if (msg.sessionTokenSet) {
            authEl.className = 'status connected';
            authEl.innerHTML = '<span class="status-dot"></span><span>Connected</span>';
          } else {
            authEl.className = 'status disconnected';
            authEl.innerHTML = '<span class="status-dot"></span><span>Not Connected</span>';
          }

          // Workspace
          $('workspaceName').textContent = msg.currentWorkspace || 'No workspace open';
          $('workspacePath').textContent = msg.currentWorkspacePath || '';

          // Connector
          $('connectorMode').value = msg.connectorMode || 'cursor-dashboard';

          // Stats
          var todayTotal = sumCents(msg.totals && msg.totals.today);
          var weekTotal = sumCents(msg.totals && msg.totals.week);
          var monthTotal = sumCents(msg.totals && msg.totals.month);
          $('statToday').textContent = fmtMoney(todayTotal);
          $('statWeek').textContent = fmtMoney(weekTotal);
          $('statMonth').textContent = fmtMoney(monthTotal);

          // Unattributed / Conflicts
          $('unattributedVal').textContent = fmtMoney((msg.unattributedWeek && msg.unattributedWeek.totalCents) || 0);
          $('conflictsVal').textContent = fmtMoney((msg.conflictsWeek && msg.conflictsWeek.totalCents) || 0);

          // Tables
          renderTable(msg.totals && msg.totals.week, 'tableBody', msg.projects);
          renderTable(msg.totals && msg.totals.month, 'tableBodyMonth', msg.projects);
          renderProjectSelect(msg.projects, msg.selectedProjectKey);
          renderHeatmap(msg.selectedHeatmapWeek);
          renderSyncState(msg.syncState);
        });

        $('refresh').onclick = function() { vscode.postMessage({ type: 'refresh' }); };
        $('connect').onclick = function() { vscode.postMessage({ type: 'connectCursor' }); };
        $('disconnect').onclick = function() { vscode.postMessage({ type: 'disconnectCursor' }); };
        $('budget').onclick = function() { vscode.postMessage({ type: 'setBudget' }); };
        $('review').onclick = function() { vscode.postMessage({ type: 'reviewAttribution' }); };
        $('projectSelect').onchange = function() { vscode.postMessage({ type: 'selectProject', projectKey: $('projectSelect').value }); };
        $('connectorMode').onchange = function() { vscode.postMessage({ type: 'setConnectorMode', mode: $('connectorMode').value }); };

        vscode.postMessage({ type: 'ready' });
      })();
    </script>
  </body>
</html>`;
  }
}

function startOfMonthMs(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}
