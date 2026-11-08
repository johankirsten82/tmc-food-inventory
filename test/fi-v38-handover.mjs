/**
 * Mocked Food -> Service and Food -> Workshop stock transfer.
 * No live URL, no live import code, no deploy.
 * Run: node test/fi-v38-handover.mjs
 */
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
function ok(name, cond, extra) { if (!cond) fail.push(name + (extra ? " — " + extra : "")); }

const props = {};
global.PropertiesService = {getScriptProperties: () => ({
  getProperty: k => (k in props ? props[k] : null),
  setProperty: (k, v) => { props[k] = String(v); },
  deleteProperty: k => { delete props[k]; },
  getProperties: () => ({...props})
})};
global.CacheService = {getScriptCache: () => ({get: () => null, put() {}, remove() {}})};
global.LockService = {getScriptLock: () => ({tryLock: () => true, waitLock() {}, releaseLock() {}})};
global.Utilities = {getUuid: () => "a".repeat(32)};
function makeSheet() {
  const rows = [];
  return {
    getLastRow: () => rows.length,
    appendRow: r => rows.push(r.slice()),
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
    }
  };
}
const sheets = {};
global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet()),
    getName: () => "TMC Food Inventory Sheet",
    rename() {}, setActiveSheet() {}, moveActiveSheet() {}
  })
};

function milli(s) {
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(String(s || "")) || s === "0") return null;
  const [a, b = ""] = String(s).split(".");
  return (+a) * 1000 + (+(b + "000").slice(0, 3));
}
function fold(s) { return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim(); }
function makeReceiver(app, code) {
  const items = [];
  const applied = new Set();
  const bindings = {};
  return {app, items, applied, bindings, post(body) {
    if (!body || body.action !== "importStockTransfer") return {ok: false, error: "bad_request"};
    if (body.code !== code) return {ok: false, error: "bad_code"};
    const t = body.transfer;
    if (!t || t.destinationApp !== app) return {ok: false, error: "wrong_app"};
    if (applied.has(t.id)) return {ok: true, transferId: t.id, result: "duplicate"};
    const plan = [];
    for (const l of t.lines || []) {
      const q = milli(l.qty);
      if (q == null || q <= 0) return {ok: false, error: "bad_qty"};
      let local = bindings[l.sourceItemId] || null;
      if (!local) {
        const hits = items.filter(i => fold(i.name) === fold(l.name) && i.unit === l.unit && !Object.values(bindings).includes(i.id));
        if (hits.length > 1) return {ok: false, error: "ambiguous_item"};
        local = hits.length === 1 ? hits[0].id : null;
      }
      plan.push({l, q, local});
    }
    for (const p of plan) {
      if (p.local) {
        bindings[p.l.sourceItemId] = p.local;
        items.find(i => i.id === p.local).milli += p.q;
      } else {
        const id = "fi-" + p.l.sourceItemId;
        items.push({id, name: p.l.name, unit: p.l.unit, milli: p.q});
        bindings[p.l.sourceItemId] = id;
      }
    }
    applied.add(t.id);
    return {ok: true, transferId: t.id, result: "accepted"};
  }};
}

const service = makeReceiver("tmcservice", "sample-service-code");
const workshop = makeReceiver("sample-workshop", "sample-workshop-code");
service.items.push({id: "part-rice", name: "SAMPLE Rice 25kg", unit: "kg", milli: 0});
const calls = [];
global.UrlFetchApp = {fetch(url, opt) {
  const body = JSON.parse(opt.payload);
  calls.push({url, body});
  const rec = url.endsWith("/service") ? service : url.endsWith("/workshop") ? workshop : null;
  const j = rec ? rec.post(body) : {ok: false, error: "bad_request"};
  return {getResponseCode: () => 200, getContentText: () => JSON.stringify(j)};
}};

const gas = require(path.join(root, "sync/Code.gs"));
ok("decimal strings keep 3 places", gas.qtyStr_(1.25) === "1.25" && gas.qtyStr_(10) === "10" && gas.qtyStr_(1.2346) === "1.235", gas.qtyStr_(1.25) + " " + gas.qtyStr_(10));

let store = gas.readAll_();
const at = "2026-11-08T11:31:00.000Z";
const old = {kind: "m", id: "oldhist01", u: 10, data: {id: "oldhist01", type: "xfer", kitchen: "Store Room", item: "itemrice01", qty: 4, to: "Services", at, by: "Past Staff", xfer: "oldissue01"}};
const move = {kind: "m", id: "line000001", u: 20, data: {id: "line000001", type: "xfer", kitchen: "Store Room", item: "itemrice01", qty: 1.25, to: "Services", at, by: "JA Kirsten", xfer: "issue00001"}};
const hoS = {kind: "ho", id: "issue00001", u: 21, data: {id: "issue00001", v: 1, destination: "Services", destinationApp: "tmcservice", status: "queued", at, by: "JA Kirsten", sourceIssueId: "issue00001", qtyScale: 3, lines: [{id: "line000001", sourceItemId: "itemrice01", name: "SAMPLE Rice 25kg", unit: "kg", qty: 1.25}]}};
const hoW = {kind: "ho", id: "issue00002", u: 22, data: {id: "issue00002", v: 1, destination: "Workshops", destinationApp: "", status: "queued", at, by: "JA Kirsten", sourceIssueId: "issue00002", qtyScale: 3, lines: [{id: "line000002", sourceItemId: "itemoil0001", name: "SAMPLE Oil", unit: "L", qty: 2}]}};
gas.merge_(store, [old, move, hoS, hoW], "phone", 30);
gas.writeRecs_ ? null : null;

props.SERVICE_STOCK_URL = "http://sample.test/service";
props.SERVICE_STOCK_CODE = "sample-service-code";
let r1 = gas.pushHandovers_(store);
const svcQty = service.items.find(i => i.id === "part-rice").milli;
ok("Service credits the one matching item once", r1.posted === 1 && svcQty === 1250 && service.applied.has("issue00001"), JSON.stringify({r1, svcQty}));
ok("historical Services issue was not exported", !calls.some(c => JSON.stringify(c.body).includes("oldissue01")));
ok("Workshop was not called before its app id exists", !calls.some(c => c.url.endsWith("/workshop")), calls.map(c => c.url).join(","));
ok("payload is only the stock action and sample code", calls.length === 1 && calls[0].body.action === "importStockTransfer" && calls[0].body.code === "sample-service-code" && !JSON.stringify(calls[0].body).match(/pin|token|TEAM_CODE/i));
const hoAccepted = JSON.parse(store.map["ho:issue00001"].data);
ok("sender marks accepted only after the ack", hoAccepted.status === "accepted" && hoAccepted.ack === 1);
ok("Food movement was not duplicated by the push", Object.keys(store.map).filter(k => k.startsWith("m:")).length === 2);

const before = svcQty;
gas.pushHandovers_(store);
ok("retry does not credit Service again", service.items.find(i => i.id === "part-rice").milli === before && service.applied.size === 1);

props.WORKSHOP_APP_ID = "sample-workshop";
props.WORKSHOP_STOCK_URL = "http://sample.test/workshop";
props.WORKSHOP_STOCK_CODE = "sample-workshop-code";
const lied = JSON.parse(store.map["ho:issue00002"].data);
lied.status = "accepted"; lied.ack = 1;
gas.merge_(store, [{kind: "ho", id: "issue00002", u: 40, data: lied}], "phone", 41);
const rW = gas.pushHandovers_(store);
const oil = workshop.items.find(i => i.name === "SAMPLE Oil");
ok("a phone cannot mark Workshop received; the receiver creates the line once", oil && oil.milli === 2000 && workshop.applied.size === 1, JSON.stringify(oil));
ok("Service stock did not gain the Workshop line", service.items.every(i => i.name !== "SAMPLE Oil"));
ok("second push posted the workshop transfer", rW.posted >= 1);

const amb = makeReceiver("tmcservice", "sample-service-code");
amb.items.push({id: "a", name: "Beans", unit: "kg", milli: 1000}, {id: "b", name: "Beans", unit: "kg", milli: 1000});
global.UrlFetchApp = {fetch(url, opt) {
  const body = JSON.parse(opt.payload);
  calls.push({url, body});
  const j = amb.post(body);
  return {getResponseCode: () => 200, getContentText: () => JSON.stringify(j)};
}};
delete props.HANDOVER_ACK;
props.HANDOVER_ACK = "{}";
const hoB = {kind: "ho", id: "issue00003", u: 50, data: {id: "issue00003", v: 1, destination: "Services", status: "queued", at, by: "JA Kirsten", sourceIssueId: "issue00003", qtyScale: 3, lines: [{id: "line000003", sourceItemId: "itembean01", name: "Beans", unit: "kg", qty: 1}]}};
gas.merge_(store, [hoB], "phone", 51);
gas.pushHandovers_(store);
const bean = JSON.parse(store.map["ho:issue00003"].data);
ok("two same names are refused and neither is credited", bean.status === "rejected" && bean.error === "ambiguous_item" && amb.items.filter(i => i.name === "Beans").every(i => i.milli === 1000) && !amb.applied.has("issue00003"), JSON.stringify(bean));
amb.items.splice(amb.items.findIndex(i => i.id === "b"), 1);
gas.pushHandovers_(store);
const bean2 = JSON.parse(store.map["ho:issue00003"].data);
ok("the same transfer is accepted once the name is no longer ambiguous", bean2.status === "accepted" && amb.applied.has("issue00003") && amb.items.find(i => i.id === "a").milli === 2000, JSON.stringify({bean2, items: amb.items}));

console.log(JSON.stringify({pass: fail.length ? "failed" : "ok", fail}, null, 2));
if (fail.length) process.exit(1);
