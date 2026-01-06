import * as vscode from 'vscode';
import { ProjectSessionTracker } from './sessionTracker';
import { startPairingServer } from './pairingServer';
import { showDashboard } from './dashboardWebview';
import { runSync } from './sync';
import { checkBudgetsAndNotify, setBudgetForCurrentProject } from './budgets';
import { reviewAttribution } from './reviewAttribution';
import { DashboardViewProvider } from './dashboardView';
import { MaintenanceRepository, SyncStateRepository } from '@codemeter/database';

let tracker: ProjectSessionTracker | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let dashboardProvider: DashboardViewProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  // Register the webview view provider FIRST, before any async operations
  // This ensures VS Code can resolve the view immediately when needed
  try {
    dashboardProvider = new DashboardViewProvider(context, {
      refresh: async (mode) => {
        const now = Date.now();
        const startMs = now - 24 * 60 * 60 * 1000;
        await runSync(context, { mode, startMs, endMs: now });
        await checkBudgetsAndNotify();
        await dashboardProvider?.refresh();
      },
      connectCursor: async () => {
        const server = await startPairingServer(context);
        context.subscriptions.push({ dispose: () => void server.dispose() });
        const url = `http://127.0.0.1:${server.port}/pair`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        try {
          await server.awaitToken();
        } finally {
          await server.dispose();
        }
      },
      disconnectCursor: async () => {
        await context.secrets.delete('cursor.sessionToken');
      },
      setBudget: async () => {
        await setBudgetForCurrentProject();
      },
      reviewAttribution: async () => {
        await reviewAttribution();
      }
    });

    // Register provider synchronously before any async operations
    // This must happen early so VS Code can resolve the view when needed
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboardProvider, {
        webviewOptions: { retainContextWhenHidden: true }
      })
    );
  } catch (error) {
    console.error('CodeMeter: Failed to register dashboard view provider:', error);
    // Re-throw to prevent silent failures
    throw error;
  }

  const enabled = vscode.workspace.getConfiguration('codemeter').get<boolean>('enableTracking', true);
  if (enabled) {
    tracker = new ProjectSessionTracker();
    tracker.start();
    context.subscriptions.push(tracker);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codemeter.showDashboard', async () => {
      await showDashboard();
    }),
    vscode.commands.registerCommand('codemeter.connectCursor', async () => {
      const server = await startPairingServer(context);
      context.subscriptions.push({ dispose: () => void server.dispose() });

      const url = `http://127.0.0.1:${server.port}/pair`;
      await vscode.env.openExternal(vscode.Uri.parse(url));

      try {
        await server.awaitToken();
        await vscode.window.showInformationMessage('CodeMeter: Cursor account connected.');
      } finally {
        await server.dispose();
      }
    }),
    vscode.commands.registerCommand('codemeter.disconnectCursor', async () => {
      await context.secrets.delete('cursor.sessionToken');
      await vscode.window.showInformationMessage('CodeMeter: Cursor account disconnected.');
    }),
    vscode.commands.registerCommand('codemeter.refreshData', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeMeter: syncing usage…' },
        async () => {
          const now = Date.now();
          const startMs = now - 24 * 60 * 60 * 1000;
          const count = await runSync(context, { mode: 'cursor-dashboard', startMs, endMs: now });
          await checkBudgetsAndNotify();
          await vscode.window.showInformationMessage(`CodeMeter: synced ${count} usage events.`);
        }
      );
    }),
    vscode.commands.registerCommand('codemeter.setProjectBudget', async () => {
      await setBudgetForCurrentProject();
    }),
    vscode.commands.registerCommand('codemeter.setAdminApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Cursor Admin API Key',
        prompt: 'Enter your Cursor Admin API key (stored securely in SecretStorage)',
        password: true,
        validateInput: (v) => (v && v.length >= 8 ? null : 'Enter a valid key')
      });
      if (!key) return;
      await context.secrets.store('cursor.adminApiKey', key);
      await vscode.window.showInformationMessage('CodeMeter: Admin API key saved.');
    }),
    vscode.commands.registerCommand('codemeter.reviewAttribution', async () => {
      await reviewAttribution();
    })
  );

  // Status bar entry point (no command palette required)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'CodeMeter';
  status.tooltip = 'Open CodeMeter dashboard';
  status.command = 'workbench.view.extension.codemeter';
  status.show();
  context.subscriptions.push(status);

  const pollMinutes = Math.max(60, vscode.workspace.getConfiguration('codemeter').get<number>('pollInterval', 60));

  // Kick off an initial sync shortly after activation so users see usage without waiting an hour.
  // Respect the configured poll interval and rely on SyncStateRepository high-water mark for safety.
  setTimeout(async () => {
    try {
      const mode = (context.globalState.get('connectorMode') as any) || 'cursor-dashboard';
      const tokenOk =
        mode === 'cursor-admin'
          ? Boolean(await context.secrets.get('cursor.adminApiKey'))
          : Boolean(await context.secrets.get('cursor.sessionToken'));
      if (!tokenOk) return;

      const source = mode === 'cursor-admin' ? 'cursor-admin' : 'cursor-dashboard';
      const state = new SyncStateRepository().get(source as any);
      const lastSyncAt = state?.lastSyncAtMs ?? 0;
      if (lastSyncAt && Date.now() - lastSyncAt < pollMinutes * 60_000) return;

      const now = Date.now();
      const startMs = now - 60 * 60 * 1000;
      await runSync(context, { mode, startMs, endMs: now });
      await checkBudgetsAndNotify();
      await dashboardProvider?.refresh();
    } catch {
      // best-effort; user can always hit "Refresh usage"
    }
  }, 4_000);

  pollTimer = setInterval(async () => {
    try {
      const now = Date.now();
      const startMs = now - 60 * 60 * 1000; // keep polite + bounded for MVP
      const mode = (context.globalState.get('connectorMode') as any) || 'cursor-dashboard';
      await runSync(context, { mode, startMs, endMs: now });
      await checkBudgetsAndNotify();
      await dashboardProvider?.refresh();
    } catch {
      // best-effort background sync; surfacing would be noisy
    }
  }, pollMinutes * 60_000);

  // Lightweight maintenance: compact JSONL stores occasionally to keep reads fast.
  // Runs best-effort and never blocks activation.
  setTimeout(() => {
    try {
      new MaintenanceRepository().compactAll();
    } catch {
      // ignore
    }
  }, 30_000);
}

export function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  tracker = null;
}


