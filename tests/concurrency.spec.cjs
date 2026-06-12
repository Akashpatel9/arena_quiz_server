/**
 * Concurrency through the real UI: simultaneous players stay in lock-step,
 * and the same user in two tabs can only answer once.
 * Best watched headed: npx playwright test concurrency --headed
 */
const { test, expect } = require("@playwright/test");
const { phaseTitle, joinAsPlayer, waitForQuestion } = require("./helpers.cjs");

test("5 players join together and stay on the same synced round", async ({ browser }) => {
  const players = await Promise.all(
    Array.from({ length: 5 }, (_, i) => joinAsPlayer(browser, `Sync${i}`))
  );
  const firstRounds = await Promise.all(players.map((p) => waitForQuestion(p.page)));

  // Everyone is guaranteed to pass through round max+1 via the same broadcast.
  const target = Math.max(...firstRounds) + 1;
  await Promise.all(
    players.map((p) =>
      expect(phaseTitle(p.page)).toContainText(`Question #${target}`, { timeout: 60_000 })
    )
  );

  // All five can answer the shared round.
  await Promise.all(players.map((p, i) => p.page.locator(".option").nth(i % 4).click()));
  for (const p of players) await expect(p.page.locator(".option.picked")).toHaveCount(1);

  await Promise.all(players.map((p) => p.context.close()));
});

test("same user in two tabs: racing answers, exactly one is accepted", async ({ browser }) => {
  const a = await joinAsPlayer(browser, "TwinTabs");
  // sessionStorage is per-tab, so a second tab is normally a NEW player.
  // Copy the identity over before the page loads to impersonate the same user.
  const userId = await a.page.evaluate(() => sessionStorage.getItem("arena_userId"));
  const tab2 = await a.context.newPage();
  await tab2.addInitScript((id) => sessionStorage.setItem("arena_userId", id), userId);
  const { openPlayerPage } = require("./helpers.cjs");
  await openPlayerPage(tab2, "TwinTabs");

  // Land both tabs on the same fresh question.
  const r1 = await waitForQuestion(a.page);
  const target = r1 + 1;
  await Promise.all([
    expect(phaseTitle(a.page)).toContainText(`Question #${target}`, { timeout: 60_000 }),
    expect(phaseTitle(tab2)).toContainText(`Question #${target}`, { timeout: 60_000 }),
  ]);

  // Race two different answers from the two tabs at the same instant.
  await Promise.all([
    a.page.locator(".option").nth(0).click(),
    tab2.locator(".option").nth(3).click(),
  ]);
  await a.page.waitForTimeout(500); // let both acks land

  const logs = await Promise.all([
    a.page.locator("#log").textContent(),
    tab2.locator("#log").textContent(),
  ]);
  const locked = logs.filter((l) => l.includes("answer locked")).length;
  const rejected = logs.filter((l) => l.includes("answer rejected")).length;
  expect(locked).toBe(1); // exactly one tab won
  expect(rejected).toBe(1); // the other was told it already answered

  await a.context.close();
});
