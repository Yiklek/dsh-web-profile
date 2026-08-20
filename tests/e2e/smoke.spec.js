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

  // dsh@next shows a blocking first-run onboarding dialog on fresh environments
  // ("添加一个 API Key 开始使用"). Dismiss it when present before opening settings.
  const configureLater = page.getByRole("button", { name: "稍后配置" });
  if ((await configureLater.count()) > 0) {
    await configureLater.click();
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
  await expect(page.getByText("已归档", { exact: true })).toBeVisible();

  // No plugin/client fatal errors should have been emitted.
  const fatal = errors.filter((entry) =>
    BLOCKED_PATTERNS.some((re) => re.test(entry)),
  );
  expect(fatal, `fatal client errors:\n${fatal.join("\n")}`).toEqual([]);
});
