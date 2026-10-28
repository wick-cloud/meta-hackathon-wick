import { expect, test, type Page } from '@playwright/test';

const buyerEmail = process.env.E2E_BUYER_EMAIL ?? process.env.SEED_BUYER_EMAIL;
const buyerPassword = process.env.SEED_BUYER_PASSWORD;
const providerEmail = process.env.E2E_PROVIDER_EMAIL ?? process.env.SEED_SUPPLIER_A_EMAIL;
const providerPassword = process.env.SEED_SUPPLIER_A_PASSWORD;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get('/api/me')).json()).user?.email)
    .toBe(email);
}

test('buyer review preserves explicit budget and unsupported region without granting flexibility', async ({
  page,
}) => {
  test.skip(!buyerEmail || !buyerPassword, 'Requires isolated fixture buyer credentials.');
  await signIn(page, buyerEmail!, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture', 'Offline fixture only.');
  await page.goto('/new');
  await page
    .getByLabel('Describe your environment')
    .fill(
      'I need 999 vCPUs and 17.5 GiB RAM in region: moon-1 for 45 minutes, maximum total $0.05.',
    );
  await expect(page.getByLabel('Your maximum total (USD)')).toHaveValue('0.05');
  await page.getByLabel('Your maximum total (USD)').fill('0.04');
  await page.getByRole('button', { name: 'Review unsupported needs and alternatives' }).click();
  await expect(page).toHaveURL(/\/alternatives\/new$/);
  await expect(page.getByLabel('Requested vCPUs', { exact: true })).toHaveValue('999');
  await expect(page.getByLabel('Requested memory (GiB)')).toHaveValue('17.5');
  await expect(page.getByLabel('Requested region')).toHaveValue('moon-1');
  await expect(page.getByLabel('Requested duration (minutes)')).toHaveValue('45');
  await expect(page.getByLabel('Original maximum total (USD)')).toHaveValue('0.04');
  await expect(page.getByLabel('Allow only the alternatives I specify below')).not.toBeChecked();
});

test('reviewed provider limits and explicit buyer counteroffer acceptance create exactly one fixture rental', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !buyerEmail || !buyerPassword || !providerEmail || !providerPassword,
    'Requires isolated fixture buyer and provider credentials.',
  );
  await signIn(page, buyerEmail!, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(
    me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture',
    'Never allocate real compute or call Meta in browser tests.',
  );
  const providerContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  const providerPage = await providerContext.newPage();
  await signIn(providerPage, providerEmail!, providerPassword!);
  // The preceding browser rental terminates asynchronously. Start this fixture-only
  // scenario after its provider holds are released, rather than snapshotting a transient hold.
  await expect
    .poll(
      async () =>
        (await (await providerPage.request.get('/api/provider/dashboard')).json()).capacity.held,
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(0);
  const original = await (await providerPage.request.get('/api/provider/dashboard')).json();
  const baselineVms = (await (await page.request.get('/api/vms')).json()).items.length;
  let vmId: string | undefined;
  try {
    await providerPage.goto('/provider/policy');
    await providerPage
      .getByLabel('Natural-language selling strategy')
      .fill('Fill idle machines, keep zero slots spare, never quote below $0.05.');
    await providerPage
      .getByRole('button', { name: 'Propose editable limits', exact: true })
      .click();
    await expect(
      providerPage.getByRole('heading', { name: 'Proposed limits · not active' }),
    ).toBeVisible();
    await providerPage.screenshot({
      path: testInfo.outputPath('provider-strategy-review.png'),
      fullPage: true,
    });
    const unchanged = await (await providerPage.request.get('/api/provider/dashboard')).json();
    expect(unchanged.policy).toEqual(original.policy);
    expect(unchanged.policyRevision).toEqual(original.policyRevision);
    await providerPage.getByLabel('Slots to keep spare').fill('0');
    await providerPage.getByLabel('Minimum total price (USD)').fill('0.05');
    await providerPage.getByLabel('Automatic bids and counteroffers', { exact: false }).check();
    await providerPage.getByRole('button', { name: 'Apply reviewed limits', exact: true }).click();
    await expect(providerPage.getByText('Policy saved', { exact: true })).toBeVisible();
    const applied = await (await providerPage.request.get('/api/provider/dashboard')).json();
    expect(applied.policy.reserveSlots).toBe(0);
    expect(applied.policy.minimumPriceCents).toBe(5);
    expect(applied.policy.autoBid).toBe(true);

    const offering = (
      await (await providerPage.request.get('/api/provider/offerings')).json()
    ).items.find(
      (item: { active: boolean; catalogId: string }) =>
        item.active &&
        me.catalog.some(
          (config: { id: string; approved: boolean; gpu?: string }) =>
            config.id === item.catalogId && config.approved && !config.gpu,
        ),
    );
    expect(offering).toBeTruthy();
    const supported = me.catalog.find((item: { id: string }) => item.id === offering.catalogId);
    const description = `Browser counteroffer ${Date.now()}: 999 vCPUs and 999 GiB RAM, region: moon-1, 45 minutes, budget $10.00.`;
    await page.goto('/new');
    await page.getByLabel('Describe your environment').fill(description);
    await page.getByRole('button', { name: 'Review unsupported needs and alternatives' }).click();
    await expect(page.getByLabel('Allow only the alternatives I specify below')).not.toBeChecked();
    await page.getByLabel('Allow only the alternatives I specify below').check();
    await page.getByLabel('Lowest acceptable vCPUs').fill(String(supported.cpu));
    await page.getByLabel('Lowest acceptable memory (GiB)').fill(String(supported.memoryGb));
    await page
      .getByRole('group', { name: 'Allowed supported regions' })
      .getByLabel(supported.region, { exact: true })
      .check();
    await page
      .getByRole('group', { name: 'Allowed rental durations' })
      .getByLabel('30 minutes', { exact: true })
      .check();
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/intents' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save reviewed intent', exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.ok()).toBe(true);
    const intent = await createdResponse.json();
    await expect(page).toHaveURL(new RegExp(`/alternatives/${intent.id}$`));
    // Publishing alone is not standing consent. Pause the shared control and
    // prove buyer-triggered proposal generation cannot use this provider.
    await providerPage.getByLabel('Automatic bids and counteroffers', { exact: false }).uncheck();
    await providerPage.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(providerPage.getByText('Policy saved', { exact: true })).toBeVisible();
    const paused = await page.request.post(`/api/intents/${intent.id}/propose`, { data: {} });
    expect(paused.ok()).toBe(true);
    expect((await paused.json()).offers).toEqual([]);
    expect(
      (await (await providerPage.request.get('/api/provider/dashboard')).json()).capacity.held,
    ).toBe(0);
    await providerPage.getByLabel('Automatic bids and counteroffers', { exact: false }).check();
    await providerPage.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(providerPage.getByText('Policy saved', { exact: true })).toBeVisible();
    const beforeProposals = await (
      await providerPage.request.get('/api/provider/dashboard')
    ).json();
    const proposed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/intents/${intent.id}/propose`,
    );
    await page.getByRole('button', { name: 'Suggest reviewed alternatives', exact: true }).click();
    expect((await proposed).ok()).toBe(true);
    await expect(
      page.getByRole('button', { name: 'Review this exact offer' }).first(),
    ).toBeVisible();
    const detail = await (await page.request.get(`/api/intents/${intent.id}`)).json();
    expect(detail.intent.desired.region).toBe('moon-1');
    expect(detail.intent.desired.cpu).toBe(999);
    expect(detail.intent.desired.durationMinutes).toBe(45);
    expect(detail.offers.length).toBeGreaterThan(0);
    expect((await (await page.request.get('/api/vms')).json()).items.length).toBe(baselineVms);
    expect(
      (await (await providerPage.request.get('/api/provider/dashboard')).json()).capacity.held,
    ).toBe(beforeProposals.capacity.held);
    const providerDecisions = (
      await (await providerPage.request.get('/api/provider/activity')).json()
    ).items;
    const proposedReceipt = providerDecisions.find(
      (item: { kind: string }) => item.kind === 'counteroffer_proposed',
    );
    expect(proposedReceipt.mode).toBe('fixture');
    expect(proposedReceipt.modelCalled).toBe(false);
    expect(proposedReceipt.message).toContain('No slot is held');
    await providerPage.reload();
    const decisions = providerPage
      .locator('section')
      .filter({
        has: providerPage.getByRole('heading', { name: 'Counteroffer decisions', exact: true }),
      });
    await expect(
      decisions
        .getByText('Counteroffer proposed; waiting for explicit buyer acceptance. No slot is held.')
        .first(),
    ).toBeVisible();
    await expect(
      decisions.getByText('Fixture · no model call', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Review this exact offer' }).first().click();
    const finalReview = page.getByRole('region', { name: 'Final counteroffer review' });
    await expect(finalReview.getByRole('cell', { name: 'moon-1', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('buyer-counteroffer-review.png'),
      fullPage: true,
    });
    await expect(
      page.getByRole('button', { name: 'Accept reviewed offer', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('I accept these exact changes, provider and fixed total.').check();
    const accepted = page.waitForResponse((response) =>
      /\/api\/intents\/[^/]+\/offers\/[^/]+\/accept$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole('button', { name: 'Accept reviewed offer', exact: true }).click();
    const acceptedResponse = await accepted;
    expect(acceptedResponse.ok()).toBe(true);
    const acceptance = await acceptedResponse.json();
    vmId = acceptance.vmId;
    const acceptedBody = acceptedResponse.request().postDataJSON();
    const duplicate = await page.request.post(new URL(acceptedResponse.url()).pathname, {
      data: acceptedBody,
    });
    expect(duplicate.ok()).toBe(true);
    expect((await duplicate.json()).vmId).toBe(vmId);
    await expect
      .poll(async () => (await (await page.request.get(`/api/vms/${vmId}`)).json()).status, {
        timeout: 30000,
      })
      .toBe('running');
    await expect(page).toHaveURL(new RegExp(`/vms/${vmId}$`));
    await page.getByRole('button', { name: 'Connect terminal', exact: true }).click();
    await expect(page.locator('.terminal-status')).toHaveText('Connected');
    const invoices = (await (await page.request.get('/api/invoices')).json()).items.filter(
      (invoice: { vmId: string }) => invoice.vmId === vmId,
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].amountCents ?? invoices[0].totalPriceCents ?? invoices[0].totalCents).toBe(
      detail.offers[0].totalPriceCents,
    );
    const resolved = await (await page.request.get(`/api/intents/${intent.id}`)).json();
    expect(resolved.intent.status).toBe('accepted');
    expect(resolved.intent.desired).toEqual(intent.desired);
    expect((await (await page.request.get('/api/vms')).json()).items.length).toBe(baselineVms + 1);
    const acceptedDecisions = (
      await (await providerPage.request.get('/api/provider/activity')).json()
    ).items.filter((item: { kind: string }) => item.kind === 'counteroffer_accepted');
    expect(acceptedDecisions).toHaveLength(1);
    expect(acceptedDecisions[0].mode).toBe('fixture');
    expect(acceptedDecisions[0].modelCalled).toBe(false);
  } finally {
    try {
      if (vmId) {
        await page.request.post(`/api/vms/${vmId}/terminate`);
        await expect
          .poll(async () => (await (await page.request.get(`/api/vms/${vmId}`)).json()).status, {
            timeout: 30000,
          })
          .toBe('terminated');
        await expect
          .poll(
            async () =>
              (await (await providerPage.request.get('/api/provider/dashboard')).json()).capacity
                .held,
          )
          .toBe(original.capacity.held);
      }
    } finally {
      try {
        const current = await (await providerPage.request.get('/api/provider/dashboard')).json();
        const restored = await providerPage.request.put('/api/provider/policy', {
          data: {
            ...original.policy,
            expectedRevision: current.policyRevision,
            operationKey: crypto.randomUUID(),
          },
        });
        expect(restored.ok()).toBe(true);
      } finally {
        await providerContext.close();
      }
    }
  }
});

test('provider reviews a server-priced unmet-demand suggestion before publishing', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !buyerEmail || !buyerPassword || !providerEmail || !providerPassword,
    'Requires isolated fixture buyer and provider credentials.',
  );
  await signIn(page, buyerEmail!, buyerPassword!);
  const me = await (await page.request.get('/api/me')).json();
  test.skip(
    me.modes.wick !== 'fixture' || me.modes.muse !== 'fixture',
    'Offline fixture only; no real compute or Meta calls.',
  );
  const providerContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  const providerPage = await providerContext.newPage();
  await signIn(providerPage, providerEmail!, providerPassword!);
  const dashboard = await (await providerPage.request.get('/api/provider/dashboard')).json();
  const supported = me.catalog.find(
    (item: { id: string; approved: boolean; durationMinutes: number[] }) =>
      item.approved &&
      item.durationMinutes.includes(30) &&
      (!dashboard.policy.allowedCatalogIds || dashboard.policy.allowedCatalogIds.includes(item.id)),
  );
  expect(supported).toBeTruthy();
  const createdIntent = await page.request.post('/api/intents', {
    data: {
      operationKey: crypto.randomUUID(),
      description: `Unmet demand fixture ${Date.now()}`,
      desired: {
        cpu: supported.cpu,
        memoryGb: supported.memoryGb,
        ...(supported.gpu ? { gpu: supported.gpu } : {}),
        region: supported.region,
        durationMinutes: 30,
        maxPriceCents: 0,
      },
    },
  });
  expect(createdIntent.ok()).toBe(true);
  const baselineVms = (await (await page.request.get('/api/vms')).json()).items.length;
  const baselineOfferings = (
    await (await providerPage.request.get('/api/provider/offerings')).json()
  ).items.length;
  let offeringId: string | undefined;
  try {
    await providerPage.goto('/provider/offerings');
    const proposed = providerPage.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/provider/offerings/propose',
    );
    await providerPage.getByRole('button', { name: 'Suggest offerings', exact: true }).click();
    const proposalResponse = await proposed;
    expect(proposalResponse.ok()).toBe(true);
    const result = await proposalResponse.json();
    expect(result.mode).toBe('fixture');
    expect(result.modelCalled).toBe(false);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.proposals[0].durationMinutes).toBe(30);
    expect(result.proposals[0].priceBasis).toBe('server-priced-candidate');
    expect(
      (await (await providerPage.request.get('/api/provider/offerings')).json()).items.length,
    ).toBe(baselineOfferings);
    expect((await (await page.request.get('/api/vms')).json()).items.length).toBe(baselineVms);
    await providerPage
      .getByRole('button', { name: 'Review suggestion', exact: true })
      .first()
      .click();
    await expect(
      providerPage.getByRole('heading', { name: 'Review & publish an offering' }),
    ).toBeVisible();
    const name = `Reviewed demand ${Date.now()}`;
    await providerPage.getByLabel('Offering name').fill(name);
    await expect(providerPage.getByLabel('Fixed rental price (USD)')).toHaveValue(
      String(result.proposals[0].priceCents / 100),
    );
    await providerPage.screenshot({
      path: testInfo.outputPath('provider-unmet-demand-review.png'),
      fullPage: true,
    });
    const published = providerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/provider/offerings' &&
        response.request().method() === 'POST',
    );
    await providerPage.getByRole('button', { name: 'Publish offering', exact: true }).click();
    const publishedResponse = await published;
    expect(publishedResponse.ok()).toBe(true);
    const offering = await publishedResponse.json();
    offeringId = offering.id;
    expect(offering.priceCents).toBe(result.proposals[0].priceCents);
    expect(offering.catalogId).toBe(result.proposals[0].catalogId);
    await expect(providerPage.getByRole('heading', { name, exact: true })).toBeVisible();
    expect((await (await page.request.get('/api/vms')).json()).items.length).toBe(baselineVms);
  } finally {
    if (offeringId)
      expect(
        (
          await providerPage.request.patch(`/api/provider/offerings/${offeringId}`, {
            data: { active: false },
          })
        ).ok(),
      ).toBe(true);
    await providerContext.close();
  }
});
