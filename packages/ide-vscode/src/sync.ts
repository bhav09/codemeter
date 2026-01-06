import * as vscode from 'vscode';
import { CursorDashboardClient } from '@codemeter/cursor-dashboard';
import { CursorAdminClient } from '@codemeter/cursor-admin';
import { AttributionEngine, UsageEvent } from '@codemeter/core';
import { AttributionRepository, EventRepository, SessionRepository, SyncStateRepository } from '@codemeter/database';

export type ConnectorMode = 'cursor-dashboard' | 'cursor-admin';

export interface SyncOptions {
  mode: ConnectorMode;
  startMs: number;
  endMs: number;
}

/**
 * MVP sync:
 * - Fetch usage events for a time window
 * - Store normalized events
 * - Attribute to sessions in the shared DB
 */
export async function runSync(context: vscode.ExtensionContext, opts: SyncOptions): Promise<number> {
  const eventsRepo = new EventRepository();
  const sessionsRepo = new SessionRepository();
  const attributionRepo = new AttributionRepository();
  const syncRepo = new SyncStateRepository();
  const attribution = new AttributionEngine();

  let events: UsageEvent[] = [];
  const source = opts.mode === 'cursor-admin' ? 'cursor-admin' : 'cursor-dashboard';
  const state = syncRepo.get(source);
  const LOOKBACK_MS = 5 * 60_000; // tolerate late-arriving aggregation; relies on eventId dedupe
  const previousHighWater = state?.lastFetchedMs ?? 0;
  const effectiveStartMs = Math.max(opts.startMs, Math.max(0, previousHighWater - LOOKBACK_MS));

  let lastError: string | undefined;
  try {
    if (opts.mode === 'cursor-dashboard') {
    const sessionToken = await context.secrets.get('cursor.sessionToken');
    if (!sessionToken) {
      throw new Error('Cursor session token not set. Run “CodeMeter: Connect Cursor Account”.');
    }
    const client = new CursorDashboardClient(sessionToken, { includeRaw: false });
      events = await client.fetchUsageEvents({ startMs: effectiveStartMs, endMs: opts.endMs });
    } else {
    const adminKey = await context.secrets.get('cursor.adminApiKey');
    if (!adminKey) {
      throw new Error('Cursor Admin API key not set.');
    }
    const client = new CursorAdminClient(adminKey, { includeRaw: false });
      events = await client.fetchUsageEvents({ startMs: effectiveStartMs, endMs: opts.endMs });
    }
  } catch (e: any) {
    lastError = String(e?.message || e);
    syncRepo.upsert({
      source,
      lastFetchedMs: previousHighWater,
      lastSyncAtMs: Date.now(),
      lastError
    });
    throw e;
  }

  let maxSeenEventMs = previousHighWater;
  for (const e of events) {
    eventsRepo.create(e);
    const activeSessions = sessionsRepo.getActiveSessions(e.timestampMs);
    const result = attribution.attributeEvent(e, activeSessions);
    if (result.attribution) {
      attributionRepo.create(result.attribution);
    }
    if (e.timestampMs > maxSeenEventMs) maxSeenEventMs = e.timestampMs;
  }

  syncRepo.upsert({
    source,
    lastFetchedMs: maxSeenEventMs,
    lastSyncAtMs: Date.now(),
    lastError: undefined
  });

  return events.length;
}


