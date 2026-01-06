import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { ProjectRepository, SessionRepository } from '@codemeter/database';
import { ProjectSession, Project } from '@codemeter/core';
import { computeProjectIdentity } from './projectIdentity';

export interface SessionTrackerOptions {
  idleMs?: number;
}

export class ProjectSessionTracker implements vscode.Disposable {
  private readonly projects = new ProjectRepository();
  private readonly sessions = new SessionRepository();

  private readonly ideInstanceId: string;
  private readonly ideType: ProjectSession['ideType'];
  private readonly idleMs: number;

  private currentSessionId: string | null = null;
  private currentProjectKey: string | null = null;
  private currentWorkspaceFolders: string[] = [];
  private currentWorkspacePath: string | null = null;
  private idle = false;
  private focused = true;
  private lastActivityAt = Date.now();
  private timer: NodeJS.Timeout | null = null;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(opts: SessionTrackerOptions = {}) {
    this.ideInstanceId = uuidv4();
    this.ideType = detectIdeType();
    this.idleMs = Math.max(30_000, opts.idleMs ?? 2 * 60_000);
  }

  start(): void {
    this.focused = vscode.window.state.focused;
    this.setActivity();
    this.ensureSessionForCurrentWorkspace();

    this.disposables.push(
      vscode.window.onDidChangeWindowState(state => {
        const prevFocused = this.focused;
        this.focused = state.focused;
        this.setActivity();
        if (prevFocused !== this.focused) {
          this.rotateSession('focus changed');
        } else {
          this.updateSessionFlags();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.ensureSessionForCurrentWorkspace(true);
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        this.setActivity();
        this.updateSessionFlags();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.setActivity();
        this.updateSessionFlags();
      })
    );

    this.timer = setInterval(() => {
      const now = Date.now();
      const nextIdle = now - this.lastActivityAt >= this.idleMs;
      if (nextIdle !== this.idle) {
        this.idle = nextIdle;
        this.rotateSession('idle toggled');
      }
    }, 5_000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    this.endCurrentSession();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }

  private setActivity(): void {
    this.lastActivityAt = Date.now();
    this.idle = false;
  }

  private ensureSessionForCurrentWorkspace(forceNew = false): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const primary = folders[0]?.uri?.fsPath;
    if (!primary) return;

    const identity = computeProjectIdentity(primary);
    if (!forceNew && this.currentProjectKey === identity.projectKey && this.currentSessionId) {
      return;
    }

    // Close out previous session (if any)
    this.endCurrentSession();

    // Upsert project row
    const project: Project = {
      projectKey: identity.projectKey,
      displayName: identity.displayName,
      gitRemote: identity.gitRemote,
      workspacePath: identity.workspacePath,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };
    this.projects.create(project);

    // Create new session
    const session: ProjectSession = {
      id: uuidv4(),
      projectKey: identity.projectKey,
      workspaceFolders: folders.map(f => f.uri.fsPath),
      startMs: Date.now(),
      focused: this.focused,
      idle: this.idle,
      ideInstanceId: this.ideInstanceId,
      ideType: this.ideType
    };
    this.sessions.create(session);

    this.currentSessionId = session.id;
    this.currentProjectKey = session.projectKey;
    this.currentWorkspaceFolders = session.workspaceFolders;
    this.currentWorkspacePath = identity.workspacePath;
  }

  private endCurrentSession(): void {
    if (!this.currentSessionId) return;
    try {
      this.sessions.updateEndTime(this.currentSessionId, Date.now());
    } catch {
      // best-effort
    }
    this.currentSessionId = null;
    this.currentProjectKey = null;
    this.currentWorkspaceFolders = [];
    this.currentWorkspacePath = null;
  }

  private updateSessionFlags(): void {
    if (!this.currentSessionId) return;
    try {
      this.sessions.updateFlags(this.currentSessionId, this.focused, this.idle);
    } catch {
      // best-effort
    }
  }

  /**
   * Start a new session segment when focus/idle changes, keeping the same project attribution.
   * This improves time attribution accuracy substantially vs mutating flags on a single long session.
   */
  private rotateSession(_reason: string): void {
    if (!this.currentProjectKey || !this.currentSessionId || !this.currentWorkspacePath) {
      // If we don't have a current project, just re-evaluate workspace normally.
      this.ensureSessionForCurrentWorkspace(true);
      return;
    }

    const projectKey = this.currentProjectKey;
    const workspacePath = this.currentWorkspacePath;
    const prevFolders = this.currentWorkspaceFolders.slice();

    // End previous segment
    this.endCurrentSession();

    // Restart segment under same project/workspace
    const folders = prevFolders.length ? prevFolders : (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

    const session: ProjectSession = {
      id: uuidv4(),
      projectKey,
      workspaceFolders: folders,
      startMs: Date.now(),
      focused: this.focused,
      idle: this.idle,
      ideInstanceId: this.ideInstanceId,
      ideType: this.ideType
    };
    this.sessions.create(session);
    this.currentSessionId = session.id;
    this.currentProjectKey = projectKey;
    this.currentWorkspaceFolders = session.workspaceFolders;
    this.currentWorkspacePath = workspacePath;
  }
}

function detectIdeType(): ProjectSession['ideType'] {
  const name = (vscode.env.appName || '').toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('antigravity')) return 'antigravity';
  return 'vscode';
}


