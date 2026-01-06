import * as vscode from 'vscode';
import { AnalyticsRepository, ProjectRepository } from '@codemeter/database';

export async function showDashboard(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'codemeterDashboard',
    'CodeMeter: Project Cost Dashboard',
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  const analytics = new AnalyticsRepository();
  const projects = new ProjectRepository();

  const now = Date.now();
  const startMs = now - 7 * 24 * 60 * 60 * 1000;
  const totals = analytics.getCostTotalsByProject(startMs, now);
  const projectMap = new Map(projects.getAll().map(p => [p.projectKey, p]));

  const rows = totals
    .map(t => {
      const p = projectMap.get(t.projectKey);
      const name = t.projectKey === 'unattributed' ? 'Unattributed' : (p?.displayName ?? t.projectKey);
      const dollars = (t.totalCents / 100).toFixed(2);
      const conf = (t.avgConfidence * 100).toFixed(0);
      return `<tr><td>${escapeHtml(name)}</td><td style="text-align:right">$${dollars}</td><td style="text-align:right">${t.eventCount}</td><td style="text-align:right">${conf}%</td></tr>`;
    })
    .join('\n');

  panel.webview.html = `
    <html>
      <body style="font-family: -apple-system, system-ui, sans-serif; padding: 16px;">
        <h2>Project cost (last 7 days)</h2>
        <table style="border-collapse: collapse; width: 100%;">
          <thead>
            <tr>
              <th style="text-align:left; border-bottom: 1px solid #ddd; padding: 8px;">Project</th>
              <th style="text-align:right; border-bottom: 1px solid #ddd; padding: 8px;">Total</th>
              <th style="text-align:right; border-bottom: 1px solid #ddd; padding: 8px;">Events</th>
              <th style="text-align:right; border-bottom: 1px solid #ddd; padding: 8px;">Avg confidence</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4" style="padding: 8px;">No data yet. Run “CodeMeter: Refresh Usage Data”.</td></tr>'}
          </tbody>
        </table>
        <p style="margin-top: 12px; color: #666;">
          Attribution is time-based. “Unattributed” covers events with no matching active session.
        </p>
      </body>
    </html>
  `;

}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


