import * as vscode from 'vscode';
import { ProjectSessionTracker } from './sessionTracker';
import { AIInteractionTracker } from './aiTracker';
import { getCurrentWorkspaceConfig } from './workspaceConfig';
import { showDashboard } from './dashboardWebview';
import { runSync } from './sync';
import { checkBudgetsAndNotify, setBudgetForCurrentProject } from './budgets';
import { reviewAttribution } from './reviewAttribution';
import { DashboardViewProvider } from './dashboardView';
import { MaintenanceRepository, SyncStateRepository } from '@codemeter/database';

let tracker: ProjectSessionTracker | null = null;
let aiTracker: AIInteractionTracker | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let dashboardProvider: DashboardViewProvider | null = null;

/**
 * Prompt user to enter their Cursor session token directly.
 * This is simpler than the Chrome extension pairing flow.
 */
async function connectCursorSimple(context: vscode.ExtensionContext): Promise<boolean> {
  const info = await vscode.window.showInformationMessage(
    'To connect Cursor, you need your session token from cursor.sh',
    { modal: false },
    'Enter Token',
    'How to get token?'
  );

  if (info === 'How to get token?') {
    await vscode.env.openExternal(vscode.Uri.parse('https://www.cursor.com/settings'));
    await vscode.window.showInformationMessage(
      'Go to Cursor Settings → Account section. Look for your session token or API key. ' +
      'Alternatively, open browser DevTools on cursor.com, go to Application → Cookies, and find the session token.',
      { modal: true }
    );
    return connectCursorSimple(context); // Retry
  }

  if (info !== 'Enter Token') {
    return false;
  }

  const token = await vscode.window.showInputBox({
    title: 'Cursor Session Token',
    prompt: 'Paste your Cursor session token (stored securely)',
    password: true,
    placeHolder: 'Your session token from cursor.com...',
    validateInput: (v: string) => {
      if (!v || v.length < 10) return 'Token appears too short. Please enter a valid session token.';
      return null;
    }
  });

  if (!token) return false;

  await context.secrets.store('cursor.sessionToken', token);
  await vscode.window.showInformationMessage('CodeMeter: Cursor account connected successfully!');
  return true;
}

export async function activate(context: vscode.ExtensionContext) {
  // Register the webview view provider FIRST, before any async operations
  try {
    dashboardProvider = new DashboardViewProvider(context, {
      refresh: async (mode) => {
        const now = Date.now();
        const startMs = now - 24 * 60 * 60 * 1000;
        // runSync now returns 0 gracefully if no credentials - no need to check
        try {
          await runSync(context, { mode, startMs, endMs: now });
        } catch {
          // best-effort sync, continue with refresh
        }
        await checkBudgetsAndNotify();
        await dashboardProvider?.refresh();
      },
      connectCursor: async () => {
        const connected = await connectCursorSimple(context);
        if (connected) {
          await dashboardProvider?.refresh();
        }
      },
      disconnectCursor: async () => {
        await context.secrets.delete('cursor.sessionToken');
        await vscode.window.showInformationMessage('CodeMeter: Cursor account disconnected.');
      },
      setBudget: async () => {
        await setBudgetForCurrentProject();
      },
      reviewAttribution: async () => {
        await reviewAttribution();
      }
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboardProvider, {
        webviewOptions: { retainContextWhenHidden: true }
      })
    );
  } catch (error) {
    console.error('CodeMeter: Failed to register dashboard view provider:', error);
    throw error;
  }

  // Start session tracking - this creates the project entry for the current workspace
  const enabled = vscode.workspace.getConfiguration('codemeter').get<boolean>('enableTracking', true);
  if (enabled) {
    tracker = new ProjectSessionTracker();
    tracker.start();
    context.subscriptions.push(tracker);

    // Start AI interaction tracking for estimated costs
    aiTracker = new AIInteractionTracker();
    aiTracker.start();
    context.subscriptions.push(aiTracker);
    
    // Refresh dashboard after a short delay to show the newly created project
    setTimeout(async () => {
      await dashboardProvider?.refresh();
    }, 500);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codemeter.showDashboard', async () => {
      await showDashboard();
    }),
    vscode.commands.registerCommand('codemeter.connectCursor', async () => {
      const connected = await connectCursorSimple(context);
      if (connected) {
        await dashboardProvider?.refresh();
      }
    }),
    vscode.commands.registerCommand('codemeter.disconnectCursor', async () => {
      await context.secrets.delete('cursor.sessionToken');
      await vscode.window.showInformationMessage('CodeMeter: Cursor account disconnected.');
      await dashboardProvider?.refresh();
    }),
    vscode.commands.registerCommand('codemeter.refreshData', async () => {
      // Check if credentials exist before showing sync progress
      const mode = (context.globalState.get('connectorMode') as 'cursor-dashboard' | 'cursor-admin') || 'cursor-dashboard';
      const hasCredentials = mode === 'cursor-admin'
        ? Boolean(await context.secrets.get('cursor.adminApiKey'))
        : Boolean(await context.secrets.get('cursor.sessionToken'));
      
      if (!hasCredentials) {
        const action = await vscode.window.showInformationMessage(
          'CodeMeter: No Cursor account connected. Connect your account to sync actual usage data, or continue using estimated costs.',
          'Connect Cursor',
          'Cancel'
        );
        if (action === 'Connect Cursor') {
          await connectCursorSimple(context);
          await dashboardProvider?.refresh();
        }
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeMeter: syncing usage…' },
        async () => {
          const now = Date.now();
          const startMs = now - 24 * 60 * 60 * 1000;
          const count = await runSync(context, { mode, startMs, endMs: now });
          await checkBudgetsAndNotify();
          await dashboardProvider?.refresh();
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
        validateInput: (v: string) => (v && v.length >= 8 ? null : 'Enter a valid key')
      });
      if (!key) return;
      await context.secrets.store('cursor.adminApiKey', key);
      await vscode.window.showInformationMessage('CodeMeter: Admin API key saved.');
    }),
    vscode.commands.registerCommand('codemeter.reviewAttribution', async () => {
      await reviewAttribution();
    })
    ,
    vscode.commands.registerCommand('codemeter.showStoragePath', async () => {
      try {
        const cfg = getCurrentWorkspaceConfig();
        const display = `CodeMeter storage path:\n${cfg.codemeterDir}`;
        const choice = await vscode.window.showInformationMessage(display, 'Open Folder', 'Show in Output');
        if (choice === 'Open Folder') {
          await vscode.env.openExternal(vscode.Uri.file(cfg.codemeterDir));
        } else if (choice === 'Show in Output') {
          const out = vscode.window.createOutputChannel('CodeMeter');
          out.show(true);
          out.appendLine(`Resolved CodeMeter storage: ${cfg.codemeterDir}`);
        }
      } catch (e) {
        await vscode.window.showErrorMessage(`CodeMeter: failed to resolve storage path: ${e}`);
      }
    })
  );

  // Status bar entry point
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'CodeMeter';
  status.tooltip = 'Open CodeMeter dashboard';
  status.command = 'workbench.view.extension.codemeter';
  status.show();
  context.subscriptions.push(status);

  const pollMinutes = Math.max(60, vscode.workspace.getConfiguration('codemeter').get<number>('pollInterval', 60));

  // Initial sync after activation (if credentials exist)
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
      // best-effort
    }
  }, 4_000);

  // Background polling
  pollTimer = setInterval(async () => {
    try {
      const now = Date.now();
      const startMs = now - 60 * 60 * 1000;
      const mode = (context.globalState.get('connectorMode') as any) || 'cursor-dashboard';
      await runSync(context, { mode, startMs, endMs: now });
      await checkBudgetsAndNotify();
      await dashboardProvider?.refresh();
    } catch {
      // best-effort
    }
  }, pollMinutes * 60_000);

  // Maintenance compaction
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
  aiTracker = null;
}
