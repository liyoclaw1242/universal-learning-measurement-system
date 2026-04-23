// Smoke tests for ULMS shell UI flows. These tests don't spawn real
// claude / gemini processes — they seed the zustand store directly
// via the window.__ulms test hook exposed in main.tsx.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchShell, seed, fakeItem } from './helpers';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const launched = await launchShell();
  app = launched.app;
  win = launched.win;
});

test.afterAll(async () => {
  await app.close();
});

test.describe('chrome', () => {
  test('renders all five regions', async () => {
    await expect(win.locator('.ribbon-strip')).toBeVisible();
    await expect(win.locator('.ribbon-tabs')).toBeVisible();
    await expect(win.locator('.ribbon-body')).toBeVisible();
    await expect(win.locator('.rail')).toBeVisible();
    await expect(win.locator('.center')).toBeVisible();
    await expect(win.locator('.statusbar')).toBeVisible();
  });

  test('ribbon tabs switch active state', async () => {
    await win.locator('.ribbon-tabs .tab', { hasText: 'Inputs' }).click();
    await expect(win.locator('.ribbon-tabs .tab.active')).toHaveText('Inputs');
    await win.locator('.ribbon-tabs .tab', { hasText: 'Home' }).click();
    await expect(win.locator('.ribbon-tabs .tab.active')).toHaveText('Home');
  });

  test('density toggle updates data-density', async () => {
    await win.locator('.density-toggle button', { hasText: 'compact' }).click();
    await expect(win.locator('.shell')).toHaveAttribute('data-density', 'compact');
    await win.locator('.density-toggle button', { hasText: 'standard' }).click();
    await expect(win.locator('.shell')).toHaveAttribute('data-density', 'standard');
    // focus mode hides ribbon-tabs + ribbon-body + rail
    await win.locator('.density-toggle button', { hasText: 'focus' }).click();
    await expect(win.locator('.shell')).toHaveAttribute('data-density', 'focus');
    await expect(win.locator('.ribbon-tabs')).toBeHidden();
    await expect(win.locator('.rail')).toBeHidden();
    // back to standard
    await seed(win, { density: 'standard' });
  });

  test('stage toggle in statusbar cycles inputs → running → review', async () => {
    await seed(win, { stage: 'inputs' });
    await expect(win.locator('.statusbar').first()).toContainText('awaiting inputs');
    const toggle = win.locator('.statusbar .item', { hasText: 'toggle stage' });
    await toggle.click();
    await expect(win.locator('.statusbar').first()).toContainText('running');
    await toggle.click();
    await expect(win.locator('.statusbar').first()).toContainText('ready');
  });
});

test.describe('review stage with seeded items', () => {
  test.beforeAll(async () => {
    // Force review stage + seed two items — one clean accept, one with
    // a disagreement so we exercise the agreement glyph.
    await seed(win, {
      stage: 'review',
      items: [
        fakeItem({ id: 'item_001', stem: '題目 A · 兩邊一致', agreement: 'accept' }),
        fakeItem({
          id: 'item_002',
          stem: '題目 B · 兩邊分歧',
          claude: 'accept',
          gemini: 'reject',
          agreement: 'disagree',
        }),
      ],
    });
  });

  test('rail shows seeded items with agreement count', async () => {
    await expect(win.locator('.rail .item-row')).toHaveCount(2);
    await expect(
      win.locator('.rail-head .count', { hasText: '(2)' }),
    ).toBeVisible();
  });

  test('click rail item opens ItemDetail tab and renders stem', async () => {
    await win.locator('.rail .item-row', { hasText: '題目 A' }).click();
    await expect(win.locator('.center .tabbar .tab.active')).toContainText('item_001');
    await expect(win.locator('.item-detail .stem')).toContainText('題目 A');
  });

  test('flag action updates store state + rail override indicator', async () => {
    // Click flag on the currently-open item
    await win.locator('.item-actions button', { hasText: 'flag' }).click();

    // Verify store — authoritative source of truth
    const snap = await win.evaluate(() => {
      type Store = {
        getState: () => {
          items: Array<{ id: string; user: string | null }>;
          stage: string;
          activeCenterTab: string;
        };
      };
      const store = (window as unknown as { __ulms: { store: Store } }).__ulms.store;
      const s = store.getState();
      return {
        itemCount: s.items.length,
        ids: s.items.map((i) => i.id),
        user001: s.items.find((i) => i.id === 'item_001')?.user ?? null,
        stage: s.stage,
        activeTab: s.activeCenterTab,
      };
    });
    expect(snap.user001).toBe('flag');
    expect(snap.itemCount).toBe(2);

    // Verify rail reflects state. When item.user is 'flag', NavRail
    // sets aria-label="flag" on the .override span.
    const rowOne = win.locator('.rail .item-row', { hasText: '題目 A' });
    await expect(rowOne).toBeVisible();
    const overrideAria = await rowOne.locator('.override').getAttribute('aria-label');
    expect(overrideAria).toBe('flag');
  });

  test('close ItemDetail tab returns to Overview', async () => {
    // Hover to show close button, click it
    const itemTab = win.locator('.center .tabbar .tab', { hasText: 'item_001' });
    await itemTab.hover();
    await itemTab.locator('.close').click();
    await expect(win.locator('.center .tabbar .tab.active')).toHaveText('Overview');
  });
});

test.describe('regenerate visibility cue', () => {
  test('re-run rejected button appears when items are rejected', async () => {
    await seed(win, {
      stage: 'review',
      items: [
        fakeItem({ id: 'item_x', user: 'reject' }),
        fakeItem({ id: 'item_y', user: null }),
      ],
    });
    await expect(
      win.locator('.ribbon-strip .btn', { hasText: /Re-run rejected/ }),
    ).toBeVisible();
  });

  test('re-run rejected button hides when no items are rejected', async () => {
    await seed(win, {
      stage: 'review',
      items: [fakeItem({ id: 'item_z', user: 'ship' })],
    });
    await expect(
      win.locator('.ribbon-strip .btn', { hasText: /Re-run rejected/ }),
    ).toHaveCount(0);
  });
});
