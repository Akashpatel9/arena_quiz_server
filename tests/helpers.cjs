const { expect } = require("@playwright/test");

const phaseTitle = (page) => page.locator("#phase-title");

async function roundNumber(page) {
  const t = await phaseTitle(page).textContent();
  return Number(t.match(/#(\d+)/)?.[1]);
}

/** Connect + join the demo arena on an existing page (UI flow). */
async function openPlayerPage(page, name) {
  await page.goto("/");
  await page.fill("#name", name);
  await page.click("#connect");
  await expect(page.locator("#conn")).toHaveText("online");
  await page.click("#arenas button"); // first (demo) arena
  await expect(page.locator("#game")).toBeVisible();
}

/** New context = own sessionStorage = an independent player. */
async function joinAsPlayer(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openPlayerPage(page, name);
  return { context, page };
}

/** Wait until the page shows a live question; returns its round number. */
async function waitForQuestion(page, timeout = 40_000) {
  await expect(phaseTitle(page)).toContainText("Question #", { timeout });
  return roundNumber(page);
}

module.exports = { phaseTitle, roundNumber, openPlayerPage, joinAsPlayer, waitForQuestion };
