import { UsageEvent, CostBreakdown } from './types';

export class CostCalculator {
  private readonly modelCosts: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'claude-3-opus': { input: 0.015, output: 0.075 },
    'claude-3-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 }
  };

  calculateCost(events: UsageEvent[]): CostBreakdown {
    const now = Date.now();
    const startMs = now - (24 * 60 * 60 * 1000);
    const endMs = now;

    const dailyEvents = events.filter(e => e.timestampMs >= startMs && e.timestampMs <= endMs);
    
    const totalCents = dailyEvents.reduce((sum, event) => sum + event.cost.totalCents, 0);
    const modelBreakdown: Record<string, number> = {};
    const tokenBreakdown = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };

    dailyEvents.forEach(event => {
      if (!modelBreakdown[event.model]) {
        modelBreakdown[event.model] = 0;
      }
      modelBreakdown[event.model] += event.cost.totalCents;

      tokenBreakdown.inputTokens += event.tokenUsage.inputTokens;
      tokenBreakdown.outputTokens += event.tokenUsage.outputTokens;
      tokenBreakdown.cacheReadTokens += event.tokenUsage.cacheReadTokens || 0;
      tokenBreakdown.cacheWriteTokens += event.tokenUsage.cacheWriteTokens || 0;
    });

    return {
      projectKey: 'aggregate',
      period: 'daily',
      startMs,
      endMs,
      totalCents,
      modelBreakdown,
      tokenBreakdown,
      eventCount: dailyEvents.length
    };
  }

  estimateMissingCost(event: UsageEvent): number {
    if (event.cost.totalCents > 0) {
      return event.cost.totalCents;
    }

    const modelCost = this.modelCosts[event.model.toLowerCase()];
    if (!modelCost) {
      return 0;
    }

    const inputCost = (event.tokenUsage.inputTokens / 1000) * modelCost.input;
    const outputCost = (event.tokenUsage.outputTokens / 1000) * modelCost.output;
    const cacheReadCost = event.tokenUsage.cacheReadTokens ? 
      (event.tokenUsage.cacheReadTokens / 1000) * (modelCost.cacheRead || modelCost.input * 0.1) : 0;
    const cacheWriteCost = event.tokenUsage.cacheWriteTokens ? 
      (event.tokenUsage.cacheWriteTokens / 1000) * (modelCost.cacheWrite || modelCost.input * 0.5) : 0;

    return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100);
  }
}
