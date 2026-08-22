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

  // dsh@next shows blocking first-run dialogs on fresh environments:
  // the preview disclaimer ("继续"), API-key onboarding ("稍后配置"),
  // and marketplace notices ("知道了" / "关闭此提示"). Dismiss whichever
  // is present before opening settings.
  for (const name of ["继续", "稍后配置", "知道了", "关闭此提示"]) {
    const dismiss = page.getByRole("button", { name, exact: true });
    if ((await dismiss.count()) > 0) {
      await dismiss.click();
      await expect(dismiss)
        .not.toBeVisible({ timeout: 5_000 })
        .catch(() => {});
    }
  }

  // Some plugins open modal overlays on first launch (doctor / remote / launcher).
  // If one is present, click its mask to dismiss it so it cannot intercept the
  // built-in Settings button below.
  const modalMask = page.locator('[role="presentation"] [aria-hidden="true"]').first();
  if ((await modalMask.count()) > 0) {
    await modalMask.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(250);
  }

  // Open settings; this exercises the core settings UI and mounts every
  // plugin's settings section. These are the sections owned by this profile
  // (our own plugins), not a third-party plugin.
  await page.getByText("设置", { exact: true }).first().click();
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
