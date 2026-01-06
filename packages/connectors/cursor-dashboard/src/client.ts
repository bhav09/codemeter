import axios, { AxiosInstance } from 'axios';
import { UsageEvent, withBackoff } from '@codemeter/core';
import { createHash } from 'crypto';

export interface CursorDashboardClientOptions {
  /**
   * Cursor web origin.
   * Keep Cursor-specific details inside connectors/ as per architecture.
   */
  baseUrl?: string;
  /**
   * If true, store raw response items in UsageEvent.raw for debugging.
   * Should be off by default in the IDE extension unless user opts in.
   */
  includeRaw?: boolean;
}

export class CursorDashboardClient {
  private readonly http: AxiosInstance;
  private readonly includeRaw: boolean;

  constructor(private readonly sessionToken: string, opts: CursorDashboardClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? 'https://cursor.com';
    this.includeRaw = Boolean(opts.includeRaw);

    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        // Keep auth user-owned: cookie is from the user's browser session.
        Cookie: `WorkosCursorSessionToken=${sessionToken}`,
        Accept: 'application/json'
      },
      timeout: 20_000
    });
  }

  /**
   * Fetch usage events from Cursor's dashboard endpoint.
   *
   * Important safety stance:
   * - We do NOT accept userId/teamId scoping input (past IDOR advisory).
   * - We only call the "current session" endpoint and normalize what comes back.
   */
  async fetchUsageEvents(params: { startMs: number; endMs: number }): Promise<UsageEvent[]> {
    const res = await withBackoff(
      () =>
        this.http.post('/api/dashboard/get-filtered-usage-events', {
          // We intentionally keep this minimal; endpoint specifics may change.
          startMs: params.startMs,
          endMs: params.endMs
        }),
      { getRetryAfterMs: getAxiosRetryAfterMs }
    );

    const payload = res.data;
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.usageEvents)
        ? payload.usageEvents
        : Array.isArray(payload?.events)
          ? payload.events
          : [];

    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item: any) => this.normalizeItem(item))
      .filter((e): e is UsageEvent => Boolean(e));
  }

  private normalizeItem(item: any): UsageEvent | null {
    const timestampMs = coerceTimestampMs(
      item?.timestampMs ??
        item?.timestamp ??
        item?.createdAtMs ??
        item?.createdAt ??
        item?.time ??
        null
    );

    if (!timestampMs) return null;

    const model = String(item?.model ?? item?.modelName ?? item?.llm ?? 'unknown');

    const tokenUsage = {
      inputTokens: coerceNumber(item?.tokenUsage?.inputTokens ?? item?.inputTokens ?? item?.promptTokens ?? 0),
      outputTokens: coerceNumber(item?.tokenUsage?.outputTokens ?? item?.outputTokens ?? item?.completionTokens ?? 0),
      cacheReadTokens: coerceOptionalNumber(item?.tokenUsage?.cacheReadTokens ?? item?.cacheReadTokens),
      cacheWriteTokens: coerceOptionalNumber(item?.tokenUsage?.cacheWriteTokens ?? item?.cacheWriteTokens)
    };

    const totalCents = coerceNumber(
      item?.cost?.totalCents ??
        item?.totalCents ??
        item?.total_cents ??
        item?.totalCostCents ??
        item?.costCents ??
        0
    );

    const modelCents = coerceNumber(
      item?.cost?.modelCents ??
        item?.modelCents ??
        item?.model_cents ??
        0
    );

    const cursorFeeCents = coerceOptionalNumber(
      item?.cost?.cursorFeeCents ??
        item?.cursorFeeCents ??
        item?.cursor_fee_cents
    );

    const eventId = String(
      item?.eventId ??
        item?.id ??
        hashStableId({ timestampMs, model, tokenUsage, totalCents })
    );

    return {
      eventId,
      timestampMs,
      source: 'cursor-dashboard',
      model,
      kind: item?.kind === 'included' || item?.kind === 'usage-based' ? item.kind : undefined,
      tokenUsage,
      cost: {
        modelCents,
        cursorFeeCents: cursorFeeCents ?? undefined,
        totalCents
      },
      raw: this.includeRaw ? item : undefined
    };
  }
}

function getAxiosRetryAfterMs(e: unknown): number | null {
  const anyErr = e as any;
  const status = anyErr?.response?.status;
  if (status !== 429) return null;
  const ra = anyErr?.response?.headers?.['retry-after'];
  const n = Number(ra);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  return null;
}

function coerceNumber(v: any): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function coerceOptionalNumber(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function coerceTimestampMs(v: any): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Heuristic: if it's seconds, convert to ms
  return n < 10_000_000_000 ? Math.round(n * 1000) : Math.round(n);
}

function hashStableId(input: any): string {
  const json = JSON.stringify(input);
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}


