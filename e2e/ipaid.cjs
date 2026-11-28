const { chromium, devices } = require('playwright');
const ok=(n,c,x='')=>console.log((c?'PASS ':'FAIL ')+n+(x?'  '+x:''));
const B=process.env.BASE||'http://localhost:4174/';
(async()=>{
  const b=await chromium.launch();
  const hc=await b.newContext({...devices['iPhone 13']}); const h=await hc.newPage();
  const errs=[]; h.on('pageerror',e=>errs.push(e.message));
  await h.goto(B); await h.waitForTimeout(600);
  await h.click('text=Start fresh'); await h.waitForTimeout(300); await h.fill('input[aria-label="Chips per buy-in"]','100'); await h.fill('input[aria-label="Real money per buy-in in dollars"]','100'); await h.click('.sheet button:has-text("Start the game")'); await h.waitForTimeout(500);
  for (const n of ['Ann','Bob']) { await h.fill('input[aria-label="New player name"]',n); await h.click('text=Add & next player'); await h.waitForTimeout(250); }
  await h.keyboard.press('Escape'); await h.waitForTimeout(400);
  const cash=h.locator('input[aria-label*="chips"]');
  await cash.nth(0).fill('150'); await cash.nth(0).press('Tab'); await cash.nth(1).fill('50'); await cash.nth(1).press('Tab'); await h.waitForTimeout(400);
  await h.click('button.new-btn.ghost'); await h.waitForTimeout(400); await h.click('.sheet button:has-text("Start sharing")'); await h.waitForTimeout(1200);
  const code=await h.evaluate(()=>JSON.parse(localStorage.getItem('stacksettle_live_autosave_v1')).share.code);
  await h.keyboard.press('Escape'); await h.waitForTimeout(400);
  // viewer = Bob
  const vc=await b.newContext({...devices['iPhone 13']}); const v=await vc.newPage(); v.on('pageerror',e=>errs.push(e.message));
  await v.goto(B+'#/v/'+code); await v.waitForTimeout(1800);
  ok('no I paid button before picking a name', await v.locator('button:has-text("I paid")').count()===0);
  await v.click('text=That’s me'); await v.waitForTimeout(400); await v.click('.sheet button:has-text("Bob")'); await v.waitForTimeout(600);
  const btn=v.locator('button:has-text("I paid")'); ok('Bob sees I paid on his payment', await btn.count()===1);
  // Ann (the receiver) must not get a button
  await btn.click(); await v.waitForTimeout(800);
  ok('viewer shows waiting for the host', /waiting for the host/i.test(await v.locator('body').innerText()));
  // host sees it
  await h.click('.tab:has-text("Settle")'); await h.waitForTimeout(500);
  let seen=false; for(let i=0;i<10&&!seen;i++){ await h.waitForTimeout(1500); seen=await h.locator('text=Waiting for your OK').count()>0 || /waiting for your ok/i.test(await h.locator('body').innerText()); }
  ok('host sees the request', seen);
  ok('nothing is paid yet', /0\/1/.test(await h.locator('body').innerText()));
  await h.click('button:has-text("Approve")'); await h.waitForTimeout(1500);
  ok('host approved: paid 1/1', /1\/1/.test(await h.locator('body').innerText()));
  let vp=false; for(let i=0;i<8&&!vp;i++){ await v.waitForTimeout(1500); vp=!/I paid/.test(await v.locator('body').innerText()) && /✓/.test(await v.locator('body').innerText()); }
  ok('viewer now shows it paid, button gone', vp);
  // decline flow: reopen? just check API-level hostile input
  const bad=await v.evaluate(async c=>(await fetch('/api/share?code='+c+'&action=paid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'<script>'})})).status,code);
  ok('hostile key refused', bad===400, String(bad));
  const noKeyAck=await v.evaluate(async c=>(await fetch('/api/share?code='+c+'&action=ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keys:['x']})})).status,code);
  ok('viewer cannot ack', noKeyAck===403, String(noKeyAck));
  ok('no page errors', errs.length===0, errs.join(';'));
  await b.close();
})();
