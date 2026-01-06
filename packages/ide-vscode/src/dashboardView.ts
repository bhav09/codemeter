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
        // Always refresh UI after any action
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

    // Fail-soft: the dashboard should still render even if storage reads throw (permissions/corruption).
    // We surface a small non-PII error string to help debugging, but never block rendering.
    let projects: any[] = [];
    let byProjectToday: any[] = [];
    let byProjectWeek: any[] = [];
    let byProjectMonth: any[] = [];
    let unattributedWeek: any = { totalCents: 0, eventCount: 0 };
    let conflictsWeek: any = { totalCents: 0, eventCount: 0 };
    let syncState: any = null;
    let selectedMetricsWeek: any = null;
    let selectedHeatmapWeek: any = null;

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
      totals: {
        today: byProjectToday,
        week: byProjectWeek,
        month: byProjectMonth
      },
      uiError: this.lastUiError
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    // Use a more permissive CSP for debugging - can tighten later
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body { font-family: var(--vscode-font-family, -apple-system, system-ui, sans-serif); margin: 0; padding: 12px; color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, transparent); }
      .row { display:flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      button { padding: 6px 10px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none; border-radius: 2px; cursor: pointer; font-size: 12px; }
      button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); font-size: 12px; text-align: left; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: var(--vscode-descriptionForeground, rgba(128,128,128,0.9)); font-size: 11px; }
      .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; background: var(--vscode-badge-background, rgba(128,128,128,0.15)); color: var(--vscode-badge-foreground, inherit); }
      h2 { margin: 12px 0 8px; font-size: 13px; font-weight: 600; }
      select { background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #ccc); border: 1px solid var(--vscode-dropdown-border, #3c3c3c); padding: 4px; font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="row">
      <button id="refresh">Refresh usage</button>
      <button id="connect">Connect Cursor</button>
      <button id="disconnect">Disconnect</button>
      <button id="budget">Set budget</button>
      <button id="review">Review attribution</button>
      <span id="auth" class="pill">auth: checking...</span>
    </div>

    <p class="muted">Project-only attribution is time-based. "Unattributed" is expected when usage happens outside an active project session.</p>

    <div class="row">
      <label class="muted" style="display:flex; align-items:center; gap:6px;">
        Connector:
        <select id="connectorMode">
          <option value="cursor-dashboard">Individual (dashboard)</option>
          <option value="cursor-admin">Teams/Enterprise (admin)</option>
        </select>
      </label>
      <label class="muted" style="display:flex; align-items:center; gap:6px;">
        Project:
        <select id="projectSelect"><option value="">(no projects yet)</option></select>
      </label>
    </div>

    <div class="row">
      <span id="projectStats" class="muted"></span>
    </div>

    <div class="row">
      <span id="unattributed" class="pill">unattributed: ...</span>
      <span id="conflicts" class="pill">conflicts: ...</span>
      <span id="sync" class="pill">sync: never</span>
    </div>

    <h2>Cost by hour (last 7 days)</h2>
    <div id="heatmap" style="display:grid; grid-template-columns: repeat(24, 1fr); gap: 2px; margin-bottom: 10px; min-height: 16px;"></div>

    <h2>Last 7 days</h2>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Confidence</th></tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="4" class="muted">No data yet. Click "Refresh usage" to sync.</td></tr>
      </tbody>
    </table>

    <h2>This month</h2>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Confidence</th></tr>
      </thead>
      <tbody id="tableBodyMonth">
        <tr><td colspan="4" class="muted">No data yet.</td></tr>
      </tbody>
    </table>

    <script nonce="${nonce}">
      (function() {
        var vscode = acquireVsCodeApi();
        function $(id) { return document.getElementById(id); }
        function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }
        function fmtPct(x) { return Math.round(x * 100) + '%'; }
        function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

        function renderTable(rows, targetId, projects) {
          var pmap = {};
          (projects || []).forEach(function(p) { pmap[p.projectKey] = p; });
          var html = (rows || []).map(function(r) {
            var name = r.projectKey === 'unattributed' ? 'Unattributed' : ((pmap[r.projectKey] && pmap[r.projectKey].displayName) || r.projectKey);
            return '<tr><td>' + esc(name) + '</td><td class="num">' + fmtMoney(r.totalCents || 0) + '</td><td class="num">' + (r.eventCount || 0) + '</td><td class="num">' + fmtPct(r.avgConfidence || 0) + '</td></tr>';
          }).join('');
          $(targetId).innerHTML = html || '<tr><td colspan="4" class="muted">No data yet. Click "Refresh usage".</td></tr>';
        }

        function renderProjectSelect(projects, selectedKey) {
          var opts = (projects || []).map(function(p) {
            var sel = p.projectKey === selectedKey ? 'selected' : '';
            return '<option value="' + esc(p.projectKey) + '" ' + sel + '>' + esc(p.displayName) + '</option>';
          }).join('');
          $('projectSelect').innerHTML = opts || '<option value="">(no projects yet)</option>';
        }

        function renderProjectStats(m) {
          if (!m) { $('projectStats').textContent = ''; return; }
          $('projectStats').textContent = '7d: ' + fmtMoney(m.totalCents||0) + ' - events ' + (m.eventCount||0) + ' - confidence ' + fmtPct(m.avgConfidence||0);
        }

        function renderUnattributed(u) {
          $('unattributed').textContent = 'unattributed (7d): ' + fmtMoney((u && u.totalCents)||0) + ' - ' + ((u && u.eventCount)||0) + ' events';
        }

        function renderConflicts(c) {
          $('conflicts').textContent = 'conflicts (7d): ' + fmtMoney((c && c.totalCents)||0) + ' - ' + ((c && c.eventCount)||0) + ' events';
        }

        function renderSyncState(s) {
          if (!s) { $('sync').textContent = 'sync: never'; return; }
          var last = s.lastSyncAtMs ? new Date(s.lastSyncAtMs).toLocaleString() : 'unknown';
          var err = s.lastError ? (' - error: ' + s.lastError) : '';
          $('sync').textContent = 'sync: ' + last + err;
        }

        function renderHeatmap(h) {
          var el = $('heatmap');
          if (!h || !h.hourTotalsCents || !h.hourTotalsCents.length) { el.innerHTML = ''; return; }
          var max = Math.max.apply(null, [1].concat(h.hourTotalsCents));
          el.innerHTML = h.hourTotalsCents.map(function(c, i) {
            var bg = 'rgba(60, 160, 255,' + (0.1 + (c / max) * 0.8).toFixed(2) + ')';
            return '<div title="' + i + ':00 - ' + fmtMoney(c) + '" style="height: 16px; background:' + bg + '; border-radius: 2px;"></div>';
          }).join('');
        }

        window.addEventListener('message', function(event) {
          var msg = event.data;
          if (!msg || msg.type !== 'state') return;
          $('auth').textContent = 'auth: ' + (msg.sessionTokenSet ? 'connected' : 'not connected');
          $('connectorMode').value = msg.connectorMode || 'cursor-dashboard';
          renderTable(msg.totals && msg.totals.week, 'tableBody', msg.projects);
          renderTable(msg.totals && msg.totals.month, 'tableBodyMonth', msg.projects);
          renderProjectSelect(msg.projects, msg.selectedProjectKey);
          renderProjectStats(msg.selectedMetricsWeek);
          renderUnattributed(msg.unattributedWeek);
          renderConflicts(msg.conflictsWeek);
          renderSyncState(msg.syncState);
          renderHeatmap(msg.selectedHeatmapWeek);
          if (msg.uiError) {
            $('projectStats').textContent = ($('projectStats').textContent || '') + ' - storage: error';
          }
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


