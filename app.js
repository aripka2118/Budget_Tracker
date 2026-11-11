"use strict";

const PROFILES_KEY = "budgetTracker.profiles"; // { active, list: [{ id, name }] }
const LEGACY_DATA_KEY = "budgetTracker.v1";    // pre-profiles single-user keys (migrated once)
const LEGACY_API_KEY = "budgetTracker.apiKey";
const LEGACY_TAB_KEY = "budgetTracker.tab";
const PALETTE = Array.from({ length: 12 }, (_, i) => `var(--c${i + 1})`);

// Finnhub key is stored per user (kept out of Export).
const QUOTES_KEY = "budgetTracker.quotes";      // cached prices (kept out of Export)
const STALE_MS = 55 * 60 * 1000;                // prices older than this get refreshed
const CHECK_MS = 5 * 60 * 1000;                 // how often an open page checks for stale prices

let state = emptyState(); // loaded from storage at the bottom, once every helper exists
let quotes = {};          // { SYMBOL: { price, prevClose, time } }
let priceStatus = "";
let refreshing = false;
let currentTab = "home";
let manageId = null;
let txClassId = null;
let tradeClassId = null;

/* ---------- helpers ---------- */

const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const money = (n) => (n <= -0.005 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const signed = (n) => (n >= 0.005 ? "+" : "") + money(n);
const pct = (n) => Math.round(n * 100) / 100;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- persistence ---------- */

function emptyState() {
  return { classes: [], categories: [], holdings: [], trades: [], paychecks: [], purchases: [], goals: [] };
}

function loadQuotes() {
  try {
    const q = JSON.parse(localStorage.getItem(QUOTES_KEY) || "{}");
    const out = {};
    Object.keys(q || {}).forEach((s) => {
      const v = q[s];
      if (v && Number(v.price) > 0) out[s] = { price: Number(v.price), prevClose: Number(v.prevClose) || 0, time: Number(v.time) || 0 };
    });
    return out;
  } catch (e) {
    return {};
  }
}

function saveQuotes() {
  try { localStorage.setItem(QUOTES_KEY, JSON.stringify(quotes)); } catch (e) { /* ignore */ }
}

/* ---------- users (profiles stored in this browser) ---------- */

let profiles = { active: "", list: [] };

function saveProfiles() {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch (e) { /* ignore */ }
}

const activeId = () => profiles.active;
const activeUser = () => profiles.list.find((u) => u.id === profiles.active) || { id: "", name: "" };
const dataKey = (id = activeId()) => `budgetTracker.p.${id}.data`;
const apiKeyKey = (id = activeId()) => `budgetTracker.p.${id}.apiKey`;
const tabKey = (id = activeId()) => `budgetTracker.p.${id}.tab`;

// Loads the user list. First run after this feature existed: wrap the old single-user
// data in a "Main" user (old keys are left in place as a safety copy).
function ensureProfiles() {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILES_KEY) || "null");
    if (p && Array.isArray(p.list) && p.list.length) {
      const list = p.list.filter((u) => u && u.id).map((u) => ({ id: String(u.id), name: String(u.name || "User") }));
      if (list.length) {
        profiles = { active: list.some((u) => u.id === p.active) ? p.active : list[0].id, list };
        return;
      }
    }
  } catch (e) { /* fall through and create Main */ }
  const id = uid();
  profiles = { active: id, list: [{ id, name: "Main" }] };
  try {
    const copy = (from, to) => { const v = localStorage.getItem(from); if (v != null) localStorage.setItem(to, v); };
    copy(LEGACY_DATA_KEY, dataKey(id));
    copy(LEGACY_API_KEY, apiKeyKey(id));
    copy(LEGACY_TAB_KEY, tabKey(id));
  } catch (e) { /* ignore */ }
  saveProfiles();
}

function getKey() {
  try { return localStorage.getItem(apiKeyKey()) || ""; } catch (e) { return ""; }
}

function load() {
  try {
    const raw = localStorage.getItem(dataKey());
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    const s = sanitize(parsed) || emptyState();
    // Old flat-category data was migrated in memory: write it back once so
    // the "as of" dates chosen during migration stay fixed.
    if (parsed && !Array.isArray(parsed.classes)) {
      localStorage.setItem(dataKey(), JSON.stringify(s));
    }
    return s;
  } catch (e) {
    return emptyState();
  }
}

function save() {
  pruneGoalLinks();
  try {
    localStorage.setItem(dataKey(), JSON.stringify(state));
  } catch (e) {
    alert("Could not save to browser storage. Use Export to keep a backup.");
  }
}

function userNameError(name, exceptId) {
  if (!name) return "Enter a name.";
  if (name.length > 24) return "Keep the name to 24 characters or fewer.";
  if (profiles.list.some((u) => u.id !== exceptId && u.name.toLowerCase() === name.toLowerCase())) return "A user with that name already exists.";
  return "";
}

function switchUser(id) {
  if (!profiles.list.some((u) => u.id === id)) return;
  profiles.active = id;
  saveProfiles();
  state = load();
  priceStatus = "";
  try { currentTab = localStorage.getItem(tabKey()) || "home"; } catch (e) { currentTab = "home"; }
  render();
  refreshPrices(false);
}

function addUser(name) {
  const id = uid();
  profiles.list.push({ id, name });
  saveProfiles();
  switchUser(id);
}

function renameUser(id, name) {
  const u = profiles.list.find((x) => x.id === id);
  if (!u) return;
  u.name = name;
  saveProfiles();
}

function deleteUser(id) {
  if (profiles.list.length < 2) return;
  const wasActive = id === activeId();
  const next = profiles.list.find((u) => u.id !== id);
  profiles.list = profiles.list.filter((u) => u.id !== id);
  try { [dataKey(id), apiKeyKey(id), tabKey(id)].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
  saveProfiles();
  if (wasActive) switchUser(next.id);
}

// Old format: flat categories (Needs/Wants/Savings/Investments, % of paycheck).
// New format: classes that hold categories. Convert the old one.
function migrateLegacy(data) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const str = (v) => String(v == null ? "" : v);
  const legacy = Array.isArray(data.categories) ? data.categories : [];
  const lower = (c) => str(c.name).trim().toLowerCase();
  const spend = legacy.filter((c) => lower(c) !== "savings" && lower(c) !== "investments");
  const sav = legacy.filter((c) => lower(c) === "savings");
  const inv = legacy.filter((c) => lower(c) === "investments");
  const sum = (a) => a.reduce((s, c) => s + num(c.percent), 0);
  const t = today();
  const classes = [], categories = [], route = {};

  if (spend.length) {
    const total = sum(spend);
    classes.push({ id: "cls-budget", name: "Budget", percent: total, kind: "spend" });
    spend.forEach((c) => categories.push({
      id: str(c.id), classId: "cls-budget", name: str(c.name),
      percent: total > 0 ? (num(c.percent) / total) * 100 : 100 / spend.length,
    }));
  }
  if (sav.length) {
    classes.push({ id: "cls-savings", name: "Savings", percent: sum(sav), kind: "hold" });
    categories.push(
      { id: "cat-college", classId: "cls-savings", name: "College Savings", percent: 50, startBalance: 0, asOf: t },
      { id: "cat-emergency", classId: "cls-savings", name: "Emergency Savings", percent: 50, startBalance: 0, asOf: t },
    );
    sav.forEach((c) => {
      route[str(c.id)] = (p) => (/emergency/i.test(str(p.description)) ? "cat-emergency" : "cat-college");
    });
  }
  if (inv.length) {
    classes.push({ id: "cls-investments", name: "Investments", percent: sum(inv), kind: "hold" });
    categories.push({ id: "cat-qqq", classId: "cls-investments", name: "QQQ/VOO", percent: 100, startBalance: 0, asOf: t });
    inv.forEach((c) => { route[str(c.id)] = () => "cat-qqq"; });
  }
  const purchases = (Array.isArray(data.purchases) ? data.purchases : []).map((p) => {
    const fn = route[str(p.categoryId)];
    return fn ? { ...p, categoryId: fn(p) } : p;
  });
  return { classes, categories, paychecks: data.paychecks, purchases };
}

// Validate imported/loaded data so bad files can't break the app.
function sanitize(data) {
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.classes)) data = migrateLegacy(data);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const str = (v) => String(v == null ? "" : v);
  const classes = data.classes.map((c) => ({
    id: str(c.id), name: str(c.name), percent: num(c.percent),
    kind: c.kind === "hold" ? "hold" : c.kind === "stocks" ? "stocks" : "spend",
    startCash: num(c.startCash), asOf: str(c.asOf) || today(),
  }));
  const catClassIds = new Set(classes.filter((c) => c.kind !== "stocks").map((c) => c.id));
  const stockClassIds = new Set(classes.filter((c) => c.kind === "stocks").map((c) => c.id));
  const colorOf = (c, i) => (Number.isInteger(c.color) && c.color >= 0 && c.color < PALETTE.length ? c.color : i % PALETTE.length);
  const holdings = (Array.isArray(data.holdings) ? data.holdings : [])
    .filter((h) => stockClassIds.has(str(h.classId)))
    .map((h, i) => ({
      id: str(h.id), classId: str(h.classId), symbol: str(h.symbol).trim().toUpperCase(),
      shares: num(h.shares), color: colorOf(h, i),
    }));
  const holdingIds = new Set(holdings.map((h) => h.id));
  const trades = (Array.isArray(data.trades) ? data.trades : [])
    .filter((t) => holdingIds.has(str(t.holdingId)))
    .map((t) => ({ id: str(t.id), date: str(t.date), holdingId: str(t.holdingId), shares: num(t.shares), price: num(t.price) }));
  const categories = (Array.isArray(data.categories) ? data.categories : [])
    .filter((c) => catClassIds.has(str(c.classId)))
    .map((c, i) => ({
      id: str(c.id), classId: str(c.classId), name: str(c.name), percent: num(c.percent),
      startBalance: num(c.startBalance), asOf: str(c.asOf) || today(),
      color: Number.isInteger(c.color) && c.color >= 0 && c.color < PALETTE.length ? c.color : i % PALETTE.length,
    }));
  const ids = new Set(categories.map((c) => c.id));
  // A goal links to a savings/investment category ("cat:ID"), a stocks class ("cls:ID"), or nothing (manual).
  const holdCatIds = new Set(categories.filter((c) => (classes.find((k) => k.id === c.classId) || {}).kind === "hold").map((c) => c.id));
  const linkOk = (l) => (l.startsWith("cat:") ? holdCatIds.has(l.slice(4)) : l.startsWith("cls:") ? stockClassIds.has(l.slice(4)) : false);
  const goals = (Array.isArray(data.goals) ? data.goals : []).map((g, i) => {
    const link = str(g.link);
    return {
      id: str(g.id) || uid(), name: str(g.name) || "Goal", target: Math.max(0, num(g.target)),
      link: linkOk(link) ? link : "", saved: num(g.saved), due: str(g.due), created: str(g.created) || today(),
      color: Number.isInteger(g.color) && g.color >= 0 && g.color < PALETTE.length ? g.color : i % PALETTE.length,
    };
  });
  return {
    classes,
    categories,
    holdings,
    trades,
    goals,
    paychecks: (Array.isArray(data.paychecks) ? data.paychecks : []).map((p) => ({
      id: str(p.id), date: str(p.date), amount: num(p.amount), note: str(p.note),
    })),
    purchases: (Array.isArray(data.purchases) ? data.purchases : [])
      .filter((p) => ids.has(str(p.categoryId)))
      .map((p) => ({
        id: str(p.id), date: str(p.date), categoryId: str(p.categoryId),
        amount: num(p.amount), description: str(p.description),
      })),
  };
}

/* ---------- calculations ---------- */

const classOf = (cat) => state.classes.find((c) => c.id === cat.classId);
const catsOf = (cls) => state.categories.filter((c) => c.classId === cls.id);
const isHold = (cat) => (classOf(cat) || {}).kind === "hold";

const incomeSince = (date) => state.paychecks
  .filter((p) => !date || p.date >= date)
  .reduce((s, p) => s + p.amount, 0);
const totalIncome = () => incomeSince("");

// Share of each paycheck that flows to a category: class % x category % of class.
const shareOf = (cat) => ((classOf(cat) || { percent: 0 }).percent / 100) * (cat.percent / 100);

// Savings/investment categories only count activity from their "as of" date.
const since = (cat) => (isHold(cat) ? cat.asOf : "");
const allocated = (cat) => incomeSince(since(cat)) * shareOf(cat);
const spent = (cat) => state.purchases
  .filter((p) => p.categoryId === cat.id && (!since(cat) || p.date >= since(cat)))
  .reduce((s, p) => s + p.amount, 0);
// Spending categories: budget left. Savings/investment categories: account balance.
const remaining = (cat) => (isHold(cat) ? cat.startBalance : 0) + allocated(cat) - spent(cat);

const spendClasses = () => state.classes.filter((c) => c.kind === "spend");
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
// Spending rings: the "whole" is what was available when the latest paycheck landed
// (carryover from earlier paychecks + the latest paycheck's share).
const latestPaycheckDate = () => state.paychecks.reduce((m, p) => (p.date > m ? p.date : m), "");
const spentBefore = (cat, date) => state.purchases
  .filter((p) => p.categoryId === cat.id && p.date < date)
  .reduce((s, p) => s + p.amount, 0);
const openingBudget = (cat) => allocated(cat) - spentBefore(cat, latestPaycheckDate());
const classOpening = (cl) => sum(catsOf(cl), openingBudget);
const classSpent = (cl) => sum(catsOf(cl), spent);
const catColor = (cat) => PALETTE[cat.color % PALETTE.length]; // categories and holdings both have .color
// Lowest palette color not used by any category/holding yet (so new ones look different).
function nextColor() {
  const all = [...state.categories, ...state.holdings];
  const used = new Set(all.map((c) => c.color));
  for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) return i;
  return all.length % PALETTE.length;
}

// Stocks classes: shares x latest price, plus paycheck money not yet invested.
const holdingsOf = (cl) => state.holdings.filter((h) => h.classId === cl.id);
const quoteOf = (h) => quotes[h.symbol];
const holdingValue = (h) => (quoteOf(h) ? h.shares * quoteOf(h).price : 0);
const classCash = (cl) => cl.startCash + incomeSince(cl.asOf) * (cl.percent / 100) - state.trades
  .filter((t) => t.date >= cl.asOf && (state.holdings.find((h) => h.id === t.holdingId) || {}).classId === cl.id)
  .reduce((s, t) => s + t.shares * t.price, 0);
const classBalance = (cl) => (cl.kind === "stocks"
  ? sum(holdingsOf(cl), holdingValue) + classCash(cl)
  : sum(catsOf(cl), remaining));

/* ---------- goals ---------- */

const DAY = 86400000;
const dayNum = (d) => Math.round(Date.parse(d + "T00:00:00Z") / DAY);
const dayStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const prettyDate = (d) => new Date(d + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

// What the goal is linked to right now: { saved, perCheck (null for manual), label }.
function goalSource(g) {
  const pcAvg = recentPaycheckAvg();
  if (g.link.startsWith("cat:")) {
    const cat = state.categories.find((c) => c.id === g.link.slice(4));
    if (cat) return { saved: remaining(cat), perCheck: pcAvg * shareOf(cat), label: `${(classOf(cat) || {}).name || "?"} › ${cat.name}` };
  } else if (g.link.startsWith("cls:")) {
    const cl = state.classes.find((c) => c.id === g.link.slice(4));
    if (cl) return { saved: classBalance(cl), perCheck: pcAvg * (cl.percent / 100), label: cl.name };
  }
  return { saved: g.saved, perCheck: null, label: "" };
}

function recentPaycheckAvg() {
  const last = [...state.paychecks].sort((a, b) => a.date.localeCompare(b.date)).slice(-6);
  return last.length ? sum(last, (p) => p.amount) / last.length : 0;
}

// Average days between paychecks (uses the last 7 dates); null when there are fewer than two.
function paycheckInterval() {
  const ds = [...new Set(state.paychecks.map((p) => p.date))].sort().slice(-7).map(dayNum);
  if (ds.length < 2) return null;
  return Math.max(1, (ds[ds.length - 1] - ds[0]) / (ds.length - 1));
}

// Everything the UI needs to know about one goal.
function goalInfo(g) {
  const src = goalSource(g);
  const saved = src.saved;
  const frac = g.target > 0 ? Math.max(0, Math.min(1, saved / g.target)) : 0;
  const left = Math.max(0, g.target - saved);
  const done = g.target > 0 && saved >= g.target - 0.005;
  const interval = paycheckInterval();
  const t = dayNum(today());
  let text = "", tone = "";

  if (done) {
    text = "Goal reached! 🎉"; tone = "ok";
  } else if (g.target <= 0) {
    text = "Set a target amount.";
  } else if (src.perCheck > 0.005 && interval) {
    // Linked goal: project from how much each paycheck adds to it.
    const n = Math.ceil(left / src.perCheck);
    const lastPc = dayNum([...state.paychecks].sort((a, b) => b.date.localeCompare(a.date))[0].date);
    const eta = Math.max(t, lastPc) + Math.round(n * interval);
    text = `~${n} paycheck${n === 1 ? "" : "s"} to go · around ${prettyDate(dayStr(eta))}`;
    if (g.due) {
      const dueN = dayNum(g.due);
      if (dueN < t) { text = `Past its ${prettyDate(g.due)} date · ${money(left)} short`; tone = "warn"; }
      else if (eta <= dueN) { text += " — on track"; tone = "ok"; }
      else {
        const checksLeft = Math.max(1, Math.floor((dueN - t) / interval));
        text = `Behind pace for ${prettyDate(g.due)} — needs ${money(left / checksLeft)} per paycheck, gets ${money(src.perCheck)}`;
        tone = "warn";
      }
    }
  } else if (g.due) {
    const dueN = dayNum(g.due);
    if (dueN < t) { text = `Past its ${prettyDate(g.due)} date · ${money(left)} short`; tone = "warn"; }
    else {
      const weeks = Math.max(1, (dueN - t) / 7);
      text = `${money(left / weeks)} per week to hit ${prettyDate(g.due)}`;
    }
  } else if (g.link) {
    text = "Add paychecks to see a projection.";
  } else {
    text = `${money(left)} to go`;
  }
  return { saved, frac, left, done, text, tone, label: src.label };
}

const activeGoals = () => state.goals.map((g) => ({ g, i: goalInfo(g) }));

/* ---------- circles ---------- */

// segs: [{frac 0..1, color}] drawn clockwise from the top.
function ringSvg(segs, size, stroke) {
  const r = (size - stroke) / 2, c = size / 2, C = 2 * Math.PI * r;
  let off = 0;
  const arcs = segs.filter((s) => s.frac > 0.0001).map((s) => {
    const f = Math.min(1 - off, Math.min(1, s.frac));
    const len = f * C;
    const el = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-linecap="butt" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off * C}" transform="rotate(-90 ${c} ${c})"/>`;
    off += f;
    return el;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" class="ring-svg" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${stroke}"/>${arcs}</svg>`;
}

function ringWrap(segs, size, stroke, value, label, bad) {
  return `<div class="ring" style="--size:${size}px">${ringSvg(segs, 100, stroke * 100 / size)}
    <div class="ring-center"><span class="ring-value${bad ? " bad" : ""}">${esc(value)}</span>${label ? `<span class="ring-label">${esc(label)}</span>` : ""}</div></div>`;
}

function holdFracs(cl) {
  const cats = catsOf(cl);
  const pos = sum(cats, (c) => Math.max(0, remaining(c)));
  return cats.map((c) => (pos > 0 ? Math.max(0, remaining(c)) / pos : 0));
}

// Fraction of each category that is still "full": share of the class balance (savings/investment)
// or what's left of the class budget (spending — spent money shows as empty track).
function catFracs(cl) {
  if (cl.kind === "hold") return holdFracs(cl);
  const b = classOpening(cl);
  return catsOf(cl).map((c) => (b > 0 ? Math.max(0, remaining(c)) / b : 0));
}

// Stocks: each holding's share of the class value, then leftover cash in a muted color.
// Holdings largest value first (stable for ties) — used for ring slice and mini-circle order.
const sortedHoldings = (cl) => [...holdingsOf(cl)]
  .sort((a, b) => Math.max(0, holdingValue(b)) - Math.max(0, holdingValue(a)));

function stockSegs(cl) {
  const hs = sortedHoldings(cl);
  const vals = hs.map((h) => Math.max(0, holdingValue(h)));
  const cash = Math.max(0, classCash(cl));
  const total = sum(vals, (v) => v) + cash;
  const f = (v) => (total > 0 ? v / total : 0);
  return [...hs.map((h, i) => ({ frac: f(vals[i]), color: catColor(h) })), { frac: f(cash), color: "var(--muted)" }];
}

function classRing(cl, size, stroke) {
  const bal = classBalance(cl);
  if (cl.kind === "stocks") return ringWrap(stockSegs(cl), size, stroke, money(bal), "total", bal < 0);
  const fr = catFracs(cl);
  const segs = catsOf(cl).map((c, i) => ({ frac: fr[i], color: catColor(c) }));
  return ringWrap(segs, size, stroke, money(bal), cl.kind === "hold" ? "balance" : "left", bal < 0);
}

/* ---------- rendering ---------- */

function render() {
  if (!["home", "paychecks", "goals"].includes(currentTab) && !state.classes.some((c) => c.id === currentTab)) currentTab = "home";
  renderUserButton();
  renderTabs();
  renderView();
}

function renderTabs() {
  $("tabs").innerHTML =
    `<button type="button" data-tab="home" aria-selected="${currentTab === "home"}">Home</button>` +
    `<button type="button" data-tab="paychecks" aria-selected="${currentTab === "paychecks"}">Paychecks</button>` +
    `<button type="button" data-tab="goals" aria-selected="${currentTab === "goals"}">Goals</button>` +
    state.classes.map((c) =>
      `<button type="button" data-tab="${esc(c.id)}" aria-selected="${currentTab === c.id}">${esc(c.name)}</button>`).join("") +
    '<button type="button" class="add-tab" data-new-class aria-label="New class" title="New class">+</button>';
}

function renderView() {
  const cl = state.classes.find((c) => c.id === currentTab);
  $("view").innerHTML = currentTab === "paychecks" ? paychecksView()
    : currentTab === "goals" ? goalsView() : cl ? classView(cl) : homeView();
}

function goalCard(g, info) {
  const col = PALETTE[g.color % PALETTE.length];
  const manual = !g.link;
  return `<div class="goal-card${info.done ? " done" : ""}">
    ${ringWrap([{ frac: info.frac, color: info.done ? "var(--good)" : col }], 130, 13, `${Math.round(info.frac * 100)}%`, "", false)}
    <div class="goal-name">${esc(g.name)}</div>
    <div class="goal-amt">${money(info.saved)} of ${money(g.target)}</div>
    <div class="goal-status ${info.tone}">${esc(info.text)}</div>
    <div class="goal-link">${manual ? "Tracked manually" : "Linked: " + esc(info.label)}${g.due ? " · due " + esc(prettyDate(g.due)) : ""}</div>
    <div class="goal-actions">
      ${manual ? `<button type="button" data-fund-goal="${esc(g.id)}">Add / remove funds</button>` : ""}
      <button type="button" class="secondary" data-edit-goal="${esc(g.id)}">Edit</button>
      <button type="button" class="secondary" data-del-goal="${esc(g.id)}">Delete</button>
    </div>
  </div>`;
}

function goalsView() {
  const gs = activeGoals();
  const target = sum(gs, (x) => x.g.target);
  const saved = sum(gs, (x) => Math.min(x.i.saved, x.g.target));
  const reached = gs.filter((x) => x.i.done).length;
  // Unfinished goals first, closest to done at the top.
  gs.sort((a, b) => a.i.done - b.i.done || b.i.frac - a.i.frac);
  return `
    <section class="stats">
      <div class="stat"><span class="label">Goals</span><span class="value">${gs.length}</span></div>
      <div class="stat"><span class="label">Reached</span><span class="value">${reached} of ${gs.length}</span></div>
      <div class="stat"><span class="label">Saved toward goals</span><span class="value">${money(saved)}<span class="muted" style="font-size:.9rem;font-weight:400"> / ${money(target)}</span></span></div>
    </section>
    <div class="section-head"><h2>Your goals</h2><button type="button" data-open-goal>New goal</button></div>
    ${gs.length ? `<div class="goal-grid">${gs.map((x) => goalCard(x.g, x.i)).join("")}</div>`
      : '<p class="muted">No goals yet. Set a target — like an emergency fund or a trip — and link it to one of your savings categories so it fills as paychecks come in.</p>'}`;
}

// Compact goal strip for the home page: the three closest-to-done unfinished goals.
function goalStrip() {
  const gs = activeGoals().filter((x) => !x.i.done).sort((a, b) => b.i.frac - a.i.frac).slice(0, 3);
  if (!gs.length) return "";
  return `<section class="goal-grid" style="margin:16px 0">${gs.map(({ g, i }) => `
    <button type="button" class="goal-mini" data-goto="goals">
      ${ringWrap([{ frac: i.frac, color: PALETTE[g.color % PALETTE.length] }], 56, 7, `${Math.round(i.frac * 100)}%`, "", false)}
      <div><div class="gm-name">${esc(g.name)}</div><div class="gm-sub">${money(i.saved)} of ${money(g.target)}</div></div>
    </button>`).join("")}</section>`;
}

// Nice round step for chart gridlines (1, 2, 5 x 10^n).
function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function lineChart() {
  const pts = [...state.paychecks].sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length) return '<p class="muted">Add a paycheck to see the graph.</p>';
  const W = 520, H = 240, L = 56, R = 22, T = 14, B = 34;
  const max = Math.max(...pts.map((p) => p.amount), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const t = (d) => Date.parse(d);
  const t0 = t(pts[0].date), span = t(pts[pts.length - 1].date) - t0;
  const x = (p) => (span > 0 ? L + ((t(p.date) - t0) / span) * (W - L - R) : L + (W - L - R) / 2);
  const y = (v) => T + (1 - v / top) * (H - T - B);

  let grid = "";
  for (let v = 0; v <= top + step / 2; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
      <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">$${v.toLocaleString()}</text>`;
  }
  const every = Math.ceil(pts.length / 7);
  const labels = pts.map((p, i) => (i % every === 0 || i === pts.length - 1)
    ? `<text x="${x(p)}" y="${H - 10}" text-anchor="middle" class="axis">${esc(p.date.slice(5))}</text>` : "").join("");
  const line = pts.length > 1
    ? `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p)},${y(p.amount)}`).join(" ")}" class="line"/>` : "";
  const dots = pts.map((p) =>
    `<circle cx="${x(p)}" cy="${y(p.amount)}" r="5" class="dot"><title>${esc(p.date)}: ${money(p.amount)}</title></circle>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Paychecks over time">${grid}${line}${dots}${labels}</svg>`;
}

function paychecksView() {
  const income = totalIncome();
  const spentTotal = sum(spendClasses(), classSpent);
  const net = sum(state.classes, classBalance);
  const f = (v) => (income > 0 ? Math.max(0, Math.min(1, v / income)) : 0);
  const spentFrac = f(spentTotal);
  const left = income - spentTotal;
  const rows = [...state.paychecks].map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.date.localeCompare(a.p.date) || b.i - a.i).map((x) => x.p);

  return `
    <div class="class-layout">
      <aside class="panel big-ring">
        ${ringWrap([{ frac: f(net), color: "var(--gold)" }], 240, 22, money(net), "net worth", net < 0)}
        <div class="ring-pair">
          ${ringWrap([
            { frac: spentFrac, color: "var(--bad)" },
            { frac: income > 0 ? 1 - spentFrac : 0, color: "var(--good)" },
          ], 180, 16, money(left), `left of ${money(income)}`, left < 0)}
        </div>
      </aside>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Paychecks over time</h2></div>
          ${lineChart()}
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>All paychecks</h2>
            <button type="button" data-open-paycheck>Add paycheck</button>
          </div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Date</th><th class="r">Amount</th><th>Note</th><th></th></tr></thead>
            <tbody>${rows.map((p) => `<tr>
              <td>${esc(p.date)}</td><td class="r">${money(p.amount)}</td><td>${esc(p.note)}</td>
              <td class="r"><button type="button" class="x" data-del-paycheck="${esc(p.id)}" aria-label="Delete paycheck">✕</button></td>
            </tr>`).join("") || '<tr><td colspan="4" class="muted">No paychecks yet.</td></tr>'}</tbody>
            ${rows.length ? `<tfoot><tr><td>Total</td><td class="r">${money(income)}</td><td></td><td></td></tr></tfoot>` : ""}
          </table></div>
        </section>
      </div>
    </div>`;
}

function txRowHtml(t) {
  return `<li>
    <div class="main">${esc(t.title)}<div class="sub">${esc(t.date)}${t.sub ? " · " + esc(t.sub) : ""}</div></div>
    <span class="amt ${t.amount >= 0 ? "pos" : "neg"}">${signed(t.amount)}</span>
    <button type="button" class="x" ${t.del} aria-label="Delete">✕</button>
  </li>`;
}

function purchaseTx(p, withClass) {
  const cat = state.categories.find((c) => c.id === p.categoryId) || {};
  const cl = classOf(cat) || {};
  return {
    date: p.date, title: p.description || "(no reason)", amount: -p.amount,
    sub: withClass ? `${cl.name || "?"} › ${cat.name || "?"}` : cat.name || "",
    del: `data-del-purchase="${esc(p.id)}"`,
  };
}

function homeView() {
  const income = totalIncome();
  const spentTotal = sum(spendClasses(), classSpent);
  const net = sum(state.classes, classBalance);

  const items = [
    ...state.paychecks.map((p) => ({
      date: p.date, title: "Paycheck", amount: p.amount, sub: p.note,
      del: `data-del-paycheck="${esc(p.id)}"`,
    })),
    ...state.purchases.map((p) => purchaseTx(p, true)),
    ...state.trades.map(tradeTx),
  ].map((t, i) => ({ ...t, i }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.i - a.i)
    .slice(0, 15);

  return `
    <section class="stats">
      <div class="stat"><span class="label">Total income</span><span class="value">${money(income)}</span></div>
      <div class="stat"><span class="label">Total spent</span><span class="value">${money(spentTotal)}</span></div>
      <div class="stat"><span class="label">Net worth</span><span class="value${net < 0 ? " bad" : ""}">${money(net)}</span></div>
    </section>

    ${goalStrip()}

    ${state.classes.length ? `<section class="ring-cards">${state.classes.map((cl) => `
      <button type="button" class="ring-card" data-goto="${esc(cl.id)}">
        ${classRing(cl, 130, 13)}
        <span class="rc-name">${esc(cl.name)}</span>
      </button>`).join("")}</section>` : '<p class="muted">Press + above to create your first class.</p>'}

    <section class="panel">
      <div class="panel-head">
        <h2>Recent transactions</h2>
        <button type="button" data-open-paycheck>Add paycheck</button>
      </div>
      <ul class="list">${items.map(txRowHtml).join("") || '<li class="empty">Nothing yet — add a paycheck to get started.</li>'}</ul>
    </section>`;
}

function classView(cl) {
  if (cl.kind === "stocks") return stocksView(cl);
  const cats = catsOf(cl);
  const ids = new Set(cats.map((c) => c.id));
  const txs = state.purchases.map((p, i) => ({ p, i })).filter((x) => ids.has(x.p.categoryId))
    .sort((a, b) => b.p.date.localeCompare(a.p.date) || b.i - a.i)
    .map((x) => purchaseTx(x.p, false));

  const hold = cl.kind === "hold";
  const fr = holdFracs(cl);
  const minis = cats.map((c, i) => {
    // Savings/investment: share of the class. Spending: how much of its own budget is left.
    const a = openingBudget(c);
    const frac = hold ? fr[i] : a > 0 ? Math.max(0, Math.min(1, remaining(c) / a)) : 0;
    return miniCard(c, [{ frac, color: catColor(c) }]);
  });

  return `
    <div class="class-layout">
      <aside class="panel big-ring">
        ${classRing(cl, 240, 22)}
        <h2 class="class-name">${esc(cl.name)}</h2>
        <div class="mini-grid" style="${miniLayout(minis.length)}">${minis.join("")}</div>
      </aside>
      <section class="panel">
        <div class="panel-head">
          <h2>Transactions</h2>
          <div class="btn-row">
            <button type="button" class="secondary" data-open-manage="${esc(cl.id)}">Manage</button>
            <button type="button" data-open-tx="${esc(cl.id)}" ${cats.length ? "" : "disabled"}>Add transaction</button>
          </div>
        </div>
        <ul class="list">${txs.map(txRowHtml).join("") || '<li class="empty">No transactions yet.</li>'}</ul>
      </section>
    </div>`;
}

// Column count and ring diameter for the per-category circles, based on how many there are.
function miniLayout(n) {
  const cols = Math.min(Math.max(n, 1), 3);
  const size = { 1: 150, 2: 125, 3: 92 }[cols];
  return `--cols:${cols};--mini-size:${size}px`;
}

function miniRing(name, value, segs, bad, sub) {
  return `<div class="mini">
    <div class="ring" style="--size:var(--mini-size, 72px)">${ringSvg(segs, 100, 14)}</div>
    <div class="mini-name">${esc(name)}</div>
    <div class="mini-val${bad ? " bad" : ""}">${money(value)}</div>
    ${sub ? `<div class="mini-sub muted">${esc(sub)}</div>` : ""}
  </div>`;
}

function miniCard(cat, segs) {
  const bal = remaining(cat);
  return miniRing(cat.name, bal, segs, bal < 0);
}

const qty = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });

function tradeTx(t) {
  const h = state.holdings.find((x) => x.id === t.holdingId) || {};
  const cl = state.classes.find((c) => c.id === h.classId) || {};
  return {
    date: t.date, amount: -(t.shares * t.price), sub: cl.name || "",
    title: `${t.shares >= 0 ? "Bought" : "Sold"} ${qty(Math.abs(t.shares))} ${h.symbol || "?"} @ ${money(t.price)}`,
    del: `data-del-trade="${esc(t.id)}"`,
  };
}

function priceStatusText() {
  if (refreshing) return "Updating prices…";
  if (priceStatus) return priceStatus;
  const t = Object.values(quotes).reduce((m, q) => Math.max(m, q.time), 0);
  return t ? `Prices updated ${new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "No prices yet.";
}

function stocksView(cl) {
  const hs = holdingsOf(cl);
  const ids = new Set(hs.map((h) => h.id));
  const cash = classCash(cl);
  const segs = stockSegs(cl);
  const txs = state.trades.map((t, i) => ({ t, i })).filter((x) => ids.has(x.t.holdingId))
    .sort((a, b) => b.t.date.localeCompare(a.t.date) || b.i - a.i).map((x) => tradeTx(x.t));
  const minis = sortedHoldings(cl).map((h, i) => miniRing(h.symbol, holdingValue(h), [{ frac: segs[i].frac, color: catColor(h) }], false, `${qty(h.shares)} sh`));
  minis.push(miniRing("Cash", cash, [{ frac: segs[hs.length].frac, color: "var(--muted)" }], cash < 0));

  const rows = hs.map((h) => {
    const q = quoteOf(h);
    const chg = q && q.prevClose > 0 ? (q.price / q.prevClose - 1) * 100 : null;
    return `<tr>
      <td><span class="dot-key" style="background:${catColor(h)}"></span>${esc(h.symbol)}</td>
      <td class="r">${qty(h.shares)}</td>
      <td class="r">${q ? money(q.price) : "—"}</td>
      <td class="r">${q ? money(holdingValue(h)) : "—"}</td>
      <td class="r ${chg == null ? "muted" : chg >= 0 ? "pos" : "neg"}">${chg == null ? "—" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</td>
    </tr>`;
  }).join("");

  return `
    <div class="class-layout">
      <aside class="panel big-ring">
        ${classRing(cl, 240, 22)}
        <h2 class="class-name">${esc(cl.name)}</h2>
        <div class="mini-grid" style="${miniLayout(minis.length)}">${minis.join("")}</div>
      </aside>
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <h2>Holdings</h2>
            <div class="btn-row">
              <button type="button" class="secondary" data-refresh>Refresh now</button>
              <button type="button" class="secondary" data-open-manage="${esc(cl.id)}">Manage</button>
              <button type="button" data-open-trade="${esc(cl.id)}" ${hs.length ? "" : "disabled"}>Buy / Sell</button>
            </div>
          </div>
          <div class="table-wrap"><table class="tbl">
            <thead><tr><th>Symbol</th><th class="r">Shares</th><th class="r">Price</th><th class="r">Value</th><th class="r">Today</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="muted">No holdings yet — press Manage to add one.</td></tr>'}</tbody>
          </table></div>
          <p class="note">${esc(priceStatusText())}</p>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Transactions</h2></div>
          <ul class="list">${txs.map(txRowHtml).join("") || '<li class="empty">No buys or sells yet.</li>'}</ul>
        </section>
      </div>
    </div>`;
}

/* ---------- dialogs ---------- */

function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
}

function openTx(clId) {
  const cl = state.classes.find((c) => c.id === clId);
  if (!cl) return;
  const cats = catsOf(cl);
  txClassId = clId;
  $("tx-title").textContent = `Add transaction — ${cl.name}`;
  $("tx-category").innerHTML = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("tx-reason").value = "";
  $("tx-amount").value = "";
  $("tx-date").value = today();
  $("tx-form").elements["tx-kind"].value = "sub";
  openDialog("dlg-tx");
  $("tx-amount").focus();
}

function openTrade(clId) {
  const cl = state.classes.find((c) => c.id === clId);
  if (!cl) return;
  tradeClassId = clId;
  $("trade-title").textContent = `Buy / Sell — ${cl.name}`;
  $("trade-holding").innerHTML = holdingsOf(cl).map((h) => `<option value="${esc(h.id)}">${esc(h.symbol)}</option>`).join("");
  $("trade-shares").value = "";
  $("trade-date").value = today();
  $("trade-form").elements["trade-kind"].value = "buy";
  fillTradePrice();
  openDialog("dlg-trade");
  $("trade-shares").focus();
}

// Prefill the price with the latest known price of the chosen holding.
function fillTradePrice() {
  const h = state.holdings.find((x) => x.id === $("trade-holding").value);
  const q = h && quoteOf(h);
  $("trade-price").value = q ? q.price.toFixed(2) : "";
}

function openSettings() {
  renderThemePicker();
  $("prices-key").value = getKey();
  $("prices-status").textContent = priceStatusText();
  $("backup-note").textContent = `Export and Import apply to the current user (${activeUser().name}).`;
  openDialog("dlg-settings");
}

function renderUsers() {
  $("user-list").innerHTML = profiles.list.map((u) => {
    const cur = u.id === activeId();
    return `<li class="user-row${cur ? " current" : ""}">
      <button type="button" class="user-name" data-switch-user="${esc(u.id)}" ${cur ? 'aria-current="true"' : ""}>${esc(u.name)}${cur ? ' <span class="badge">current</span>' : ""}</button>
      <button type="button" class="secondary small" data-rename-user="${esc(u.id)}">Rename</button>
      <button type="button" class="danger small" data-del-user="${esc(u.id)}" ${profiles.list.length < 2 ? "disabled" : ""}>Delete</button>
    </li>`;
  }).join("");
  $("user-error").textContent = "";
}

function openUsers() {
  renderUsers();
  $("user-new-name").value = "";
  openDialog("dlg-users");
}

// Top-bar button shows who is signed in.
function renderUserButton() {
  $("user-btn").textContent = `👤 ${activeUser().name}`;
}

let goalEditId = null;
let fundGoalId = null;

// Every balance a goal can follow: savings/investment categories and stocks classes.
function goalLinkOptions(selected) {
  const opts = ['<option value="">Manual — I add the money myself</option>'];
  state.classes.forEach((cl) => {
    if (cl.kind === "hold") {
      catsOf(cl).forEach((c) => {
        const v = "cat:" + c.id;
        opts.push(`<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(cl.name)} › ${esc(c.name)}</option>`);
      });
    } else if (cl.kind === "stocks") {
      const v = "cls:" + cl.id;
      opts.push(`<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(cl.name)} (all holdings)</option>`);
    }
  });
  return opts.join("");
}

function syncGoalForm() {
  const linked = !!$("goal-link").value;
  $("goal-saved-wrap").hidden = linked;
  $("goal-hint").textContent = linked
    ? "Progress follows that balance automatically, and the ETA is based on your paycheck history."
    : "";
}

function openGoal(id) {
  const g = id ? state.goals.find((x) => x.id === id) : null;
  goalEditId = g ? g.id : null;
  $("goal-title").textContent = g ? "Edit goal" : "New goal";
  $("goal-name").value = g ? g.name : "";
  $("goal-target").value = g ? g.target : "";
  $("goal-link").innerHTML = goalLinkOptions(g ? g.link : "");
  $("goal-saved").value = g ? g.saved : 0;
  $("goal-due").value = g ? g.due : "";
  syncGoalForm();
  openDialog("dlg-goal");
  $("goal-name").focus();
}

function openFund(id) {
  const g = state.goals.find((x) => x.id === id);
  if (!g) return;
  fundGoalId = id;
  $("fund-title").textContent = `Funds — ${g.name}`;
  $("fund-amount").value = "";
  $("fund-form").elements["fund-kind"].value = "add";
  openDialog("dlg-fund");
  $("fund-amount").focus();
}

// Drop goal links whose category/class no longer exists (or is no longer savings/stocks).
function pruneGoalLinks() {
  const valid = new Set([
    ...state.categories.filter((c) => (classOf(c) || {}).kind === "hold").map((c) => "cat:" + c.id),
    ...state.classes.filter((c) => c.kind === "stocks").map((c) => "cls:" + c.id),
  ]);
  state.goals.forEach((g) => { if (g.link && !valid.has(g.link)) g.link = ""; });
}

function openClassDialog() {
  const total = state.classes.reduce((s, c) => s + c.percent, 0);
  $("cls-hint").textContent = state.classes.length
    ? `Your classes currently total ${pct(total)}% of each paycheck.` : "";
  $("cls-name").value = "";
  $("cls-percent").value = "";
  $("cls-kind").value = "spend";
  openDialog("dlg-class");
  $("cls-name").focus();
}

function renderManage() {
  const cl = state.classes.find((c) => c.id === manageId);
  if (!cl) { $("dlg-manage").close(); return; }
  const cats = catsOf(cl);
  const hold = cl.kind === "hold";
  $("manage-title").textContent = `Manage ${cl.name}`;
  if (cl.kind === "stocks") { renderManageStocks(cl); return; }
  $("manage-body").innerHTML = `
    <div class="field-row">
      <label class="field grow">Name
        <input type="text" value="${esc(cl.name)}" maxlength="40" data-cls-name="${esc(cl.id)}"></label>
      <label class="field">% of paycheck
        <input type="number" value="${pct(cl.percent)}" min="0" max="100" step="0.01" data-cls-percent="${esc(cl.id)}"></label>
      <label class="field">Type
        <select data-cls-kind="${esc(cl.id)}">
          <option value="spend"${hold ? "" : " selected"}>Spending</option>
          <option value="hold"${hold ? " selected" : ""}>Savings/Investment</option>
          <option value="stocks">Stocks (live prices)</option>
        </select></label>
    </div>
    <p id="mg-classtotal" class="note"></p>
    <h3>Categories</h3>
    <ul class="list">${cats.map((c) => `
      <li class="cat-row">
        <input type="text" value="${esc(c.name)}" maxlength="40" data-edit-name="${esc(c.id)}" aria-label="Category name">
        <label class="inline">% of class
          <input type="number" value="${pct(c.percent)}" min="0" max="100" step="0.01" data-edit-percent="${esc(c.id)}" class="pct"></label>
        ${hold ? `
        <label class="inline">Starting balance
          <input type="number" value="${c.startBalance}" step="0.01" data-hold-start="${esc(c.id)}" class="money"></label>
        <label class="inline">As of
          <input type="date" value="${esc(c.asOf)}" data-hold-asof="${esc(c.id)}"></label>` : ""}
        <button type="button" class="x" data-del-category="${esc(c.id)}" aria-label="Delete category">✕</button>
        <div class="swatches" role="group" aria-label="Color">${PALETTE.map((col, i) =>
          `<button type="button" class="swatch${c.color === i ? " sel" : ""}" style="--sw:${col}" data-color="${esc(c.id)}:${i}" aria-label="Color ${i + 1}"></button>`).join("")}</div>
      </li>`).join("") || '<li class="empty">No categories yet.</li>'}</ul>
    <p id="mg-cattotal" class="note"></p>
    <form class="form" data-add-cat="${esc(cl.id)}">
      <input type="text" name="n" placeholder="New category" required maxlength="40" aria-label="New category name">
      <input type="number" name="p" min="0" max="100" step="0.01" placeholder="% of class" required aria-label="New category percent">
      <button type="submit" class="secondary">Add category</button>
    </form>
    <div class="dlg-actions split">
      <button type="button" class="danger" data-del-cls="${esc(cl.id)}">Delete class</button>
      <button type="button" data-close>Done</button>
    </div>`;
  manageWarnings();
}

function renderManageStocks(cl) {
  const hs = holdingsOf(cl);
  $("manage-body").innerHTML = `
    <div class="field-row">
      <label class="field grow">Name
        <input type="text" value="${esc(cl.name)}" maxlength="40" data-cls-name="${esc(cl.id)}"></label>
      <label class="field">% of paycheck
        <input type="number" value="${pct(cl.percent)}" min="0" max="100" step="0.01" data-cls-percent="${esc(cl.id)}"></label>
      <label class="field">Type
        <select disabled><option>Stocks (live prices)</option></select></label>
    </div>
    <p id="mg-classtotal" class="note"></p>
    <div class="field-row">
      <label class="field">Starting cash to invest
        <input type="number" value="${cl.startCash}" step="0.01" data-cls-cash="${esc(cl.id)}"></label>
      <label class="field">As of
        <input type="date" value="${esc(cl.asOf)}" data-cls-asof="${esc(cl.id)}"></label>
    </div>
    <h3>Holdings</h3>
    <ul class="list">${hs.map((h) => `
      <li class="cat-row">
        <input type="text" value="${esc(h.symbol)}" maxlength="10" data-hold-symbol="${esc(h.id)}" aria-label="Ticker symbol">
        <label class="inline">Shares
          <input type="number" value="${h.shares}" min="0" step="any" data-hold-shares="${esc(h.id)}" class="money"></label>
        <button type="button" class="x" data-del-holding="${esc(h.id)}" aria-label="Delete holding">✕</button>
        <div class="swatches" role="group" aria-label="Color">${PALETTE.map((col, i) =>
          `<button type="button" class="swatch${h.color === i ? " sel" : ""}" style="--sw:${col}" data-color="${esc(h.id)}:${i}" aria-label="Color ${i + 1}"></button>`).join("")}</div>
      </li>`).join("") || '<li class="empty">No holdings yet.</li>'}</ul>
    <form class="form" data-add-holding="${esc(cl.id)}">
      <input type="text" name="s" placeholder="Ticker (e.g. VOO)" required maxlength="10" pattern="[A-Za-z0-9.\\-]{1,10}" aria-label="Ticker symbol">
      <input type="number" name="n" min="0" step="any" placeholder="Shares you own" required aria-label="Shares owned">
      <button type="submit" class="secondary">Add holding</button>
    </form>
    <div class="dlg-actions split">
      <button type="button" class="danger" data-del-cls="${esc(cl.id)}">Delete class</button>
      <button type="button" data-close>Done</button>
    </div>`;
  manageWarnings();
}

function manageWarnings() {
  const cl = state.classes.find((c) => c.id === manageId);
  if (!cl || !$("mg-classtotal")) return;
  const total = state.classes.reduce((s, c) => s + c.percent, 0);
  const t = $("mg-classtotal");
  const okAll = Math.abs(total - 100) < 0.005;
  t.textContent = `All classes total ${pct(total)}% of each paycheck` + (okAll ? "." : total < 100 ? ` — ${pct(100 - total)}% is unallocated.` : " — over 100%.");
  t.className = "note " + (okAll ? "ok" : "bad");
  const c2 = $("mg-cattotal");
  if (!c2) return; // stocks classes have no categories
  const ct = sum(catsOf(cl), (c) => c.percent);
  const okCat = Math.abs(ct - 100) < 0.005;
  c2.textContent = catsOf(cl).length ? `Categories total ${pct(ct)}% of this class` + (okCat ? "." : " — should be 100%.") : "";
  c2.className = "note " + (okCat ? "ok" : "bad");
}

/* ---------- events ---------- */

function go(tab) {
  currentTab = tab;
  try { localStorage.setItem(tabKey(), tab); } catch (e) { /* ignore */ }
  render();
}

document.addEventListener("click", (e) => {
  const dlg = e.target.tagName === "DIALOG" ? e.target : null;
  if (dlg) { // click on the backdrop closes the pop-up
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    return;
  }
  const btn = e.target.closest("button");
  if (!btn) return;
  const d = btn.dataset;
  if (d.close !== undefined) { btn.closest("dialog").close(); return; }
  if (d.tab) { go(d.tab); return; }
  if (d.goto) { go(d.goto); return; }
  if (d.newClass !== undefined) { openClassDialog(); return; }
  if (d.openPaycheck !== undefined) {
    $("pc-date").value = today(); $("pc-amount").value = ""; $("pc-note").value = "";
    openDialog("dlg-paycheck"); $("pc-amount").focus(); return;
  }
  if (d.openTx) { openTx(d.openTx); return; }
  if (d.openTrade) { openTrade(d.openTrade); return; }
  if (d.openGoal !== undefined) { openGoal(null); return; }
  if (d.editGoal) { openGoal(d.editGoal); return; }
  if (d.fundGoal) { openFund(d.fundGoal); return; }
  if (d.delGoal) {
    const g = state.goals.find((x) => x.id === d.delGoal);
    if (g && confirm(`Delete the goal "${g.name}"?`)) { state.goals = state.goals.filter((x) => x.id !== d.delGoal); save(); render(); }
    return;
  }
  if (d.openSettings !== undefined) { openSettings(); return; }
  if (d.openUsers !== undefined) { openUsers(); return; }
  if (d.switchUser) {
    if (d.switchUser !== activeId()) switchUser(d.switchUser);
    $("dlg-users").close();
    return;
  }
  if (d.renameUser) {
    const u = profiles.list.find((x) => x.id === d.renameUser);
    const name = u && (prompt("Rename user", u.name) || "").trim();
    if (!u || !name || name === u.name) return;
    const err = userNameError(name, u.id);
    if (err) { $("user-error").textContent = err; return; }
    renameUser(u.id, name); renderUsers(); renderUserButton();
    return;
  }
  if (d.delUser) {
    const u = profiles.list.find((x) => x.id === d.delUser);
    if (u && profiles.list.length > 1 && confirm(`Delete user "${u.name}" and all of their data? This can't be undone (export it first if unsure).`)) {
      deleteUser(u.id); renderUsers(); renderUserButton();
    }
    return;
  }
  if (d.exportData !== undefined) { exportData(); return; }
  if (d.importData !== undefined) { $("import-file").click(); return; }
  if (d.theme) { setTheme(d.theme); return; }
  if (d.refresh !== undefined) { refreshPrices(true); return; }
  if (d.openManage) { manageId = d.openManage; renderManage(); openDialog("dlg-manage"); return; }
  if (d.color) {
    const [itemId, idx] = d.color.split(":");
    const item = state.categories.find((c) => c.id === itemId) || state.holdings.find((h) => h.id === itemId);
    if (item) { item.color = Number(idx) % PALETTE.length; save(); render(); renderManage(); }
    return;
  }

  if (d.delPaycheck) {
    state.paychecks = state.paychecks.filter((p) => p.id !== d.delPaycheck);
  } else if (d.delTrade) {
    const t = state.trades.find((x) => x.id === d.delTrade);
    const h = t && state.holdings.find((x) => x.id === t.holdingId);
    if (h) h.shares = Math.max(0, h.shares - t.shares); // undo the buy/sell
    state.trades = state.trades.filter((x) => x.id !== d.delTrade);
  } else if (d.delHolding) {
    const count = state.trades.filter((t) => t.holdingId === d.delHolding).length;
    if (count && !confirm(`This holding has ${count} buy/sell record(s). Deleting it will delete them too. Continue?`)) return;
    state.holdings = state.holdings.filter((h) => h.id !== d.delHolding);
    state.trades = state.trades.filter((t) => t.holdingId !== d.delHolding);
    save(); render(); renderManage(); return;
  } else if (d.delPurchase) {
    state.purchases = state.purchases.filter((p) => p.id !== d.delPurchase);
  } else if (d.delCategory) {
    const count = state.purchases.filter((p) => p.categoryId === d.delCategory).length;
    if (count && !confirm(`This category has ${count} transaction(s). Deleting it will delete them too. Continue?`)) return;
    state.categories = state.categories.filter((c) => c.id !== d.delCategory);
    state.purchases = state.purchases.filter((p) => p.categoryId !== d.delCategory);
    save(); render(); renderManage(); return;
  } else if (d.delCls) {
    const catIds = new Set(state.categories.filter((c) => c.classId === d.delCls).map((c) => c.id));
    const holdIds = new Set(state.holdings.filter((h) => h.classId === d.delCls).map((h) => h.id));
    const count = state.purchases.filter((p) => catIds.has(p.categoryId)).length
      + state.trades.filter((t) => holdIds.has(t.holdingId)).length;
    const n = catIds.size + holdIds.size;
    const msg = count
      ? `This class has ${n} categor${n === 1 ? "y/holding" : "ies/holdings"} and ${count} transaction(s). Deleting it will delete them too. Continue?`
      : "Delete this class and everything in it?";
    if (!confirm(msg)) return;
    state.classes = state.classes.filter((c) => c.id !== d.delCls);
    state.categories = state.categories.filter((c) => c.classId !== d.delCls);
    state.purchases = state.purchases.filter((p) => !catIds.has(p.categoryId));
    state.holdings = state.holdings.filter((h) => h.classId !== d.delCls);
    state.trades = state.trades.filter((t) => !holdIds.has(t.holdingId));
    $("dlg-manage").close();
    go("home");
    save();
    return;
  } else {
    return;
  }
  save(); render();
});

$("pc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = parseFloat($("pc-amount").value);
  const date = $("pc-date").value;
  if (!(amount > 0) || !date) return;
  state.paychecks.push({ id: uid(), date, amount, note: $("pc-note").value.trim() });
  $("dlg-paycheck").close();
  save(); render();
});

$("tx-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amount = parseFloat($("tx-amount").value);
  const date = $("tx-date").value;
  const categoryId = $("tx-category").value;
  const cl = state.classes.find((c) => c.id === txClassId);
  if (!(amount > 0) || !date || !cl || !catsOf(cl).some((c) => c.id === categoryId)) return;
  const added = $("tx-form").elements["tx-kind"].value === "add";
  // Stored as money out of the category (+) or into it (-).
  state.purchases.push({
    id: uid(), date, categoryId, amount: added ? -amount : amount, description: $("tx-reason").value.trim(),
  });
  $("dlg-tx").close();
  save(); render();
});

$("cls-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("cls-name").value.trim();
  const percent = parseFloat($("cls-percent").value);
  const kindVal = $("cls-kind").value;
  const kind = kindVal === "hold" ? "hold" : kindVal === "stocks" ? "stocks" : "spend";
  if (!name || !(percent >= 0 && percent <= 100)) return;
  const id = uid();
  state.classes.push({ id, name, percent, kind, startCash: 0, asOf: today() });
  // Start with one category holding all of the class so it works immediately
  // (a stocks class starts empty: add tickers under Manage).
  if (kind !== "stocks") {
    state.categories.push({ id: uid(), classId: id, name, percent: 100, startBalance: 0, asOf: today(), color: nextColor() });
  }
  $("dlg-class").close();
  save(); go(id);
});

$("goal-link").addEventListener("change", syncGoalForm);

$("goal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("goal-name").value.trim();
  const target = parseFloat($("goal-target").value);
  if (!name || !(target > 0)) return;
  const link = $("goal-link").value;
  const saved = parseFloat($("goal-saved").value);
  const fields = { name, target, link, saved: link ? 0 : (Number.isFinite(saved) ? saved : 0), due: $("goal-due").value };
  const g = state.goals.find((x) => x.id === goalEditId);
  if (g) Object.assign(g, fields);
  else state.goals.push({ id: uid(), created: today(), color: state.goals.length % PALETTE.length, ...fields });
  $("dlg-goal").close();
  save(); render();
});

$("fund-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const g = state.goals.find((x) => x.id === fundGoalId);
  const amt = parseFloat($("fund-amount").value);
  if (!g || !(amt > 0)) return;
  const remove = $("fund-form").elements["fund-kind"].value === "remove";
  g.saved = Math.max(0, g.saved + (remove ? -amt : amt));
  $("dlg-fund").close();
  save(); render();
});

$("trade-holding").addEventListener("change", fillTradePrice);

$("trade-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const cl = state.classes.find((c) => c.id === tradeClassId);
  const h = state.holdings.find((x) => x.id === $("trade-holding").value);
  const shares = parseFloat($("trade-shares").value);
  const price = parseFloat($("trade-price").value);
  const date = $("trade-date").value;
  if (!cl || !h || h.classId !== cl.id || !(shares > 0) || !(price >= 0) || !date) return;
  const buy = $("trade-form").elements["trade-kind"].value === "buy";
  if (!buy && shares > h.shares + 1e-9) { alert(`You only have ${qty(h.shares)} shares of ${h.symbol}.`); return; }
  const signedShares = buy ? shares : -shares;
  h.shares += signedShares;
  state.trades.push({ id: uid(), date, holdingId: h.id, shares: signedShares, price });
  $("dlg-trade").close();
  save(); render();
});

$("prices-form").addEventListener("submit", (e) => {
  e.preventDefault();
  try { localStorage.setItem(apiKeyKey(), $("prices-key").value.trim()); } catch (err) { /* ignore */ }
  priceStatus = "";
  refreshPrices(true);
});

// Add a holding or a category inside the manage pop-up.
$("manage-body").addEventListener("submit", (e) => {
  const hform = e.target.closest("form[data-add-holding]");
  if (hform) {
    e.preventDefault();
    const symbol = hform.elements.s.value.trim().toUpperCase();
    const shares = parseFloat(hform.elements.n.value);
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol) || !(shares >= 0)) return;
    state.holdings.push({ id: uid(), classId: hform.dataset.addHolding, symbol, shares, color: nextColor() });
    save(); render(); renderManage();
    refreshPrices(false);
    return;
  }
  const form = e.target.closest("form[data-add-cat]");
  if (!form) return;
  e.preventDefault();
  const name = form.elements.n.value.trim();
  const percent = parseFloat(form.elements.p.value);
  if (!name || !(percent >= 0 && percent <= 100)) return;
  state.categories.push({
    id: uid(), classId: form.dataset.addCat, name, percent, startBalance: 0, asOf: today(), color: nextColor(),
  });
  save(); render(); renderManage();
});

// Inline edits in the manage pop-up ("change" so typing isn't interrupted).
$("manage-body").addEventListener("change", (e) => {
  const t = e.target, d = t.dataset;
  let structural = false;
  if (d.clsName || d.clsPercent || d.clsKind) {
    const cls = state.classes.find((c) => c.id === (d.clsName || d.clsPercent || d.clsKind));
    if (!cls) return;
    if (d.clsName) { const n = t.value.trim(); if (n) cls.name = n; }
    else if (d.clsPercent) { const p = parseFloat(t.value); if (p >= 0 && p <= 100) cls.percent = p; }
    else if (t.value === "stocks") {
      structural = true;
      const cats = catsOf(cls);
      const ids = new Set(cats.map((c) => c.id));
      const n = state.purchases.filter((p) => ids.has(p.categoryId)).length;
      if (!confirm(`Switch "${cls.name}" to stocks? Its ${cats.length} categor${cats.length === 1 ? "y" : "ies"} and ${n} transaction(s) will be removed, and its current balance of ${money(classBalance(cls))} becomes starting cash. You then add your tickers and shares.`)) {
        renderManage();
        return;
      }
      cls.startCash = classBalance(cls);
      cls.asOf = today();
      cls.kind = "stocks";
      state.categories = state.categories.filter((c) => c.classId !== cls.id);
      state.purchases = state.purchases.filter((p) => !ids.has(p.categoryId));
    } else {
      cls.kind = t.value === "hold" ? "hold" : "spend";
      // Becoming a savings/investment class: start tracking from today.
      if (cls.kind === "hold") catsOf(cls).forEach((c) => { c.asOf = today(); });
      structural = true;
    }
  } else if (d.clsCash || d.clsAsof) {
    const cls = state.classes.find((c) => c.id === (d.clsCash || d.clsAsof));
    if (!cls) return;
    if (d.clsCash) { const v = parseFloat(t.value); cls.startCash = Number.isFinite(v) ? v : 0; }
    else if (t.value) cls.asOf = t.value;
  } else if (d.holdSymbol || d.holdShares) {
    const h = state.holdings.find((x) => x.id === (d.holdSymbol || d.holdShares));
    if (!h) return;
    if (d.holdSymbol) {
      const s = t.value.trim().toUpperCase();
      if (/^[A-Z0-9.\-]{1,10}$/.test(s)) h.symbol = s;
      structural = true;
    } else { const v = parseFloat(t.value); h.shares = v >= 0 ? v : 0; }
  } else if (d.editName || d.editPercent || d.holdStart || d.holdAsof) {
    const cat = state.categories.find((c) => c.id === (d.editName || d.editPercent || d.holdStart || d.holdAsof));
    if (!cat) return;
    if (d.editName) { const n = t.value.trim(); if (n) cat.name = n; }
    else if (d.editPercent) { const p = parseFloat(t.value); if (p >= 0 && p <= 100) cat.percent = p; }
    else if (d.holdStart) { const v = parseFloat(t.value); cat.startBalance = Number.isFinite(v) ? v : 0; }
    else if (t.value) cat.asOf = t.value;
  } else {
    return;
  }
  save(); render();
  if (structural) renderManage(); else { $("manage-title").textContent = `Manage ${(state.classes.find((c) => c.id === manageId) || {}).name || ""}`; manageWarnings(); }
  if (d.holdSymbol) refreshPrices(false); // a renamed ticker needs its own price
});

/* ---------- live prices (Finnhub) ---------- */

const symbolsList = () => [...new Set(state.holdings.map((h) => h.symbol).filter(Boolean))];
const isStale = () => symbolsList().some((s) => !quotes[s] || Date.now() - quotes[s].time >= STALE_MS);

function showPriceStatus() {
  render();
  if ($("dlg-settings").open) $("prices-status").textContent = priceStatusText();
}

// Fetch the latest price of every held symbol. Without force, only runs when prices are stale.
async function refreshPrices(force) {
  if (refreshing) return;
  const syms = symbolsList();
  if (!syms.length || (!force && !isStale())) return;
  const key = getKey();
  if (!key) {
    priceStatus = "Add your free Finnhub key under Settings to get live prices.";
    showPriceStatus();
    return;
  }
  refreshing = true;
  priceStatus = "";
  showPriceStatus();
  const unknown = [];
  try {
    for (const sym of syms) {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
      if (res.status === 401 || res.status === 403) { priceStatus = "Finnhub rejected the key — check it under Settings."; break; }
      if (res.status === 429) { priceStatus = "Finnhub says too many requests — it will retry later."; break; }
      if (!res.ok) { priceStatus = `Finnhub returned an error (${res.status}).`; break; }
      const q = await res.json();
      if (!(Number(q.c) > 0)) { unknown.push(sym); continue; }
      quotes[sym] = { price: Number(q.c), prevClose: Number(q.pc) > 0 ? Number(q.pc) : 0, time: Date.now() };
    }
  } catch (err) {
    priceStatus = "Couldn't reach Finnhub — showing the last known prices.";
  }
  if (!priceStatus && unknown.length) priceStatus = `No price found for ${unknown.join(", ")} (US tickers only).`;
  saveQuotes();
  refreshing = false;
  showPriceStatus();
}

/* ---------- export / import ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const who = activeUser().name.replace(/[^\w\-]+/g, "_") || "user";
  a.download = `budget-${who}-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = sanitize(JSON.parse(await file.text()));
    if (!data) throw new Error("bad data");
    if (!confirm(`Importing replaces all of ${activeUser().name}'s current data. Continue?`)) return;
    state = data;
    save(); $("dlg-settings").close(); go("home");
    refreshPrices(false);
  } catch (err) {
    alert("That file isn't a valid budget backup.");
  }
});

/* ---------- themes ---------- */

const THEME_KEY = "budgetTracker.theme";
// Preview colors are [background, panel, accent]. "auto" has no entry: it shows a light/dark split.
const THEMES = [
  { id: "auto", name: "System" },
  { id: "light", name: "Light", prev: ["#f4f6f8", "#ffffff", "#2563eb"] },
  { id: "dark", name: "Dark", prev: ["#12161c", "#1b212a", "#5b8def"] },
  { id: "midnight", name: "Midnight", prev: ["#0b0b17", "#14142a", "#8b7cf6"] },
  { id: "forest", name: "Forest", prev: ["#0f1a14", "#16241c", "#3fb872"] },
  { id: "ocean", name: "Ocean", prev: ["#eaf4f8", "#ffffff", "#0e7490"] },
  { id: "sunset", name: "Sunset", prev: ["#fbf3ea", "#fffaf4", "#d9480f"] },
  { id: "nord", name: "Nord", prev: ["#2e3440", "#3b4252", "#88c0d0"] },
  { id: "dracula", name: "Dracula", prev: ["#282a36", "#343746", "#bd93f9"] },
  { id: "solarized", name: "Solarized", prev: ["#fdf6e3", "#fffdf5", "#268bd2"] },
  { id: "mocha", name: "Mocha", prev: ["#1e1714", "#2a201b", "#d4a373"] },
  { id: "rose", name: "Rose", prev: ["#fdf2f5", "#fff8fa", "#db2777"] },
  { id: "graphite", name: "Graphite", prev: ["#151515", "#202020", "#e8e8e8"] },
  { id: "cyber", name: "Cyber", prev: ["#0a0e1a", "#111833", "#00e5ff"] },
];

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return THEMES.some((x) => x.id === t) ? t : "auto";
}

function setTheme(id) {
  if (!THEMES.some((x) => x.id === id)) return;
  if (id === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try { localStorage.setItem(THEME_KEY, id); } catch (e) { /* ignore */ }
  renderThemePicker();
}

function renderThemePicker() {
  const cur = currentTheme();
  $("theme-grid").innerHTML = THEMES.map((t) => {
    const prev = t.prev
      ? `--p-bg:${t.prev[0]};--p-panel:${t.prev[1]};--p-accent:${t.prev[2]}`
      : "--p-bg:linear-gradient(90deg,#f4f6f8 50%,#12161c 50%);--p-panel:linear-gradient(90deg,#ffffff 50%,#1b212a 50%);--p-accent:#5b8def";
    return `<button type="button" class="theme-opt" data-theme="${t.id}" aria-pressed="${t.id === cur}">
      <span class="theme-prev" style="${prev}"></span>${esc(t.name)}</button>`;
  }).join("");
}

/* ---------- init ---------- */

ensureProfiles();
state = load();
quotes = loadQuotes();
try { currentTab = localStorage.getItem(tabKey()) || "home"; } catch (e) { /* ignore */ }
render();

// Add a new user from the users pop-up.
$("user-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("user-new-name").value.trim();
  const err = userNameError(name, "");
  if (err) { $("user-error").textContent = err; return; }
  addUser(name);
  $("dlg-users").close();
});

// Prices refresh when the page opens, then roughly hourly while it stays open.
refreshPrices(false);
setInterval(() => refreshPrices(false), CHECK_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshPrices(false); });
