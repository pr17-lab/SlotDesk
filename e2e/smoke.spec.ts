import { expect, test, type Page } from '@playwright/test';

test('staff can sign up, add sample data and book a slot', async ({ page }) => {
  await signUpWithOrganization(page);
  await createSampleData(page);

  // The first free slot shown, so the test works on any day and at any hour.
  await page
    .getByRole('button', { name: /^Book \d/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Customer name').fill('Asha Rao');
  await dialog.getByLabel('Customer email').fill('asha@example.com');
  await dialog.getByRole('button', { name: 'Book', exact: true }).click();

  await expect(page.getByText('Booking confirmed')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Cancel booking for Asha Rao/ }),
  ).toBeVisible();
});

// Uses Cloudflare's test keys (set in CI), so the real widget always passes.
test('a customer can book online, cancel with the link, and staff see it', async ({
  page,
  browser,
}) => {
  await signUpWithOrganization(page);
  const link = `smoke-${Date.now()}`;
  await page.getByLabel('Link name').fill(link);
  await page.getByRole('button', { name: 'Turn on online booking' }).click();
  await expect(page.getByText('Online booking is on')).toBeVisible();
  await createSampleData(page);

  // A customer, signed out, in a separate browser window.
  const customer = await browser.newContext();
  const shop = await customer.newPage();
  await shop.goto(`/book/${link}`);
  await expect(
    shop.getByRole('heading', { name: 'Smoke Clinic' }),
  ).toBeVisible();
  // A week ahead, so the booking is more than 24 hours away and gets a
  // cancel link.
  await shop.getByRole('link', { name: 'Next 7 days' }).click();
  await shop
    .getByRole('button', { name: /^Book \d/ })
    .first()
    .click();
  const dialog = shop.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Pat Lee');
  await dialog.getByLabel('Your email').fill('pat@example.com');

  // The widget takes a moment to pass. Until it does, the page only says
  // "Please complete the check first" and sends nothing, so click again.
  const booked = shop.getByRole('heading', { name: "You're booked" });
  await expect(async () => {
    if (await booked.isVisible()) return;
    await dialog
      .getByRole('button', { name: 'Book', exact: true })
      .click({ timeout: 1000 });
    await expect(booked).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });

  // The link works in a real browser: the secret after # reaches the page.
  const cancelLink = await shop.getByLabel('Your cancel link').inputValue();
  const manage = await customer.newPage();
  await manage.goto(cancelLink);
  await manage.getByRole('button', { name: 'Cancel booking' }).click();
  await manage
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel booking' })
    .click();
  await expect(
    manage.getByText('Booking cancelled. The time is free again.'),
  ).toBeVisible();
  await customer.close();

  // Staff see the booking, made online and now cancelled.
  await page.reload();
  await page.getByRole('link', { name: 'Next 7 days' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'pat@example.com' });
  await expect(row.getByText('Online', { exact: true })).toBeVisible();
  await expect(row.getByText('Cancelled', { exact: true })).toBeVisible();
});

// The page has no dark theme, so a device in dark mode must see the same
// colours. This would have caught the bug fixed in PR #47.
test('dark mode looks the same as light mode', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.emulateMedia({ colorScheme: 'light' });
  const light = await readColours(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await readColours(page);

  expect(light.length).toBeGreaterThan(0);
  expect(dark).toEqual(light);
});

// A new account each run, so the test never depends on old data. Ends on the
// new organization's page.
async function signUpWithOrganization(page: Page) {
  const email = `smoke-${Date.now()}@example.com`;

  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Smoke Test');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a long smoke test password');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Sign-up has a Name field too, so wait for the home page before typing.
  await expect(
    page.getByRole('heading', { name: 'Your organizations' }),
  ).toBeVisible();
  await page.getByLabel('Name').fill('Smoke Clinic');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(
    page.getByRole('heading', { name: 'Smoke Clinic' }),
  ).toBeVisible();
}

// Sample data opens the new room's schedule.
async function createSampleData(page: Page) {
  await page.getByRole('button', { name: 'Create sample data' }).click();
  await expect(
    page.getByRole('heading', { name: 'Consultation room' }),
  ).toBeVisible();
}

function readColours(page: Page) {
  return page.locator('body, input, button, a').evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return `${element.tagName} ${style.backgroundColor} ${style.borderColor} ${style.boxShadow} ${style.color}`;
    }),
  );
}
