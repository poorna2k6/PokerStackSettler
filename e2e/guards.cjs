// Guards: things the app must refuse or warn about instead of silently doing something wrong.
const { chromium, devices } = require('playwright');
const ok = (n, c, x = '') => console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
const B = process.env.BASE || 'http://localhost:4174/';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('stacksettle_prefs_v1', JSON.stringify({ sound: false, view: 'list', confirmBuyIn: false })); } catch {} });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(B); await p.waitForTimeout(600);
  await p.click('text=Start fresh'); await p.waitForTimeout(500);
  ok('money field starts blank', (await p.inputValue('input[aria-label="Real money per buy-in in dollars"]')) === '');
  await p.fill('input[aria-label="Chips per buy-in"]', '40abc'); await p.fill('input[aria-label="Real money per buy-in in dollars"]', '10');
  await p.click('.sheet button:has-text("Start the game")'); await p.waitForTimeout(300);
  ok('"40abc" chips refused', await p.locator('.sheet[aria-label="Set up the chips"]').count() === 1);
  await p.fill('input[aria-label="Chips per buy-in"]', '25');
  await p.click('.sheet button:has-text("Start the game")'); await p.waitForTimeout(600);
  // 25 chips for $10 -> 40 cents per chip; a half buy-in is 12.5 chips -> refused
  await p.fill('input[aria-label="New player name"]', 'Ann'); await p.fill('input[aria-label="Number of buy-ins"]', '0.5');
  await p.click('text=Add & next player'); await p.waitForTimeout(300);
  ok('half buy-in with 25 chips refused', /whole number of chips/.test(await p.locator('.sheet').innerText()));
  await p.fill('input[aria-label="Number of buy-ins"]', '1'); await p.click('text=Add & next player'); await p.waitForTimeout(300);
  ok('player added with confirmation', /Added Ann/.test(await p.locator('.sheet').innerText()));
  await p.fill('input[aria-label="New player name"]', 'ann'); await p.click('text=Add & next player'); await p.waitForTimeout(300);
  ok('duplicate name refused', /already a player called Ann/i.test(await p.locator('.sheet').innerText()));
  await p.fill('input[aria-label="New player name"]', ''); await p.click('text=Add & next player'); await p.waitForTimeout(300);
  ok('empty name refused', /Type a name/.test(await p.locator('.sheet').innerText()));
  await p.fill('input[aria-label="New player name"]', 'Bob'); await p.fill('input[aria-label="Number of buy-ins"]', 'abc'); await p.click('text=Add & next player'); await p.waitForTimeout(300);
  ok('bad buy-in count refused', /more than 0/.test(await p.locator('.sheet').innerText()));
  await p.fill('input[aria-label="Number of buy-ins"]', '1'); await p.click('text=Add & finish'); await p.waitForTimeout(500);
  // no chips back yet: no alarming banner, and End is refused
  let t = await p.locator('body').innerText();
  ok('no "chips missing" alarm before anyone hands chips back', !/chips missing|too many/.test(t));
  await p.click('button:has-text("End & settle")'); await p.waitForTimeout(500);
  ok('End refused until chips are entered', /handed back first/i.test(await p.locator('#toast').innerText()) && (await p.locator('.sheet').count()) === 0);
  // junk chip count is refused, not guessed
  const cash = p.locator('input[aria-label$="chips handed back"]');
  await cash.nth(0).fill('12abc'); await cash.nth(0).press('Tab'); await p.waitForTimeout(300);
  ok('junk chip count refused', /whole number/.test(await p.locator('#toast').innerText()));
  // chips: Ann 40 (all), Bob 10 -> 25 given each => 50 total, returned 50 -> balanced
  await cash.nth(0).fill('40'); await cash.nth(0).press('Tab'); await cash.nth(1).fill('10'); await cash.nth(1).press('Tab'); await p.waitForTimeout(400);
  // removing a player with money in the game warns
  await p.click('button[aria-label="Remove Ann"]'); await p.waitForTimeout(400);
  const rm = await p.locator('.sheet').innerText();
  ok('remove warns that others\' results change', /CHANGE/.test(rm) && /Keep in the game/.test(rm), rm.replace(/\n/g, ' ').slice(0, 120));
  await p.click('.sheet button:has-text("Keep in the game")'); await p.waitForTimeout(400);
  ok('Ann still there', /Ann/.test(await p.locator('body').innerText()));
  // unbalanced End shows who changes
  await cash.nth(1).fill('5'); await cash.nth(1).press('Tab'); await p.waitForTimeout(300);
  await p.click('button:has-text("End & settle")'); await p.waitForTimeout(400); await p.click('.sheet button:has-text("No extra expenses")'); await p.waitForTimeout(500);
  const conf = await p.locator('.sheet').innerText();
  ok('unbalanced End lists the exact changes', /Ann: 40 chips → /.test(conf) || /Bob: 5 chips → /.test(conf), conf.replace(/\n/g, ' ').slice(0, 260));
  await p.click('.sheet button:has-text("Balance & settle")'); await p.waitForTimeout(1200);
  t = await p.locator('body').innerText();
  ok('Settle shows what was typed before the adjustment', /typed \d+ chips?, adjusted/.test(t));
  ok('no page errors', errs.length === 0, errs.join(';'));
  await b.close();
})();
