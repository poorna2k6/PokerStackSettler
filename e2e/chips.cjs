const { chromium, devices } = require('playwright');
const ok=(n,c,x='')=>console.log((c?'PASS ':'FAIL ')+n+(x?'  '+x:''));
const B=process.env.BASE||'http://localhost:4174/';
(async()=>{
  const b=await chromium.launch();
  const ctx=await b.newContext({...devices['iPhone 13']}); const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(B); await p.waitForTimeout(600);
  await p.click('text=Start fresh'); await p.waitForTimeout(500);
  ok('chip setup shown first and mandatory', await p.locator('.sheet[aria-label="Set up the chips"]').count()===1);
  // bad: 30 chips for $10 refused
  await p.fill('input[aria-label="Chips per buy-in"]','30'); await p.fill('input[aria-label="Real money per buy-in in dollars"]','10');
  await p.click('.sheet button:has-text("Start the game")'); await p.waitForTimeout(300);
  const err=await p.locator('.sheet').innerText();
  ok('30 chips for $10 refused with a helpful message', /can’t be split into exactly 30 chips/.test(err) && /Try/.test(err), err.match(/\$10\.00 can’t[^\n]*/)?.[0]);
  await p.fill('input[aria-label="Chips per buy-in"]','40');
  ok('preview explains chip value', /1 chip = \$0\.25/.test(await p.locator('.sheet').innerText()));
  await p.click('.sheet button:has-text("Start the game")'); await p.waitForTimeout(600);
  ok('add player opens after setup', await p.locator('.sheet[aria-label="Add player"]').count()===1);
  for (const [n,c] of [['Ann','2'],['Bob','2']]) { await p.fill('input[aria-label="New player name"]',n); await p.fill('input[aria-label="Number of buy-ins"]',c); await p.click('text=Add & next player'); await p.waitForTimeout(250); }
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  let t=await p.locator('body').innerText();
  ok('pot shows chips given out (160)', /160 chips given out/.test(t), t.match(/[^\n]*given out[^\n]*/)?.[0]);
  const cash=p.locator('input[aria-label$="chips handed back"]');
  ok('inputs are chip counts', await cash.count()===2);
  await cash.nth(0).fill('120'); await cash.nth(0).press('Tab'); await p.waitForTimeout(300);
  t=await p.locator('body').innerText();
  ok('unbalanced shows chips missing, not dollars', /(\d+) chips missing/.test(t), t.match(/[^\n]*(missing|too many)[^\n]*/)?.[0]);
  ok('row shows chips back = money', /120 chips back = \$30\.00/.test(t), t.match(/[^\n]*chips back[^\n]*/)?.[0]);
  await cash.nth(1).fill('40'); await cash.nth(1).press('Tab'); await p.waitForTimeout(300);
  t=await p.locator('body').innerText();
  ok('balanced', /Balanced/.test(t));
  // share + settle
  await p.click('button.new-btn.ghost'); await p.waitForTimeout(400); await p.click('.sheet button:has-text("Start sharing")'); await p.waitForTimeout(1200);
  const code=await p.evaluate(()=>JSON.parse(localStorage.getItem('stacksettle_live_autosave_v1')).share.code);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.click('button:has-text("End & settle")'); await p.waitForTimeout(500);
  await p.click('.sheet button:has-text("No extra expenses")'); await p.waitForTimeout(500);
  await p.click('.sheet button:has-text("End session")'); await p.waitForTimeout(1200);
  t=await p.locator('body').innerText();
  ok('settle tab lists what everyone handed back', /what everyone handed back/i.test(t) && /120 chips/.test(t) && /= \$30\.00/.test(t) && /\+\$10\.00/.test(t), t.match(/[^\n]*120 chips[^\n]*/g)?.join('|'));
  ok('Bob pays Ann $10', /Bob pays Ann/.test(t) && /\$10\.00/.test(t));
  // viewer
  const vc=await b.newContext({...devices['iPhone 13']}); const v=await vc.newPage(); await v.goto(B+'#/v/'+code); await v.waitForTimeout(1800);
  const vt=await v.locator('body').innerText();
  ok('viewer shows chips', /160 chips given out/i.test(vt) && /Chips back/i.test(vt), vt.match(/[^\n]*chips[^\n]*/gi)?.slice(0,3).join('|'));
  // history round trip
  await p.click('.tab:has-text("History")'); await p.waitForTimeout(500);
  ok('no page errors', errs.length===0, errs.join(';'));
  await b.close();
})();
