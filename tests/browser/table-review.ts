import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
export * from '@playwright/test';

export async function reviewTables(page: Page, info: TestInfo) {
  if (process.env.TABLE_REVIEW !== '1' || page.isClosed()) return;
  if (!['localhost', '127.0.0.1'].includes(new URL(page.url()).hostname)) return;
  if (await page.getByRole('dialog').count()) return;
  await page.evaluate(() => document.fonts.ready);
  for (const detail of await page.locator('details').all()) {
    if (
      (await detail.locator('table').count()) &&
      !(await detail.evaluate((el) => el.hasAttribute('open')))
    ) {
      const summary = detail.locator('summary').first();
      if (await summary.isVisible()) await summary.click();
    }
  }
  const tables = page.locator('.data-table-frame');
  const layouts = [];
  for (let i = 0; i < (await tables.count()); i++) {
    const frame = tables.nth(i);
    if (!(await frame.isVisible())) continue;
    const layout = await frame.evaluate((el) => {
      const table = el.querySelector('table')!;
      const scroll = el.querySelector<HTMLElement>('.data-table-scroll')!;
      return {
        label: scroll.getAttribute('aria-label')!,
        columns: table.querySelectorAll('thead th').length,
        unscopedHeaders: table.querySelectorAll('thead th:not([scope="col"])').length,
        named: !!table.querySelector('caption') || !!table.getAttribute('aria-label'),
        keyboardReachable: scroll.tabIndex === 0,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        horizontalOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
        clippedNumbers: [
          ...table.querySelectorAll<HTMLElement>('td.numeric-cell, td.money-cell, td.money-column'),
        ].filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
      };
    });
    expect(layout.named, `${layout.label}: table has an accessible name`).toBe(true);
    expect(layout.keyboardReachable, `${layout.label}: keyboard scrolling`).toBe(true);
    expect(layout.unscopedHeaders, `${layout.label}: column semantics`).toBe(0);
    expect(layout.pageOverflow, `${layout.label}: page overflow`).toBeLessThanOrEqual(1);
    expect(layout.clippedNumbers, `${layout.label}: hidden numerical content`).toBe(0);
    await expect(frame, `${layout.label}: valid timestamps`).not.toContainText('Invalid Date');
    const name = layout.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const viewport = frame.locator('.data-table-scroll');
    const left = await viewport.evaluate((el) => el.scrollLeft);
    await viewport.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await frame.screenshot({ path: info.outputPath(`${name}.png`) });
    if (layout.horizontalOverflow) {
      await viewport.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await frame.screenshot({ path: info.outputPath(`${name}-right.png`) });
    }
    await viewport.evaluate((el, x) => {
      el.scrollLeft = x;
    }, left);
    layouts.push(layout);
  }
  if (layouts.length)
    await info.attach('table-layout-audit', {
      body: JSON.stringify(layouts),
      contentType: 'application/json',
    });
}

/** Opt-in visual audit of actual fixture pages, without account/key dialogs. */
export const test = base.extend<{ tableReview: void }>({
  tableReview: [
    async ({ page }, use, info) => {
      await use();
      await reviewTables(page, info);
    },
    { auto: true },
  ],
});
