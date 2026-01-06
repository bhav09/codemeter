import * as vscode from 'vscode';
import { AnalyticsRepository, BudgetRepository, ProjectRepository } from '@codemeter/database';
import { Budget } from '@codemeter/core';
import { computeProjectIdentity } from './projectIdentity';

export async function setBudgetForCurrentProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const primary = folders[0]?.uri?.fsPath;
  if (!primary) {
    await vscode.window.showErrorMessage('CodeMeter: open a folder/workspace to set a project budget.');
    return;
  }

  const identity = computeProjectIdentity(primary);
  const input = await vscode.window.showInputBox({
    title: 'Set monthly budget (USD)',
    prompt: 'Example: 25.00',
    validateInput: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return 'Enter a positive number';
      return null;
    }
  });
  if (!input) return;

  const dollars = Number(input);
  const monthlyCents = Math.round(dollars * 100);
  const repo = new BudgetRepository();

  const now = Date.now();
  const budget: Budget = {
    projectKey: identity.projectKey,
    monthlyCents,
    alertThresholds: [0.7, 0.85, 1.0],
    createdAt: now,
    updatedAt: now
  };
  repo.createOrUpdate(budget);

  await vscode.window.showInformationMessage(`CodeMeter: budget set to $${dollars.toFixed(2)} / month for ${identity.displayName}.`);
}

export async function checkBudgetsAndNotify(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('codemeter').get<boolean>('budgetAlerts', true);
  if (!enabled) return;

  const budgets = new BudgetRepository().getAll();
  if (budgets.length === 0) return;

  const startOfMonth = getStartOfMonthMs(Date.now());
  const analytics = new AnalyticsRepository();
  const totals = analytics.getCostTotalsByProject(startOfMonth, Date.now());
  const totalsMap = new Map(totals.map(t => [t.projectKey, t]));

  const projectMap = new Map(new ProjectRepository().getAll().map(p => [p.projectKey, p]));

  for (const b of budgets) {
    const t = totalsMap.get(b.projectKey);
    if (!t) continue;
    if (!b.monthlyCents) continue;

    const ratio = t.totalCents / b.monthlyCents;
    const crossed = b.alertThresholds
      .slice()
      .sort((a: number, c: number) => a - c)
      .find((th: number) => ratio >= th);

    if (!crossed) continue;

    const pct = Math.round(ratio * 100);
    const dollars = (t.totalCents / 100).toFixed(2);
    const cap = (b.monthlyCents / 100).toFixed(2);
    const name = projectMap.get(b.projectKey)?.displayName ?? b.projectKey;

    // MVP: best-effort notification (may repeat across restarts).
    void vscode.window.showWarningMessage(`CodeMeter budget alert: ${name} is at ${pct}% ($${dollars} / $${cap}) this month.`);
  }
}

function getStartOfMonthMs(nowMs: number): number {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return start.getTime();
}


