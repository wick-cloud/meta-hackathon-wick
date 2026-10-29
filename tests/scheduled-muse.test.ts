import { describe, expect, it, vi } from 'vitest';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { scheduledDraft } from '../src/server/integrations/scheduled-muse.js';
import type { CatalogItem } from '../src/shared/types.js';

const catalog: CatalogItem[] = [
  {
    id: 'approved-small',
    name: 'Small',
    description: 'Approved test configuration',
    provider: 'simulated-demo',
    profile: 'small',
    region: 'us-east',
    cpu: 2,
    memoryGb: 4,
    durationMinutes: [15, 30, 60],
    approved: true,
    organizationId: 'org-private',
    groupId: 'group-private',
  },
];
const value = {
  timeZone: 'Asia/Singapore',
  windowStart: '00:00',
  windowEnd: '06:00',
  minimumQuantity: 12,
  targetQuantity: 20,
  maxDiscountRateCentsPerHour: 10,
  continuationEnabled: true,
  continuationUntil: '08:00',
  maxNormalRateCentsPerHour: 20,
};
describe('scheduled Muse drafts', () => {
  it('projects only editable schedule fields and explicit continuation consent', () => {
    expect(
      scheduledDraft(
        value,
        'agreement',
        catalog,
        '20 VMs, minimum 12, with normal-rate continuation',
      ),
    ).toEqual({
      timeZone: 'Asia/Singapore',
      windowStart: '00:00',
      windowEnd: '06:00',
      minimumQuantity: 12,
      targetQuantity: 20,
      maxDiscountRateCentsPerHour: 10,
      continuation: { enabled: true, until: '08:00', maxRateCentsPerHour: 20 },
    });
    expect(() => scheduledDraft(value, 'agreement', catalog, '20 VMs at night')).toThrow(
      'Continuation',
    );
    for (const invalid of [
      { creditCents: 999999 },
      { operationKey: 'model-authority' },
      { catalogId: 'unapproved' },
      { targetQuantity: 21 },
      { timeZone: 'Fake/Zone' },
      { windowEnd: '25:00' },
    ])
      expect(() => scheduledDraft(invalid, 'agreement', catalog, 'draft')).toThrow();
  });
  it('makes one bounded real structured call, redacts credentials and returns a nonbinding reviewed draft', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format.json_schema.name).toBe('wick_scheduled_draft');
      expect(body.model).toBe('meta-models/muse-spark-open-1026');
      expect(body.max_tokens).toBe(8192);
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(String(init?.body)).not.toContain('org-private');
      expect(String(init?.body)).not.toContain('group-private');
      expect(String(init?.body)).not.toContain('pasted-password');
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify(value),
                reasoning_content: 'private-schedule-reasoning',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const muse = createMuseAdapter(
      {
        museMode: 'real',
        metaApiKey: 'fake-test-key',
        metaApiBase: 'https://meta.example.invalid/v1',
      },
      { fetch: fetcher as typeof fetch },
    );
    const result = await muse.draftSchedule!({
      kind: 'agreement',
      description: '20 VMs with normal-rate continuation. password=pasted-password',
      catalog,
    });
    expect(result).toMatchObject({
      mode: 'real',
      modelCalled: true,
      draft: { minimumQuantity: 12, targetQuantity: 20 },
    });
    expect(result.explanation).toContain('No capacity or credit was reserved');
    expect(JSON.stringify(result)).not.toContain('private-schedule-reasoning');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports fixture mode without invoking the network', async () => {
    const fetcher = vi.fn();
    const muse = createMuseAdapter({ museMode: 'fixture' }, { fetch: fetcher });
    expect(
      await muse.draftSchedule!({ kind: 'offering', description: 'Schedule a discount', catalog }),
    ).toMatchObject({ mode: 'fixture', modelCalled: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
