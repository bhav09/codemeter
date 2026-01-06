import { ModelPricing } from './types';

/**
 * Current AI model pricing (as of Jan 2025).
 * Prices are in cents per 1 million tokens.
 * 
 * Sources:
 * - OpenAI: https://openai.com/pricing
 * - Anthropic: https://www.anthropic.com/pricing
 * 
 * Cursor uses a mix of models and has its own pricing/markup.
 * These are approximate wholesale prices for estimation.
 */
export const MODEL_PRICING: ModelPricing[] = [
  // Claude models (commonly used by Cursor)
  {
    modelId: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    inputCentsPerMillion: 300,   // $3/M input
    outputCentsPerMillion: 1500, // $15/M output
  },
  {
    modelId: 'claude-3-opus',
    displayName: 'Claude 3 Opus',
    inputCentsPerMillion: 1500,  // $15/M input
    outputCentsPerMillion: 7500, // $75/M output
  },
  {
    modelId: 'claude-3-haiku',
    displayName: 'Claude 3 Haiku',
    inputCentsPerMillion: 25,    // $0.25/M input
    outputCentsPerMillion: 125,  // $1.25/M output
  },
  // GPT models
  {
    modelId: 'gpt-4-turbo',
    displayName: 'GPT-4 Turbo',
    inputCentsPerMillion: 1000,  // $10/M input
    outputCentsPerMillion: 3000, // $30/M output
  },
  {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    inputCentsPerMillion: 250,   // $2.50/M input
    outputCentsPerMillion: 1000, // $10/M output
  },
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    inputCentsPerMillion: 15,    // $0.15/M input
    outputCentsPerMillion: 60,   // $0.60/M output
  },
  {
    modelId: 'gpt-3.5-turbo',
    displayName: 'GPT-3.5 Turbo',
    inputCentsPerMillion: 50,    // $0.50/M input
    outputCentsPerMillion: 150,  // $1.50/M output
  },
];

/**
 * Default model to use for cost estimation when we can't detect which model is used.
 * Claude 3.5 Sonnet is Cursor's primary model as of 2024-2025.
 */
export const DEFAULT_MODEL = 'claude-3-5-sonnet';

/**
 * Get pricing for a specific model, or default if not found.
 */
export function getModelPricing(modelId: string): ModelPricing {
  const pricing = MODEL_PRICING.find(
    m => m.modelId === modelId || m.displayName.toLowerCase().includes(modelId.toLowerCase())
  );
  return pricing ?? MODEL_PRICING.find(m => m.modelId === DEFAULT_MODEL)!;
}

/**
 * Estimate the number of tokens from a character count.
 * Rule of thumb: ~4 characters per token for English text.
 * Code tends to be slightly more tokenized (~3-3.5 chars/token).
 */
export function estimateTokensFromChars(charCount: number, isCode: boolean = true): number {
  const charsPerToken = isCode ? 3.5 : 4;
  return Math.ceil(charCount / charsPerToken);
}

/**
 * Calculate estimated cost in cents for a given token usage.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelId: string = DEFAULT_MODEL
): number {
  const pricing = getModelPricing(modelId);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputCentsPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCentsPerMillion;
  return Math.round((inputCost + outputCost) * 100) / 100; // Round to 2 decimal places
}

/**
 * Estimate context size (input tokens) for different interaction types.
 * These are rough averages based on typical usage patterns.
 */
export const CONTEXT_ESTIMATES = {
  /** Chat typically sends conversation history + current file context */
  chat: {
    baseContextTokens: 2000,  // Conversation history
    fileContextTokens: 1500,  // Current file/selection
  },
  /** Completions send surrounding code context */
  completion: {
    contextTokens: 500,  // Lines before/after cursor
  },
  /** Inline edits send selection + instruction */
  inlineEdit: {
    instructionTokens: 50,   // User's edit instruction
    contextMultiplier: 1.5,  // Selection + surrounding context
  },
};

