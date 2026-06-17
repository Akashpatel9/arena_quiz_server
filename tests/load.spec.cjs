/**
 * Mini load through real browsers: 8 Chromium players in lock-step through a
 * full question → result → next-question cycle. (Real volume testing — 100s
 * to 1000s of players — stays in tests/load.cjs over raw sockets; browsers
 * are too heavy for that.)
 * Best watched headed: npx playwright test load --headed
 */
const { test, expect } = require("@playwright/test");
const { phaseTitle, joinAsPlayer } = require("./helpers.cjs");
const { waitForQuestion } = require("./helpers.cjs");

const N = 8;

test(`${N} browser players run a full round in lock-step`, async ({ browser }) => {
  const players = await Promise.all(
    Array.from({ length: N }, (_, i) => joinAsPlayer(browser, `Crowd${i}`))
  );
  const firstRounds = await Promise.all(players.map((p) => waitForQuestion(p.page)));

  // Everyone passes through round max+1 via the same broadcast.
  const target = Math.max(...firstRounds) + 1;
  await Promise.all(
    players.map((p) =>
      expect(phaseTitle(p.page)).toContainText(`Question #${target}`, { timeout: 60_000 })
    )
  );

  // All answer (different options), all lock.
  await Promise.all(players.map((p, i) => p.page.locator(".option").nth(i % 4).click()));
  for (const p of players) await expect(p.page.locator(".option.picked")).toHaveCount(1);

  // All reach the result together: outcome + explanation; graph iff correct.
  for (const p of players) {
    await expect(phaseTitle(p.page)).toContainText(/Correct|Wrong|Not attempted/, {
      timeout: 30_000,
    });
    await expect(p.page.locator("#content")).toContainText("Explanation:");
    const correct = (await phaseTitle(p.page).textContent()).includes("Correct");
    if (correct) {
      await expect(p.page.locator(".graph-row", { hasText: "(you)" })).toHaveCount(1);
    } else {
      await expect(p.page.locator(".graph-row")).toHaveCount(0);
    }
  }

  // And all land on the SAME next round.
  await Promise.all(
    players.map((p) =>
      expect(phaseTitle(p.page)).toContainText(`Question #${target + 1}`, { timeout: 30_000 })
    )
  );

  await Promise.all(players.map((p) => p.context.close()));
});
