import * as fs from 'fs';
import * as path from 'path';
import { StoreKind, getDatabaseDir, getStoreFile, readJsonl, writeJsonSnapshot, writeJsonDerived } from './schema';

export interface StorageDriver {
  append(kind: StoreKind, record: unknown): void;
  readAll<T>(kind: StoreKind): T[];
  /**
   * Compacts a store by writing a snapshot + rewriting the JSONL file into a smaller canonical form.
   * Intended to keep MVP JSONL storage fast enough without switching databases.
   */
  compact(kind: StoreKind): void;
}

/**
 * JSONL storage driver with optional snapshots for fast reads.
 *
 * Files live in `~/.codemeter/` for cross-IDE continuity.
 */
export class JsonlStorageDriver implements StorageDriver {
  append(kind: StoreKind, record: unknown): void {
    // Ensure directory exists
    getDatabaseDir();
    
    const file = getStoreFile(kind);
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(file, line, { encoding: 'utf8' });
  }

  readAll<T>(kind: StoreKind): T[] {
    return readJsonl<T>(kind);
  }

  compact(kind: StoreKind): void {
    const lock = acquireLock(kind);
    if (!lock) return; // someone else is compacting

    try {
    const file = getStoreFile(kind);
    if (!fs.existsSync(file)) return;

    const records = readJsonl<any>(kind);

    // Build canonical snapshot + canonical JSONL rewrite
    const { snapshot, canonicalLines } = compactByKind(kind, records);

    writeJsonSnapshot(kind, snapshot);

    // Rewrite JSONL atomically (best effort)
    const tmp = path.join(getDatabaseDir(), `${kind}.jsonl.tmp`);
    fs.writeFileSync(tmp, canonicalLines.join('\n') + (canonicalLines.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);

    // Build derived indexes (fast-path analytics) when we have enough inputs.
    // For MVP, only rebuild when compacting events/attributions (common growth drivers).
    if (kind === 'events' || kind === 'attributions') {
      tryBuildDerivedIndexes();
    }
    } finally {
      releaseLock(lock);
    }
  }
}

let defaultDriver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (!defaultDriver) defaultDriver = new JsonlStorageDriver();
  return defaultDriver;
}

function compactByKind(kind: StoreKind, records: any[]): { snapshot: any; canonicalLines: string[] } {
  if (kind === 'projects') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'upsert' || !r?.project?.projectKey) continue;
      const key = r.project.projectKey;
      const prev = map.get(key);
      if (!prev || (r.project.lastActiveAt ?? 0) >= (prev.project.lastActiveAt ?? 0)) map.set(key, r);
    }
    const snapshot = [...map.values()].map(r => r.project);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'upsert', project: r.project }));
    return { snapshot, canonicalLines };
  }

  if (kind === 'events') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'upsert' || !r?.event?.eventId) continue;
      map.set(r.event.eventId, r);
    }
    const snapshot = [...map.values()].map(r => r.event);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'upsert', event: r.event }));
    return { snapshot, canonicalLines };
  }

  if (kind === 'attributions') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'upsert' || !r?.attribution?.eventId) continue;
      map.set(r.attribution.eventId, r);
    }
    const snapshot = [...map.values()].map(r => r.attribution);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'upsert', attribution: r.attribution }));
    return { snapshot, canonicalLines };
  }

  if (kind === 'budgets') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'upsert' || !r?.budget?.projectKey) continue;
      const key = r.budget.projectKey;
      const prev = map.get(key);
      if (!prev || (r.budget.updatedAt ?? 0) >= (prev.budget.updatedAt ?? 0)) map.set(key, r);
    }
    const snapshot = [...map.values()].map(r => r.budget);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'upsert', budget: r.budget }));
    return { snapshot, canonicalLines };
  }

  if (kind === 'sync_state') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'upsert' || !r?.state?.source) continue;
      map.set(r.state.source, r);
    }
    const snapshot = [...map.values()].map(r => r.state);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'upsert', state: r.state }));
    return { snapshot, canonicalLines };
  }

  // sessions: merge patches into canonical "create" records
  if (kind === 'sessions') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type === 'create' && r?.session?.id) {
        map.set(r.session.id, r.session);
      } else if (r?.type === 'update' && r?.sessionId) {
        const prev = map.get(r.sessionId);
        if (!prev) continue;
        map.set(r.sessionId, { ...prev, ...(r.patch || {}) });
      }
    }
    const snapshot = [...map.values()];
    const canonicalLines = [...map.values()].map(session => JSON.stringify({ type: 'create', session }));
    return { snapshot, canonicalLines };
  }

  // ai_interactions: dedupe by id
  if (kind === 'ai_interactions') {
    const map = new Map<string, any>();
    for (const r of records) {
      if (r?.type !== 'create' || !r?.interaction?.id) continue;
      map.set(r.interaction.id, r);
    }
    const snapshot = [...map.values()].map(r => r.interaction);
    const canonicalLines = [...map.values()].map(r => JSON.stringify({ type: 'create', interaction: r.interaction }));
    return { snapshot, canonicalLines };
  }

  return { snapshot: [], canonicalLines: [] };
}

type LockHandle = { lockPath: string };
const LOCK_STALE_MS = 5 * 60_000;

function lockPathFor(kind: StoreKind): string {
  return path.join(getDatabaseDir(), `${kind}.compact.lock`);
}

function acquireLock(kind: StoreKind): LockHandle | null {
  const lockPath = lockPathFor(kind);

  // Best-effort stale lock cleanup
  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // ignore
  }

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
    fs.closeSync(fd);
    return { lockPath };
  } catch {
    return null;
  }
}

function releaseLock(lock: LockHandle): void {
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    // ignore
  }
}

function tryBuildDerivedIndexes(): void {
  // Read snapshots (fast) if present; fallback to reading JSONL (readJsonl already prefers snapshots).
  const events = readJsonl<any>('events') as Array<any>;
  const attributions = readJsonl<any>('attributions') as Array<any>;

  const attribByEvent = new Map<string, any>();
  for (const a of attributions) {
    if (!a?.eventId) continue;
    attribByEvent.set(a.eventId, a);
  }

  // per project per day totals
  const byProjectByDay: Record<string, Record<string, { totalCents: number; eventCount: number; confSum: number }>> = {};

  for (const e of events) {
    const a = attribByEvent.get(e.eventId);
    const projectKey = a?.projectKey ?? 'unattributed';
    const day = new Date(e.timestampMs).toISOString().slice(0, 10);
    const entry =
      (byProjectByDay[projectKey] ??= {})[day] ??= { totalCents: 0, eventCount: 0, confSum: 0 };
    entry.totalCents += e?.cost?.totalCents ?? 0;
    entry.eventCount += 1;
    entry.confSum += a?.confidence ?? 0;
  }

  writeJsonDerived('index.cost_by_project_by_day', {
    version: 1,
    generatedAtMs: Date.now(),
    byProjectByDay
  });
}


