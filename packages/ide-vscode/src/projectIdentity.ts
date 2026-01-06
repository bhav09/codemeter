import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectIdentity {
  projectKey: string;
  displayName: string;
  gitRemote?: string;
  workspacePath: string;
}

export function computeProjectIdentity(workspacePath: string): ProjectIdentity {
  const displayName = path.basename(workspacePath);
  const gitRemote = tryReadGitRemote(workspacePath);
  const projectKey = sha256(`${workspacePath}::${gitRemote ?? ''}`).slice(0, 32);

  return { projectKey, displayName, gitRemote, workspacePath };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function tryReadGitRemote(workspacePath: string): string | undefined {
  try {
    const gitConfigPath = path.join(workspacePath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return undefined;
    const content = fs.readFileSync(gitConfigPath, 'utf8');

    // Minimal parser: find [remote "origin"] then url = ...
    const lines = content.split(/\r?\n/);
    let inOrigin = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const sectionMatch = trimmed.match(/^\[remote\s+"([^"]+)"\]$/);
      if (sectionMatch) {
        inOrigin = sectionMatch[1] === 'origin';
        continue;
      }
      if (!inOrigin) continue;
      const urlMatch = trimmed.match(/^url\s*=\s*(.+)$/);
      if (urlMatch) return urlMatch[1].trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}


