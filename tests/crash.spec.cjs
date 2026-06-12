/**
 * Crash recovery through the real UI: the server is SIGKILLed mid-question
 * while a browser player has an answer locked; the page must auto-reconnect
 * and land exactly where the game is, answer intact.
 * Best watched headed: npx playwright test crash --headed
 */
const { test, expect } = require("@playwright/test");
const { execSync, spawn } = require("node:child_process");
const path = require("node:path");
const { phaseTitle, joinAsPlayer, waitForQuestion } = require("./helpers.cjs");

test("server SIGKILL mid-question: browser auto-recovers in place", async ({ browser }) => {
  const p = await joinAsPlayer(browser, "CrashUI");

  // Land on a FRESH question so there's time to crash & recover inside it.
  const target = (await waitForQuestion(p.page)) + 1;
  await expect(phaseTitle(p.page)).toContainText(`Question #${target}`, { timeout: 60_000 });

  await p.page.locator(".option").nth(2).click();
  await expect(p.page.locator(".option.picked")).toHaveCount(1);

  // ---- kill the server (only the listener — not our own connections)
  execSync("kill -9 $(lsof -ti:3000 -sTCP:LISTEN)");
  await expect(p.page.locator("#conn")).toHaveText("offline", { timeout: 10_000 });

  // ---- restart it
  spawn("npm", ["run", "start:test"], {
    cwd: path.join(__dirname, ".."),
    detached: true,
    stdio: "ignore",
  }).unref();

  // The page reconnects and re-joins by itself…
  await expect(p.page.locator("#conn")).toHaveText("online", { timeout: 30_000 });
  // …landing in the SAME round (or its result, if the boundary passed
  // during the restart) — never on the waiting screen.
  await expect(phaseTitle(p.page)).toContainText(
    new RegExp(`Question #${target}\\b|Correct|Wrong|Not attempted`),
    { timeout: 15_000 }
  );
  await expect(phaseTitle(p.page)).not.toContainText("Waiting for the next question");

  // If still in the question, the pre-crash answer is shown locked.
  if ((await phaseTitle(p.page).textContent()).includes("Question")) {
    await expect(p.page.locator(".option.picked")).toHaveCount(1);
    for (const btn of await p.page.locator(".option").all()) {
      await expect(btn).toBeDisabled();
    }
  }

  // And the game keeps looping.
  await expect(phaseTitle(p.page)).toContainText(`Question #${target + 1}`, {
    timeout: 60_000,
  });

  await p.context.close();
});
