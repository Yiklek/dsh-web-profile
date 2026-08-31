// @ts-check
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

const BLOCKED_PATTERNS = [
  /Failed to load plugins/i,
  /missed the module table/i,
  /client-modules:/i,
  /Cannot find package/i,
];

/**
 * Resolve the dsh connection URL to establish the browser session before the
 * test navigates. dsh boot prints a token-bearing root URL
 * (`http://host:port/?token=...`) and only serves the app once the browser has
 * exchanged that token for an authority-bound cookie. The URL comes from
 * `DSH_TOKEN_URL` when the caller knows it directly; otherwise it is parsed
 * from the dsh boot log (`DSH_BOOT_LOG`, defaulting to the path the CI writes).
 * Returns `undefined` when no token URL is available, in which case the test
 * navigates straight to "/" (deployments that disable the root gate).
 */
function tokenUrl() {
  if (process.env.DSH_TOKEN_URL && process.env.DSH_TOKEN_URL.trim() !== "") {
    return process.env.DSH_TOKEN_URL.trim();
  }
  const logPath = process.env.DSH_BOOT_LOG || "/tmp/dsh-e2e.log";
  let log;
  try {
    log = fs.readFileSync(logPath, "utf8");
  } catch {
    return undefined;
  }
  const match = log.match(/https?:\/\/[^\s]+[?&]token=[A-Za-z0-9_-]+/);
  return match ? match[0] : undefined;
}

test("web profile loads and settings show plugin sections", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });

  // Establish the session from the printed connection URL if one is available;
  // the token exchange redirects to the clean root and sets the auth cookie.
  const url = tokenUrl();
  if (url !== undefined) {
    await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
  }

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
