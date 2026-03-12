import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { normalizeModelSlug } from '@codemeter/core';

export type DetectedEditor = 'cursor' | 'windsurf' | 'antigravity' | 'vscode' | 'claude-code' | 'unknown';

export interface DetectedModelInfo {
  editor: DetectedEditor;
  rawModel: string | null;
  normalizedModel: string | null;
  source: string;
  detectedAtMs: number;
  claudeCodeModel: string | null;
}

const CACHE_TTL_MS = 2 * 60_000;
const REACTIVE_STORAGE_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

export class ModelDetector {
  private cached: DetectedModelInfo | null = null;
  private cachedAtMs = 0;

  invalidateCache(): void {
    this.cached = null;
    this.cachedAtMs = 0;
  }

  detect(): DetectedModelInfo {
    const now = Date.now();
    if (this.cached && (now - this.cachedAtMs) < CACHE_TTL_MS) {
      return this.cached;
    }

    const editor = this.detectHostEditor();
    const host = this.detectHostEditorModel(editor);
    const claudeCodeModel = this.detectClaudeCodeModel();

    const info: DetectedModelInfo = {
      editor: host.rawModel ? editor : (claudeCodeModel ? 'claude-code' : editor),
      rawModel: host.rawModel ?? claudeCodeModel ?? null,
      normalizedModel: host.rawModel ? normalizeModelSlug(host.rawModel) : (claudeCodeModel ? normalizeModelSlug(claudeCodeModel) : null),
      source: host.source || (claudeCodeModel ? 'claude-settings' : 'none'),
      detectedAtMs: now,
      claudeCodeModel,
    };

    this.cached = info;
    this.cachedAtMs = now;
    return info;
  }

  private detectHostEditor(): DetectedEditor {
    const app = (vscode.env.appName || '').toLowerCase();
    if (app.includes('cursor')) return 'cursor';
    if (app.includes('windsurf')) return 'windsurf';
    if (app.includes('antigravity')) return 'antigravity';
    if (app.includes('visual studio code') || app.includes('vscode')) return 'vscode';
    return 'unknown';
  }

  private detectHostEditorModel(editor: DetectedEditor): { rawModel: string | null; source: string } {
    if (editor === 'cursor') {
      const model = this.detectModelFromReactiveStorage(this.cursorStatePath());
      return { rawModel: model, source: model ? 'cursor-state.vscdb' : 'cursor-fallback' };
    }

    if (editor === 'windsurf') {
      const model = this.detectModelFromReactiveStorage(this.windsurfStatePath());
      return { rawModel: model, source: model ? 'windsurf-state.vscdb' : 'windsurf-fallback' };
    }

    if (editor === 'antigravity') {
      const model = this.detectModelFromAntigravityConfig();
      return { rawModel: model, source: model ? 'antigravity-gui_config.json' : 'antigravity-fallback' };
    }

    if (editor === 'vscode') {
      const model = this.detectModelFromVSCodeLM();
      return { rawModel: model, source: model ? 'vscode-lm-api' : 'vscode-fallback' };
    }

    return { rawModel: null, source: 'unknown' };
  }

  private detectModelFromReactiveStorage(dbPath: string): string | null {
    if (!fs.existsSync(dbPath)) return null;
    const rawJson = this.readSqliteValue(dbPath, REACTIVE_STORAGE_KEY);
    if (!rawJson) return null;

    try {
      const parsed = JSON.parse(rawJson);
      const aiSettings = parsed?.aiSettings ?? parsed?.['aiSettings'];
      const directCandidate =
        aiSettings?.modelConfig?.composer?.modelName
        ?? aiSettings?.modelConfig?.chat?.modelName
        ?? aiSettings?.modelConfig?.inline?.modelName
        ?? aiSettings?.modelName;
      if (typeof directCandidate === 'string' && directCandidate.trim()) {
        return directCandidate;
      }
      return this.pickModelFromObject(parsed);
    } catch {
      return null;
    }
  }

  private detectModelFromAntigravityConfig(): string | null {
    const file = path.join(os.homedir(), '.antigravity_tools', 'gui_config.json');
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return this.pickModelFromObject(parsed);
    } catch {
      return null;
    }
  }

  private detectModelFromVSCodeLM(): string | null {
    // Keep this defensive: lm APIs vary by VS Code version and may be unavailable.
    const lm = (vscode as any)?.lm;
    if (!lm) return null;

    const candidates: string[] = [];
    const maybeModels = lm.models ?? lm.chatModels ?? [];
    if (Array.isArray(maybeModels)) {
      for (const m of maybeModels) {
        const id = m?.id ?? m?.name ?? m?.model ?? m?.identifier;
        if (typeof id === 'string' && id.trim()) candidates.push(id);
      }
    }
    return this.pickBestCandidate(candidates);
  }

  private detectClaudeCodeModel(): string | null {
    const home = os.homedir();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const files = [
      workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.local.json') : '',
      workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.json') : '',
      path.join(home, '.claude', 'settings.json'),
    ].filter(Boolean);

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const model = parsed?.model;
        if (typeof model === 'string' && model.trim()) return model;
      } catch {
        // Ignore malformed local config and continue with lower-precedence files.
      }
    }
    return null;
  }

  private readSqliteValue(dbPath: string, key: string): string | null {
    try {
      const sql = `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}'`;
      const out = execFileSync('sqlite3', [dbPath, sql], {
        encoding: 'utf8',
        timeout: 1500,
        maxBuffer: 2 * 1024 * 1024,
      });
      const value = out.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private pickModelFromObject(value: unknown): string | null {
    const candidates: string[] = [];
    const seen = new Set<any>();

    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          const key = k.toLowerCase();
          if (key.includes('model') || key.includes('agent')) {
            candidates.push(v);
          }
        } else if (typeof v === 'object') {
          walk(v);
        }
      }
    };

    walk(value);
    return this.pickBestCandidate(candidates);
  }

  private pickBestCandidate(candidates: string[]): string | null {
    const cleaned = candidates
      .map(s => (s || '').trim())
      .filter(Boolean);
    if (cleaned.length === 0) return null;

    // Prefer concrete model identifiers over broad labels.
    const scored = cleaned.map(c => {
      const lc = c.toLowerCase();
      let score = 0;
      if (lc.includes('claude')) score += 5;
      if (lc.includes('gpt') || lc.includes('o3') || lc.includes('o4')) score += 5;
      if (lc.includes('gemini')) score += 5;
      if (lc.includes('sonnet') || lc.includes('opus') || lc.includes('haiku')) score += 3;
      if (/\d/.test(lc)) score += 2;
      if (lc.includes('thinking') || lc.includes('high') || lc.includes('low')) score += 1;
      return { value: c, score };
    }).sort((a, b) => b.score - a.score);

    return scored[0]?.value ?? null;
  }

  private cursorStatePath(): string {
    return this.platformStatePath('Cursor');
  }

  private windsurfStatePath(): string {
    return this.platformStatePath('Windsurf');
  }

  private platformStatePath(appFolder: string): string {
    const home = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', appFolder, 'User', 'globalStorage', 'state.vscdb');
    }
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, appFolder, 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(home, '.config', appFolder, 'User', 'globalStorage', 'state.vscdb');
  }
}

