import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { AIInteractionRepository } from '@codemeter/database';
import { AIInteraction, estimateTokensFromChars, calculateCost, DEFAULT_MODEL, CONTEXT_ESTIMATES } from '@codemeter/core';
import { computeProjectIdentity } from './projectIdentity';

/**
 * Configuration thresholds for detecting AI-generated content.
 */
const DETECTION_CONFIG = {
  /** Minimum characters in an insertion to consider it possibly AI-generated */
  MIN_CHARS: 50,
  /** Minimum lines in an insertion to consider it possibly AI-generated */
  MIN_LINES: 3,
  /** Maximum time between insertions to aggregate them (ms) */
  AGGREGATION_WINDOW_MS: 500,
  /** Debounce time before processing aggregated changes (ms) */
  DEBOUNCE_MS: 1000,
  /** Characters per second threshold - AI is faster than humans */
  AI_CHARS_PER_SEC_THRESHOLD: 100,
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
  private readonly disposables: vscode.Disposable[] = [];
  
  private pendingChanges: PendingChange[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastChangeTimestamp = 0;
  private lastTypingTimestamp = 0;
  private recentTypingChars = 0;
  
  private currentProjectKey: string | null = null;

  start(): void {
    this.updateProjectKey();

    this.disposables.push(
      // Track document changes
      vscode.workspace.onDidChangeTextDocument(event => {
        this.handleDocumentChange(event);
      }),
      
      // Track workspace changes to update project key
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.updateProjectKey();
      }),

      // Track typing to estimate typing speed
      vscode.workspace.onDidChangeTextDocument(event => {
        this.trackTypingSpeed(event);
      }),

      // Detect Cursor-specific AI commands (if available)
      ...this.registerAICommandListeners()
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

  private updateProjectKey(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const primary = folders[0]?.uri?.fsPath;
    if (primary) {
      const identity = computeProjectIdentity(primary);
      this.currentProjectKey = identity.projectKey;
    }
  }

  private trackTypingSpeed(event: vscode.TextDocumentChangeEvent): void {
    const now = Date.now();
    for (const change of event.contentChanges) {
      // Only track small insertions (likely typing)
      if (change.text.length > 0 && change.text.length <= 5) {
        if (now - this.lastTypingTimestamp < 2000) {
          this.recentTypingChars += change.text.length;
        } else {
          this.recentTypingChars = change.text.length;
        }
        this.lastTypingTimestamp = now;
      }
    }
    // Decay typing chars over time
    if (now - this.lastTypingTimestamp > 5000) {
      this.recentTypingChars = 0;
    }
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    // Skip if no project context
    if (!this.currentProjectKey) return;
    
    // Skip non-file URIs (e.g., git, output)
    if (event.document.uri.scheme !== 'file') return;

    const now = Date.now();
    
    for (const change of event.contentChanges) {
      const text = change.text;
      const lineCount = text.split('\n').length;
      
      // Check if this looks like AI-generated content
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

  private isPotentiallyAIGenerated(text: string, lineCount: number, now: number): boolean {
    const charCount = text.length;
    
    // Size thresholds
    if (charCount < DETECTION_CONFIG.MIN_CHARS) return false;
    if (lineCount < DETECTION_CONFIG.MIN_LINES) return false;
    
    // Check insertion speed
    const timeSinceLastTyping = now - this.lastTypingTimestamp;
    if (timeSinceLastTyping < 1000 && this.recentTypingChars > 10) {
      // User was recently typing manually - probably not AI
      return false;
    }
    
    // Large multi-line insertions that appear instantly are likely AI
    // (human typing would have many intermediate changes)
    const isInstantLargeInsertion = charCount > 100 && lineCount >= 3;
    
    // Code patterns that suggest AI generation
    const hasCodePatterns = this.hasCodePatterns(text);
    
    return isInstantLargeInsertion || (hasCodePatterns && charCount > 200);
  }

  private hasCodePatterns(text: string): boolean {
    // Common patterns in AI-generated code
    const patterns = [
      /function\s+\w+/,           // function declarations
      /const\s+\w+\s*=/,          // const declarations
      /export\s+(default\s+)?/,   // exports
      /import\s+.*from/,          // imports
      /class\s+\w+/,              // class declarations
      /async\s+function/,         // async functions
      /=>\s*\{/,                  // arrow functions
      /interface\s+\w+/,          // TypeScript interfaces
      /type\s+\w+\s*=/,           // TypeScript type aliases
      /def\s+\w+\(/,              // Python functions
      /class\s+\w+:/,             // Python classes
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

    // Aggregate nearby changes (they might be parts of one AI response)
    const aggregated = this.aggregateChanges(this.pendingChanges);
    this.pendingChanges = [];

    for (const group of aggregated) {
      const interaction = this.createInteraction(group, this.currentProjectKey);
      if (interaction) {
        try {
          this.repo.create(interaction);
        } catch (e) {
          // best-effort, don't crash
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
    
    return groups;
  }

  private createInteraction(changes: PendingChange[], projectKey: string): AIInteraction | null {
    if (changes.length === 0) return null;

    const totalChars = changes.reduce((sum, c) => sum + c.insertedText.length, 0);
    const totalLines = changes.reduce((sum, c) => sum + c.lineCount, 0);
    const firstTimestamp = changes[0].timestampMs;

    // Determine interaction type based on size and patterns
    const type = this.inferInteractionType(changes);

    // Estimate tokens
    const outputTokens = estimateTokensFromChars(totalChars, true);
    const inputTokens = this.estimateInputTokens(type, totalChars);

    // Calculate estimated cost
    const estimatedCost = calculateCost(inputTokens, outputTokens, DEFAULT_MODEL);

    return {
      id: uuidv4(),
      projectKey,
      timestampMs: firstTimestamp,
      type,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      estimatedCostCents: estimatedCost,
      charCount: totalChars,
      assumedModel: DEFAULT_MODEL,
    };
  }

  private inferInteractionType(changes: PendingChange[]): AIInteraction['type'] {
    const totalChars = changes.reduce((sum, c) => sum + c.insertedText.length, 0);
    const totalLines = changes.reduce((sum, c) => sum + c.lineCount, 0);
    const combinedText = changes.map(c => c.insertedText).join('\n');

    // Large multi-file or very large insertions suggest chat
    if (totalChars > 1000 || totalLines > 30) {
      return 'chat';
    }

    // Medium-sized code blocks with function/class patterns suggest inline edit
    if (totalLines >= 5 && this.hasCodePatterns(combinedText)) {
      return 'inline-edit';
    }

    // Smaller completions
    if (totalLines < 10 && totalChars < 500) {
      return 'completion';
    }

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
        return 500; // Conservative default
    }
  }

  /**
   * Register listeners for Cursor-specific commands if available.
   * These provide more accurate tracking than heuristics.
   */
  private registerAICommandListeners(): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // Try to listen for common AI command patterns
    // Note: Cursor's internal commands may not be public
    const aiCommands = [
      'cursor.generateCode',
      'cursor.chat.submit',
      'cursor.edit.accept',
      'cursor.acceptSuggestion',
      'editor.action.inlineSuggest.commit',
      'editor.action.triggerSuggest',
    ];

    // We can't directly intercept commands, but we can register our own
    // wrapper commands or use the extension API if available
    
    return disposables;
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
    const model = params.model ?? DEFAULT_MODEL;
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
      assumedModel: model,
    };

    try {
      this.repo.create(interaction);
    } catch (e) {
      console.error('[CodeMeter] Failed to save AI interaction:', e);
    }
  }

  /**
   * Get cost summary for current workspace.
   */
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


