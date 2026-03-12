import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { AIInteractionRepository, setDatabaseDir } from '@codemeter/database';
import { AIInteraction, estimateTokensFromChars, calculateCost, DEFAULT_MODEL, CONTEXT_ESTIMATES, initializePricing, getPricingService } from '@codemeter/core';
import { computeProjectIdentity } from './projectIdentity';
import { getCurrentWorkspaceConfig, onWorkspaceConfigChange } from './workspaceConfig';
import { ModelDetector } from './modelDetector';

const outputChannel = vscode.window.createOutputChannel('CodeMeter');

function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

const DETECTION_CONFIG = {
  AGGREGATION_WINDOW_MS: 500,
  DEBOUNCE_MS: 1000,
  /** Minimum characters for an insertion to be considered AI-generated */
  MIN_AI_CHARS: 15,
};

interface PendingChange {
  documentUri: string;
  insertedText: string;
  timestampMs: number;
  lineCount: number;
}

/**
 * Tracks AI interactions by analyzing document changes.
 * Uses heuristics to detect AI-generated code insertions.
 */
export class AIInteractionTracker implements vscode.Disposable {
  private readonly repo = new AIInteractionRepository();
  private readonly modelDetector = new ModelDetector();
  private readonly disposables: vscode.Disposable[] = [];

  private pendingChanges: PendingChange[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastChangeTimestamp = 0;
  private lastTypingTimestamp = 0;
  private recentTypingChars = 0;

  private currentProjectKey: string | null = null;

  start(): void {
    this.updateProjectKey();
    this.initializeWorkspaceConfig();

    // Fire-and-forget: fetch live pricing on startup
    initializePricing().then(() => {
      const svc = getPricingService();
      if (svc.isLive) {
        log(`Live pricing loaded (date: ${svc.pricingDate})`);
      } else {
        log(`Using bundled fallback pricing${svc.initError ? ': ' + svc.initError : ''}`);
      }
    }).catch((err) => { log(`Pricing init failed: ${err?.message ?? err}`); });

    const detected = this.modelDetector.detect();
    log(
      `AIInteractionTracker started. Project key: ${this.currentProjectKey}, ` +
      `assumedModel: ${this.getAssumedModel()}, detectedModel: ${detected.normalizedModel ?? 'none'}, editor: ${detected.editor}`
    );
    outputChannel.show(true);

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        this.handleDocumentChange(event);
      }),

      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.updateProjectKey();
        this.initializeWorkspaceConfig();
      }),

      vscode.workspace.onDidChangeTextDocument(event => {
        this.trackTypingSpeed(event);
      }),

      ...this.registerAICommandListeners(),

      onWorkspaceConfigChange((config) => {
        log(`Workspace config changed: ${config.displayName} at ${config.codemeterDir}`);
        setDatabaseDir(config.codemeterDir);
      })
    );
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.flushPendingChanges();
    this.disposables.forEach(d => d.dispose());
    this.disposables.length = 0;
  }

  /**
   * Read the model the user has configured (or fall back to DEFAULT_MODEL).
   */
  private getAssumedModel(): string {
    return vscode.workspace.getConfiguration('codemeter').get<string>('assumedModel') || DEFAULT_MODEL;
  }

  private updateProjectKey(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const primary = folders[0]?.uri?.fsPath;
    if (primary) {
      const identity = computeProjectIdentity(primary);
      this.currentProjectKey = identity.projectKey;
    }
  }

  private initializeWorkspaceConfig(): void {
    const config = getCurrentWorkspaceConfig();
    setDatabaseDir(config.codemeterDir);
    log(`Initialized workspace config: ${config.displayName} → ${config.codemeterDir}`);
  }

  private trackTypingSpeed(event: vscode.TextDocumentChangeEvent): void {
    const now = Date.now();
    for (const change of event.contentChanges) {
      if (change.text.length > 0 && change.text.length <= 5) {
        if (now - this.lastTypingTimestamp < 2000) {
          this.recentTypingChars += change.text.length;
        } else {
          this.recentTypingChars = change.text.length;
        }
        this.lastTypingTimestamp = now;
      }
    }
    if (now - this.lastTypingTimestamp > 5000) {
      this.recentTypingChars = 0;
    }
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (!this.currentProjectKey) return;
    if (event.document.uri.scheme !== 'file') return;

    const now = Date.now();

    for (const change of event.contentChanges) {
      const text = change.text;
      const lineCount = text.split('\n').length;

      if (this.isPotentiallyAIGenerated(text, lineCount, now)) {
        this.pendingChanges.push({
          documentUri: event.document.uri.toString(),
          insertedText: text,
          timestampMs: now,
          lineCount,
        });
      }
    }

    this.lastChangeTimestamp = now;
    this.scheduleFlush();
  }

  /**
   * Heuristic check for AI-generated content.
   *
   * Three positive signals (any one is enough):
   *   1. Large multi-line insertion that appears all at once (>100 chars, >=3 lines)
   *   2. Text contains common code-structure patterns AND is at least MIN_AI_CHARS long
   *   3. Medium-sized insertion (>= MIN_AI_CHARS) that isn't simple whitespace
   *
   * One negative filter applied first:
   *   - If the user was actively typing (small keystrokes) in the last second, skip.
   */
  private isPotentiallyAIGenerated(text: string, lineCount: number, now: number): boolean {
    const charCount = text.length;
    if (charCount === 0) return false;

    // Reject if user was recently typing manually
    const timeSinceLastTyping = now - this.lastTypingTimestamp;
    if (timeSinceLastTyping < 1000 && this.recentTypingChars > 10) {
      return false;
    }

    // Large multi-line insertions that appear instantly are almost certainly AI
    if (charCount > 100 && lineCount >= 3) return true;

    // Code-structure patterns with a minimum size guard
    if (charCount >= DETECTION_CONFIG.MIN_AI_CHARS && this.hasCodePatterns(text)) return true;

    // Moderate-size insertions that aren't just whitespace/newlines
    if (charCount >= 50 && text.trim().length > 10) return true;

    return false;
  }

  private hasCodePatterns(text: string): boolean {
    const patterns = [
      /function\s+\w+/,
      /const\s+\w+\s*=/,
      /export\s+(default\s+)?/,
      /import\s+.*from/,
      /class\s+\w+/,
      /async\s+function/,
      /=>\s*\{/,
      /interface\s+\w+/,
      /type\s+\w+\s*=/,
      /def\s+\w+\(/,
      /class\s+\w+:/,
    ];

    return patterns.some(p => p.test(text));
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flushPendingChanges();
    }, DETECTION_CONFIG.DEBOUNCE_MS);
  }

  private flushPendingChanges(): void {
    if (this.pendingChanges.length === 0) return;
    if (!this.currentProjectKey) return;

    log(`Flushing ${this.pendingChanges.length} pending changes for project ${this.currentProjectKey}`);

    // Force a fresh model detection on every flush so we pick up model switches promptly
    this.modelDetector.invalidateCache();

    const aggregated = this.aggregateChanges(this.pendingChanges);
    this.pendingChanges = [];

    for (const group of aggregated) {
      const interaction = this.createInteraction(group, this.currentProjectKey);
      if (interaction) {
        try {
          this.repo.create(interaction);
          log(`Saved AI interaction: type=${interaction.type}, model=${interaction.detectedModel ?? interaction.assumedModel}, ` +
              `editor=${interaction.editor ?? 'unknown'}, ` +
              `chars=${interaction.charCount}, inputTokens=${interaction.estimatedInputTokens}, outputTokens=${interaction.estimatedOutputTokens}, ` +
              `cost=$${(interaction.estimatedCostCents / 100).toFixed(4)}`);
        } catch (e) {
          log(`Failed to save AI interaction: ${e}`);
          console.error('[CodeMeter] Failed to save AI interaction:', e);
        }
      }
    }
  }

  private aggregateChanges(changes: PendingChange[]): PendingChange[][] {
    if (changes.length === 0) return [];

    const sorted = [...changes].sort((a, b) => a.timestampMs - b.timestampMs);
    const groups: PendingChange[][] = [[sorted[0]]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const lastGroup = groups[groups.length - 1];
      const lastChange = lastGroup[lastGroup.length - 1];

      if (current.timestampMs - lastChange.timestampMs < DETECTION_CONFIG.AGGREGATION_WINDOW_MS) {
        lastGroup.push(current);
      } else {
        groups.push([current]);
      }
    }

    // Filter out tiny groups that are likely noise (below the minimum AI threshold)
    return groups.filter(group => {
      const totalChars = group.reduce((sum, c) => sum + c.insertedText.length, 0);
      return totalChars >= DETECTION_CONFIG.MIN_AI_CHARS;
    });
  }

  private createInteraction(changes: PendingChange[], projectKey: string): AIInteraction | null {
    if (changes.length === 0) return null;

    const totalChars = changes.reduce((sum, c) => sum + c.insertedText.length, 0);
    const firstTimestamp = changes[0].timestampMs;

    if (totalChars <= 0) return null;

    const type = this.inferInteractionType(changes);
    const assumedModel = this.getAssumedModel();
    const detected = this.modelDetector.detect();
    const model = detected.normalizedModel ?? assumedModel;

    const outputTokens = Math.max(1, estimateTokensFromChars(totalChars, true));
    const inputTokens = Math.max(1, this.estimateInputTokens(type, totalChars));
    const estimatedCost = calculateCost(inputTokens, outputTokens, model);

    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
      log(`Skipping interaction with invalid cost: ${estimatedCost} (model=${model}, in=${inputTokens}, out=${outputTokens})`);
      return null;
    }

    return {
      id: uuidv4(),
      projectKey,
      timestampMs: firstTimestamp,
      type,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCostCents: estimatedCost,
      charCount: totalChars,
      assumedModel,
      detectedModel: detected.normalizedModel ?? undefined,
      editor: detected.editor,
    };
  }

  private inferInteractionType(changes: PendingChange[]): AIInteraction['type'] {
    const totalChars = changes.reduce((sum, c) => sum + c.insertedText.length, 0);
    const totalLines = changes.reduce((sum, c) => sum + c.lineCount, 0);
    const combinedText = changes.map(c => c.insertedText).join('\n');
    const hasPatterns = this.hasCodePatterns(combinedText);

    if (totalChars > 1000 || totalLines > 30) return 'chat';
    if (totalLines >= 5 && totalChars >= 200 && hasPatterns) return 'inline-edit';
    if (totalChars < 500 && totalLines < 10) return 'completion';
    if (totalChars < 200 && hasPatterns) return 'completion';

    return 'unknown';
  }

  private estimateInputTokens(type: AIInteraction['type'], outputChars: number): number {
    const ctx = CONTEXT_ESTIMATES;

    switch (type) {
      case 'chat':
        return ctx.chat.baseContextTokens + ctx.chat.fileContextTokens;
      case 'completion':
        return ctx.completion.contextTokens;
      case 'inline-edit':
        return Math.round(estimateTokensFromChars(outputChars * ctx.inlineEdit.contextMultiplier) + ctx.inlineEdit.instructionTokens);
      default:
        return 500;
    }
  }

  private registerAICommandListeners(): vscode.Disposable[] {
    return [];
  }

  /**
   * Manually record an AI interaction (for integrations that can provide exact data).
   */
  recordInteraction(params: {
    type: AIInteraction['type'];
    inputChars: number;
    outputChars: number;
    model?: string;
  }): void {
    if (!this.currentProjectKey) return;

    const inputTokens = estimateTokensFromChars(params.inputChars, true);
    const outputTokens = estimateTokensFromChars(params.outputChars, true);
    const assumedModel = this.getAssumedModel();
    const detected = this.modelDetector.detect();
    const model = (params.model && params.model.trim())
      ? params.model
      : (detected.normalizedModel ?? assumedModel);
    const cost = calculateCost(inputTokens, outputTokens, model);

    const interaction: AIInteraction = {
      id: uuidv4(),
      projectKey: this.currentProjectKey,
      timestampMs: Date.now(),
      type: params.type,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCostCents: cost,
      charCount: params.outputChars,
      assumedModel,
      detectedModel: detected.normalizedModel ?? undefined,
      editor: detected.editor,
    };

    try {
      this.repo.create(interaction);
    } catch (e) {
      console.error('[CodeMeter] Failed to save AI interaction:', e);
    }
  }

  getCostSummary(periodDays: number = 30): {
    totalCents: number;
    interactions: number;
    breakdown: Record<string, { count: number; cents: number }>;
  } | null {
    if (!this.currentProjectKey) return null;

    const now = Date.now();
    const startMs = now - (periodDays * 24 * 60 * 60 * 1000);

    try {
      const summary = this.repo.getEstimatedCostSummary(this.currentProjectKey, startMs, now);
      return {
        totalCents: summary.totalEstimatedCents,
        interactions: summary.interactionCount,
        breakdown: {
          chat: summary.breakdown.chat,
          completion: summary.breakdown.completion,
          'inline-edit': summary.breakdown.inlineEdit,
          unknown: summary.breakdown.unknown,
        },
      };
    } catch {
      return null;
    }
  }
}
