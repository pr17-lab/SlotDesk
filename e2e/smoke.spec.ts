import { expect, test, type Page } from '@playwright/test';

test('staff can sign up, add sample data and book a slot', async ({ page }) => {
  // A new account each run, so the test never depends on old data.
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

  // Sample data opens the new room's schedule.
  await page.getByRole('button', { name: 'Create sample data' }).click();
  await expect(
    page.getByRole('heading', { name: 'Consultation room' }),
  ).toBeVisible();

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

function readColours(page: Page) {
  return page.locator('body, input, button, a').evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return `${element.tagName} ${style.backgroundColor} ${style.borderColor} ${style.boxShadow} ${style.color}`;
    }),
  );
}
