import { UsageEvent, CostBreakdown } from './types';
import { calculateCost } from './pricing';

export class CostCalculator {
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

  /**
   * Fill in missing cost data for a usage event using live pricing.
   * Returns cost in cents.
   */
  estimateMissingCost(event: UsageEvent): number {
    if (event.cost.totalCents > 0) {
      return event.cost.totalCents;
    }

    return calculateCost(
      event.tokenUsage.inputTokens,
      event.tokenUsage.outputTokens,
      event.model
    );
  }
}
