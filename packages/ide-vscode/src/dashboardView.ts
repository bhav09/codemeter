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

    const projects = new ProjectRepository().getAll();
    const analytics = new AnalyticsRepository();

    const byProjectToday = analytics.getCostTotalsByProject(dayStart, now);
    const byProjectWeek = analytics.getCostTotalsByProject(weekStart, now);
    const byProjectMonth = analytics.getCostTotalsByProject(monthStart, now);
    const unattributedWeek = analytics.getUnattributedSummary(weekStart, now);
    const conflictsWeek = analytics.getConflictSummary(weekStart, now);

    const syncRepo = new SyncStateRepository();
    const syncState = syncRepo.get(this.connectorMode === 'cursor-admin' ? 'cursor-admin' : 'cursor-dashboard');

    const defaultProjectKey =
      this.selectedProjectKey ??
      projects[0]?.projectKey ??
      (byProjectWeek.find(r => r.projectKey !== 'unattributed')?.projectKey ?? null);
    this.selectedProjectKey = defaultProjectKey;

    const selectedMetricsWeek = defaultProjectKey
      ? analytics.getProjectMetrics(defaultProjectKey, weekStart, now)
      : null;
    const selectedHeatmapWeek = defaultProjectKey
      ? analytics.getHourlyHeatmap(defaultProjectKey, weekStart, now)
      : null;

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
      }
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 12px; }
      .row { display:flex; gap: 8px; flex-wrap: wrap; }
      button { padding: 8px 10px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { padding: 8px; border-bottom: 1px solid rgba(128,128,128,0.25); font-size: 12px; }
      th { text-align: left; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: rgba(128,128,128,0.9); font-size: 12px; }
      .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: rgba(128,128,128,0.15); }
      h2 { margin: 6px 0 10px; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="row">
      <button id="refresh">Refresh usage</button>
      <button id="connect">Connect Cursor</button>
      <button id="disconnect">Disconnect</button>
      <button id="budget">Set budget</button>
      <button id="review">Review attribution</button>
      <span id="auth" class="pill">auth: …</span>
    </div>

    <p class="muted">Project-only attribution is time-based. “Unattributed” is expected when usage happens outside an active project session.</p>

    <div class="row" style="margin-top: 8px;">
      <label class="muted" style="display:flex; align-items:center; gap:8px;">
        Connector:
        <select id="connectorMode">
          <option value="cursor-dashboard">Individual (dashboard)</option>
          <option value="cursor-admin">Teams/Enterprise (admin)</option>
        </select>
      </label>
      <label class="muted" style="display:flex; align-items:center; gap:8px;">
        Project:
        <select id="projectSelect"></select>
      </label>
      <span id="projectStats" class="muted"></span>
    </div>

    <div class="row" style="margin-top: 8px;">
      <span id="unattributed" class="pill">unattributed: …</span>
      <span id="conflicts" class="pill">conflicts: …</span>
      <span id="sync" class="pill">sync: …</span>
    </div>

    <h2>Cost by hour (last 7 days)</h2>
    <div id="heatmap" style="display:grid; grid-template-columns: repeat(24, 1fr); gap: 2px; margin-bottom: 10px;"></div>

    <h2>Last 7 days</h2>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Avg confidence</th></tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="4" class="muted">Loading…</td></tr>
      </tbody>
    </table>

    <h2>This month</h2>
    <table>
      <thead>
        <tr><th>Project</th><th class="num">Cost</th><th class="num">Events</th><th class="num">Avg confidence</th></tr>
      </thead>
      <tbody id="tableBodyMonth">
        <tr><td colspan="4" class="muted">Loading…</td></tr>
      </tbody>
    </table>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const $ = (id) => document.getElementById(id);

      function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }
      function fmtPct(x) { return Math.round(x * 100) + '%'; }
      function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

      function renderTable(rows, targetId, projects) {
        const pmap = new Map((projects || []).map(p => [p.projectKey, p]));
        const html = (rows || []).map(r => {
          const name = r.projectKey === 'unattributed' ? 'Unattributed' : (pmap.get(r.projectKey)?.displayName || r.projectKey);
          return '<tr>'
            + '<td>' + esc(name) + '</td>'
            + '<td class="num">' + fmtMoney(r.totalCents || 0) + '</td>'
            + '<td class="num">' + (r.eventCount || 0) + '</td>'
            + '<td class="num">' + fmtPct(r.avgConfidence || 0) + '</td>'
            + '</tr>';
        }).join('\\n');
        $(targetId).innerHTML = html || '<tr><td colspan="4" class="muted">No data yet. Click “Refresh usage”.</td></tr>';
      }

      function renderProjectSelect(projects, selectedKey) {
        const opts = (projects || []).map(p => {
          const sel = p.projectKey === selectedKey ? 'selected' : '';
          return '<option value="' + esc(p.projectKey) + '" ' + sel + '>' + esc(p.displayName) + '</option>';
        }).join('\\n');
        $('projectSelect').innerHTML = opts || '<option value="">(no projects yet)</option>';
      }

      function renderProjectStats(m) {
        if (!m) { $('projectStats').textContent = ''; return; }
        const topModels = Object.entries(m.modelBreakdown || {})
          .sort((a,b)=> (b[1]||0)-(a[1]||0))
          .slice(0, 3)
          .map(([k,v]) => k + ' ' + fmtMoney(v||0))
          .join(' · ');
        $('projectStats').textContent =
          '7d: ' + fmtMoney(m.totalCents||0) +
          ' · events ' + (m.eventCount||0) +
          ' · confidence ' + fmtPct(m.avgConfidence||0) +
          (topModels ? (' · top models: ' + topModels) : '');
      }

      function renderUnattributed(u) {
        if (!u) { $('unattributed').textContent = 'unattributed: …'; return; }
        $('unattributed').textContent = 'unattributed (7d): ' + fmtMoney(u.totalCents||0) + ' · events ' + (u.eventCount||0);
      }

      function renderConflicts(c) {
        if (!c) { $('conflicts').textContent = 'conflicts: …'; return; }
        $('conflicts').textContent = 'conflicts (7d): ' + fmtMoney(c.totalCents||0) + ' · events ' + (c.eventCount||0);
      }

      function renderSyncState(s) {
        if (!s) { $('sync').textContent = 'sync: never'; return; }
        const last = s.lastSyncAtMs ? new Date(s.lastSyncAtMs).toLocaleString() : 'unknown';
        const err = s.lastError ? (' · error: ' + s.lastError) : '';
        $('sync').textContent = 'sync: ' + last + err;
      }

      function renderHeatmap(h) {
        const el = $('heatmap');
        if (!h || !Array.isArray(h.hourTotalsCents)) { el.innerHTML = ''; return; }
        const max = Math.max(1, ...h.hourTotalsCents);
        el.innerHTML = h.hourTotalsCents.map((c, i) => {
          const intensity = Math.round((c / max) * 200);
          const bg = 'rgba(60, 160, 255,' + (0.1 + (c / max) * 0.8).toFixed(2) + ')';
          return '<div title="' + i + ':00 — ' + fmtMoney(c) + '" style="height: 16px; background:' + bg + '; border-radius: 2px;"></div>';
        }).join('');
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg?.type !== 'state') return;
        $('auth').textContent = 'auth: ' + (msg.sessionTokenSet ? 'connected' : 'not connected');
        $('connectorMode').value = msg.connectorMode || 'cursor-dashboard';
        renderTable(msg.totals?.week, 'tableBody', msg.projects);
        renderTable(msg.totals?.month, 'tableBodyMonth', msg.projects);
        renderProjectSelect(msg.projects, msg.selectedProjectKey);
        renderProjectStats(msg.selectedMetricsWeek);
        renderUnattributed(msg.unattributedWeek);
        renderConflicts(msg.conflictsWeek);
        renderSyncState(msg.syncState);
        renderHeatmap(msg.selectedHeatmapWeek);
      });

      $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
      $('connect').onclick = () => vscode.postMessage({ type: 'connectCursor' });
      $('disconnect').onclick = () => vscode.postMessage({ type: 'disconnectCursor' });
      $('budget').onclick = () => vscode.postMessage({ type: 'setBudget' });
      $('review').onclick = () => vscode.postMessage({ type: 'reviewAttribution' });
      $('projectSelect').onchange = () => vscode.postMessage({ type: 'selectProject', projectKey: $('projectSelect').value });
      $('connectorMode').onchange = () => vscode.postMessage({ type: 'setConnectorMode', mode: $('connectorMode').value });

      vscode.postMessage({ type: 'ready' });
    </script>
  </body>
</html>`;
  }
}

function startOfMonthMs(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}


