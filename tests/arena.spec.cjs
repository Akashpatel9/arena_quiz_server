/**
 * Browser-level tests of the real web client (public/index.html) with
 * Playwright — actual Chromium pages playing the game as users would.
 * Needs the server on :3000 with TIMER_SCALE=0.2 (auto-started if absent)
 * and seeded data (npm run seed).
 */
const { test, expect } = require("@playwright/test");

// Each context = its own sessionStorage = its own player identity.
async function joinAsPlayer(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.fill("#name", name);
  await page.click("#connect");
  await expect(page.locator("#conn")).toHaveText("online");
  await page.click("#arenas button"); // first (demo) arena
  await expect(page.locator("#game")).toBeVisible();
  return { context, page };
}

const phaseTitle = (page) => page.locator("#phase-title");
const roundNumber = async (page) => {
  const t = await phaseTitle(page).textContent();
  return Number(t.match(/#(\d+)/)?.[1]);
};

test("two players: question → answer lock → waiting joiner → result → next round", async ({ browser }) => {
  // --- Alice joins; the game shows her a live question
  const alice = await joinAsPlayer(browser, "PW-Alice");
  await expect(phaseTitle(alice.page)).toContainText("Question #", { timeout: 30_000 });
  const round = await roundNumber(alice.page);
  await expect(alice.page.locator(".option")).toHaveCount(4);

  // --- she answers: choice highlighted, all options locked
  await alice.page.locator(".option").nth(1).click();
  await expect(alice.page.locator(".option.picked")).toHaveCount(1);
  for (const btn of await alice.page.locator(".option").all()) {
    await expect(btn).toBeDisabled();
  }

  // --- Bob joins mid-question (past the 2s join-start window): must wait
  await alice.page.waitForTimeout(2500);
  const bob = await joinAsPlayer(browser, "PW-Bob");
  await expect(phaseTitle(bob.page)).toContainText("Waiting for the next question");
  await expect(bob.page.locator("#timer")).toContainText("s"); // waiting countdown runs

  // --- Alice's result screen: outcome title, explanation, graph iff correct
  await expect(phaseTitle(alice.page)).toContainText(/Correct|Wrong|Not attempted/, {
    timeout: 30_000,
  });
  await expect(alice.page.locator("#content")).toContainText("Explanation:");
  const correct = (await phaseTitle(alice.page).textContent()).includes("Correct");
  const graphRows = alice.page.locator(".graph-row");
  if (correct) {
    await expect(graphRows.first()).toBeVisible();
    await expect(alice.page.locator(".graph-row", { hasText: "(you)" })).toHaveCount(1);
  } else {
    await expect(graphRows).toHaveCount(0); // no graph for wrong/unattempted
  }
  // Bob saw nothing of a round he didn't play
  await expect(phaseTitle(bob.page)).toContainText("Waiting for the next question");

  // --- next round: both land on the SAME question; Bob is in and can answer
  await expect(phaseTitle(bob.page)).toContainText("Question #", { timeout: 30_000 });
  await expect(phaseTitle(alice.page)).toContainText(`Question #${round + 1}`, {
    timeout: 30_000,
  });
  expect(await roundNumber(bob.page)).toBe(round + 1);
  await bob.page.locator(".option").nth(0).click();
  await expect(bob.page.locator(".option.picked")).toHaveCount(1);

  await alice.context.close();
  await bob.context.close();
});

test("page reload mid-game: player keeps identity and lands back in place", async ({ browser }) => {
  const carol = await joinAsPlayer(browser, "PW-Carol");
  await expect(phaseTitle(carol.page)).toContainText("Question #", { timeout: 30_000 });
  const userId = await carol.page.evaluate(() => sessionStorage.getItem("arena_userId"));

  // Reload = full client restart (network drop + fresh page) mid-round.
  await carol.page.reload();
  await carol.page.fill("#name", "PW-Carol");
  await carol.page.click("#connect");
  await expect(carol.page.locator("#conn")).toHaveText("online");
  await carol.page.click("#arenas button");

  // Same identity (sessionStorage) → kept seat: question or result, never waiting.
  const userIdAfter = await carol.page.evaluate(() => sessionStorage.getItem("arena_userId"));
  expect(userIdAfter).toBe(userId);
  await expect(phaseTitle(carol.page)).toContainText(/Question #|Correct|Wrong|Not attempted/, {
    timeout: 15_000,
  });
  await expect(phaseTitle(carol.page)).not.toContainText("Waiting for the next question");

  await carol.context.close();
});
