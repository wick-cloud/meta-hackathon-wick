import { z } from 'zod';
import type { Operation } from '@wick-cloud/broker-cli/operations';
const text = z.string().min(1).max(4000);
const id = z.string().min(1).max(200);
const cents = z
  .number()
  .multipleOf(0.01)
  .min(0)
  .max(100000000)
  .describe('USD cents, allowing hundredths of a cent ($0.0001).');
const opKey = z
  .string()
  .regex(/^[-A-Za-z0-9_:./]{8,160}$/)
  .describe('Stable operation key. Reuse this key and identical input after an uncertain result.');
const requirements = z
  .object({
    cpu: z.number().int().min(1).max(1024),
    memoryGb: z.number().positive().max(16384),
    gpu: z.string().max(120).optional(),
  })
  .strict();
const desired = z
  .object({
    cpu: z.number().int().min(1).max(1024),
    memoryGb: z.number().positive().max(16384),
    gpu: z.string().max(120).optional(),
    region: id,
    durationMinutes: z.number().int().min(1).max(100000),
    maxPriceCents: cents,
  })
  .strict();
export const bodySchemas: Record<string, z.ZodType> = {
  tokenQuote: z
    .object({
      grantId: id.optional(),
      modelId: z.literal('meta/muse-spark-open').optional(),
      inputTokens: z.number().int().positive().max(10_000_000),
      outputTokens: z.number().int().positive().max(1_000_000),
    })
    .strict(),
  tokenOrder: z
    .object({
      grantId: id.optional(),
      modelId: z.literal('meta/muse-spark-open').optional(),
      inputTokens: z.number().int().positive().max(10_000_000),
      outputTokens: z.number().int().positive().max(1_000_000),
      mode: z.enum(['auction', 'instant']),
      maxTotalCents: cents.min(0.01),
      quoteId: z.string().min(1).max(4000).optional(),
    })
    .strict(),
  inferenceCompletion: z
    .object({
      model: z.literal('meta/muse-spark-open'),
      messages: z
        .array(
          z
            .object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string().max(60000),
            })
            .strict(),
        )
        .min(1)
        .max(64),
      max_tokens: z.number().int().positive().max(8192),
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      stream: z.literal(false).optional(),
    })
    .strict(),
  tokenOffering: z
    .object({
      expectedRevision: z.number().int().positive().max(2_000_000_000),
      active: z.boolean(),
      autoBid: z.boolean(),
      inputRateMicrosPerMillion: z.number().int().min(100).multipleOf(100).max(1_000_000_000_000),
      outputRateMicrosPerMillion: z.number().int().min(100).multipleOf(100).max(1_000_000_000_000),
      instantMarkupBps: z.number().int().nonnegative().max(100_000),
      minimumPriceCents: cents.min(0.01),
      maxOutstandingInputTokens: z.number().int().positive().max(100_000_000),
      maxOutstandingOutputTokens: z.number().int().positive().max(10_000_000),
    })
    .strict(),
  order: z
    .object({
      description: text,
      catalogId: id,
      region: id,
      matchAcrossProviders: z.boolean().optional(),
      durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
      maxPriceCents: cents,
      requirements,
    })
    .strict(),
  intent: z
    .object({
      description: text,
      desired,
      flexible: z.boolean(),
      sourceRequestId: id.optional(),
      flexibility: z
        .object({
          minCPU: z.number().int().min(1).max(1024),
          minMemoryGb: z.number().positive().max(16384),
          allowedRegions: z.array(id).max(64),
          allowedDurations: z.array(z.number().int()).max(3),
          hardMaxPriceCents: cents,
          gpu: z.enum(['preserve', 'none', 'any']),
        })
        .strict(),
    })
    .strict(),
  capacity: z
    .object({
      total: z.number().int().min(0).max(10000),
      expectedRevision: z.number().int().min(1),
    })
    .strict(),
  bid: z.object({ totalPriceCents: cents, offeringId: id.optional() }).strict(),
  strategy: z.object({ strategy: text }).strict(),
  policy: z
    .object({
      expectedRevision: z.number().int().min(1),
      autoBid: z.boolean(),
      minimumPriceCents: cents,
      basePriceCents: cents,
      maxPriceCents: cents.optional(),
      reserveSlots: z.number().int().min(0).max(10000).optional(),
      allowedCatalogIds: z.array(id).max(100).optional(),
    })
    .strict(),
  offering: z
    .object({
      catalogId: id,
      name: z.string().min(1).max(160),
      description: z.string().min(1).max(2000),
      priceCents: cents,
      durationMinutes: z.literal(30).optional(),
      priceBasis: z.literal('server-priced-candidate').optional(),
    })
    .strict(),
  active: z.object({ active: z.boolean() }).strict(),
  translation: z.object({ description: text }).strict(),
  prompt: z.object({ prompt: text }).strict(),
};
export const filtersSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(768).optional(),
    kind: z.enum(['all', 'auction', 'token']).optional(),
    status: z.enum(['all', 'active', 'history', 'attention']).optional(),
    created: z.enum(['all', '24h', '7d', '30d']).optional(),
  })
  .strict();
export function operationSchema(operation: Operation): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  if (operation.path.includes(':id')) shape.id = id;
  if (operation.path.includes(':offerId')) shape.offerId = id;
  if (operation.mutation) shape.operationKey = opKey;
  if (operation.body) shape.input = bodySchemas[operation.body]!;
  if (operation.method === 'GET' && !operation.path.includes(':id'))
    shape.filters = filtersSchema.optional();
  return z.object(shape).strict();
}
