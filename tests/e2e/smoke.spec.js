// @ts-check
const { test, expect } = require("@playwright/test");

const BLOCKED_PATTERNS = [
  /Failed to load plugins/i,
  /missed the module table/i,
  /client-modules:/i,
  /Cannot find package/i,
];

test("web profile loads and settings show plugin sections", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });

  await page.goto("/", { waitUntil: "networkidle", timeout: 60_000 });

  // Core dsh web UI is up.
  await expect(page).toHaveTitle(/DeepSeek Harness/);
  await expect(page.getByText("设置", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // First-run dialogs can appear a beat after the shell settles. Repeatedly
  // dismiss whatever modal is currently present, then try to open settings.
  // If a modal mounts late and blocks the first attempt, the loop sees it on
  // the next iteration and dismisses it before retrying.
  let settingsOpened = false;
  for (let attempt = 0; attempt < 5 && !settingsOpened; attempt++) {
    const modal = page.locator('[role="presentation"]').first();
    if ((await modal.count()) > 0) {
      const mask = modal.locator('[aria-hidden="true"]').first();
      if ((await mask.count()) > 0) {
        await mask.click({ position: { x: 5, y: 5 } }).catch(() => {});
      }
      await page.waitForTimeout(250);
    }

    for (const name of ["继续", "稍后配置", "知道了", "关闭此提示"]) {
      const dismiss = page.getByRole("button", { name, exact: true });
      if ((await dismiss.count()) > 0) {
        await dismiss.click().catch(() => {});
        await expect(dismiss).not.toBeVisible({ timeout: 2_000 }).catch(() => {});
      }
    }

    try {
      await page.getByText("设置", { exact: true }).first().click({
        timeout: 3_000,
      });
      settingsOpened = true;
    } catch {
      // The modal probably mounted just in time; loop and dismiss it again.
    }
  }
  expect(settingsOpened, "settings should open after dismissing first-run dialogs").toBe(true);

  // The built-in Settings UI should now be open with our plugin sections
  // mounted. These are the sections owned by this profile (our own plugins),
  // not a third-party plugin.
  await expect(page.getByText("通用设置", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Anchored 预设", { exact: true })).toBeVisible();
  await expect(page.getByText("API 重试", { exact: true })).toBeVisible();

  // No plugin/client fatal errors should have been emitted.
  const fatal = errors.filter((entry) =>
    BLOCKED_PATTERNS.some((re) => re.test(entry)),
  );
  expect(fatal, `fatal client errors:\n${fatal.join("\n")}`).toEqual([]);
});
