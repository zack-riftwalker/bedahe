/* apk.js: everything the Android wrapper adds. In a plain browser every method is a no-op. */
(function () {
"use strict";
const cap = window.Capacitor;
const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
const P = native ? cap.registerPlugin("Badahe") : null;
const REC = "badahe-rec-v1";
const API = "https://api.github.com/repos/zack-riftwalker/bedahe/releases/latest";
const TAG = { prep: "PREP", mia: "MAHAGH", one: "ONE" };
const $ = s => document.querySelector(s);

let X = null;          // page internals, set by bind()
let files = {};        // "10/r1" key -> absolute path; only files that exist on disk
let micOk = false, asking = false, cur = null, chain = Promise.resolve();
let upd = null, audio = null, playing = -1;

/* ---------- names ---------- */
// first 5 words, punctuation / illegal chars removed, spaces -> "-", ZWNJ kept inside words only
function slug(q) {
  const w = String(q).replace(/[‎‏]/g, "")
    .replace(/[؟،؛?,;:.!«»"'()\/\\*<>|…\u0000-\u001f\-–—]/g, " ")
    .split(/\s+/).map(x => x.replace(/^‌+|‌+$/g, "")).filter(Boolean).slice(0, 5);
  return w.join("-").slice(0, 60) || "q";
}
const fname = (d, n, fw, q) => "day" + d + "_r" + n + "_" + TAG[fw] + "_" + slug(q) + ".m4a";
const isoDay = () => { const t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };

/* ---------- sidecar: badahe-rec-v1 = { day: { roundIndex: {q,secs,date,intr,at} } } ---------- */
const side = () => { try { return JSON.parse(localStorage.getItem(REC) || "{}") || {}; } catch (e) { return {}; } };
function putSide(d, i, v) { const s = side(); (s[d] = s[d] || {})[i] = v; try { localStorage.setItem(REC, JSON.stringify(s)); } catch (e) {} }
const key = (d, i) => d + "/r" + (i + 1);
// rounds of day d that have a recording on disk AND a sidecar entry for the same question
function linked(d) {
  const sd = side()[d] || {};
  return X.roundsOf(d).map((r, i) => ({ i, r, m: sd[i] })).filter(x => x.m && x.m.q === x.r.q && files[key(d, x.i)]);
}

/* ---------- what gets exported ---------- */
function pack(d) {
  const L = linked(d); if (!L.length) return null;
  const p = X.plan(d), date = L[0].m.date, fa = X.fa;
  const out = L.map(x => ({ src: "d" + d + "/r" + (x.i + 1) + ".m4a", name: fname(d, x.i + 1, p.fw, x.r.q) }));
  let t = "تمرین بداهه‌گویی\nروز: " + fa(d) + "\nتاریخ: " + date + "\nچارچوب: " + X.FW[p.fw].name + " (" + TAG[p.fw] + ")\n" +
    "زمان فکر: " + fa(p.think) + " ثانیه\nزمان صحبت: " + fa(p.speak) + " ثانیه\n";
  L.forEach((x, k) => {
    t += "\nدور " + fa(x.i + 1) + "\nسؤال: " + x.r.q + "\nمدت ضبط: " + fa(x.m.secs) + " ثانیه\nفایل: " + out[k].name + "\n";
    if (x.m.intr) t += "سؤال مزاحم: " + x.m.intr + " (در ثانیه‌ی " + fa(x.m.at) + ")\n";
  });
  return { folder: "day" + d + "_" + date, files: out, info: { name: "day" + d + "_" + date + "_info.txt", text: t } };
}

/* ---------- UI ---------- */
const btns = '<button class="btn sm" data-apk="save">ذخیره‌ی ضبط‌های امروز در دانلود</button><button class="btn sm" data-apk="share">اشتراک‌گذاری</button>';
function box(id, host, place) {
  let e = $("#" + id);
  if (!e) { e = document.createElement("div"); e.id = id; host()[place](e); }
  return e;
}
function renderRev() {
  if (!X || !native) return;
  const L = linked(X.S().day), e = box("apkRev", () => $("#rvForm"), "before");
  e.className = "card"; e.hidden = !L.length;
  e.innerHTML = '<h3>ضبط‌های امروز</h3>' + L.map(x =>
    '<div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span class="small" style="min-width:0">' + X.fa(x.i + 1) + ". " + X.esc(x.r.q) + " · " + X.mmss(x.m.secs) +
    '</span><button class="btn sm" data-apk="play" data-i="' + x.i + '">' + (playing === x.i ? "توقف" : "پخش") + "</button></div>").join("") + '<div class="row">' + btns + "</div>";
}
function renderToday() {
  if (!X || !native) return;
  const L = linked(X.S().day), e = box("apkToday", () => $("#cta"), "after");
  e.className = "row"; e.hidden = !L.length; e.innerHTML = L.length ? btns : "";
}
function stopAudio() { if (audio) audio.pause(); playing = -1; }
function play(i) {
  const d = X.S().day, was = playing;
  stopAudio();
  if (was !== i) {
    audio = audio || new Audio(); audio.preload = "none";
    audio.src = cap.convertFileSrc(files[key(d, i)]);
    audio.onended = () => { playing = -1; renderRev(); };
    audio.play().catch(() => { playing = -1; X.toast("پخش نشد"); renderRev(); });
    playing = i;
  }
  renderRev();
}
async function run(kind) {
  const m = pack(X.S().day); if (!m) return;
  try {
    const r = await P[kind](m);
    if (kind === "save") X.toast("در " + r.where + " ذخیره شد");
  } catch (e) { X.toast(kind === "save" ? "ذخیره نشد؛ فضای گوشی یا اجازه‌ی ذخیره را بررسی کن" : "اشتراک‌گذاری انجام نشد"); }
}

/* ---------- update ---------- */
function msg(t) { const e = $("#updMsg"); if (e) e.textContent = t; }
async function checkUpdate() {
  const b = $("#updBtn");
  if (upd) { // already found a newer version: install it
    msg("در حال دانلود…"); b.disabled = true;
    try {
      const r = await P.install({ url: upd });
      msg(r.needPerm ? "اجازه‌ی «نصب از این برنامه» را روشن کن، برگرد و دوباره بزن." : "نصب‌کننده باز شد.");
    } catch (e) { msg("دانلود نشد؛ دوباره امتحان کن."); }
    b.disabled = false; return;
  }
  msg("در حال بررسی…"); b.disabled = true;
  try {
    const code = (await P.info()).code;
    let j;
    try { const r = await fetch(API); if (r.status === 404) { msg("نسخه‌ی شما به‌روز است."); return; } if (!r.ok) throw 0; j = await r.json(); } catch (e) { msg("اینترنت در دسترس نیست."); return; }
    const n = parseInt(String(j.tag_name).replace(/\D/g, ""), 10), a = (j.assets || []).find(x => /\.apk$/i.test(x.name));
    if (n > code && a) { upd = a.browser_download_url; b.textContent = "نسخه‌ی جدید هست؛ نصب"; msg("نسخه‌ی " + X.fa(n) + " آماده است."); }
    else msg("نسخه‌ی شما به‌روز است.");
  } catch (e) { msg("بررسی انجام نشد."); } finally { b.disabled = false; }
}

document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-apk]"); if (!b || !X) return;
  const a = b.dataset.apk;
  if (a === "play") play(+b.dataset.i); else if (a === "upd") checkUpdate(); else run(a);
});

/* ---------- public API (called from index.html) ---------- */
const q = fn => { chain = chain.then(fn).catch(e => console.warn("apk:", e)); return chain; };
function indicator(on) {
  let e = $("#recInd");
  if (!e) { e = document.createElement("span"); e.id = "recInd"; e.className = "chip"; e.style.cssText = "color:var(--air);font-weight:700"; e.textContent = "● در حال ضبط"; $("#fHint").before(e); }
  e.hidden = !on;
}

window.N = {
  slug, fname, pack, native,
  bind(ctx) {
    X = ctx; if (!native) return;
    const row = $("#expBtn").parentNode;
    row.insertAdjacentHTML("beforeend", '<button class="btn sm" id="updBtn" data-apk="upd">بررسی به‌روزرسانی</button>');
    row.insertAdjacentHTML("afterend", '<p class="small muted" id="updMsg"></p>');
    P.info().then(r => msg("نسخه‌ی فعلی: " + X.fa(r.code))).catch(() => {});
    P.recList().then(r => { files = {}; r.files.forEach(f => { files[f.key.replace(/^d/, "").replace(/\.m4a$/, "")] = f.path; }); X.renderToday(); }).catch(() => {});
  },
  // window-level hooks -------------------------------------------------
  pre(cb) { // ask for the microphone before the first round starts; denial never blocks practice
    if (!native || micOk) { cb(); return; }
    if (asking) return; asking = true;
    P.micPerm().then(r => { micOk = !!r.granted; if (!micOk) X.toast("دسترسی میکروفون داده نشد؛ تمرین بدون ضبط ادامه دارد"); })
      .catch(() => {}).then(() => { asking = false; if (X.F.phase === "idle" && X.focusOpen()) cb(); });
  },
  focus(on) { if (native) P.keepAwake({ on }).catch(() => {}); if (on) stopAudio(); },
  speak(n) {
    const d = X.S().day; cur = { d, n, intr: "", at: 0, rec: false };
    if (!native || !micOk) return;
    const c = cur;
    q(() => P.recStart({ day: d, n }).then(() => { c.rec = true; if (cur === c) indicator(true); }, () => {}));
  },
  intr(t, el) { if (cur) { cur.intr = t; cur.at = Math.floor(el); } return t; },
  end(d, qq, secs) {
    const c = cur; cur = null; if (!native || !c) return;
    const i = X.roundsOf(d).length - 1; // endRound has already pushed this round
    q(async () => {
      indicator(false);
      if (!c.rec) return;
      const r = await P.recStop();
      if (r.ok) { files[d + "/r" + (i + 1)] = r.path; putSide(d, i, { q: qq, secs, date: isoDay(), intr: c.intr, at: c.at }); }
      renderToday(); renderRev();
    });
  },
  cancel() {
    const c = cur; cur = null; if (!native) return;
    q(() => { indicator(false); if (c && c.rec) { delete files[c.d + "/r" + c.n]; return P.recCancel(); } }).then(renderToday);
  },
  review() { renderRev(); },
  today() { renderToday(); },
  _back() { // hardware Back: true = handled here
    if (!X) return false;
    if (X.focusOpen()) { const ph = X.F.phase; if (ph !== "think" && ph !== "speak") X.closeFocus(); return true; }
    if (X.sheet()) { X.closeSheet(); return true; }
    return false;
  }
};

/* self-check */
console.assert(slug("ورزش باید در مدرسه بیشتر شود؟") === "ورزش-باید-در-مدرسه-بیشتر", "slug: 5 words");
console.assert(slug("آیا اشتباه کردن؟") === "آیا-اشتباه-کردن", "slug: fewer words");
console.assert(slug("«سر کلاس خودم…» (؟!) a/b:c") === "سر-کلاس-خودم-a-b", "slug: punctuation");
console.assert(slug("قطب‌نما  ‌ خوب") === "قطب‌نما-خوب", "slug: ZWNJ inside kept, stray ZWNJ dropped");
console.assert(slug("؟؟") === "q", "slug: empty");
console.assert(fname(10, 1, "prep", "ورزش در مدرسه؟") === "day10_r1_PREP_ورزش-در-مدرسه.m4a", "fname");
})();
