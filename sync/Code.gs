/**
 * SERVER v12 (fi-v34): a session token ALWAYS wins over the team code (viaCode only when no token is sent).
 *   Admin fixes need the Admin's token; fixes sent with the team code are refused (refusedWhy 'admin_only_fix').
 *   Via the team code a phone may only touch its OWN user record and never an Admin record.
 *   setupOnce seeds the first Admin (JA Kirsten, no PIN yet); the first JA Kirsten sign-in with a PIN claims it.
 * SERVER v6 (fi-v23, TMC base v4 port): name + PIN -> session token (Script Properties TOK_*); token OR team code accepted.
 *   After ANY change: Deploy > Manage deployments > Edit > Version: NEW version > Deploy (same /exec link).
 * TMC Food Inventory – Google Sheet sync (own sheet, own code – NOT the Purshes one)
 * Paste into Extensions > Apps Script of a NEW Google Sheet.
 * 1) SERVER v11 (fi-v32): NO real code is in this file. The team code and the import code live ONLY in
 *    Script Properties TEAM_CODE / IMPORT_CODE (and PURSHES_IMPORT_CODE). One time: add the small file
 *    Setup-once.gs (built at deploy time from .secrets.env, never committed), Run setupNow, Allow, then DELETE
 *    Setup-once.gs from the project and Save. Placeholders: '__TMC_TEAM_CODE__' / '__TMC_IMPORT_CODE__'.
 *    STRICT_TOKEN Script Property = 1 → the team code may no longer change users; default off.
 * 2) Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Records: i = stock item, m = movement (in / use / xfer), u = user,
 *          incoming = paid purchase waiting at the Store Room, d = delivery received,
 *          shortage = paid but not delivered (id "s-<purchaseId>", one per purchase).
 * Shortages are pushed to the Purshes /exec (see INTEGRATION.md) when PURSHES_EXEC_URL is set.
 * Import (for the Purshes script): POST {action:'importIncoming', code:IMPORT_CODE, items:[...]}
 *   each item {id, item, size, qty, unit, paidDate, by, batch}. Insert-only and idempotent:
 *   an id already here is skipped, so re-sending never undoes what the storeman received.
 */
var TEAM_CODE = '';  // v11: never in the file – Script Property TEAM_CODE only (see setupOnce)
var TEAM_CODE_SETUP = '__TMC_TEAM_CODE__';   // v12 (base suite): placeholder only, the real code comes from Setup-once.gs at deploy time
var IMPORT_CODE = '';  // never a real code here: Script Property IMPORT_CODE only (set by setupOnce)
// Leave blank until the Purshes side is built. Script Properties PURSHES_EXEC_URL / PURSHES_IMPORT_CODE win.
var PURSHES_EXEC_URL = '';
var PURSHES_IMPORT_CODE = '';
/* Non-food items are not tracked in Food Inventory (ignored on import, hidden in views, never pushed as shortages). */
var NONFOOD = ['welding', 'shovel', 'cable', 'plug', 'blanket', 'sheep food', 'tubing', 'grease', 'socket'];
function isNonFood_(name) { var l = String(name || '').toLowerCase(); return NONFOOD.some(function (w) { return l.indexOf(w) >= 0; }); }
var KITCHENS = ['Store Room', 'HQ Kitchen', 'GZ Kitchen', 'Expats Kitchen', '1Alfa Camp Kitchen'];
var REC = '_Records';   // raw data used by the app (do not edit by hand)
var REC_HEAD = ['Key', 'Kind', 'Id', 'UpdatedAt', 'Deleted', 'ServerTime', 'Device', 'Json'];

function teamCode_() {   /* v11: Script Property only */
  return String(PropertiesService.getScriptProperties().getProperty('TEAM_CODE') || '').trim();
}
function importCode_() {   /* v11: Script Property only (IMPORT_CODE above stays '') */
  return String(PropertiesService.getScriptProperties().getProperty('IMPORT_CODE') || '').trim();
}
function importIncoming_(req) {
  var ic = importCode_(); if (!ic || String(req.code || '').trim() !== ic) return { ok: false, error: 'bad_code' };   /* no property → import closed */
  var lock = LockService.getScriptLock(); if (!lock.tryLock(25000)) return { ok: false, error: 'busy_try_again' };
  try {
    var store = readAll_(), now = Date.now(), ch = [], skipped = 0;
    (req.items || []).forEach(function (x) {
      if (!x || !x.id || !x.item) return;
      if (isNonFood_(x.item) || String(x.category || '').toLowerCase() === 'non-food') { skipped++; return; }
      var id = 'p-' + String(x.id).replace(/^p-/, '');
      if (store.map['incoming:' + id]) { skipped++; return; }
      ch.push({ kind: 'incoming', id: id, u: now, data: { id: id, item: String(x.item), size: String(x.size || ''), qty: +x.qty || 0, unit: String(x.unit || ''),
        paidDate: String(x.paidDate || '').slice(0, 10), by: String(x.by || ''), batch: String(x.batch || ''), status: 'open', recvQty: 0, src: 'purshes' } });
    });
    var acc = merge_(store, ch, 'purshes-import', now);
    if (acc) { writeRecs_(store); try { rebuildViews_(store); } catch (e) {} }
    return { ok: true, added: acc, skipped: skipped };
  } finally { lock.releaseLock(); }
}
/* ===== Shortages -> Purshes (resend-safe) =====
   Sends {action:'importShortages', code, items:[{id:'s-<purchaseId>', purchaseId, item, size, unit, short, batch, driver, date, status}]}.
   Purshes keys on purchaseId and REPLACES the qty (never adds), so sending again is harmless.
   We remember the last qty sent per shortage id and only send new or changed ones. */
function prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d; }
function sentMap_() { try { return JSON.parse(prop_('SHORT_SENT', '{}')); } catch (e) { return {}; } }
function pushShortages_(store) {
  var url = String(prop_('PURSHES_EXEC_URL', PURSHES_EXEC_URL)).trim(), code = String(prop_('PURSHES_IMPORT_CODE', PURSHES_IMPORT_CODE)).trim();
  if (!url || !code) return { ok: false, skipped: 'not_configured' };
  store = store || readAll_();
  var sent = sentMap_(), items = [];
  Object.keys(store.map).forEach(function (k) { var r = store.map[k]; if (r.kind !== 'shortage' || r.del) return; var z = safeParse_(r.data); if (!z || isNonFood_(z.item)) return;
    var q = z.status === 'open' ? +z.short || 0 : 0;
    if (sent[z.id] === undefined ? q > 0 : Number(sent[z.id]) !== q) items.push({ id: z.id, purchaseId: z.purchaseId, item: z.item, size: z.size, unit: z.unit, short: q, batch: z.batch, driver: z.driver, date: z.date, status: q > 0 ? 'open' : 'resolved' }); });
  if (!items.length) return { ok: true, sent: 0 };
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true, followRedirects: true,
    payload: JSON.stringify({ action: 'importShortages', code: code, from: 'TMC Food Inventory', items: items }) });
  var j = safeParse_(res.getContentText());
  if (!j || !j.ok) return { ok: false, error: (j && j.error) || ('http_' + res.getResponseCode()) };
  items.forEach(function (x) { sent[x.id] = x.short; });
  PropertiesService.getScriptProperties().setProperty('SHORT_SENT', JSON.stringify(sent));
  try { rebuildViews_(store); } catch (e) {}
  return { ok: true, sent: items.length };
}
/** Optional: add a time trigger (every 15 min) on this so failed sends are retried. */
function retryShortages() { return pushShortages_(); }
function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function sheet_(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function readAll_() {
  var sh = sheet_(REC, REC_HEAD), n = sh.getLastRow(), map = {}, rows = [];
  var txt = [];
  if (n > 1) { var rg = sh.getRange(2, 1, n - 1, REC_HEAD.length); rows = rg.getValues(); txt = rg.getDisplayValues(); }  /* v10 (TMC base date fix) */
  rows.forEach(function (r, i) {
    /* text columns as typed (never Sheets' Date objects); Id taken from Key, so an Id that Sheets once turned into a date is exact again.
       Numbers (u, del, s) stay real numbers: old rows hold big timestamps that Sheets may DISPLAY shortened (1.76E+12). */
    var t = txt[i] || [], key = String(t[0] !== undefined && t[0] !== '' ? t[0] : r[0]), kind = String(t[1] !== undefined ? t[1] : r[1]);
    var id = key.indexOf(kind + ':') === 0 ? key.slice(kind.length + 1) : String(t[2] !== undefined ? t[2] : r[2]);
    var num = function (x, y) { var v = Number(x); return isNaN(v) ? Number(y) || 0 : v; };
    map[key] = { key: key, kind: kind, id: id, u: num(r[3], t[3]), del: num(r[4], t[4]) ? 1 : 0, s: num(r[5], t[5]), dev: String(t[6] !== undefined ? t[6] : r[6]), data: String(t[7] !== undefined ? t[7] : r[7]), row: i + 2 };
  });
  return { sh: sh, map: map };
}

/** Last-write-wins merge. Returns number of records accepted. */
function merge_(store, changes, device, now) {
  var acc = 0;
  (changes || []).forEach(function (c) {
    if (!c || !c.kind || c.id === undefined || c.id === null) return;
    /* v9: users are never removed or blanked by a sync/restore; only an explicit purge:1 delete (Admin) removes one */
    if (String(c.kind) === 'u' && !(c.del && c.purge === 1) && (c.del || c.data == null || typeof c.data !== 'object')) return;
    var key = c.kind + ':' + c.id, old = store.map[key], u = Number(c.u) || 0;
    if (old && old.u >= u) return;                 // server copy is newer or same
    var rec = { key: key, kind: c.kind, id: String(c.id), u: u, del: c.del ? 1 : 0, s: now, dev: device || '',
                data: c.del ? '' : JSON.stringify(c.data == null ? null : c.data), row: old ? old.row : 0 };
    store.map[key] = rec; rec.dirty = true; acc++;
  });
  return acc;
}
function writeRecs_(store) {
  var sh = store.sh, add = [];
  Object.keys(store.map).forEach(function (k) {
    var r = store.map[k]; if (!r.dirty) return;
    var v = [r.key, r.kind, r.id, r.u, r.del, r.s, r.dev, r.data];
    if (r.row) sh.getRange(r.row, 1, 1, v.length).setNumberFormat('@').setValues([v]); else add.push(v);   /* v10: plain text, Ids like 2099-01-01 stay text */
    delete r.dirty;
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, REC_HEAD.length).setNumberFormat('@').setValues(add);
}
/* v10 (TMC base security fix): NEVER send PIN secrets in a sync. Only a token phone's OWN user record keeps them; team code / legacy get none. */
var SECRET_U = ['pinH', 'salt', 'pin'];
function stripRecs_(recs, viewerId) {
  return recs.map(function (x) {
    if (x.kind !== 'u' || !x.data || typeof x.data !== 'object') return x;
    if (viewerId && String(x.id) === String(viewerId)) return x;
    var d = Object.assign({}, x.data); d.hasPin = d.pinH ? 1 : 0; SECRET_U.forEach(function (f) { delete d[f]; });
    return { kind: x.kind, id: x.id, u: x.u, del: x.del, purge: x.purge, data: d };
  });
}
/* phones no longer hold other users' PIN hashes: an edit that arrives without one keeps the stored hash (no PIN wipe) */
function keepPins_(store, changes) {
  return (changes || []).map(function (c) {
    if (!c || String(c.kind) !== 'u' || c.del || !c.data || typeof c.data !== 'object') return c;
    var o = store.map['u:' + c.id], old = o && !o.del ? safeParse_(o.data) : null;
    if (c.data.pinH || c.data.pinReset || !old || !old.pinH) { if (!('hasPin' in c.data)) return c; var e = Object.assign({}, c.data); delete e.hasPin; return { kind: c.kind, id: c.id, u: c.u, del: c.del, purge: c.purge, data: e }; }
    var d = Object.assign({}, c.data); d.pinH = old.pinH; if (old.salt) d.salt = old.salt; delete d.hasPin;
    return { kind: c.kind, id: c.id, u: c.u, del: c.del, purge: c.purge, data: d };
  });
}
function safeParse_(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function changedSince_(store, since) {
  var r = [];
  Object.keys(store.map).forEach(function (k) { var x = store.map[k];
    if (x.s > since) r.push({ kind: x.kind, id: String(x.id), u: x.u, del: x.del, purge: (x.kind === 'u' && x.del) ? 1 : 0, data: x.del ? null : safeParse_(x.data) }); });
  return r;
}
/* ===== Readable tabs, rebuilt on every save: Summary · Stock · Usage · Receipts · Shopping (_Records hidden) ===== */
function tab_(name, head, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents(); sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
  sh.setFrozenRows(1); if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows); return sh;
}
function q3_(v) { return Math.round((+v || 0) * 1000) / 1000; }
function rebuildViews_(store) {
  var I = {}, M = [], U = {}, N = [], DL = [], SH = [], STK = [];
  Object.keys(store.map).forEach(function (k) { var r = store.map[k]; if (r.del || !r.data) return; var d = safeParse_(r.data); if (!d) return;
    if (r.kind === 'i') I[d.id] = d; else if (r.kind === 'm') M.push(d); else if (r.kind === 'u') U[d.id] = d; else if (r.kind === 'incoming') { if (!isNonFood_(d.item)) N.push(d); } else if (r.kind === 'd') DL.push(d); else if (r.kind === 'shortage') { if (!isNonFood_(d.item)) SH.push(d); } else if (r.kind === 'st') STK.push(d); });
  var Q = {}; Object.keys(I).forEach(function (id) { Q[id] = 0; });
  /* v11: only the Store Room holds stock. in/adj add (adj is signed), use/xfer (issue) subtract. */
  M.forEach(function (m) { if (m.item in Q) Q[m.item] += (m.type === 'in' || m.type === 'adj') ? +m.qty : -m.qty; });
  var its = Object.keys(I).map(function (id) { return I[id]; }).filter(function (i) { return i.kitchen === 'Store Room' && i.cat !== 'Non-food'; }).sort(function (a, b) { return (a.kitchen + a.name).localeCompare(b.kitchen + b.name); });
  var low = function (i) { return !i.direct && q3_(Q[i.id]) <= (+i.rl || 0); };  // direct-to-kitchen items never reorder from the Store Room
  tab_('Stock', ['Location', 'Item', 'Category', 'Unit', 'Qty', 'Reorder level', 'Supplier', 'Status'],
    its.map(function (i) { return [i.kitchen, i.name, i.cat || '', i.unit || '', q3_(Q[i.id]), +i.rl || 0, i.supplier || '', i.direct ? 'DIRECT → ' + i.direct : low(i) ? 'REORDER' : 'OK']; }));
  var shop = its.filter(low);
  tab_('Shopping', ['Location', 'Item', 'Unit', 'Qty now', 'Reorder level', 'Buy', 'Supplier'],
    shop.map(function (i) { return [i.kitchen, i.name, i.unit || '', q3_(Q[i.id]), +i.rl || 0, Math.max(0, q3_((+i.rl || 0) * 2 - Q[i.id])), i.supplier || '']; }));
  M.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  var nm = function (id) { return I[id] ? I[id].name : '(deleted)'; }, un = function (id) { return I[id] ? I[id].unit : ''; };
  tab_('Usage', ['Date', 'Time', 'Kitchen', 'Item', 'Qty', 'Unit', 'Type', 'To kitchen', 'By', 'Note'],
    M.filter(function (m) { return m.type === 'use'; }).map(function (m) { var a = new Date(Date.parse(m.at) + 36e5).toISOString(); /* Chad time UTC+1 */ return [a.slice(0, 10), a.slice(11, 16), m.kitchen, nm(m.item), +m.qty, un(m.item), m.type === 'xfer' ? (m.kitchen === 'Store Room' ? 'Issue' : 'Transfer') : 'Use', m.to || '', m.by || '', m.note || '']; }));
  tab_('Receipts', ['Date', 'Time', 'Kitchen', 'Item', 'Qty', 'Unit', 'By', 'Note'],
    M.filter(function (m) { return m.type === 'in'; }).map(function (m) { var a = new Date(Date.parse(m.at) + 36e5).toISOString(); /* Chad time UTC+1 */ return [a.slice(0, 10), a.slice(11, 16), m.kitchen, nm(m.item), +m.qty, un(m.item), m.by || '', m.note || '']; }));
  /* Issues (Store Room -> kitchen) and Kitchen usage by week (week starts Monday 00:00 Chad time) */
  var chad_ = function (ms) { return new Date(ms + 36e5).toISOString(); };
  var monK_ = function (ms) { var d = new Date(ms + 36e5), dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 864e5).toISOString().slice(0, 10); };
  var ISS = M.filter(function (m) { return m.type === 'xfer' && m.to; });
  tab_('Issues', ['Date', 'Time', 'Week (Mon)', 'Kitchen', 'Item', 'Qty', 'Unit', 'By', 'Issue id', 'Note'],
    ISS.map(function (m) { var ms = Date.parse(m.at), a = chad_(ms); return [a.slice(0, 10), a.slice(11, 16), monK_(ms), m.to, nm(m.item), +m.qty, un(m.item), m.by || '', m.xfer || m.id, m.note || '']; }));
  var KU = {}; ISS.forEach(function (m) { var k = monK_(Date.parse(m.at)) + '|' + m.to + '|' + nm(m.item) + '|' + un(m.item); var o = KU[k] = KU[k] || { q: 0, n: 0 }; o.q += +m.qty; o.n++; });
  tab_('Kitchen usage', ['Week (Mon)', 'Kitchen', 'Item', 'Unit', 'Qty issued', 'Times issued'],
    Object.keys(KU).sort(function (a, b) { return b.localeCompare(a); }).map(function (k) { var p = k.split('|'); return [p[0], p[1], p[2], p[3], q3_(KU[k].q), KU[k].n]; }));
  /* Stock takes: one row per line */
  STK.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  var SR = []; STK.forEach(function (x) { var a = chad_(Date.parse(x.at)); (x.lines || []).forEach(function (l) { SR.push([x.week, a.slice(0, 10), a.slice(11, 16), x.by || '', l.name, l.unit || '', +l.expected || 0, +l.counted || 0, +l.diff || 0, l.diff ? (l.diff < 0 ? 'SHORT' : 'OVER') : 'OK', x.id]); }); });
  tab_('Stock takes', ['Week (Sunday)', 'Date', 'Time', 'Counted by', 'Item', 'Unit', 'Expected', 'Counted', 'Difference', 'Check', 'Stock take id'], SR);
  /* Summary: Store Room status + what each kitchen got this week */
  var thisWk = monK_(Date.now()), l0 = its.filter(low).length;
  var SUM = [['Store Room', its.length + ' items', l0 + ' to reorder', l0 ? 'REORDER' : 'OK']];
  KITCHENS.filter(function (k) { return k !== 'Store Room'; }).forEach(function (k) {
    var mine = ISS.filter(function (m) { return m.to === k && monK_(Date.parse(m.at)) === thisWk; }), ev = {};
    mine.forEach(function (m) { ev[m.xfer || m.id] = 1; });
    SUM.push([k, Object.keys(ev).length + ' issues this week', mine.length + ' lines', '']); });
  var lastST = STK[0]; SUM.push(['Last stock take', lastST ? lastST.week + ' by ' + (lastST.by || '') : 'none', lastST ? (lastST.lines || []).filter(function (l) { return l.diff; }).length + ' differences' : '', '']);
  tab_('Summary', ['Location', 'Status', 'Detail', 'Reorder'], SUM);
  N.sort(function (a, b) { return String(b.paidDate).localeCompare(String(a.paidDate)); });
  tab_('Incoming', ['Paid date', 'Item', 'Size', 'Qty', 'Unit', 'Bought by', 'Batch', 'Received', 'Status', 'Id'],
    N.map(function (n) { return [n.paidDate, n.item, n.size || '', +n.qty || 0, n.unit || '', n.by || '', n.batch || '', +n.recvQty || 0,
      n.status === 'received' ? 'Received' : n.status === 'part' ? 'Part-received' : 'Waiting', n.id]; }));
  var DR = []; DL.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  DL.forEach(function (d) { var a = new Date(Date.parse(d.at) + 36e5).toISOString();
    (d.lines || []).forEach(function (l) { DR.push([a.slice(0, 10), a.slice(11, 16), d.driver || '', d.vehicle || '', d.by || '', l.item, +l.expected || 0, +l.qty || 0, l.unit || '',
      l.extra ? 'Extra' : (+l.qty < +l.expected ? 'Short' : +l.qty > +l.expected ? 'Over' : 'OK'), l.note || '', d.id]); }); });
  tab_('Deliveries', ['Date', 'Time', 'Driver', 'Vehicle', 'Received by', 'Item', 'Expected', 'Received', 'Unit', 'Check', 'Note', 'Delivery id'], DR);
  SH.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  var sent = sentMap_();
  tab_('Shortages', ['Date', 'Item', 'Size', 'Unit', 'Expected', 'Received', 'Short', 'Purchase id', 'Batch', 'Driver', 'Status', 'Sent to Purshes'],
    SH.map(function (z) { var k = sent[z.id]; return [z.date, z.item, z.size || '', z.unit || '', +z.expected || 0, +z.received || 0, +z.short || 0, z.purchaseId, z.batch || '', z.driver || '',
      z.status === 'open' ? 'SHORT' : 'Resolved', k === undefined ? '' : (Number(k) === Number(z.short) ? 'Yes' : 'Changed – resend')]; }));
  var ss = SpreadsheetApp.getActiveSpreadsheet(), rec = ss.getSheetByName(REC); if (rec) rec.hideSheet();
  var sm = ss.getSheetByName('Summary'); if (sm) { ss.setActiveSheet(sm); ss.moveActiveSheet(1); }
}
/* ===== Server-side approval check (v9 proposal – NOT deployed yet) =====
   The app no longer contains the code (v13: phones get it via openStatus_ after approval).
   Rules (req.user = the user id the phone sends):
   - Approved user (status 'ok'): may change stock/movement/delivery/etc. records.
     'u' (user) records: Admin may change any; others only their own, and never their role/status/perms/kitchens.
   - Everyone else (unknown, pending, blocked, rejected): may only create/update THEIR OWN request
     (kind 'u', id = req.user, status 'wait', role 'user', no perms) – and gets back only that record.
   - Bootstrap: while the sheet has no approved Admin, the first user record may be an approved Admin. */
// v7 Admin fix rule: staff may only ADD records. Only the Admin (token login, role admin) may change or delete a saved record.
// Food exceptions (workflow steps that staff must do): receiving updates the purchase line (recvQty/status/lastDelivery),
// its shortage line, and an item's pack size. Nothing else of an old record may change. Every change to a saved record goes to the Fix log.
var FIX_LOG = 'Fix log', FIX_HEAD = ['Time', 'Who', 'Kind', 'Id', 'Field', 'Old value', 'New value'];
var STAFF_KEYS_ = { incoming: ['recvQty', 'status', 'lastDelivery'], i: ['unit', 'packPer', 'packW', 'packWU', 'packUnit'],
  shortage: ['short', 'expected', 'received', 'driver', 'vehicle', 'date', 'at', 'by', 'delivery', 'lastDelivery', 'status', 'note'] };
function staffStep_(kind, o, n) {
  var keys = STAFF_KEYS_[kind]; if (!keys || !o || !n || typeof o !== 'object' || typeof n !== 'object') return false;
  var all = {}; Object.keys(o).concat(Object.keys(n)).forEach(function (k) { all[k] = 1; });
  for (var k in all) if (keys.indexOf(k) < 0 && JSON.stringify(o[k]) !== JSON.stringify(n[k])) return false;
  if (kind === 'incoming' && (Number(n.recvQty) || 0) < (Number(o.recvQty) || 0)) return false;   // receiving only goes up
  return true;
}
function addOnly_(store, changes, refused) {
  return (changes || []).filter(function (c) {
    if (!c || !c.kind || c.kind === 'u') return true;
    var old = store.map[c.kind + ':' + c.id];
    if (!c.del && !old) return true;
    if (old && !c.del && old.data === JSON.stringify(c.data == null ? null : c.data)) return true;  // same add sent again
    if (old && !old.del && !c.del && staffStep_(c.kind, safeParse_(old.data), c.data)) return true;
    refused.n++; return false;
  });
}
function logFixes_(store, who, changes) {   // one row per changed field: who, when, kind, id, field, old, new
  var rows = [], now = new Date().toISOString();
  function v_(x) { return x === undefined ? '' : (typeof x === 'string' ? x : JSON.stringify(x)); }
  (changes || []).forEach(function (c) {
    if (!c || !c.kind || c.kind === 'u') return;
    var old = store.map[c.kind + ':' + c.id]; if (!old || old.u >= (Number(c.u) || 0)) return;
    var nv = c.del ? 'DELETED' : JSON.stringify(c.data == null ? null : c.data);
    if (nv === old.data) return;
    if (c.del || old.del) { rows.push([now, who, c.kind, String(c.id), '(record)', old.del ? 'DELETED' : old.data, nv]); return; }
    var o = safeParse_(old.data) || {}, n = c.data || {}, ks = {};
    Object.keys(o).concat(Object.keys(n)).forEach(function (k) { ks[k] = 1; });
    Object.keys(ks).forEach(function (k) { if (k === '_fix' || JSON.stringify(o[k]) === JSON.stringify(n[k])) return; rows.push([now, who, c.kind, String(c.id), k, v_(o[k]), v_(n[k])]); });
  });
  if (rows.length) { var sh = sheet_(FIX_LOG, FIX_HEAD); sh.getRange(sh.getLastRow() + 1, 1, rows.length, FIX_HEAD.length).setValues(rows); }
}
function authorize_(store, req, viaCode) {
  var U = {}, anyAdmin = false;
  Object.keys(store.map).forEach(function (k) { var r = store.map[k]; if (r.kind !== 'u' || r.del) return; var d = safeParse_(r.data); if (!d) return; U[String(r.id)] = d;
    if (d.role === 'admin' && d.status === 'ok') anyAdmin = true; });
  var me = U[String(req.user || '')], ok = !!(me && me.status === 'ok'), adm = !viaCode && ok && me.role === 'admin', out = [], rej = 0;
  (req.changes || []).forEach(function (c) {
    if (!c || !c.kind) { rej++; return; }
    var id = String(c.id), d = c.data || {}, old = U[id];
    if (c.kind === 'u') {
      if (adm) { out.push(c); return; }
      if (!anyAdmin && id === String(req.user) && !c.del && d.role === 'admin' && d.status === 'ok') { out.push(c); anyAdmin = true; return; }
      if (id !== String(req.user) || c.del) { rej++; return; }
      if (ok) { // own record: keep server's role/status/perms/kitchens
        c.data = Object.assign({}, d, { role: me.role, status: me.status, perms: me.perms || {}, kitchens: me.kitchens || [] }); out.push(c); return; }
      if (old && old.status !== 'wait') { rej++; return; }   // blocked/rejected cannot re-open themselves
      if (d.status === 'wait' && d.role !== 'admin' && !Object.keys(d.perms || {}).length && !(d.kitchens || []).length) { out.push(c); return; }
      rej++; return;
    }
    if (ok) out.push(c); else rej++;
  });
  return { changes: out, rejected: rej, approved: ok };
}
/* v8 (TMC base port) – ONE join request per name per app.
   Name key: accents stripped, lower case, spaces + dots ignored; Johan's variants (JA Kirsten, J.A. Kirsten, Johan Kirsten,
   Johan A Kirsten, J Kirsten) all count as one name. A new request is refused (refusedWhy 'duplicate_request') when another
   person with the same name key is waiting or approved. Exception (as base): 2+ approved people already share the name. */
function dupKey_(s) {
  var c = String(s || ''); try { c = c.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  c = c.toLowerCase().replace(/[\s.]+/g, ''); return ADMIN0.indexOf(c) >= 0 ? 'jakirsten' : c;
}
function dupReq_(U, name, exceptId) {
  var K = dupKey_(name); if (!K) return false;
  var ids = Object.keys(U).filter(function (id) { return dupKey_(U[id].name) === K; });
  if (ids.filter(function (id) { return U[id].status === 'ok'; }).length >= 2) return false;
  return ids.some(function (id) { return id !== String(exceptId || '') && (U[id].status === 'wait' || U[id].status === 'ok'); });
}
function noDupReq_(store, changes, refused) {
  var U = users_(store);
  return (changes || []).filter(function (c) {
    if (!c || c.kind !== 'u' || c.del || !c.data || U[String(c.id)] || c.data.status !== 'wait') return true;
    if (dupReq_(U, c.data.name, c.id)) { refused.dup++; return false; }
    U[String(c.id)] = c.data; return true;   // two look-alike requests in one batch: only the first passes
  });
}
/* v8 – permission 'add' (TMC base): when the Admin un-ticks Add, a staff phone cannot add new records (server check too).
   Missing key = allowed (existing users keep what they had). */
function noAdd_(store, me, changes, refused) {
  if (!me || me.role === 'admin' || !me.perms || me.perms.add !== 0) return changes;
  return (changes || []).filter(function (c) {
    if (!c || !c.kind || c.kind === 'u' || store.map[c.kind + ':' + c.id]) return true;
    refused.add++; return false;
  });
}
function handle_(req) {
  if (!req) return { ok: false, error: 'bad_request' };
  var code = String(req.code || '').trim(), viaCode = !req.token && !!code && code === teamCode_();   // v12: a token always wins over the code
  if (!viaCode && !req.token) return { ok: false, error: code ? 'bad_code' : 'need_login' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy_try_again' };
  try {
    var store = readAll_(), now = Date.now(), since = Number(req.since) || 0, me = null;
    if (!viaCode) {                       // v6 token: the user comes from the token, never from the request
      var ss = session_(store, req.token, req.device); if (ss.error) return { ok: false, error: ss.error };
      me = ss.u; req.user = ss.id;
    }
    req.changes = keepPins_(store, req.changes);   // v10
    var refused = { n: 0, dup: 0, add: 0, strict: 0 };
    if (viaCode && strict_()) req.changes = (req.changes || []).filter(function (c) { if (c && c.kind === 'u') { refused.strict++; return false; } return true; });   /* v11 STRICT_TOKEN: users only via a signed-in token */
    if (viaCode) {   /* v12: with the team code only your OWN user record, and never an Admin record (no Admin edits/approvals via the code) */
      var U0 = users_(store), anyA0 = Object.keys(U0).some(function (id) { return U0[id].role === 'admin' && U0[id].status === 'ok'; });
      req.changes = (req.changes || []).filter(function (c) {
        if (!c || c.kind !== 'u') return true;
        var o0 = U0[String(c.id)];
        if (String(c.id) !== String(req.user || '') || (o0 && o0.role === 'admin' && anyA0)) { refused.n++; return false; }
        return true;
      });
    }
    var au = authorize_(store, req, viaCode);
    var fixer = !viaCode && me && me.role === 'admin' && me.status === 'ok';   // team-code phones count as staff
    au.changes = noDupReq_(store, au.changes, refused);   // v8: one request per name
    if (!fixer) au.changes = noAdd_(store, me, addOnly_(store, au.changes, refused), refused);   // staff: adds + the 3 receiving steps only
    logFixes_(store, fixer ? me.name + ' (Admin)' : (me ? me.name : 'team code ' + String(req.user || '')), au.changes);   // every change to a saved record is logged
    var acc = merge_(store, au.changes, req.device, now);
    var warn = '';
    if (acc) { writeRecs_(store); try { rebuildViews_(store); } catch (ve) { warn = 'views: ' + String(ve && ve.message || ve).slice(0, 200); } }
    if ((req.changes || []).some(function (c) { return c && c.kind === 'shortage'; })) { try { var ps = pushShortages_(store); if (ps.error) warn += ' purshes: ' + ps.error; } catch (pe) { warn += ' purshes: ' + String(pe).slice(0, 100); } }
    var recs = changedSince_(store, since);
    if (!au.approved) recs = recs.filter(function (x) { return x.kind === 'u' && String(x.id) === String(req.user || ''); });
    recs = stripRecs_(recs, viaCode ? '' : (me ? req.user : ''));   // v10: every path (team code, legacy, Admin, staff): only your own PIN hash
    var res = { ok: true, now: now, accepted: acc, rejected: au.rejected, approved: au.approved, records: recs };
    if (refused.n) { res.refused = refused.n; res.refusedWhy = 'admin_only_fix'; }
    if (refused.add) { res.refused = (res.refused || 0) + refused.add; res.refusedWhy = 'not_allowed'; }
    if (refused.dup) { res.refused = (res.refused || 0) + refused.dup; res.refusedWhy = 'duplicate_request'; }
    if (refused.strict) { res.refused = (res.refused || 0) + refused.strict; res.refusedWhy = 'need_token'; }
    if (warn) res.warn = warn;
    return res;
  } finally { lock.releaseLock(); }
}
/* ===== Open (no-code) endpoints – v13 =====
   The public app holds NO sync password. A phone without it may only:
   - action 'request': create/refresh ITS OWN access request {user, device, name, pinH} (status 'wait', role 'user', no perms).
     If an approved user with the same name + PIN hash has no device bound yet (Admin added them by hand), the device is bound to it.
   - action 'status': {user, device, pinH} -> {status}. The sync password is returned ONLY when the user is approved ('ok'),
     the device matches the one bound to the user, and the PIN hash matches (when the user has one).
   Blocked / rejected / removed / unknown users get no code. Both are size- and rate-limited.
   Bootstrap: on an empty user list the first Admin enters the sync password once in the app (Admin setup box on the sign-up
   screen); the normal sync then lets the first record become the approved Admin (authorize_ rule). */
var OPEN_MAX_BODY = 2048, OPEN_MAX_WAIT = 40;
function rate_(key, secs) {
  try { var c = CacheService.getScriptCache(), k = 'rl:' + key; if (c.get(k)) return false; c.put(k, '1', secs); return true; }
  catch (e) { return true; }
}
function users_(store) {
  var U = {}; Object.keys(store.map).forEach(function (k) { var r = store.map[k]; if (r.kind !== 'u' || r.del) return; var d = safeParse_(r.data); if (d) U[String(r.id)] = d; });
  return U;
}
function nu_(store, id, now) { var o = store.map['u:' + id]; return Math.max(now, o ? o.u + 1 : 0); }
function idOk_(s, max) { return typeof s === 'string' && s.length >= 4 && s.length <= (max || 64) && /^[A-Za-z0-9_-]+$/.test(s); }
/* v5 – re-login after a reinstall / wiped phone:
   an APPROVED user (incl. Admin) who sends the same name (case/space-insensitive) + the correct PIN hash is re-bound to the
   new device and gets status 'ok' (the following 'status' call then returns the sync password). No new approval needed.
   - Blocked / rejected users are never re-bound (answer 'denied').
   - Same name on two approved users with the same PIN -> 'dup' (Admin must rename one); nothing is re-bound.
   - Wrong / missing PIN for an approved name -> 'pin' and a failure is counted per name AND per device:
     PIN_MAX_FAIL fails within PIN_LOCK_SECS -> 'locked' for PIN_LOCK_SECS (also blocks a correct PIN while locked).
   - Approved users WITHOUT a PIN cannot re-login this way (they must ask the Admin, as before). */
var PIN_MAX_FAIL = 5, PIN_LOCK_SECS = 3600;
function normName_(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
/* Johan's Admin name variants (same rule as TMC GRV): spaces + dots stripped, any variant -> 'jakirsten'. Other names: exact (case/space-insensitive). */
var ADMIN0 = ['jakirsten', 'johankirsten', 'johanakirsten', 'jkirsten'];
function nameKey_(s) { var c = String(s || '').toLowerCase().replace(/[\s.]+/g, ''); return ADMIN0.indexOf(c) >= 0 ? 'jakirsten' : normName_(s); }
function failGet_(k) { try { return Number(CacheService.getScriptCache().get('pf:' + k)) || 0; } catch (e) { return 0; } }
function failAdd_(k) { try { var c = CacheService.getScriptCache(), n = (Number(c.get('pf:' + k)) || 0) + 1; c.put('pf:' + k, String(n), PIN_LOCK_SECS); return n; } catch (e) { return 0; } }
function failClr_(k) { try { CacheService.getScriptCache().remove('pf:' + k); } catch (e) {} }
/* ===== v6 – session tokens (TMC base v4) =====
   'status' with tok:1 returns {token} instead of the sync password. A token is bound to one user + one device,
   stored as Script Property TOK_<token>; a new token for the same user+device replaces the old one.
   It stops working at once when the user is blocked/rejected/removed or re-bound to another device.
   LEGACY_CODE: fi-v22 phones (no tok flag) still receive the sync password after approval + PIN, as in v5.
   Set it to false once every phone runs fi-v23. */
var LEGACY_CODE = true;
function props_() { return PropertiesService.getScriptProperties(); }
function strict_() { return String(props_().getProperty('STRICT_TOKEN') || '').trim() === '1'; }   /* v11 (base 18) */
function newToken_(uid, dev) {
  var p = props_(), all = p.getProperties(), tok = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  Object.keys(all).forEach(function (k) { if (k.indexOf('TOK_') !== 0) return; var v = safeParse_(all[k]); if (!v || (v.uid === uid && v.dev === dev)) p.deleteProperty(k); });
  p.setProperty('TOK_' + tok, JSON.stringify({ uid: uid, dev: dev, at: Date.now() }));
  return tok;
}
function session_(store, tok, dev) {
  if (!tok || !/^[a-f0-9]{32,80}$/i.test(String(tok))) return { error: 'bad_token' };
  var s = safeParse_(props_().getProperty('TOK_' + tok)); if (!s) return { error: 'bad_token' };
  if (String(dev || '') !== s.dev) return { error: 'bad_token' };
  var u = users_(store)[String(s.uid)];
  if (!u || u.dev !== s.dev) return { error: 'bad_token' };          // removed, or re-bound to another phone
  if (u.status !== 'ok') return { error: 'not_active' };              // blocked / rejected
  return { id: String(s.uid), u: u };
}
function openReq_(req) {
  var user = String(req.user || ''), dev = String(req.device || ''), name = String(req.name || '').replace(/\s+/g, ' ').trim(), pinH = String(req.pinH || '');
  if (!idOk_(user) || !idOk_(dev) || !name || name.length > 60 || (pinH && !/^[0-9a-f]{64}$/.test(pinH))) return { ok: false, error: 'bad_request' };
  var nk = 'n:' + nameKey_(name), dk = 'd:' + dev;
  if (failGet_(nk) >= PIN_MAX_FAIL || failGet_(dk) >= PIN_MAX_FAIL) return { ok: true, status: 'locked' };
  if (!rate_('req:' + dev, 20) || !rate_('reqn:' + normName_(name), 20)) return { ok: false, error: 'slow_down' };
  var lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return { ok: false, error: 'busy_try_again' };
  try {
    var store = readAll_(), U = users_(store), now = Date.now();
    var named = Object.keys(U).filter(function (id) { return nameKey_(U[id].name) === nameKey_(name); });
    var bad = named.filter(function (id) { return U[id].status === 'blocked' || U[id].status === 'rejected'; });
    var okN = named.filter(function (id) { return U[id].status === 'ok' && U[id].pinH; });
    var seed = named.filter(function (id) { return U[id].status === 'ok' && U[id].role === 'admin' && !U[id].pinH && !U[id].dev; });
    if (pinH && !okN.length && seed.length === 1) {   // v12: the Admin seeded by setupOnce is claimed by the first JA Kirsten sign-in with a PIN
      var sid = seed[0], ds = Object.assign({}, U[sid], { pinH: pinH, dev: dev });
      merge_(store, [{ kind: 'u', id: sid, u: nu_(store, sid, now), data: ds }], dev, now); writeRecs_(store); try { rebuildViews_(store); } catch (e) {}
      failClr_(nk); failClr_(dk); return { ok: true, user: sid, status: 'ok' };
    }
    var hit = pinH ? okN.filter(function (id) { return U[id].pinH === pinH; }) : [];
    if (pinH && bad.some(function (id) { return U[id].pinH === pinH; })) return { ok: true, status: 'denied' };
    if (hit.length > 1) return { ok: true, status: 'dup' };
    if (hit.length === 1) {
      var id1 = hit[0]; failClr_(nk); failClr_(dk);
      if (U[id1].dev !== dev) { var d1 = Object.assign({}, U[id1], { dev: dev }); merge_(store, [{ kind: 'u', id: id1, u: nu_(store, id1, now), data: d1 }], dev, now); writeRecs_(store); }
      return { ok: true, user: id1, status: 'ok' };
    }
    if (okN.length) {   // approved name, wrong/missing PIN: count it, never create a look-alike request
      var f = Math.max(failAdd_(nk), failAdd_(dk));
      return { ok: true, status: f >= PIN_MAX_FAIL ? 'locked' : 'pin', left: Math.max(0, PIN_MAX_FAIL - f) };
    }
    var anyAdm = Object.keys(U).some(function (id) { return U[id].role === 'admin' && U[id].status === 'ok'; });
    if (!anyAdm && nameKey_(name) === 'jakirsten' && pinH && !U[user]) {   // v6: very first Admin, no sync password needed
      var d0 = { id: user, name: name, status: 'ok', role: 'admin', perms: {}, kitchens: [], pinH: pinH, at: new Date(now).toISOString(), dev: dev };
      merge_(store, [{ kind: 'u', id: user, u: nu_(store, user, now), data: d0 }], dev, now); writeRecs_(store); try { rebuildViews_(store); } catch (e) {}
      return { ok: true, user: user, status: 'ok' };
    }
    var old = U[user];
    if (old && (old.status !== 'wait' || old.dev !== dev)) return { ok: true, user: user, status: old.dev === dev ? old.status : 'wait' };
    if (!old && dupReq_(U, name, user)) return { ok: true, status: 'dup_request', refusedWhy: 'duplicate_request' };   // v8
    if (!old && Object.keys(U).filter(function (id) { return U[id].status === 'wait'; }).length >= OPEN_MAX_WAIT) return { ok: false, error: 'too_many_requests' };
    var d = { id: user, name: name, status: 'wait', role: 'user', perms: {}, kitchens: [], pinH: pinH, at: new Date(now).toISOString(), dev: dev };
    merge_(store, [{ kind: 'u', id: user, u: nu_(store, user, now), data: d }], dev, now); writeRecs_(store);
    return { ok: true, user: user, status: 'wait' };
  } finally { lock.releaseLock(); }
}
function openStatus_(req) {
  var user = String(req.user || ''), dev = String(req.device || ''), pinH = String(req.pinH || '');
  if (!idOk_(user) || !idOk_(dev)) return { ok: false, error: 'bad_request' };
  if (!rate_('st:' + dev, 5)) return { ok: false, error: 'slow_down' };
  var d = users_(readAll_())[user];
  if (!d || d.dev !== dev) return { ok: true, status: 'none' };
  if (d.status !== 'ok') return { ok: true, status: d.status === 'wait' ? 'wait' : 'denied' };
  var nk = 'n:' + nameKey_(d.name), dk = 'd:' + dev;
  if (failGet_(nk) >= PIN_MAX_FAIL || failGet_(dk) >= PIN_MAX_FAIL) return { ok: true, status: 'locked' };
  if (d.pinH && d.pinH !== pinH) {
    // v6: count each DIFFERENT wrong PIN (waiting-screen polls repeat the same hash and must not lock the user)
    var lastK = 'pl:' + user, c = null; try { c = CacheService.getScriptCache(); } catch (e) {}
    if (pinH && c && c.get(lastK) !== pinH) { c.put(lastK, pinH, PIN_LOCK_SECS); var f = Math.max(failAdd_(nk), failAdd_(dk)); if (f >= PIN_MAX_FAIL) return { ok: true, status: 'locked' }; }
    return { ok: true, status: 'pin' };
  }
  failClr_(nk); failClr_(dk);
  if (req.tok) return { ok: true, status: 'ok', token: newToken_(user, dev) };
  return LEGACY_CODE ? { ok: true, status: 'ok', code: teamCode_() } : { ok: true, status: 'ok' };
}
function doPost(e) {
  // Always answer with JSON, never an HTML error page.
  try {
    var body = e && e.postData && e.postData.contents;
    if (!body) return out_({ ok: false, error: 'empty_request' });
    var req; try { req = JSON.parse(body); } catch (pe) { return out_({ ok: false, error: 'bad_json' }); }
    if (req.action === 'importIncoming') return out_(importIncoming_(req));
    if (req.action === 'request' || req.action === 'status') {
      if (body.length > OPEN_MAX_BODY) return out_({ ok: false, error: 'too_big' });
      return out_(req.action === 'request' ? openReq_(req) : openStatus_(req));
    }
    return out_(handle_(req));
  } catch (err) {
    try { return out_({ ok: false, error: String(err && err.message || err).slice(0, 300) }); }
    catch (e2) { return ContentService.createTextOutput('{"ok":false,"error":"server_error"}').setMimeType(ContentService.MimeType.JSON); }
  }
}
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.code) return out_({ ok: true, app: 'TMC Food Inventory sync', hint: 'running' });
  try { return out_(handle_({ code: p.code, since: p.since, changes: [] })); }
  catch (err) { return out_({ ok: false, error: String(err) }); }
}
/* ===== v11 ONE-TIME SETUP (TMC base section 17): open the editor, pick setupOnce, Run, Allow. =====
   setupOnce(opt) takes the codes as an argument: opt = {team:'…', import:'…', purshesImport:'…'}. Never type them here.
   Deploy time: build Setup-once.gs from .secrets.env (make_setup_snippet.py), add it as a 2nd file, Run setupNow,
   Allow, then DELETE Setup-once.gs and Save. Run with no argument (or placeholders '__…__') → existing properties kept.
   Safe to run again: keeps users, PINs and data; never adds a second Admin; triggers never doubled.
   Food has no seeded Admin: on an empty Sheet the first "JA Kirsten" sign-in with a PIN becomes the Admin (openReq_). */
var APP_SHEET_NAME = 'TMC Food Inventory Sheet';
var ADMIN_NAME = 'JA Kirsten';
var SETUP_PLACEHOLDERS = { team: TEAM_CODE_SETUP, import: '__TMC_IMPORT_CODE__', purshesImport: '__TMC_PURSHES_IMPORT_CODE__' };
function setProp_(p, key, val, have) {
  val = String(val == null ? '' : val).trim();
  if (val && val.indexOf('__') !== 0) { p.setProperty(key, val); return 'set'; }
  return have ? 'kept' : 'none';
}
var TRIGGERS = [];   /* Food has no time triggers */
function renameSheetOnce_() { try { var ss = SpreadsheetApp.getActive(); if (ss.getName() !== APP_SHEET_NAME) { ss.rename(APP_SHEET_NAME); return 'renamed'; } return 'ok'; } catch (e) { return 'skip'; } }
function installTriggers_() {
  var have = {}, out = [];
  ScriptApp.getProjectTriggers().forEach(function (t) { var f = t.getHandlerFunction(); if (have[f]) ScriptApp.deleteTrigger(t); else have[f] = 1; });
  TRIGGERS.forEach(function (t) {
    if (have[t.fn]) { out.push(t.fn + ':kept'); return; }
    ScriptApp.newTrigger(t.fn).timeBased().everyDays(1).atHour(t.hour || 5).nearMinute(t.minute || 0).create(); have[t.fn] = 1; out.push(t.fn + ':added');
  });
  return out;
}
function setupOnce(opt) {
  if (!opt || typeof opt !== 'object' || opt.authMode) opt = (typeof SETUP_ONCE !== 'undefined' && SETUP_ONCE) ? SETUP_ONCE : {};
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var p = props_(), out = { sheet: renameSheetOnce_() };
    out.teamCode = setProp_(p, 'TEAM_CODE', opt.team, !!teamCode_()); if (out.teamCode === 'none') out.teamCode = 'none (token sign-in only)';
    out.importCode = setProp_(p, 'IMPORT_CODE', opt['import'], !!importCode_()); if (out.importCode === 'none') out.importCode = 'none (import closed)';
    if (opt.purshesImport) out.purshesImport = setProp_(p, 'PURSHES_IMPORT_CODE', opt.purshesImport, !!p.getProperty('PURSHES_IMPORT_CODE'));
    var store = readAll_(); sheet_(FIX_LOG, FIX_HEAD);
    var U = users_(store);
    if (Object.keys(U).some(function (id) { return U[id].role === 'admin' && U[id].status === 'ok'; })) out.admin = 'kept';
    else if (Object.keys(U).some(function (id) { return nameKey_(U[id].name) === 'jakirsten'; })) out.admin = 'none yet (a JA Kirsten record exists – the Admin approves it)';
    else {   /* v12: seed the first Admin; no PIN yet – the first JA Kirsten sign-in with a PIN claims it (openReq_) */
      var aid = 'admin' + Utilities.getUuid().replace(/-/g, '').slice(0, 12), nowA = Date.now();
      merge_(store, [{ kind: 'u', id: aid, u: nowA, data: { id: aid, name: ADMIN_NAME, status: 'ok', role: 'admin', perms: {}, kitchens: [], at: new Date(nowA).toISOString() } }], 'setup', nowA);
      writeRecs_(store); out.admin = 'seeded';
    }
    try { rebuildViews_(store); } catch (e) {}
    out.triggers = installTriggers_();
    out.strict = strict_() ? 'on' : 'off';
    return JSON.stringify(out);
  } finally { lock.releaseLock(); }
}
if (typeof module !== 'undefined') module.exports = { stripRecs_: stripRecs_, keepPins_: keepPins_, readAll_: readAll_, normName_: normName_, nameKey_: nameKey_, openReq_: openReq_, openStatus_: openStatus_, handle_: handle_, merge_: merge_, rebuildViews_: rebuildViews_, importIncoming_: importIncoming_, pushShortages_: pushShortages_, setupOnce: setupOnce };
