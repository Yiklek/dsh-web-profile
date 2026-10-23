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

  // Fail with the real boot symptom before looking for shell controls. Without
  // this check, a plugin activation failure is misreported as a missing
  // Settings button.
  await expect(page).toHaveTitle(/DeepSeek Harness/);
  await expect(
    page.getByText("Failed to load plugins", { exact: true }),
  ).toHaveCount(0);
  // The shell is up if a sidebar row renders. Assert one that exists in both UI
  // languages, not a specific control: this check is about "the shell booted",
  // and pinning it to a label makes it fail when a sidebar plugin renames or
  // moves things (which is what happened to the Settings entry).
  await expect(page.getByText(/^(插件|Plugins)$/).first()).toBeVisible({
    timeout: 30_000,
  });

  // First-run dialogs can appear a beat after the shell settles. Repeatedly
  // dismiss whatever modal is currently present, then try to open settings.
  // If a modal mounts late and blocks the first attempt, the loop sees it on
  // the next iteration and dismisses it before retrying.
  let settingsOpened = false;
  let lastScreen = "";
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

    // Not every dialog names its button one of the above — a plugin's own
    // onboarding can say anything. Escape closes the focused dialog whatever it
    // is, so try that too rather than teaching this list every label.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);

    // A sidebar plugin may fold Settings into an overflow ("更多" / "More")
    // menu; open it when it is there. Without this the entry is simply absent
    // from the DOM and the click below can never succeed.
    const more = page.getByText(/^(更多|More)$/, { exact: false }).first();
    if ((await more.count()) > 0 && (await more.isVisible().catch(() => false))) {
      await more.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(300);
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
  if (!settingsOpened) {
    lastScreen = await page.evaluate(() => document.body.innerText).catch(() => "");
  }
  expect(
    settingsOpened,
    "settings should open after dismissing first-run dialogs. Screen was:\n" +
      lastScreen.split("\n").filter(Boolean).slice(0, 40).join("\n"),
  ).toBe(true);

  // The built-in Settings UI should now be open with our plugin sections
  // mounted. These are the sections owned by this profile (our own plugins),
  // not a third-party plugin.
  await expect(page.getByText("通用设置", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  // "Anchored 预设" is deliberately not asserted: that Settings section was
  // owned by the dsh-anchored-standard plugin, which this profile no longer
  // loads.
  await expect(page.getByText("API 重试", { exact: true })).toBeVisible();

  // No plugin/client fatal errors should have been emitted.
  const fatal = errors.filter((entry) =>
    BLOCKED_PATTERNS.some((re) => re.test(entry)),
  );
  expect(fatal, `fatal client errors:\n${fatal.join("\n")}`).toEqual([]);
});
