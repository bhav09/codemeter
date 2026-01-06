import { describe, it, expect, beforeEach } from '@jest/globals';
import { AttributionEngine } from './attribution';
import { UsageEvent, ProjectSession } from './types';

describe('AttributionEngine', () => {
  let engine: AttributionEngine;

  beforeEach(() => {
    engine = new AttributionEngine();
  });

  const mockEvent: UsageEvent = {
    eventId: 'evt-1',
    timestampMs: 1000,
    source: 'cursor-dashboard',
    model: 'gpt-4',
    tokenUsage: { inputTokens: 10, outputTokens: 10 },
    cost: { modelCents: 1, totalCents: 1 }
  };

  it('should attribute to a single focused non-idle session', () => {
    const session: ProjectSession = {
      id: 'sess-1',
      projectKey: 'proj-a',
      workspaceFolders: ['/foo'],
      startMs: 0,
      focused: true,
      idle: false,
      ideInstanceId: 'inst-1',
      ideType: 'cursor'
    };

    const result = engine.attributeEvent(mockEvent, [session]);
    expect(result.attribution?.projectKey).toBe('proj-a');
    expect(result.confidence).toBe(1.0);
  });

  it('should return unattributed if no workspace is active', () => {
    const result = engine.attributeEvent(mockEvent, []);
    expect(result.attribution?.projectKey).toBe('unattributed');
    expect(result.confidence).toBe(0);
  });
});
