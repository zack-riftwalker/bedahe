// End-to-end run of the real APK on an emulator: adb + the WebView devtools socket (raw CDP over WebSocket).
// Usage (emulator already booted): node test/e2e.js path/to/badahe.apk
const { execFileSync } = require("child_process");
const fs = require("fs");
const PKG = "com.badahe.app";
setTimeout(() => { console.log("FAIL watchdog: e2e took over 12 minutes"); process.exit(1); }, 12 * 60 * 1000);
let fails = 0;
setInterval(() => {}, 1000); // keep the event loop alive while a WebSocket connects
process.on("exit", c => console.log("exit code " + c));
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => { try { return execFileSync("adb", a, { encoding: "utf8", maxBuffer: 1 << 26, timeout: 60000 }); } catch (e) { return ""; } };
const sh = c => adb("shell", c);
const asApp = c => sh(`run-as ${PKG} ${c}`);
fs.mkdirSync("shots", { recursive: true });
const shot = n => { try { fs.writeFileSync("shots/" + n + ".png", execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 1 << 26 })); } catch (e) {} };

/* ---------- CDP ---------- */
let ws = null, seq = 0, first = true; const pend = new Map();
async function connect() {
  const page = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(t => t.type === "page");
  if (!page) throw new Error("no devtools page");
  const w = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { w.onopen = r; w.onerror = () => j(new Error("ws error")); setTimeout(() => j(new Error("ws open timeout")), 8000); });
  w.onclose = () => { if (ws === w) ws = null; };
  w.onmessage = e => {
    const m = JSON.parse(e.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === "Runtime.consoleAPICalled") console.log("PAGE console." + m.params.type + ": " + m.params.args.map(a => a.value || a.description).join(" ").slice(0, 300));
    else if (m.method === "Runtime.exceptionThrown") console.log("PAGE exception: " + JSON.stringify(m.params.exceptionDetails.exception || m.params.exceptionDetails.text).slice(0, 300));
  };
  ws = w;
  if (first) { first = false; w.send(JSON.stringify({ id: ++seq, method: "Runtime.enable" })); }
}
async function attach() {
  console.log("attaching to WebView");
  let pid = "";
  for (let i = 0; i < 60 && !pid; i++) { await sleep(1000); pid = sh("pidof " + PKG).trim().split(/\s+/)[0]; }
  let sock = "";
  for (let i = 0; i < 60 && !sock; i++) { await sleep(1000); const m = sh("cat /proc/net/unix").match(/@(webview_devtools_remote_\d+)/); sock = m ? m[1] : ""; }
  adb("forward", "tcp:9222", "localabstract:" + sock);
  ws = null; first = true;
  await until("typeof window.N==='object'&&document.readyState==='complete'", 90000);
}
const rawEv = expr => new Promise((res, rej) => {
  const id = ++seq; setTimeout(() => { if (pend.delete(id)) rej(new Error("evaluate timed out")); }, 8000);
  pend.set(id, m => m.result && m.result.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails.exception || m.result.exceptionDetails))) : res(m.result && m.result.result && m.result.result.value));
  // userGesture: lets audio.play() and similar run as if the user tapped
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
});
const ev = async expr => { if (!ws || ws.readyState !== 1) await connect(); return rawEv(expr); }; // reconnects if the socket dropped
async function until(expr, ms = 20000) {
  const t = Date.now();
  for (;;) { try { if (await ev(expr)) return true; } catch (e) {} if (Date.now() - t > ms) throw new Error("timeout: " + expr); await sleep(300); }
}
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const phase = () => ev("document.querySelector('#focus').dataset.phase");

async function round(speakMs, cancel) {
  if ((await phase()) === "done") await click("#fPri");                 // دور بعد
  await click("#fPri");                                                   // شروع
  await until("['think','speak'].includes(document.querySelector('#focus').dataset.phase)");
  if ((await phase()) === "think") await click("#fPri");                  // الان شروع می‌کنم
  await until("document.querySelector('#focus').dataset.phase==='speak'");
  await sleep(speakMs);
  await click(cancel ? "#fSec" : "#fPri");
  await until(`document.querySelector('#focus').dataset.phase==='${cancel ? "idle" : "done"}'`);
  await sleep(800);                                                       // let the recorder finish
}
const ls = d => asApp("ls files/rec/" + d).split("\n").map(x => x.trim()).filter(Boolean);
function launch() { adb("shell", "am", "start", "-n", PKG + "/.MainActivity"); }
async function denyDialog() {
  for (let i = 0; i < 20; i++) {
    sh("uiautomator dump /sdcard/ui.xml");
    const x = sh("cat /sdcard/ui.xml"), m = x.match(/permission_deny_button[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) { sh(`input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`); return true; }
    await sleep(1000);
  }
  return false;
}

(async () => {
  const apk = process.argv[2];
  adb("install", "-r", "-g", apk);
  ok(sh("pm list packages " + PKG).includes(PKG), "installed");
  launch(); await attach();
  ok(await ev("N.native===true"), "Capacitor native bridge detected, Badahe plugin usable");
  console.log("INFO insets:", await ev("JSON.stringify({ih:innerHeight,sh:screen.height,pt:getComputedStyle(document.documentElement).paddingTop,pb:getComputedStyle(document.documentElement).paddingBottom,tab:document.querySelector('.tabbar').getBoundingClientRect().bottom,dark:matchMedia('(prefers-color-scheme:dark)').matches})"));
  shot("1-today");
  ok(/نسخه‌ی فعلی/.test(await ev("document.querySelector('#updMsg').textContent")), "version text shown");

  // --- full day 1: 4 rounds, one cancelled
  await click("#cta"); shot("2-focus");
  await round(3000);
  await click("#fPri"); await click("#fPri");                              // دور بعد، شروع
  await until("['think','speak'].includes(document.querySelector('#focus').dataset.phase)");
  if ((await phase()) === "think") await click("#fPri");
  await until("document.querySelector('#focus').dataset.phase==='speak'");
  await sleep(1500);
  ok(await ev("!document.querySelector('#recInd').hidden"), "recording indicator visible while speaking");
  ok(ls("d1").includes("r2.m4a"), "round 2 file exists while recording");
  await click("#fSec"); await sleep(800);                                  // لغو
  ok(!ls("d1").includes("r2.m4a"), "cancelled round: file deleted");
  await round(3000); await round(2500); await round(2500);
  const f = ls("d1");
  ok(["r1.m4a", "r2.m4a", "r3.m4a", "r4.m4a"].every(x => f.includes(x)), "4 round files " + f.join(","));
  const head = execFileSync("adb", ["exec-out", "run-as", PKG, "cat", "files/rec/d1/r1.m4a"], { maxBuffer: 1 << 26 });
  ok(head.length > 3000 && head.slice(4, 8).toString() === "ftyp", "r1.m4a is an MP4/AAC container, " + head.length + " bytes");

  // --- review: playback + save
  await click("#fPri");                                                    // برو به بازبینی
  await until("!document.querySelector('#sh-review').hidden");
  ok((await ev("document.querySelectorAll('#apkRev [data-apk=play]').length")) === 4, "review: 4 play buttons");
  const played = await ev(`(async()=>{const a=new Audio(Capacitor.convertFileSrc('/data/user/0/${PKG}/files/rec/d1/r1.m4a'));
    await new Promise((r,j)=>{a.onloadedmetadata=r;a.onerror=()=>j(new Error('audio error'));setTimeout(()=>j(new Error('timeout')),8000);a.load();});return a.duration;})()`).catch(e => String(e));
  ok(typeof played === "number" && played > 1, "WebView can load the recording through convertFileSrc, duration " + played);
  await click('#apkRev [data-apk=play]'); await sleep(1500);
  ok((await ev("document.querySelector('#apkRev [data-apk=play]').textContent")).includes("توقف"), "play button toggles to stop");
  await click('#apkRev [data-apk=play]');
  shot("3-review");
  const date = await ev("JSON.parse(localStorage.getItem('badahe-rec-v1'))[1][0].date");
  const dir = "/sdcard/Download/Badahe/day1_" + date;
  await ev("document.querySelector('#toast').textContent=''");
  await click('#apkRev [data-apk=save]');
  await until("document.querySelector('#toast').textContent.includes('ذخیره')", 30000);
  console.log("toast:", await ev("document.querySelector('#toast').textContent"));
  let out = sh(`ls "${dir}"`).split("\n").filter(Boolean);
  ok(out.length === 5 && out.filter(x => /^day1_r[1-4]_PREP_.+\.m4a$/.test(x)).length === 4 && out.includes(`day1_${date}_info.txt`), "Download folder: 4 named m4a + info.txt: " + out.join(" | "));
  const info = sh(`cat "${dir}/day1_${date}_info.txt"`);
  ok(info.includes("روز: ۱") && info.includes("چارچوب: PREP") && info.includes("زمان فکر: ۳۰ ثانیه") && info.includes("دور ۴") && (info.match(/فایل: day1_r\d_/g) || []).length === 4, "info.txt content");
  await ev("document.querySelector('#toast').textContent=''");
  await click('#apkRev [data-apk=save]');
  await until("document.querySelector('#toast').textContent.includes('ذخیره')", 30000);
  out = sh(`ls "${dir}"`).split("\n").filter(Boolean);
  ok(out.length === 5, "re-save replaces files (still 5): " + out.length);

  // --- restart: state + recordings survive
  adb("shell", "am", "force-stop", PKG); await sleep(1500);
  launch(); await attach();
  ok((await ev("JSON.parse(localStorage.getItem('badahe-state-v1')).rounds[1].length")) === 4, "after restart: 4 rounds in state");
  await until("document.querySelector('#apkToday [data-apk=save]')&&!document.querySelector('#apkToday').hidden");
  ok(true, "after restart: recordings linked, save/share buttons visible");
  await click("#apkToday [data-apk=share]"); await sleep(2500);
  ok(sh("dumpsys window").includes("ResolverActivity") || sh("dumpsys activity activities").includes("Chooser") || sh("dumpsys activity activities").toLowerCase().includes("resolver"), "share sheet opened");
  adb("shell", "input", "keyevent", "KEYCODE_BACK"); await sleep(1000);

  // --- update check never crashes
  await ev("location.hash='progress'"); await click("#updBtn");
  await until("!/در حال/.test(document.querySelector('#updMsg').textContent)", 30000);
  console.log("update msg:", await ev("document.querySelector('#updMsg').textContent"));

  // --- mic permission denied
  adb("shell", "pm", "clear", PKG); sh(`pm revoke ${PKG} android.permission.RECORD_AUDIO`);
  launch(); await attach();
  await click("#cta"); await click("#fPri");
  ok(await denyDialog(), "permission dialog appeared and was denied");
  await until("['think','speak'].includes(document.querySelector('#focus').dataset.phase)", 20000);
  ok(true, "denied: practice continues");
  ok((await ev("document.querySelector('#toast').textContent")).includes("دسترسی میکروفون"), "denied: Persian toast");
  if ((await phase()) === "think") await click("#fPri");
  await sleep(1500); await click("#fPri");
  await until("document.querySelector('#focus').dataset.phase==='done'");
  ok(ls("d1").length === 0, "denied: no recording file written");
  ok(sh("pidof " + PKG).trim() !== "", "app still running");
  ok(!sh("logcat -d -b crash").includes(PKG), "no crash in logcat");
  console.log(fails ? fails + " FAILED" : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log("FAIL exception: " + e.stack); shot("error"); console.log(sh("logcat -d -t 120 -s chromium:E AndroidRuntime:E Capacitor:* Badahe:*")); process.exit(1); });
