import type { Requirements } from './types.js';

/** Explicit facts only. This parser never grants flexibility or substitutes supported values. */
export function parseExplicitBuyerDescription(description: string): {
  requirements: Partial<Requirements>;
  durationMinutes?: number;
  maxPriceCents?: number;
  region?: string;
} {
  const cpu = description.match(/\b(\d{1,4})\s*(?:v?cpus?|cores?)\b/i);
  const memory = description.match(
    /\b(\d{1,5}(?:\.\d+)?)\s*(?:gb|gib)\s*(?:of\s+)?(?:ram|memory)?\b/i,
  );
  const gpu = description.match(/\b(?:nvidia\s+)?(a100|h100|a10g?|t4|l4|v100|rtx\s*\d{4})\b/i);
  const minutes = description.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i);
  const hours = description.match(/\b(\d+)\s*(?:hours?|hrs?)\b/i);
  const money =
    description.match(/\$\s*(\d{1,6})(?:\.(\d{1,2})(?!\d))?\b/) ??
    description.match(
      /\b(?:budget|max(?:imum)?(?:\s+total)?|under|up to)\s*(?:of|:|=)?\s*(\d{1,6})(?:\.(\d{1,2})(?!\d))?\s*(?:usd|dollars?)\b/i,
    );
  const region =
    description.match(/\bregion\s*(?:[:=]|is|of)?\s*([a-z][a-z0-9_-]{0,119})\b/i) ??
    description.match(/\bin\s+([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+|us|eu|auto)\b/i);
  return {
    requirements: {
      ...(cpu ? { cpu: Number(cpu[1]) } : {}),
      ...(memory ? { memoryGb: Number(memory[1]) } : {}),
      ...(gpu
        ? { gpu: gpu[1]!.toUpperCase() }
        : /\b(?:gpu|cuda)\b/i.test(description) &&
            !/\b(?:no|without)\s+(?:a\s+)?gpu\b/i.test(description)
          ? { gpu: 'any' }
          : {}),
    },
    ...(minutes
      ? { durationMinutes: Number(minutes[1]) }
      : hours
        ? { durationMinutes: Number(hours[1]) * 60 }
        : /\b(?:an?|one)\s+hour\b/i.test(description)
          ? { durationMinutes: 60 }
          : {}),
    ...(money
      ? { maxPriceCents: Number(money[1]) * 100 + Number((money[2] ?? '').padEnd(2, '0')) }
      : {}),
    ...(region ? { region: region[1]!.toLowerCase() } : {}),
  };
}

export interface MusePricedCandidate {
  id: string;
  catalogId: string;
  region: string;
  durationMinutes: number;
  requirements: Requirements;
  totalPriceCents: number;
}
