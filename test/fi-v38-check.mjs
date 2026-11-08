/**
 * Local sample checks for fi-v38 issue destinations.
 * Does not call the live Apps Script and does not deploy.
 * Run: NODE_PATH=/tmp/fi-test/node_modules node test/fi-v38-check.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = "/opt/cursor/artifacts";
fs.mkdirSync(art, {recursive: true});
const require = createRequire(import.meta.url);
const out = {pass: [], fail: []};
function ok(name, cond, extra) {
  if (cond) out.pass.push(name);
  else out.fail.push(name + (extra ? " — " + extra : ""));
}

/* ---------- Apps Script mock: admin re-sign-in + issue idempotency ---------- */
const props = {};
global.PropertiesService = {getScriptProperties: () => ({
  getProperty: k => (k in props ? props[k] : null),
  setProperty: (k, v) => { props[k] = String(v); },
  deleteProperty: k => { delete props[k]; },
  getProperties: () => ({...props})
})};
const cache = new Map();
global.CacheService = {getScriptCache: () => ({
  get: k => cache.has(k) ? cache.get(k) : null,
  put: (k, v) => { cache.set(k, String(v)); },
  remove: k => { cache.delete(k); }
})};
global.LockService = {getScriptLock: () => ({tryLock: () => true, waitLock: () => {}, releaseLock: () => {}})};
let uuidN = 0;
global.Utilities = {getUuid: () => (uuidN++).toString(16).padStart(32, "a")};
function makeSheet(name) {
  const rows = [];
  const sh = {
    getLastRow: () => rows.length,
    appendRow: r => { rows.push(r.slice()); },
    setFrozenRows() {}, clearContents() { rows.length = 0; }, hideSheet() {},
    getRange(r, c, nr, nc) {
      const range = {
        getValues() {
          const o = [];
          for (let i = 0; i < nr; i++) {
            const src = rows[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(src[c - 1 + j] === undefined ? "" : src[c - 1 + j]);
            o.push(line);
          }
          return o;
        },
        getDisplayValues() { return this.getValues().map(row => row.map(v => v == null ? "" : String(v))); },
        setNumberFormat() { return range; },
        setValues(v) {
          for (let i = 0; i < v.length; i++) {
            const ri = r - 1 + i;
            while (rows.length <= ri) rows.push([]);
            for (let j = 0; j < v[i].length; j++) rows[ri][c - 1 + j] = v[i][j];
          }
          return range;
        },
        setFontWeight() { return range; }, setBackground() { return range; }, setFontColor() { return range; }
      };
      return range;
    },
    rows
  };
  return sh;
}
const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n)),
  getName: () => "TMC Food Inventory Sheet",
  rename() {}, setActiveSheet() {}, moveActiveSheet() {}
};
global.SpreadsheetApp = {getActiveSpreadsheet: () => ss, getActive: () => ss};
const gas = require(path.join(root, "sync/Code.gs"));
const PIN = "ab".repeat(32);
const PIN2 = "cd".repeat(32);

const first = gas.openReq_({user: "userphone1aaa", device: "phone1dev", name: "JA Kirsten", pinH: PIN});
ok("admin first sign-in seeds ok", first && first.ok && first.status === "ok" && first.user === "userphone1aaa", JSON.stringify(first));
const wrong = gas.openReq_({user: "userphone9aaa", device: "phone9dev", name: "J.A. Kirsten", pinH: PIN2});
ok("admin wrong PIN does not rebind", wrong && wrong.status === "pin", JSON.stringify(wrong));
cache.clear();
const again = gas.readAll_();
const still = Object.values(again.map).map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).find(d => d && d.role === "admin");
ok("wrong PIN keeps the old device", still && still.dev === "phone1dev", JSON.stringify(still && still.dev));
const back = gas.openReq_({user: "userphone2aaa", device: "phone2dev", name: "Johan Kirsten", pinH: PIN});
ok("admin re-sign-in after new device returns the same user", back && back.ok && back.status === "ok" && back.user === "userphone1aaa", JSON.stringify(back));
const after = gas.readAll_();
const adm = Object.values(after.map).map(r => JSON.parse(r.data)).find(d => d.role === "admin");
ok("re-sign-in rebinds device and keeps admin", adm && adm.dev === "phone2dev" && adm.status === "ok" && adm.role === "admin");
const st = gas.openStatus_({user: "userphone1aaa", device: "phone2dev", pinH: PIN, tok: 1});
ok("re-sign-in status returns a token", st && st.ok && st.status === "ok" && /^[a-f0-9]{32,80}$/i.test(st.token || ""), JSON.stringify(st && st.status));
const sess = gas.handle_({token: st.token, device: "phone2dev", since: 0, changes: []});
ok("token session matches the admin", sess && sess.ok && sess.approved === true, JSON.stringify(sess && (sess.error || sess.approved)));

/* blocked admin is not silently restored */
const blockedStore = gas.readAll_();
const bRec = blockedStore.map["u:userphone1aaa"];
const bData = JSON.parse(bRec.data);
bData.status = "blocked";
bRec.data = JSON.stringify(bData);
bRec.dirty = true;
const shU = sheets._Records;
const dataRow = shU.rows.findIndex(r => String(r[0]) === "u:userphone1aaa");
shU.rows[dataRow][7] = bRec.data;
const denied = gas.openReq_({user: "userphone3aaa", device: "phone3dev", name: "JA Kirsten", pinH: PIN});
ok("blocked admin is not re-signed-in", denied && denied.status === "denied", JSON.stringify(denied));

/* restore ok for the destination idempotency check (blocked row would still accept movements) */
bData.status = "ok";
shU.rows[dataRow][7] = JSON.stringify(bData);

let store = gas.readAll_();
const at = new Date().toISOString();
const item = {kind: "i", id: "itemrice1", u: 50, data: {id: "itemrice1", kitchen: "Store Room", name: "SAMPLE Rice 25kg", cat: "Dry goods", unit: "kg", rl: 0}};
const oldHq = {kind: "m", id: "oldhq1", u: 60, data: {id: "oldhq1", type: "xfer", kitchen: "Store Room", item: "itemrice1", qty: 2, to: "HQ Kitchen", at, by: "JA Kirsten"}};
const srv = {kind: "m", id: "srv1", u: 70, data: {id: "srv1", type: "xfer", kitchen: "Store Room", item: "itemrice1", qty: 4, to: "Services", at, by: "JA Kirsten", xfer: "x1"}};
gas.merge_(store, [item, oldHq, srv], "phone2dev", 80);
gas.merge_(store, [srv], "phone2dev", 81); // same u retry
const mCount = Object.keys(store.map).filter(k => k.startsWith("m:") && !store.map[k].del).length;
ok("server retry of the same issue id does not add a second row", mCount === 2, "m=" + mCount);
gas.rebuildViews_(store);
const summary = sheets.Summary.rows.map(r => r[0]);
ok("summary keeps kitchens and adds Services and Workshops", summary.includes("Store Room") && summary.includes("HQ Kitchen") && summary.includes("Services") && summary.includes("Workshops") && summary.indexOf("HQ Kitchen") < summary.indexOf("Services"), summary.join(" | "));
const issues = sheets.Issues.rows.slice(1).map(r => r[3] + ":" + r[4]);
ok("issues tab keeps HQ history and records Services", issues.some(x => x.startsWith("HQ Kitchen:")) && issues.some(x => x.startsWith("Services:")), issues.join(" | "));
const usage = sheets["Kitchen usage"].rows.slice(1).map(r => r[1]);
ok("kitchen usage tab lists Services", usage.includes("Services") && usage.includes("HQ Kitchen"), usage.join(" | "));

/* ---------- browser: real issue flow, isolation, screenshots ---------- */
const puppeteer = require("puppeteer-core");
const mime = {html: "text/html", js: "text/javascript", json: "application/json", png: "image/png", svg: "image/svg+xml", jpg: "image/jpeg"};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = path.join(root, u === "/" ? "index.html" : u.replace(/^\/+/, ""));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, {"content-type": mime[path.extname(f).slice(1)] || "application/octet-stream", "cache-control": "no-store"});
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const net = {offline: false, posts: 0};
const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const page = await browser.newPage();
await page.setViewport({width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true});
page.on("dialog", d => d.accept());
const pageErr = [];
page.on("pageerror", e => pageErr.push(String(e)));
await page.setRequestInterception(true);
page.on("request", req => {
  const u = req.url();
  if (u.includes("script.google.com") || u.includes("127.0.0.1:9")) {
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
    if (body.action || net.offline) return req.abort();
    net.posts++;
    return req.respond({status: 200, contentType: "application/json", headers: {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type"}, body: JSON.stringify({ok: true, now: Date.now(), accepted: (body.changes || []).length, approved: true, records: []})});
  }
  return req.continue();
});
await page.evaluateOnNewDocument(() => {
  const sw = navigator.serviceWorker;
  if (sw) {
    sw.register = () => Promise.resolve(null);
    sw.getRegistration = () => Promise.resolve(undefined);
    sw.addEventListener = () => {};
    try { Object.defineProperty(sw, "controller", {get: () => null}); } catch (e) {}
  }
  localStorage.setItem("fi_mig", "1");
  localStorage.setItem("fi_cfg", JSON.stringify({url: "http://127.0.0.1:9/sync", code: "SAMPLE", since: 0}));
  localStorage.setItem("fi_lang", "en");
  localStorage.setItem("grv_me", "keep-grv");
  localStorage.setItem("tmcservice_me", "keep-svc");
  localStorage.setItem("me", "otherapp");
});
await page.goto("http://127.0.0.1:" + port + "/", {waitUntil: "domcontentloaded"});
await page.waitForSelector("#nm", {timeout: 15000});
await page.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open("grv_photos", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("p");
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction("p", "readwrite");
    tx.objectStore("p").put("keep-grv-photo", "k1");
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
}));
await page.reload({waitUntil: "domcontentloaded"});
await page.waitForSelector("#nm", {timeout: 15000});
await page.type("#nm", "JA Kirsten");
await page.click("#nmGo");
await page.waitForSelector("#nk", {timeout: 10000});
await page.type("#nk", "1234");
await page.evaluate(() => signup());
await page.waitForFunction(() => document.querySelector("#hello") && document.querySelector("#hello").textContent.includes("JA Kirsten"), {timeout: 15000});

await page.evaluate(() => go("stock"));
await page.waitForFunction(() => typeof itemForm === "function");
await page.evaluate(() => itemForm());
await page.waitForSelector("#fn");
await page.type("#fn", "SAMPLE Rice 25kg");
await page.type("#fq", "20");
await page.evaluate(() => saveItem(""));
await page.waitForFunction(() => document.body.innerText.includes("SAMPLE Rice 25kg"));
const stock0 = await page.evaluate(() => {
  const i = items().find(x => x.name === "SAMPLE Rice 25kg");
  return i ? qtyOf(i) : null;
});
ok("opening stock is 20 once", stock0 === 20, String(stock0));

await page.evaluate(() => go("move"));
await page.waitForSelector("#destPick");
const dests = await page.$$eval("#destPick [data-dest]", ns => ns.map(n => n.getAttribute("data-dest")));
ok("destination buttons keep kitchens then add Services and Workshops", JSON.stringify(dests) === JSON.stringify(["HQ Kitchen", "GZ Kitchen", "Expats Kitchen", "1Alfa Camp Kitchen", "Services", "Workshops"]), JSON.stringify(dests));
const btnH = await page.$eval("#destPick [data-dest='Services']", e => e.getBoundingClientRect().height);
ok("destination buttons are large", btnH >= 64, "h=" + btnH);

async function shot(sel, file) {
  await page.evaluate(s => {
    const toast = document.querySelector("#toast"); if (toast) toast.style.display = "none";
    document.getElementById("sampleFlag")?.remove();
    const n = document.querySelector(s);
    n.insertAdjacentHTML("afterbegin", '<div id="sampleFlag" style="background:#fde68a;color:#78350f;font-weight:800;font-size:15px;line-height:1.3;padding:8px 10px;border-radius:8px;margin:0 0 8px;text-align:center">SAMPLE ONLY — not live data</div>');
  }, sel);
  const el = await page.$(sel);
  await el.screenshot({path: path.join(art, file)});
  await page.evaluate(() => document.getElementById("sampleFlag")?.remove());
}
await shot("#destPick", "food_destinations_sample.png");

async function issue(dest, qty) {
  await page.evaluate(d => startXfer(d), dest);
  await page.waitForSelector("#xfTo");
  const title = await page.$eval("#xfTo", e => e.textContent);
  const backBg = await page.$eval("#xfBk", e => getComputedStyle(e).backgroundColor);
  await page.evaluate(() => {
    const s = document.querySelector("#xi0");
    s.value = [...s.options].find(o => o.textContent.includes("SAMPLE Rice")).value;
    s.dispatchEvent(new Event("change", {bubbles: true}));
  });
  await page.waitForSelector("#xq0");
  await page.evaluate(q => {
    const e = document.querySelector("#xq0");
    e.value = q;
    e.dispatchEvent(new Event("input", {bubbles: true}));
  }, String(qty));
  return {title, backBg};
}
let opened = await issue("Services", 3, 2);
ok("Services opens its own screen", opened.title.includes("Services"), opened.title);
ok("issue screen Back is grey", opened.backBg === "rgb(229, 231, 235)", opened.backBg);
await shot("main#m", "food_issue_services_sample.png");
const beforeSvc = await page.evaluate(() => all("m").filter(m => m.type === "xfer").length);
await page.evaluate(() => { saveXfer(); saveXfer(); });
await page.waitForSelector("#destPick");
const afterSvc = await page.evaluate(() => {
  const i = items().find(x => x.name === "SAMPLE Rice 25kg");
  const xs = all("m").filter(m => m.type === "xfer" && m.to === "Services");
  return {qty: qtyOf(i), n: xs.length, q: xs.reduce((a, m) => a + +m.qty, 0), tab: document.querySelector("#destPick") ? "move" : "no"};
});
ok("Services save returns to the destination list", afterSvc.tab === "move");
ok("Services issue decrements stock once", afterSvc.qty === 17 && afterSvc.n === 1 && afterSvc.q === 3, JSON.stringify(afterSvc));
ok("second save on the same submit does not add another issue", beforeSvc + 1 === afterSvc.n);

opened = await issue("HQ Kitchen", 2);
ok("existing kitchen still opens an issue screen", opened.title.includes("HQ Kitchen"), opened.title);
await page.click("#xfSave");
await page.waitForSelector("#destPick");
const hq = await page.evaluate(() => {
  const xs = all("m").filter(m => m.type === "xfer" && m.to === "HQ Kitchen");
  const i = items().find(x => x.name === "SAMPLE Rice 25kg");
  return {n: xs.length, q: xs[0] && +xs[0].qty, id: xs[0] && xs[0].id, qty: qtyOf(i)};
});
ok("HQ Kitchen issue decrements once and keeps its id", hq.n === 1 && hq.q === 2 && hq.qty === 15, JSON.stringify(hq));

await page.evaluate(() => startXfer("Workshops"));
await page.waitForSelector("#xfBk");
await page.evaluate(() => {
  const s = document.querySelector("#xi0");
  s.value = [...s.options].find(o => o.textContent.includes("SAMPLE Rice")).value;
  s.dispatchEvent(new Event("change", {bubbles: true}));
});
await page.waitForSelector("#xq0");
await page.evaluate(() => { const e = document.querySelector("#xq0"); e.value = "9"; e.dispatchEvent(new Event("input", {bubbles: true})); });
await page.click("#xfBk");
await page.waitForSelector("#destPick");
const backed = await page.evaluate(() => all("m").filter(m => m.to === "Workshops").length);
ok("grey Back leaves without issuing", backed === 0, "n=" + backed);

await page.evaluate(() => startXfer("Workshops"));
await page.waitForSelector("#xi0");
await page.evaluate(() => {
  const s = document.querySelector("#xi0");
  s.value = [...s.options].find(o => o.textContent.includes("SAMPLE Rice")).value;
  s.dispatchEvent(new Event("change", {bubbles: true}));
});
await page.waitForSelector("#xq0");
await page.evaluate(() => { const e = document.querySelector("#xq0"); e.value = "1"; e.dispatchEvent(new Event("input", {bubbles: true})); });
await page.click("#xfSave");
await page.waitForSelector("#destPick");
const mid = await page.evaluate(() => {
  const i = items().find(x => x.name === "SAMPLE Rice 25kg");
  const hq1 = all("m").find(m => m.id && m.to === "HQ Kitchen");
  const xs = all("m").filter(m => m.type === "xfer");
  return {qty: qtyOf(i), n: xs.length, hqId: hq1.id, hqQty: +hq1.qty, tos: xs.map(m => m.to).sort()};
});
ok("three issues drop 20 to 14 and HQ history is unchanged", mid.qty === 14 && mid.n === 3 && mid.hqId === hq.id && mid.hqQty === 2, JSON.stringify(mid));
ok("issues landed on HQ, Services and Workshops", JSON.stringify(mid.tos) === JSON.stringify(["HQ Kitchen", "Services", "Workshops"]), JSON.stringify(mid.tos));

net.offline = true;
await page.evaluate(() => sync());
await new Promise(r => setTimeout(r, 1800));
await page.evaluate(() => sync());
const pendOff = await page.evaluate(() => window.TMC.pending());
const offQty = await page.evaluate(() => qtyOf(items().find(x => x.name === "SAMPLE Rice 25kg")));
ok("offline retry keeps the issues queued and does not change stock", pendOff >= 3 && offQty === 14, "pending=" + pendOff + " qty=" + offQty);
net.offline = false;
await page.evaluate(() => sync());
const pendOn = await page.evaluate(() => window.TMC.pending());
await page.evaluate(() => sync());
const retry = await page.evaluate(() => {
  const i = items().find(x => x.name === "SAMPLE Rice 25kg");
  return {qty: qtyOf(i), n: all("m").filter(m => m.type === "xfer").length, pending: window.TMC.pending()};
});
ok("successful retry clears the queue without a second decrement", pendOn === 0 && retry.qty === 14 && retry.n === 3 && retry.pending === 0, JSON.stringify({pendOn, retry, posts: net.posts}));

await page.evaluate(() => go("move"));
await page.waitForSelector("#mvRecent");
await shot("#mvRecent", "food_issue_history_sample.png");
const recent = await page.$eval("#mvRecent", e => e.innerText);
ok("recent history names each destination", ["SAMPLE Rice", "Services", "Workshops", "HQ Kitchen"].every(s => recent.includes(s)), recent.slice(0, 500));
const hos = await page.evaluate(() => all("ho").map(h => ({to: h.destination, st: h.status, app: h.destinationApp, n: (h.lines || []).length, issue: h.sourceIssueId === h.id})));
ok("new Services and Workshops issues queue a handover", hos.length === 2 && hos.every(h => h.st === "queued" && h.n === 1 && h.issue) && hos.some(h => h.to === "Services" && h.app === "tmcservice") && hos.some(h => h.to === "Workshops" && h.app === "tmcworkshop"), JSON.stringify(hos));
ok("queued handover is not marked received", recent.includes("Queued") && !recent.includes("In their stock"), recent.slice(0, 500));

await page.evaluate(() => { rp.id = "where"; go("reports"); });
await page.waitForSelector("#rpOut");
const whereTxt = await page.$eval("#rpOut", e => e.innerText);
ok("where report lists Services and Workshops", whereTxt.includes("Services") && whereTxt.includes("Workshops") && whereTxt.includes("HQ Kitchen") && whereTxt.includes("SAMPLE Rice"), whereTxt.slice(0, 500));
await page.evaluate(() => { rp.id = "peritem"; render(); });
await page.waitForSelector("#rpOut");
const perTxt = await page.$eval("#rpOut", e => e.innerText);
ok("per-item report has Services and Workshops columns", perTxt.includes("Services") && perTxt.includes("Workshops") && perTxt.includes("3") && perTxt.includes("SAMPLE Rice"), perTxt.slice(0, 500));
await page.evaluate(() => { rp.id = "issk"; render(); });
await page.waitForSelector("#rpOut");
const issTxt = await page.$eval("#rpOut", e => e.innerText);
ok("issued-per-place report keeps zero kitchens and counts new places", issTxt.includes("Services") && issTxt.includes("Workshops") && issTxt.includes("GZ Kitchen"), issTxt.slice(0, 500));

await page.evaluate(() => go("stock"));
await page.waitForSelector("#tb");
await page.evaluate(() => {
  const toast = document.querySelector("#toast"); if (toast) toast.style.display = "none";
  document.getElementById("sampleFlag")?.remove();
  const n = document.querySelector("#tb").closest(".card");
  n.id = "stockCard";
  n.insertAdjacentHTML("afterbegin", '<div id="sampleFlag" style="background:#fde68a;color:#78350f;font-weight:800;font-size:15px;padding:8px 10px;border-radius:8px;margin:0 0 8px;text-align:center">SAMPLE ONLY — not live data</div>');
});
await (await page.$("#stockCard")).screenshot({path: path.join(art, "food_stock_after_issue_sample.png")});
await page.evaluate(() => document.getElementById("sampleFlag")?.remove());
const stockTxt = await page.$eval("#tb", e => e.innerText);
ok("stock screen shows 14 for the sample item", /SAMPLE Rice[\s\S]*14/.test(stockTxt), stockTxt.slice(0, 300));

await page.evaluate(() => setL("fr"));
await page.evaluate(() => go("move"));
await page.waitForSelector("#destPick");
const fr = await page.$eval("#destPick [data-dest='Workshops']", e => e.textContent);
ok("French label for Workshops is Ateliers", fr.includes("Ateliers"), fr);
await page.evaluate(() => setL("en"));

await page.evaluate(() => go("users"));
await page.waitForSelector("#nu-n");
const kitLabel = await page.evaluate(() => document.body.innerText.includes("Places they may issue to"));
ok("permission place list is labelled for every destination", kitLabel);
await page.evaluate(() => {
  document.querySelector("#nu-n").value = "Sam Staff";
  document.querySelector("#nu-k").value = "4321";
  document.querySelector('#pe-new input[data-k="HQ Kitchen"]').checked = true;
  document.querySelector('#pe-new input[data-p="xfer"]').checked = true;
  document.querySelector('#pe-new input[data-p="view"]').checked = true;
});
await page.evaluate(() => addU());
await page.waitForFunction(() => document.body.innerText.includes("Sam Staff"));
await page.evaluate(() => logOut());
await page.waitForSelector("#nm", {timeout: 10000});
await page.type("#nm", "Sam Staff");
await page.click("#nmGo");
await page.waitForSelector("#nk");
await page.type("#nk", "4321");
await page.evaluate(() => signup());
await page.waitForFunction(() => document.querySelector("#hello") && document.querySelector("#hello").textContent.includes("Sam"), {timeout: 15000});
await page.evaluate(() => go("move"));
await page.waitForSelector("#destPick");
const samDest = await page.$$eval("#destPick [data-dest]", ns => ns.map(n => n.getAttribute("data-dest")));
ok("a person limited to HQ Kitchen does not see Services or Workshops", JSON.stringify(samDest) === JSON.stringify(["HQ Kitchen"]), JSON.stringify(samDest));
await page.evaluate(() => startXfer("Services"));
const noSvc = await page.evaluate(() => !document.querySelector("#xfTo"));
ok("limited person cannot open Services", noSvc);

const ls = await page.evaluate(() => {
  const keys = Object.keys(localStorage);
  return {
    grv: localStorage.getItem("grv_me"),
    svc: localStorage.getItem("tmcservice_me"),
    bare: localStorage.getItem("me"),
    foreign: keys.filter(k => !k.startsWith("fi_") && !["grv_me", "tmcservice_me", "me"].includes(k))
  };
});
ok("other app localStorage keys stay put", ls.grv === "keep-grv" && ls.svc === "keep-svc" && ls.bare === "otherapp" && ls.foreign.length === 0, JSON.stringify(ls));
const dbs = await page.evaluate(async () => {
  const names = (await indexedDB.databases()).map(d => d.name).sort();
  const grv = await new Promise((resolve, reject) => {
    const r = indexedDB.open("grv_photos", 1);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction("p");
      const q = tx.objectStore("p").get("k1");
      q.onsuccess = () => { db.close(); resolve(q.result); };
    };
  });
  return {names, grv};
});
ok("food uses its own database and leaves the GRV photo store", dbs.names.includes("food-inv") && dbs.names.includes("grv_photos") && dbs.grv === "keep-grv-photo", JSON.stringify(dbs));

await browser.close();
server.close();

const dims = {};
for (const f of ["food_destinations_sample.png", "food_issue_services_sample.png", "food_issue_history_sample.png", "food_stock_after_issue_sample.png"]) {
  const b = fs.readFileSync(path.join(art, f));
  dims[f] = {w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length};
  ok("screenshot " + f + " is sharp and phone-width", dims[f].w >= 900 && dims[f].w <= 1400 && dims[f].h >= 200 && dims[f].h <= 2800, JSON.stringify(dims[f]));
}

const report = {pass: out.pass.length, fail: out.fail, dims, pageErr: pageErr.slice(0, 8)};
fs.writeFileSync(path.join(art, "fi-v38-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (out.fail.length) process.exit(1);
