import { ModelPricing } from './types';

export type PricingProvider = 'anthropic' | 'openai' | 'google';

interface LiveModelPrice {
  input: number;   // USD per million input tokens
  output: number;  // USD per million output tokens
  cached?: number;
  context?: number;
}

/**
 * Bundled fallback pricing (March 2026 rates).
 * Used when live pricing fetch fails or extension is offline.
 * These are updated with each extension release — but live fetch is preferred.
 */
const FALLBACK_PRICING: Record<string, LiveModelPrice> = {
  // Anthropic (March 2026)
  'claude-sonnet-4.6':  { input: 3,    output: 15,   cached: 0.3 },
  'claude-opus-4.6':    { input: 5,    output: 25,   cached: 0.5 },
  'claude-haiku-4.5':   { input: 1,    output: 5,    cached: 0.1 },
  'claude-sonnet-4.5':  { input: 3,    output: 15,   cached: 0.3 },
  'claude-opus-4.5':    { input: 5,    output: 25,   cached: 0.5 },
  'claude-sonnet-4':    { input: 3,    output: 15,   cached: 0.3 },
  'claude-haiku-3.5':   { input: 0.8,  output: 4,    cached: 0.08 },
  // OpenAI (March 2026)
  'gpt-4.1':            { input: 2,    output: 8 },
  'gpt-4.1-mini':       { input: 0.4,  output: 1.6 },
  'gpt-4.1-nano':       { input: 0.1,  output: 0.4 },
  'gpt-4o':             { input: 2.5,  output: 10 },
  'gpt-4o-mini':        { input: 0.15, output: 0.6 },
  'gpt-5.4':            { input: 2.5,  output: 15 },
  'o3-pro':             { input: 20,   output: 80 },
  'o4-mini':            { input: 1.1,  output: 4.4 },
  // Cursor
  'cursor-small':       { input: 0.1,  output: 0.4 },
};

export const DEFAULT_MODEL = 'claude-sonnet-4.6';

const PRICING_ENDPOINTS: Record<PricingProvider, string> = {
  anthropic: 'https://mikkotikkanen.github.io/token-costs/api/v1/anthropic.json',
  openai:    'https://mikkotikkanen.github.io/token-costs/api/v1/openai.json',
  google:    'https://mikkotikkanen.github.io/token-costs/api/v1/google.json',
};

function isValidPrice(p: LiveModelPrice): boolean {
  return typeof p?.input === 'number' && typeof p?.output === 'number'
    && p.input >= 0 && p.output >= 0;
}

/**
 * Normalize editor-specific model slugs into token-cost API IDs.
 */
export function normalizeModelSlug(rawModel: string | null | undefined): string {
  if (!rawModel) return DEFAULT_MODEL;
  let m = rawModel.trim().toLowerCase();
  if (!m) return DEFAULT_MODEL;

  // Claude Code aliases
  if (m === 'default' || m === 'sonnet') return 'claude-sonnet-4.6';
  if (m === 'opus' || m === 'opusplan') return 'claude-opus-4.6';
  if (m === 'haiku') return 'claude-haiku-4.5';

  // Normalize separators and remove editor effort/thinking suffixes.
  m = m.replace(/[\s_]+/g, '-');
  m = m.replace(/-thinking\b/g, '');
  m = m.replace(/-(high|low|medium)\b/g, '');
  m = m.replace(/-+/g, '-');
  m = m.replace(/^-|-$/g, '');

  // Cursor/Windsurf slug variants like claude-4.6-opus-high-thinking
  m = m
    .replace(/^claude-(\d+(?:\.\d+)?)-opus(?:-.+)?$/, 'claude-opus-$1')
    .replace(/^claude-(\d+(?:\.\d+)?)-sonnet(?:-.+)?$/, 'claude-sonnet-$1')
    .replace(/^claude-(\d+(?:\.\d+)?)-haiku(?:-.+)?$/, 'claude-haiku-$1');

  // Convert dash version suffixes to dot style used in this project.
  m = m
    .replace(/^claude-opus-(\d+)-(\d+)$/, 'claude-opus-$1.$2')
    .replace(/^claude-sonnet-(\d+)-(\d+)$/, 'claude-sonnet-$1.$2')
    .replace(/^claude-haiku-(\d+)-(\d+)$/, 'claude-haiku-$1.$2');

  return m || DEFAULT_MODEL;
}

export function deriveProvider(modelId: string): PricingProvider {
  const model = normalizeModelSlug(modelId);
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  return 'openai';
}

/**
 * Singleton pricing service that fetches live model prices from the
 * token-costs API (daily-updated) and falls back to bundled prices when offline.
 */
class PricingServiceImpl {
  private liveCache = new Map<string, LiveModelPrice>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private _pricingDate: string | null = null;
  private _initError: string | null = null;

  get isInitialized(): boolean { return this.initialized; }
  get pricingDate(): string | null { return this._pricingDate; }
  get initError(): string | null { return this._initError; }
  get isLive(): boolean { return this.liveCache.size > 0; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const providers: PricingProvider[] = ['anthropic', 'openai'];

    for (const provider of providers) {
      try {
        const url = PRICING_ENDPOINTS[provider];
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) continue;

        const data = await response.json() as {
          current?: { date: string; models: Record<string, LiveModelPrice> };
        };
        if (!data?.current?.models) continue;

        if (!this._pricingDate || data.current.date > this._pricingDate) {
          this._pricingDate = data.current.date;
        }

        for (const [modelId, pricing] of Object.entries(data.current.models)) {
          this.liveCache.set(`${provider}:${modelId}`, pricing);
        }
      } catch (e: any) {
        const msg = `Failed to fetch ${provider} pricing: ${e?.message ?? e}`;
        this._initError = this._initError ? `${this._initError}; ${msg}` : msg;
      }
    }

    this.initialized = true;
  }

  getPrice(modelId: string): LiveModelPrice {
    const normalizedModelId = normalizeModelSlug(modelId);
    const provider = deriveProvider(normalizedModelId);

    // 1. Exact match in live cache
    const exact = this.liveCache.get(`${provider}:${normalizedModelId}`);
    if (exact && isValidPrice(exact)) return exact;

    // 2. Cross-provider exact match (in case provider derivation is wrong)
    for (const p of ['anthropic', 'openai', 'google'] as PricingProvider[]) {
      const cross = this.liveCache.get(`${p}:${normalizedModelId}`);
      if (cross && isValidPrice(cross)) return cross;
    }

    // 3. Bundled fallback
    return FALLBACK_PRICING[normalizedModelId] ?? FALLBACK_PRICING[DEFAULT_MODEL];
  }

  calculateCost(inputTokens: number, outputTokens: number, modelId: string = DEFAULT_MODEL): number {
    const price = this.getPrice(modelId);
    // price.input/output are USD per million tokens; we return cents
    const inputCostCents = (inputTokens / 1_000_000) * price.input * 100;
    const outputCostCents = (outputTokens / 1_000_000) * price.output * 100;
    return Math.round((inputCostCents + outputCostCents) * 100) / 100;
  }

  listAvailableModels(): Array<{ provider: PricingProvider; modelId: string; price: LiveModelPrice }> {
    const result: Array<{ provider: PricingProvider; modelId: string; price: LiveModelPrice }> = [];

    if (this.liveCache.size > 0) {
      for (const [key, price] of this.liveCache) {
        const colonIdx = key.indexOf(':');
        const provider = key.slice(0, colonIdx) as PricingProvider;
        const modelId = key.slice(colonIdx + 1);
        result.push({ provider, modelId, price });
      }
    } else {
      for (const [modelId, price] of Object.entries(FALLBACK_PRICING)) {
        result.push({ provider: deriveProvider(modelId), modelId, price });
      }
    }

    return result;
  }
}

// Singleton instance
const pricingService = new PricingServiceImpl();

/**
 * Initialize live pricing by fetching current rates from the token-costs API.
 * Call once on extension activation. Safe to call multiple times (no-op after first).
 * Never throws — falls back to bundled prices on failure.
 */
export async function initializePricing(): Promise<void> {
  return pricingService.initialize();
}

export function getPricingService(): PricingServiceImpl {
  return pricingService;
}

/**
 * Get pricing for a specific model.
 * Uses live pricing if available, otherwise bundled fallback.
 */
export function getModelPricing(modelId: string): ModelPricing {
  const normalizedModelId = normalizeModelSlug(modelId);
  const price = pricingService.getPrice(normalizedModelId);
  return {
    modelId: normalizedModelId,
    displayName: normalizedModelId,
    inputCentsPerMillion: price.input * 100,
    outputCentsPerMillion: price.output * 100,
  };
}

/**
 * Estimate the number of tokens from a character count.
 * Code tends to be more heavily tokenized (~3.5 chars/token) than prose (~4 chars/token).
 */
export function estimateTokensFromChars(charCount: number, isCode: boolean = true): number {
  if (charCount <= 0) return 0;
  const charsPerToken = isCode ? 3.5 : 4;
  return Math.ceil(charCount / charsPerToken);
}

/**
 * Calculate estimated cost in cents for a given token usage.
 * Uses live pricing when available, bundled fallback otherwise.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string = DEFAULT_MODEL
): number {
  return pricingService.calculateCost(inputTokens, outputTokens, normalizeModelSlug(modelId));
}

/**
 * Estimate context size (input tokens) for different interaction types.
 */
export const CONTEXT_ESTIMATES = {
  chat: {
    baseContextTokens: 2000,
    fileContextTokens: 1500,
  },
  completion: {
    contextTokens: 500,
  },
  inlineEdit: {
    instructionTokens: 50,
    contextMultiplier: 1.5,
  },
};
