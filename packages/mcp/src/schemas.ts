import { z } from 'zod';
import type { Operation } from '@wick-cloud/broker-cli/operations';
const text = z.string().min(1).max(4000);
const id = z.string().min(1).max(200);
const cents = z.number().int().min(0).max(100000000);
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
const agreement = z
  .object({
    operationKey: opKey.optional(),
    description: text,
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: id,
    windowStart: z.string().regex(/^\d{2}:\d{2}$/),
    windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    minimumQuantity: z.number().int().min(1).max(20),
    targetQuantity: z.number().int().min(1).max(20),
    requirements,
    region: id,
    maxDiscountRateCentsPerHour: cents,
    maxReservationCents: cents.optional(),
    continuation: z
      .object({
        enabled: z.boolean(),
        until: z.string().regex(/^\d{2}:\d{2}$/),
        maxRateCentsPerHour: cents,
      })
      .strict()
      .optional(),
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
  agreement,
  activation: z.object({ windowId: id, quantity: z.number().int().min(1).max(20) }).strict(),
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
  scheduleActive: z
    .object({ active: z.boolean(), expectedRevision: z.number().int().min(1) })
    .strict(),
  schedule: z
    .object({
      catalogId: id,
      name: z.string().min(1).max(160),
      kind: z.enum(['discount_schedule', 'capacity_window']),
      timeZone: id,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      windowStart: z.string().regex(/^\d{2}:\d{2}$/),
      windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
      availableUntil: z.string().regex(/^\d{2}:\d{2}$/),
      capacityQuantity: z.number().int().min(1).max(20),
      discountRateCentsPerHour: cents,
      normalRateCentsPerHour: cents,
    })
    .strict(),
  translation: z.object({ description: text }).strict(),
  prompt: z.object({ prompt: text }).strict(),
};
export const filtersSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(768).optional(),
    kind: z.enum(['all', 'auction', 'agreement']).optional(),
    status: z.enum(['all', 'active', 'history', 'attention']).optional(),
    created: z.enum(['all', '24h', '7d', '30d']).optional(),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
  })
  .strict();
export function operationSchema(operation: Operation): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  if (operation.path.includes(':id')) shape.id = id;
  if (operation.path.includes(':offerId')) shape.offerId = id;
  if (operation.mutation) shape.operationKey = opKey;
  if (operation.body)
    shape.input =
      operation.command === 'agreements preview'
        ? agreement.extend({ operationKey: opKey })
        : bodySchemas[operation.body]!;
  if (operation.method === 'GET' && !operation.path.includes(':id'))
    shape.filters = filtersSchema.optional();
  return z.object(shape).strict();
}
