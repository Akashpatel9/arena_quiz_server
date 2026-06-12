# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: arena.spec.cjs >> two players: question → answer lock → waiting joiner → result → next round
- Location: tests/arena.spec.cjs:28:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('#phase-title')
Expected substring: "Waiting for the next question"
Received string:    "Question #1 (medium)"
Timeout: 5000ms

Call log:
  - Expect "toContainText" with timeout 5000ms
  - waiting for locator('#phase-title')
    14 × locator resolved to <h2 id="phase-title">Question #1 (medium)</h2>
       - unexpected value "Question #1 (medium)"

```

```yaml
- 'heading "Question #1 (medium)" [level=2]'
```

# Test source

```ts
  1  | /**
  2  |  * Browser-level tests of the real web client (public/index.html) with
  3  |  * Playwright — actual Chromium pages playing the game as users would.
  4  |  * Needs the server on :3000 with TIMER_SCALE=0.2 (auto-started if absent)
  5  |  * and seeded data (npm run seed).
  6  |  */
  7  | const { test, expect } = require("@playwright/test");
  8  | 
  9  | // Each context = its own sessionStorage = its own player identity.
  10 | async function joinAsPlayer(browser, name) {
  11 |   const context = await browser.newContext();
  12 |   const page = await context.newPage();
  13 |   await page.goto("/");
  14 |   await page.fill("#name", name);
  15 |   await page.click("#connect");
  16 |   await expect(page.locator("#conn")).toHaveText("online");
  17 |   await page.click("#arenas button"); // first (demo) arena
  18 |   await expect(page.locator("#game")).toBeVisible();
  19 |   return { context, page };
  20 | }
  21 | 
  22 | const phaseTitle = (page) => page.locator("#phase-title");
  23 | const roundNumber = async (page) => {
  24 |   const t = await phaseTitle(page).textContent();
  25 |   return Number(t.match(/#(\d+)/)?.[1]);
  26 | };
  27 | 
  28 | test("two players: question → answer lock → waiting joiner → result → next round", async ({ browser }) => {
  29 |   // --- Alice joins; the game shows her a live question
  30 |   const alice = await joinAsPlayer(browser, "PW-Alice");
  31 |   await expect(phaseTitle(alice.page)).toContainText("Question #", { timeout: 30_000 });
  32 |   const round = await roundNumber(alice.page);
  33 |   await expect(alice.page.locator(".option")).toHaveCount(4);
  34 | 
  35 |   // --- she answers: choice highlighted, all options locked
  36 |   await alice.page.locator(".option").nth(1).click();
  37 |   await expect(alice.page.locator(".option.picked")).toHaveCount(1);
  38 |   for (const btn of await alice.page.locator(".option").all()) {
  39 |     await expect(btn).toBeDisabled();
  40 |   }
  41 | 
  42 |   // --- Bob joins mid-question (past the 2s join-start window): must wait
  43 |   await alice.page.waitForTimeout(2500);
  44 |   const bob = await joinAsPlayer(browser, "PW-Bob");
  45 |   await expect(phaseTitle(bob.page)).toContainText("Waiting for the next question");
  46 |   await expect(bob.page.locator("#timer")).toContainText("s"); // waiting countdown runs
  47 | 
  48 |   // --- Alice's result screen: outcome title, explanation, graph iff correct
  49 |   await expect(phaseTitle(alice.page)).toContainText(/Correct|Wrong|Not attempted/, {
  50 |     timeout: 30_000,
  51 |   });
  52 |   await expect(alice.page.locator("#content")).toContainText("Explanation:");
  53 |   const correct = (await phaseTitle(alice.page).textContent()).includes("Correct");
  54 |   const graphRows = alice.page.locator(".graph-row");
  55 |   if (correct) {
  56 |     await expect(graphRows.first()).toBeVisible();
  57 |     await expect(alice.page.locator(".graph-row", { hasText: "(you)" })).toHaveCount(1);
  58 |   } else {
  59 |     await expect(graphRows).toHaveCount(0); // no graph for wrong/unattempted
  60 |   }
  61 |   // Bob saw nothing of a round he didn't play
> 62 |   await expect(phaseTitle(bob.page)).toContainText("Waiting for the next question");
     |                                      ^ Error: expect(locator).toContainText(expected) failed
  63 | 
  64 |   // --- next round: both land on the SAME question; Bob is in and can answer
  65 |   await expect(phaseTitle(bob.page)).toContainText("Question #", { timeout: 30_000 });
  66 |   await expect(phaseTitle(alice.page)).toContainText(`Question #${round + 1}`, {
  67 |     timeout: 30_000,
  68 |   });
  69 |   expect(await roundNumber(bob.page)).toBe(round + 1);
  70 |   await bob.page.locator(".option").nth(0).click();
  71 |   await expect(bob.page.locator(".option.picked")).toHaveCount(1);
  72 | 
  73 |   await alice.context.close();
  74 |   await bob.context.close();
  75 | });
  76 | 
  77 | test("page reload mid-game: player keeps identity and lands back in place", async ({ browser }) => {
  78 |   const carol = await joinAsPlayer(browser, "PW-Carol");
  79 |   await expect(phaseTitle(carol.page)).toContainText("Question #", { timeout: 30_000 });
  80 |   const userId = await carol.page.evaluate(() => sessionStorage.getItem("arena_userId"));
  81 | 
  82 |   // Reload = full client restart (network drop + fresh page) mid-round.
  83 |   await carol.page.reload();
  84 |   await carol.page.fill("#name", "PW-Carol");
  85 |   await carol.page.click("#connect");
  86 |   await expect(carol.page.locator("#conn")).toHaveText("online");
  87 |   await carol.page.click("#arenas button");
  88 | 
  89 |   // Same identity (sessionStorage) → kept seat: question or result, never waiting.
  90 |   const userIdAfter = await carol.page.evaluate(() => sessionStorage.getItem("arena_userId"));
  91 |   expect(userIdAfter).toBe(userId);
  92 |   await expect(phaseTitle(carol.page)).toContainText(/Question #|Correct|Wrong|Not attempted/, {
  93 |     timeout: 15_000,
  94 |   });
  95 |   await expect(phaseTitle(carol.page)).not.toContainText("Waiting for the next question");
  96 | 
  97 |   await carol.context.close();
  98 | });
  99 | 
```