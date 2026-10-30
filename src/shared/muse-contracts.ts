import { usdToCents } from './money.js';
import type { Requirements } from './types.js';

// Bare "in ..." and "... region" are ambiguous prose. Recognize locations,
// while explicitly named region values may remain unsupported catalog choices.
const REGIONAL_WORDS = new Set(
  'us usa eu uk ca au asia europe africa australia america americas antarctica canada japan india china singapore tokyo osaka london paris frankfurt amsterdam dublin sydney melbourne mumbai delhi seoul hongkong taipei zurich stockholm helsinki warsaw madrid milan montreal toronto oregon ohio virginia california texas'.split(
    ' ',
  ),
);
const REGION_PROSE = new Set(
  'and or is of with fine ok okay acceptable preference preferences'.split(' '),
);
function recognizableRegion(candidate: string): boolean {
  return (
    REGIONAL_WORDS.has(candidate) ||
    (/[\w][-_][\w]/.test(candidate) &&
      /(?:^|[-_])(?:us|eu|uk|ca|au|ap|asia|europe|north|south|east|west|central|northeast|northwest|southeast|southwest)(?:$|[-_])/.test(
        candidate,
      ))
  );
}
function explicitRegion(description: string): string | undefined {
  // Keep the first named region; delimited values also preserve unknown names.
  for (const match of description.matchAll(
    /\bregion(?:\s*([:=])\s*|\s+(?:(?:is|of)\s+)?)([a-z][a-z0-9_-]{0,119})\b/gi,
  )) {
    const candidate = match[2]!.toLowerCase();
    if (match[1] || !REGION_PROSE.has(candidate)) return candidate;
  }
  // "Any US region" still constrains location to US; "any region is fine"
  // does not name a region. Do not turn either sentence's prose into a value.
  for (const pattern of [
    /\b([a-z][a-z0-9_-]{0,119})\s+region\b/gi,
    /\bin\s+([a-z][a-z0-9_-]{0,119})\b/gi,
  ]) {
    for (const match of description.matchAll(pattern)) {
      const candidate = match[1]!.toLowerCase();
      if (recognizableRegion(candidate)) return candidate;
    }
  }
  return undefined;
}

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
  // Multiple stated limits never silently broaden a smaller explicit budget.
  const money = [
    ...description.matchAll(/\$\s*(\d{1,6})(?:\.(\d{1,4})(?!\d))?(?![\d.])\b/g),
    ...description.matchAll(
      /\b(?:budget|max(?:imum)?(?:\s+total)?|under|up to)\s*(?:of|is|:|=)?\s*(\d{1,6})(?:\.(\d{1,4})(?!\d))?\s*(?:usd|dollars?)\b/gi,
    ),
  ]
    .map((value) => usdToCents(`${value[1]}.${value[2] ?? ''}`))
    .filter((value): value is number => value !== undefined);
  const region = explicitRegion(description);
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
    ...(money.length ? { maxPriceCents: Math.min(...money) } : {}),
    ...(region ? { region } : {}),
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
