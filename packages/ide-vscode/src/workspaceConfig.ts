/**
 * Workspace Configuration Module
 *
 * Manages resolution of project-specific storage paths for CodeMeter data.
 * Supports multi-root workspaces where each project folder gets its own .codemeter directory.
 *
 * Design:
 * - Primary workspace folder (first in vscode.workspace.workspaceFolders) is the "current project"
 * - Each project's .codemeter data lives at: <projectRoot>/.codemeter/
 * - Falls back to ~/.codemeter for single-file editing (no workspace)
 * - Allows override via workspace settings for advanced use cases
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

export interface WorkspaceConfig {
  /** Primary workspace root path (where .codemeter will be stored) */
  projectRoot: string;
  /** .codemeter directory for this project */
  codemeterDir: string;
  /** Whether this is the default fallback location */
  isDefaultFallback: boolean;
  /** Display name for logging/debugging */
  displayName: string;
}

/**
 * Get the current workspace configuration.
 * Handles multi-root workspaces, no-folder mode, and config overrides.
 *
 * Resolution order:
 * 1. Check workspace settings for custom codemeterPath
 * 2. Use primary workspace folder (first in list)
 * 3. Fall back to ~/.codemeter if no workspace is open
 */
export function getCurrentWorkspaceConfig(): WorkspaceConfig {
  const folders = vscode.workspace.workspaceFolders ?? [];

  // Check for workspace settings override
  const configOverride = vscode.workspace.getConfiguration('codemeter').get<string>('codemeterPath');
  if (configOverride) {
    const expandedPath = expandPath(configOverride);
    return {
      projectRoot: expandedPath,
      codemeterDir: expandedPath,
      isDefaultFallback: false,
      displayName: `Custom: ${configOverride}`,
    };
  }

  // Use primary (first) workspace folder
  if (folders.length > 0) {
    const primaryRoot = folders[0].uri.fsPath;
    const codemeterDir = path.join(primaryRoot, '.codemeter');
    return {
      projectRoot: primaryRoot,
      codemeterDir,
      isDefaultFallback: false,
      displayName: folders[0].name,
    };
  }

  // Fallback: ~/.codemeter for single-file editing or no workspace
  const homeDir = os.homedir();
  const codemeterDir = path.join(homeDir, '.codemeter');
  return {
    projectRoot: homeDir,
    codemeterDir,
    isDefaultFallback: true,
    displayName: 'Default (~/.codemeter)',
  };
}

/**
 * Get config for a specific workspace folder by index.
 * Useful if you need to track multiple projects simultaneously.
 */
export function getWorkspaceConfigByIndex(index: number): WorkspaceConfig | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (index < 0 || index >= folders.length) {
    return null;
  }

  const folder = folders[index];
  const codemeterDir = path.join(folder.uri.fsPath, '.codemeter');
  return {
    projectRoot: folder.uri.fsPath,
    codemeterDir,
    isDefaultFallback: false,
    displayName: folder.name,
  };
}

/**
 * Get all workspace configs (one per folder).
 * Useful for tracking usage across multi-root workspaces.
 */
export function getAllWorkspaceConfigs(): WorkspaceConfig[] {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    // No workspace, return fallback
    return [getCurrentWorkspaceConfig()];
  }

  return folders.map((folder, index) => ({
    projectRoot: folder.uri.fsPath,
    codemeterDir: path.join(folder.uri.fsPath, '.codemeter'),
    isDefaultFallback: false,
    displayName: folder.name,
  }));
}

/**
 * Expand special path variables:
 * - ${workspaceFolder} -> primary workspace root
 * - ${home} -> home directory
 * - ${env:VAR_NAME} -> environment variable
 */
function expandPath(configPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const primaryRoot = folders.length > 0 ? folders[0].uri.fsPath : os.homedir();

  return configPath
    .replace(/\$\{workspaceFolder\}/g, primaryRoot)
    .replace(/\$\{home\}/g, os.homedir())
    .replace(/\$\{env:([^}]+)\}/g, (_match, varName) => process.env[varName] ?? '');
}

/**
 * Watch for workspace changes and call callback when workspace config changes.
 * Useful for reinitializing tracking when user switches projects.
 */
export function onWorkspaceConfigChange(callback: (config: WorkspaceConfig) => void): vscode.Disposable {
  const listeners: vscode.Disposable[] = [];

  // Listen for workspace folder changes
  listeners.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      callback(getCurrentWorkspaceConfig());
    })
  );

  // Listen for config changes
  listeners.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codemeter.codemeterPath')) {
        callback(getCurrentWorkspaceConfig());
      }
    })
  );

  return {
    dispose: () => listeners.forEach(l => l.dispose()),
  };
}
