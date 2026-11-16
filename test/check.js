// Browser-level checks of www/index.html + www/apk.js: plain browser, then with a mocked native bridge.
// Run: node test/check.js   (needs the globally installed playwright + chromium)
const { chromium } = require("playwright");
const path = require("path");
const URL = "file://" + path.resolve(__dirname, "../www/index.html");
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// Fake Capacitor + Badahe plugin. Files live in localStorage so they survive reload like real storage.
const MOCK = mic => `(() => {
  const fs = () => JSON.parse(localStorage.getItem("__fs") || "{}"), setfs = o => localStorage.setItem("__fs", JSON.stringify(o));
  window.__calls = []; let active = null;
  const impl = {
    info: () => ({ name: "1.0.7", code: 7 }),
    keepAwake: () => ({}),
    micPerm: () => ({ granted: ${mic} }),
    recStart: a => { active = a.day + "/r" + a.n; return {}; },
    recStop: () => { const f = fs(); f[active] = "/rec/" + active; setfs(f); return { ok: true, path: "/rec/" + active }; },
    recCancel: () => { active = null; return {}; },
    recList: () => ({ files: Object.entries(fs()).map(([k, p]) => ({ key: "d" + k + ".m4a", path: p })) }),
    save: a => ({ where: "Download/Badahe/" + a.folder }),
    share: () => ({}),
    install: () => ({ ok: true })
  };
  window.Capacitor = { isNativePlatform: () => true, convertFileSrc: p => "file://" + p,
    registerPlugin: () => new Proxy({}, { get: (_, m) => async a => { window.__calls.push([m, a]); return impl[m](a); } }) };
})();`;

const names = p => p.evaluate(() => window.__calls.map(c => c[0]));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function open(browser, { mic, state, native = true, clock = false }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("console", m => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", e => p.errors.push(String(e)));
  if (state) await p.addInitScript(s => { if (!localStorage.getItem("badahe-state-v1")) localStorage.setItem("badahe-state-v1", s); }, JSON.stringify(state));
  if (native) await p.addInitScript(MOCK(mic));
  if (clock) await p.clock.install();
  await p.goto(URL);
  await p.waitForTimeout(100);
  return p;
}
// day 1: start, skip think, speak briefly, "تمام کردم"
async function round(p, speakMs = 1100) {
  await p.click("#fPri");                        // شروع (permission first, then think)
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase !== "idle");
  if ((await p.getAttribute("#focus", "data-phase")) === "think") await p.click("#fPri");
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "speak");
  await wait(speakMs);
  await p.click("#fPri");                        // تمام کردم
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "done");
}

(async () => {
  const browser = await chromium.launch();

  // (a) plain browser
  let p = await open(browser, { native: false });
  await p.click("#cta"); await round(p);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem("badahe-state-v1")).rounds[1].length)) === 1, "plain: a round completes and is stored");
  ok(await p.evaluate(() => !document.querySelector("#apkToday, #apkRev, #updBtn")), "plain: no native UI injected");
  await p.click("#fClose");
  await p.evaluate(() => { location.hash = "progress"; });
  await p.click("#expBtn");
  const backup = await p.evaluate(() => navigator.clipboard.readText());
  ok(backup.includes('"rounds"'), "plain: backup copied");
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.evaluate(() => { location.hash = "progress"; });
  await p.click("#impOpen"); await p.fill("#impTxt", backup); await p.click("#impBtn"); await p.click("#impBtn");
  await p.waitForTimeout(100);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem("badahe-state-v1")).rounds[1].length)) === 1, "plain: restore from pasted backup");
  ok(p.errors.length === 0, "plain: zero console errors " + JSON.stringify(p.errors));
  await p.context().close();

  // (b) native mock, mic granted, day 1
  p = await open(browser, { mic: true });
  await p.click("#cta");
  await p.click("#fPri");                                     // first start
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "think");
  ok((await names(p)).includes("micPerm") && !(await names(p)).includes("recStart"), "mock: mic asked before timer, no recording during think");
  await p.click("#fPri");                                     // الان شروع می‌کنم
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "speak");
  await p.waitForTimeout(150);
  let n = await names(p);
  ok(n.indexOf("micPerm") < n.indexOf("recStart") && n.includes("recStart"), "mock: recStart on speak, after permission");
  ok(await p.isVisible("#recInd"), "mock: recording indicator shown");
  ok(await p.evaluate(() => window.N._back()) === true && !(await p.isHidden("#focus")), "mock: Back ignored during speak");
  await p.click("#fSec");                                     // لغو
  await p.waitForTimeout(100);
  ok((await names(p)).includes("recCancel") && !(await p.isVisible("#recInd")), "mock: cancel -> recCancel, indicator off");
  await round(p);                                             // round 1 recorded
  n = await names(p);
  ok(n.indexOf("recStop") > n.indexOf("recStart"), "mock: recStop on end");
  const sc = await p.evaluate(() => JSON.parse(localStorage.getItem("badahe-rec-v1")));
  const m0 = sc[1] && sc[1][0], st = await p.evaluate(() => JSON.parse(localStorage.getItem("badahe-state-v1")));
  ok(m0 && m0.q === st.rounds[1][0].q && m0.secs >= 1 && /^\d{4}-\d\d-\d\d$/.test(m0.date) && m0.intr === "", "mock: sidecar {q,secs,date,intr,at} " + JSON.stringify(m0));
  ok(!("rec" in st) && Object.keys(st).sort().join() === "bank,baseQ,day,done,log,rounds,seeded,used", "mock: badahe-state-v1 format unchanged");
  await p.click("#fClose"); await p.waitForTimeout(100);
  ok(await p.isVisible('#apkToday [data-apk="save"]') && await p.isVisible('#apkToday [data-apk="share"]'), "mock: save+share buttons on today view");
  await p.click('[data-open="review"]');
  ok(await p.isVisible('#apkRev [data-apk="play"]'), "mock: play button in review");
  ok(await p.isVisible('#apkRev [data-apk="save"]'), "mock: save button in review");
  ok(await p.evaluate(() => window.N._back()) === true && await p.isHidden("#sh-review"), "mock: Back closes the sheet");
  ok(await p.evaluate(() => window.N._back()) === false, "mock: Back with nothing open falls through");
  await p.click('#apkToday [data-apk="save"]'); await p.waitForTimeout(100);
  const saved = await p.evaluate(() => window.__calls.filter(c => c[0] === "save")[0][1]);
  const d = m0.date;
  ok(saved.folder === "day1_" + d && saved.files.length === 1 && /^day1_r1_PREP_[^\/]+\.m4a$/.test(saved.files[0].name) && saved.files[0].src === "d1/r1.m4a", "mock: save payload names " + saved.files[0].name);
  ok(saved.info.name === "day1_" + d + "_info.txt" && saved.info.text.includes("روز: ۱") && saved.info.text.includes("تاریخ: " + d) && saved.info.text.includes("PREP") && saved.info.text.includes("زمان فکر: ۳۰ ثانیه") && saved.info.text.includes("سؤال: " + st.rounds[1][0].q) && saved.info.text.includes("فایل: " + saved.files[0].name), "mock: info.txt content");
  ok((await p.textContent("#toast")).includes("Download/Badahe/day1_" + d), "mock: Persian saved message " + await p.textContent("#toast"));
  await p.reload(); await p.waitForTimeout(200);
  ok(await p.isVisible('#apkToday [data-apk="save"]'), "mock: recordings still linked after reload");
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem("badahe-state-v1")); s.rounds[1][0].q = "سؤال دیگر"; localStorage.setItem("badahe-state-v1", JSON.stringify(s)); });
  await p.reload(); await p.waitForTimeout(200);
  ok(await p.isHidden("#apkToday"), "mock: q mismatch (restored backup) -> not linked");
  ok(p.errors.length === 0, "mock: zero console errors " + JSON.stringify(p.errors));
  await p.context().close();

  // (c) mic denied
  p = await open(browser, { mic: false });
  await p.click("#cta"); await p.click("#fPri");
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "think");
  ok((await p.textContent("#toast")).includes("دسترسی میکروفون داده نشد"), "denied: Persian toast, practice proceeds to think");
  await p.click("#fPri"); await p.waitForTimeout(1100); await p.click("#fPri");
  await p.waitForFunction(() => document.querySelector("#focus").dataset.phase === "done");
  ok(!(await names(p)).includes("recStart") && !(await p.evaluate(() => localStorage.getItem("badahe-rec-v1"))), "denied: no recording, no sidecar");
  ok(p.errors.length === 0, "denied: zero console errors " + JSON.stringify(p.errors));
  await p.context().close();

  // (d) day 11: no think -> recording starts immediately; interrupt metadata
  p = await open(browser, { mic: true, state: { day: 11 }, clock: true });
  await p.click("#cta"); await p.click("#fPri"); await p.clock.runFor(300);
  ok((await p.getAttribute("#focus", "data-phase")) === "speak" && (await names(p)).includes("recStart"), "day11: speak + recStart immediately");
  await p.clock.runFor(70000);
  ok(await p.isVisible("#fIntr"), "day11: interrupt shown");
  await p.click("#fPri"); await p.clock.runFor(300);
  const s11 = await p.evaluate(() => JSON.parse(localStorage.getItem("badahe-rec-v1"))[11][0]);
  ok(s11.intr.length > 0 && s11.at >= 67 && s11.at <= 72 && s11.secs >= 70, "day11: sidecar intr/at " + JSON.stringify(s11));
  await p.click("#fClose"); await p.clock.runFor(300);
  await p.click('#apkToday [data-apk="save"]'); await p.clock.runFor(300);
  const sv = await p.evaluate(() => window.__calls.filter(c => c[0] === "save")[0][1]);
  ok(sv.info.text.includes("سؤال مزاحم: " + s11.intr) && /_ONE_|_MAHAGH_/.test(sv.files[0].name) , "day11: info has interrupt + tag " + sv.files[0].name);
  ok(p.errors.length === 0, "day11: zero console errors " + JSON.stringify(p.errors));
  await p.context().close();

  await browser.close();
  console.log(fails ? fails + " FAILED" : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
