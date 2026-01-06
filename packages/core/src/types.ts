export interface UsageEvent {
  eventId: string;
  timestampMs: number;
  source: 'cursor-admin' | 'cursor-dashboard';
  model: string;
  kind?: 'included' | 'usage-based';
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cost: {
    modelCents: number;
    cursorFeeCents?: number;
    totalCents: number;
  };
  raw?: any;
}

export interface ProjectSession {
  id: string;
  projectKey: string;
  workspaceFolders: string[];
  startMs: number;
  endMs?: number;
  focused: boolean;
  idle: boolean;
  ideInstanceId: string;
  ideType: 'vscode' | 'cursor' | 'antigravity';
}

export interface AttributionRecord {
  eventId: string;
  projectKey: string | 'unattributed';
  confidence: number;
  reason: string;
  timestampMs: number;
}

export interface Project {
  projectKey: string;
  displayName: string;
  gitRemote?: string;
  workspacePath: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface Budget {
  projectKey: string;
  monthlyCents: number;
  alertThresholds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface SyncState {
  source: 'cursor-admin' | 'cursor-dashboard';
  /**
   * High-water mark of the latest *observed* usage event timestamp (ms).
   * This should NOT be the request end time; using observed timestamps avoids gaps.
   */
  lastFetchedMs: number;
  /**
   * Last successful sync completion time (ms).
   */
  lastSyncAtMs?: number;
  /**
   * If the last sync failed, this can contain a short, non-PII error string.
   */
  lastError?: string;
  etag?: string;
  cursor?: string;
}

export interface CostBreakdown {
  projectKey: string;
  period: 'daily' | 'weekly' | 'monthly';
  startMs: number;
  endMs: number;
  totalCents: number;
  modelBreakdown: Record<string, number>;
  tokenBreakdown: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  eventCount: number;
}

export interface AttributionResult {
  event: UsageEvent;
  attribution?: AttributionRecord;
  confidence: number;
  conflicts: ProjectSession[];
}

/**
 * Estimated AI interaction detected locally (without API access).
 * These are heuristic-based estimates, not exact measurements.
 */
export interface AIInteraction {
  id: string;
  projectKey: string;
  timestampMs: number;
  type: 'chat' | 'completion' | 'inline-edit' | 'unknown';
  /** Estimated input tokens (prompt/context sent to AI) */
  estimatedInputTokens: number;
  /** Estimated output tokens (AI response) */
  estimatedOutputTokens: number;
  /** Estimated cost in cents based on typical model pricing */
  estimatedCostCents: number;
  /** Characters of text involved */
  charCount: number;
  /** Assumed model for cost calculation */
  assumedModel: string;
}

/**
 * Model pricing information for cost estimation.
 * Prices are in cents per 1M tokens.
 */
export interface ModelPricing {
  modelId: string;
  displayName: string;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
}

/**
 * Summary of estimated AI costs for a workspace.
 */
export interface EstimatedCostSummary {
  projectKey: string;
  periodStartMs: number;
  periodEndMs: number;
  totalEstimatedCents: number;
  interactionCount: number;
  breakdown: {
    chat: { count: number; cents: number };
    completion: { count: number; cents: number };
    inlineEdit: { count: number; cents: number };
    unknown: { count: number; cents: number };
  };
  totalInputTokens: number;
  totalOutputTokens: number;
}
