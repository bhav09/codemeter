import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const CODEMETER_GITIGNORE_ENTRY = '.codemeter/';
const CODEMETER_GITIGNORE_PATTERNS = [
  /^\.codemeter\/?$/,
  /^\.codemeter\/\*\*$/,
];

const outputChannel = vscode.window.createOutputChannel('CodeMeter');

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] [gitignore] ${message}`);
}

function isCodemeterIgnored(content: string): boolean {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (CODEMETER_GITIGNORE_PATTERNS.some(p => p.test(trimmed))) {
      return true;
    }
  }
  return false;
}

function detectEditor(): string {
  const app = (vscode.env.appName || '').toLowerCase();
  if (app.includes('cursor')) return 'Cursor';
  if (app.includes('windsurf')) return 'Windsurf';
  if (app.includes('antigravity')) return 'Antigravity';
  if (app.includes('visual studio code') || app.includes('vscode')) return 'VS Code';
  return vscode.env.appName || 'Unknown';
}

function hasGitRepo(folderPath: string): boolean {
  try {
    return fs.existsSync(path.join(folderPath, '.git'));
  } catch {
    return false;
  }
}

/**
 * Ensure `.codemeter/` is in the .gitignore of the given folder.
 * Only acts on folders that are git repos (have a .git directory).
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignoreForFolder(folderPath: string): boolean {
  if (!hasGitRepo(folderPath)) return false;

  const gitignorePath = path.join(folderPath, '.gitignore');

  try {
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (isCodemeterIgnored(content)) {
        return false;
      }

      const separator = content.endsWith('\n') ? '' : '\n';
      const addition = `${separator}\n# CodeMeter local data\n${CODEMETER_GITIGNORE_ENTRY}\n`;
      fs.appendFileSync(gitignorePath, addition, 'utf8');
      log(`Appended ${CODEMETER_GITIGNORE_ENTRY} to existing .gitignore at ${gitignorePath}`);
      return true;
    }

    fs.writeFileSync(gitignorePath, `# CodeMeter local data\n${CODEMETER_GITIGNORE_ENTRY}\n`, 'utf8');
    log(`Created .gitignore with ${CODEMETER_GITIGNORE_ENTRY} at ${gitignorePath}`);
    return true;
  } catch (err) {
    log(`Failed to update .gitignore at ${gitignorePath}: ${err}`);
    return false;
  }
}

/**
 * Ensure `.codemeter/` is in .gitignore for all workspace folders.
 * Auto-detects the host editor and logs it.
 */
export function ensureGitignoreForAllWorkspaces(): void {
  const editor = detectEditor();
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    log(`No workspace folders open in ${editor}, skipping .gitignore check`);
    return;
  }

  log(`Ensuring .codemeter/ is in .gitignore for ${folders.length} workspace folder(s) in ${editor}`);

  for (const folder of folders) {
    const folderPath = folder.uri.fsPath;
    const updated = ensureGitignoreForFolder(folderPath);
    if (updated) {
      log(`Updated .gitignore for workspace "${folder.name}" (${folderPath})`);
    }
  }
}

/**
 * Register listeners that re-check .gitignore when workspace folders change.
 */
export function registerGitignoreWatcher(): vscode.Disposable {
  return vscode.workspace.onDidChangeWorkspaceFolders(() => {
    ensureGitignoreForAllWorkspaces();
  });
}
