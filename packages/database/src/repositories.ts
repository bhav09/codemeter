import { UsageEvent, ProjectSession, AttributionRecord, Project, Budget, SyncState, AIInteraction, EstimatedCostSummary } from '@codemeter/core';
import { StoreKind } from './schema';
import { StorageDriver, getStorageDriver } from './driver';
import { readJsonDerived } from './schema';

type ProjectRecord = { type: 'upsert'; project: Project };
type SessionRecord =
  | { type: 'create'; session: ProjectSession }
  | { type: 'update'; sessionId: string; patch: Partial<ProjectSession> };
type EventRecord = { type: 'upsert'; event: UsageEvent };
type AttributionRecordLine = { type: 'upsert'; attribution: AttributionRecord };

export class ProjectRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  create(project: Project): void {
    this.driver.append('projects', { type: 'upsert', project } satisfies ProjectRecord);
  }

  getByKey(projectKey: string): Project | undefined {
    return this.getAll().find(p => p.projectKey === projectKey);
  }

  getAll(): Project[] {
    const records = this.driver.readAll<ProjectRecord>('projects');
    const map = new Map<string, Project>();
    for (const r of records) {
      const p = r?.project;
      if (!p?.projectKey) continue;
      const prev = map.get(p.projectKey);
      if (!prev || (p.lastActiveAt ?? 0) >= (prev.lastActiveAt ?? 0)) map.set(p.projectKey, p);
    }
    return [...map.values()].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }
}

export class SessionRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  create(session: ProjectSession): void {
    this.driver.append('sessions', { type: 'create', session } satisfies SessionRecord);
  }

  updateEndTime(sessionId: string, endMs: number): void {
    this.driver.append('sessions', { type: 'update', sessionId, patch: { endMs } } satisfies SessionRecord);
  }

  updateFlags(sessionId: string, focused: boolean, idle: boolean): void {
    this.driver.append('sessions', { type: 'update', sessionId, patch: { focused, idle } } satisfies SessionRecord);
  }

  getAll(): ProjectSession[] {
    const records = this.driver.readAll<SessionRecord>('sessions');
    const map = new Map<string, ProjectSession>();
    for (const r of records) {
      if (r.type === 'create') {
        map.set(r.session.id, r.session);
      } else if (r.type === 'update') {
        const prev = map.get(r.sessionId);
        if (!prev) continue;
        map.set(r.sessionId, { ...prev, ...(r.patch || {}) });
      }
    }
    return [...map.values()];
  }

  getActiveSessions(atTimestampMs: number): ProjectSession[] {
    return this.getAll()
      .filter(s => s.startMs <= atTimestampMs && (!s.endMs || s.endMs >= atTimestampMs))
      .sort((a, b) => b.startMs - a.startMs);
  }
}

export class EventRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  create(event: UsageEvent): void {
    this.driver.append('events', { type: 'upsert', event } satisfies EventRecord);
  }

  getAll(): UsageEvent[] {
    const records = this.driver.readAll<EventRecord>('events');
    const map = new Map<string, UsageEvent>();
    for (const r of records) {
      const e = r?.event;
      if (!e?.eventId) continue;
      map.set(e.eventId, e);
    }
    return [...map.values()];
  }

  getByTimeRange(startMs: number, endMs: number): UsageEvent[] {
    return this.getAll()
      .filter(e => e.timestampMs >= startMs && e.timestampMs <= endMs)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }
}

export class AttributionRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  create(attribution: AttributionRecord): void {
    this.driver.append('attributions', { type: 'upsert', attribution } satisfies AttributionRecordLine);
  }

  getByEventId(eventId: string): AttributionRecord | undefined {
    const records = this.driver.readAll<AttributionRecordLine>('attributions');
    let last: AttributionRecord | undefined;
    for (const r of records) {
      const a = r?.attribution;
      if (a?.eventId === eventId) last = a;
    }
    return last;
  }

  getAll(): AttributionRecord[] {
    const records = this.driver.readAll<AttributionRecordLine>('attributions');
    const map = new Map<string, AttributionRecord>();
    for (const r of records) {
      const a = r?.attribution;
      if (!a?.eventId) continue;
      map.set(a.eventId, a);
    }
    return [...map.values()];
  }

  getByProjectKey(projectKey: string): AttributionRecord[] {
    return this.getAll()
      .filter(a => a.projectKey === projectKey)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }
}

export class AnalyticsRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  getCostTotalsByProject(startMs: number, endMs: number): Array<{
    projectKey: string;
    totalCents: number;
    eventCount: number;
    avgConfidence: number;
  }> {
    const derived = readJsonDerived<any>('index.cost_by_project_by_day');
    if (derived?.version === 1 && derived?.byProjectByDay) {
      return aggregateFromDerivedByDay(derived.byProjectByDay, startMs, endMs);
    }

    // Fallback: scan events + attributions.
    const events = new EventRepository(this.driver).getByTimeRange(startMs, endMs);
    const attribByEvent = new Map<string, AttributionRecord>();
    for (const a of new AttributionRepository(this.driver).getAll()) attribByEvent.set(a.eventId, a);

    const agg = new Map<string, { totalCents: number; eventCount: number; confSum: number }>();
    for (const e of events) {
      const a = attribByEvent.get(e.eventId);
      const key = a?.projectKey ?? 'unattributed';
      const prev = agg.get(key) ?? { totalCents: 0, eventCount: 0, confSum: 0 };
      prev.totalCents += e.cost.totalCents;
      prev.eventCount += 1;
      prev.confSum += a?.confidence ?? 0;
      agg.set(key, prev);
    }

    return [...agg.entries()]
      .map(([projectKey, v]) => ({
        projectKey,
        totalCents: v.totalCents,
        eventCount: v.eventCount,
        avgConfidence: v.eventCount ? v.confSum / v.eventCount : 0
      }))
      .sort((a, b) => b.totalCents - a.totalCents);
  }

  getProjectMetrics(projectKey: string, startMs: number, endMs: number): {
    projectKey: string;
    totalCents: number;
    eventCount: number;
    avgConfidence: number;
    modelBreakdown: Record<string, number>;
    tokenBreakdown: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  } {
    const events = new EventRepository(this.driver).getByTimeRange(startMs, endMs);
    const attribByEvent = new Map<string, AttributionRecord>();
    for (const a of new AttributionRepository(this.driver).getAll()) attribByEvent.set(a.eventId, a);

    const modelBreakdown: Record<string, number> = {};
    const tokenBreakdown = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let totalCents = 0;
    let eventCount = 0;
    let confSum = 0;

    for (const e of events) {
      const a = attribByEvent.get(e.eventId);
      const key = a?.projectKey ?? 'unattributed';
      if (key !== projectKey) continue;
      eventCount += 1;
      totalCents += e.cost.totalCents;
      confSum += a?.confidence ?? 0;

      modelBreakdown[e.model] = (modelBreakdown[e.model] ?? 0) + e.cost.totalCents;
      tokenBreakdown.inputTokens += e.tokenUsage.inputTokens ?? 0;
      tokenBreakdown.outputTokens += e.tokenUsage.outputTokens ?? 0;
      tokenBreakdown.cacheReadTokens += e.tokenUsage.cacheReadTokens ?? 0;
      tokenBreakdown.cacheWriteTokens += e.tokenUsage.cacheWriteTokens ?? 0;
    }

    return {
      projectKey,
      totalCents,
      eventCount,
      avgConfidence: eventCount ? confSum / eventCount : 0,
      modelBreakdown,
      tokenBreakdown
    };
  }

  getHourlyHeatmap(projectKey: string, startMs: number, endMs: number): {
    projectKey: string;
    hourTotalsCents: number[]; // length 24
  } {
    const events = new EventRepository(this.driver).getByTimeRange(startMs, endMs);
    const attribByEvent = new Map<string, AttributionRecord>();
    for (const a of new AttributionRepository(this.driver).getAll()) attribByEvent.set(a.eventId, a);

    const hourTotalsCents = Array.from({ length: 24 }, () => 0);
    for (const e of events) {
      const a = attribByEvent.get(e.eventId);
      const key = a?.projectKey ?? 'unattributed';
      if (key !== projectKey) continue;
      const h = new Date(e.timestampMs).getHours();
      hourTotalsCents[h] += e.cost.totalCents;
    }
    return { projectKey, hourTotalsCents };
  }

  getUnattributedSummary(startMs: number, endMs: number): {
    totalCents: number;
    eventCount: number;
  } {
    const totals = this.getCostTotalsByProject(startMs, endMs);
    const row = totals.find(t => t.projectKey === 'unattributed');
    return { totalCents: row?.totalCents ?? 0, eventCount: row?.eventCount ?? 0 };
  }

  getConflictSummary(startMs: number, endMs: number): { totalCents: number; eventCount: number } {
    // Conflicts are represented as low-confidence attributions (typically due to overlapping sessions).
    const events = new EventRepository(this.driver).getByTimeRange(startMs, endMs);
    const attribByEvent = new Map<string, AttributionRecord>();
    for (const a of new AttributionRepository(this.driver).getAll()) attribByEvent.set(a.eventId, a);

    let totalCents = 0;
    let eventCount = 0;
    for (const e of events) {
      const a = attribByEvent.get(e.eventId);
      if (!a) continue;
      if (a.projectKey === 'unattributed') continue;
      if (a.confidence >= 0.7) continue;
      totalCents += e.cost.totalCents;
      eventCount += 1;
    }

    return { totalCents, eventCount };
  }
}

function aggregateFromDerivedByDay(
  byProjectByDay: Record<string, Record<string, { totalCents: number; eventCount: number; confSum: number }>>,
  startMs: number,
  endMs: number
): Array<{ projectKey: string; totalCents: number; eventCount: number; avgConfidence: number }> {
  const startDay = new Date(startMs).toISOString().slice(0, 10);
  const endDay = new Date(endMs).toISOString().slice(0, 10);

  const agg = new Map<string, { totalCents: number; eventCount: number; confSum: number }>();
  for (const [projectKey, dayMap] of Object.entries(byProjectByDay || {})) {
    for (const [day, v] of Object.entries(dayMap || {})) {
      if (day < startDay || day > endDay) continue;
      const prev = agg.get(projectKey) ?? { totalCents: 0, eventCount: 0, confSum: 0 };
      prev.totalCents += v.totalCents || 0;
      prev.eventCount += v.eventCount || 0;
      prev.confSum += v.confSum || 0;
      agg.set(projectKey, prev);
    }
  }

  return [...agg.entries()]
    .map(([projectKey, v]) => ({
      projectKey,
      totalCents: v.totalCents,
      eventCount: v.eventCount,
      avgConfidence: v.eventCount ? v.confSum / v.eventCount : 0
    }))
    .sort((a, b) => b.totalCents - a.totalCents);
}

type BudgetLine = { type: 'upsert'; budget: Budget };
type SyncStateLine = { type: 'upsert'; state: SyncState };

export class BudgetRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  createOrUpdate(budget: Budget): void {
    this.driver.append('budgets', { type: 'upsert', budget } satisfies BudgetLine);
  }

  getByProjectKey(projectKey: string): Budget | undefined {
    const map = this.getAllMap();
    return map.get(projectKey);
  }

  getAll(): Budget[] {
    return [...this.getAllMap().values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  private getAllMap(): Map<string, Budget> {
    const records = this.driver.readAll<BudgetLine>('budgets');
    const map = new Map<string, Budget>();
    for (const r of records) {
      const b = r?.budget;
      if (!b?.projectKey) continue;
      const prev = map.get(b.projectKey);
      if (!prev || (b.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) map.set(b.projectKey, b);
    }
    return map;
  }
}

export class SyncStateRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  upsert(state: SyncState): void {
    this.driver.append('sync_state', { type: 'upsert', state } satisfies SyncStateLine);
  }

  get(source: SyncState['source']): SyncState | undefined {
    const records = this.driver.readAll<SyncStateLine>('sync_state');
    let last: SyncState | undefined;
    for (const r of records) {
      if (r?.type !== 'upsert') continue;
      if (r.state?.source === source) last = r.state;
    }
    return last;
  }
}

export class MaintenanceRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  compactAll(): void {
    const kinds: StoreKind[] = ['projects', 'sessions', 'events', 'attributions', 'budgets', 'sync_state', 'ai_interactions'];
    for (const k of kinds) this.driver.compact(k);
  }

  compact(kind: StoreKind): void {
    this.driver.compact(kind);
  }
}

type AIInteractionLine = { type: 'create'; interaction: AIInteraction };

export class AIInteractionRepository {
  constructor(private readonly driver: StorageDriver = getStorageDriver()) {}

  create(interaction: AIInteraction): void {
    this.driver.append('ai_interactions', { type: 'create', interaction } satisfies AIInteractionLine);
  }

  getAll(): AIInteraction[] {
    const records = this.driver.readAll<AIInteractionLine>('ai_interactions');
    return records
      .filter(r => r?.type === 'create' && r?.interaction?.id)
      .map(r => r.interaction);
  }

  getByTimeRange(startMs: number, endMs: number): AIInteraction[] {
    return this.getAll()
      .filter(i => i.timestampMs >= startMs && i.timestampMs <= endMs)
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }

  getByProjectKey(projectKey: string, startMs?: number, endMs?: number): AIInteraction[] {
    let results = this.getAll().filter(i => i.projectKey === projectKey);
    if (startMs !== undefined) {
      results = results.filter(i => i.timestampMs >= startMs);
    }
    if (endMs !== undefined) {
      results = results.filter(i => i.timestampMs <= endMs);
    }
    return results.sort((a, b) => b.timestampMs - a.timestampMs);
  }

  getEstimatedCostSummary(projectKey: string, startMs: number, endMs: number): EstimatedCostSummary {
    const interactions = this.getByProjectKey(projectKey, startMs, endMs);
    
    const breakdown = {
      chat: { count: 0, cents: 0 },
      completion: { count: 0, cents: 0 },
      inlineEdit: { count: 0, cents: 0 },
      unknown: { count: 0, cents: 0 },
    };
    
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCents = 0;

    for (const i of interactions) {
      totalInputTokens += i.estimatedInputTokens;
      totalOutputTokens += i.estimatedOutputTokens;
      totalCents += i.estimatedCostCents;

      const key = i.type === 'inline-edit' ? 'inlineEdit' : i.type;
      if (breakdown[key as keyof typeof breakdown]) {
        breakdown[key as keyof typeof breakdown].count += 1;
        breakdown[key as keyof typeof breakdown].cents += i.estimatedCostCents;
      }
    }

    return {
      projectKey,
      periodStartMs: startMs,
      periodEndMs: endMs,
      totalEstimatedCents: Math.round(totalCents * 100) / 100,
      interactionCount: interactions.length,
      breakdown,
      totalInputTokens,
      totalOutputTokens,
    };
  }

  getAllProjectsSummary(startMs: number, endMs: number): Array<{
    projectKey: string;
    totalEstimatedCents: number;
    interactionCount: number;
  }> {
    const interactions = this.getByTimeRange(startMs, endMs);
    const byProject = new Map<string, { cents: number; count: number }>();

    for (const i of interactions) {
      const prev = byProject.get(i.projectKey) ?? { cents: 0, count: 0 };
      prev.cents += i.estimatedCostCents;
      prev.count += 1;
      byProject.set(i.projectKey, prev);
    }

    return [...byProject.entries()]
      .map(([projectKey, v]) => ({
        projectKey,
        totalEstimatedCents: Math.round(v.cents * 100) / 100,
        interactionCount: v.count,
      }))
      .sort((a, b) => b.totalEstimatedCents - a.totalEstimatedCents);
  }
}
