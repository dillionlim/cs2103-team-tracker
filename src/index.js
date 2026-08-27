// Filters the public CS2103 dashboards down to one team, serves them as a few KB
// of JSON, and posts two weekly Telegram digests. Everything team-specific comes
// from the environment; see README.md.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_SITE = "https://nus-cs2103-ay2627-s1.github.io";

// TEAM is either JSON, or the shorthand "1234A:Alex:alex-gh, 5678B:Bo:bo-gh"
// with one member per comma or newline. The id is the tail of the student number
// the dashboards publish (they show "A---1234A"); the handle is for the forum
// dashboard and may be left off.
function parseTeam(raw){
  const t = (raw || "").trim();
  if (!t) throw new Error("TEAM is not set");

  const list = t.startsWith("[")
    ? JSON.parse(t)
    : t.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(entry => {
        const [id, name, handle] = entry.split(":").map(s => s.trim());
        return {id, name, handle};
      });

  if (!Array.isArray(list) || !list.length) throw new Error("TEAM is empty");
  const people = list.map((p, i) => {
    if (!p || !p.id || !p.name)
      throw new Error(`TEAM entry ${i + 1} needs at least an id and a name`);
    return {id: String(p.id).toUpperCase(), name: String(p.name), handle: p.handle || ""};
  });
  // Ids key the per-person lookups, so a duplicate would quietly drop someone.
  const dupe = people.map(p => p.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dupe) throw new Error(`TEAM lists ${dupe} twice`);
  return people;
}

function config(env, request){
  const site = (env.COURSE_SITE || DEFAULT_SITE).replace(/\/+$/, "");
  return {
    people: parseTeam(env.TEAM),
    team: env.TEAM_NAME || "",
    // Cron runs have no request to infer the public URL from.
    self: (env.PUBLIC_URL || (request ? new URL(request.url).origin : "")).replace(/\/+$/, ""),
    src: {
      ip:    `${site}/dashboards/contents/ip-progress.html`,
      part:  `${site}/dashboards/contents/participation.html`,
      forum: `${site}/dashboards/contents/forum-activities.html`,
      vue:   `${site}/dashboards/contents/ip-progress.page-vue-render.js`,
      sched: `${site}/website/schedule`,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

const IPCLS = {"bg-success": "done", "bg-info": "done-opt", "bg-danger": "overdue",
               "bg-dark": "soon", "bg-secondary": "soon-opt"};
const PCLS  = {"bg-success": "met", "bg-warning": "short", "bg-danger": "none"};

const BADGE = /<span class="badge ([^"]*)">((?:(?!<span class="badge)[\s\S])*?)<\/span>/g;

// Source text arrives HTML-encoded ("team&#39;s"); decode on the way out so it
// isn't escaped a second time downstream.
const ENT = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
             hellip: "…", mdash: "—", ndash: "–",
             lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”"};
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#"
    ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1))
    : (ENT[e.toLowerCase()] ?? m));

const strip = s => decode(s.replace(/<[^>]+>/g, ""));

const stamp = html => {
  const m = strip(html).match(/last updated on\s*(.+?)\s*\]/);
  return m ? m[1].trim() : "unknown";
};

// The source tables are one long line; slice to the table before matching rows.
function rowsOf(html){
  const i = html.indexOf("<table"), j = html.indexOf("</table>");
  if (i < 0 || j < 0) return {};
  const out = {};
  for (const m of html.slice(i, j).matchAll(/<tr id="([^"]+)"([\s\S]*?)<\/tr>/g)) out[m[1]] = m[2];
  return out;
}

const cellsOf = row => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);

const badgesOf = (cell, map) => cell
  ? [...cell.matchAll(BADGE)].map(m => ({
      label: strip(m[2]).replace(/^\s*!\s*/, "").trim(),
      status: map[m[1].split(" ")[0]] || "unknown",
    }))
  : [];

// Sources regenerate daily/weekly, so a few minutes of edge cache costs nothing.
const grab = (url, ttl = 240) => fetch(url, {cf: {cacheTtl: ttl, cacheEverything: true}})
  .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });

// ---------------------------------------------------------------------------
// The three dashboards
// ---------------------------------------------------------------------------

function parseIp(html, people){
  const rows = rowsOf(html), by = {};
  for (const p of people){
    const tds = rows[p.id] ? cellsOf(rows[p.id]) : [];
    by[p.id] = {
      weeks:      badgesOf(tds[1], IPCLS),
      increments: badgesOf(tds[2], IPCLS),
      git:        badgesOf(tds[3], IPCLS),
    };
  }
  return {by, updated: stamp(html)};
}

function parsePart(html, people){
  const rows = rowsOf(html), by = {};
  for (const p of people){
    const tds = rows[p.id] ? cellsOf(rows[p.id]) : [];
    const weeks = badgesOf(tds[1], PCLS);
    const tot = tds[1] ? tds[1].match(/<strong>(\d+)<\/strong>/) : null;

    // Per-week activity codes live in the card title: "W1: S W Q | W2: Q B W | details".
    const detail = {};
    const card = tds[2] ? tds[2].match(/<p class="card-title">([\s\S]*?)<\/p>/) : null;
    if (card){
      let cur = null;
      const tok = /W(\d+)\s*:|<span class="badge bg-light (text-\w+)[^"]*">([^<]*)</g;
      for (const m of card[1].matchAll(tok)){
        if (m[1]) { cur = "W" + m[1]; detail[cur] = detail[cur] || []; }
        else if (cur && m[3] && m[3].trim() && m[3].trim() !== "details")
          detail[cur].push({code: m[3].trim(), tone: m[2]});
      }
    }
    by[p.id] = {weeks, total: tot ? +tot[1] : null, detail};
  }
  return {by, updated: stamp(html)};
}

// The forum page has no table: each poster is an <h3> like
// "30. TAN AH KOW @ahkow (1 posts)". Anyone absent has posted nothing.
function parseForum(html, people){
  const found = {};
  let listed = 0;
  for (const m of html.matchAll(/<h3 id="[^"]*">([\s\S]*?)<\/h3>/g)){
    const txt = strip(m[1]).replace(/\s+/g, " ").trim();
    const e = txt.match(/^(\d+)\.\s*(.*?)\s*@([\w.-]+)\s*\((\d+)\s*posts?\)/);
    if (!e) continue;
    listed++;
    found[e[3].toLowerCase()] = {rank: +e[1], posts: +e[4], watching: /class="text-warning"/.test(m[1])};
  }
  const by = {};
  for (const p of people)
    by[p.id] = {handle: p.handle,
                ...(found[p.handle.toLowerCase()] || {rank: null, posts: 0, watching: false})};
  return {by, listed, updated: stamp(html)};
}

async function collect(cfg){
  const {people, src} = cfg;
  const [ipR, partR, forumR] =
    await Promise.allSettled([grab(src.ip), grab(src.part), grab(src.forum)]);
  const problems = [];
  const run = (res, fn, label) => {
    if (res.status === "rejected"){ problems.push(`${label}: ${res.reason.message}`); return null; }
    try { return fn(res.value, people); }
    catch (e){ problems.push(`${label} parse: ${e.message}`); return null; }
  };

  let ip = run(ipR, parseIp, "iP");
  const part  = run(partR,  parsePart,  "participation");
  const forum = run(forumR, parseForum, "forum");
  if (ip){
    const missing = people.filter(p => !ip.by[p.id].increments.length && !ip.by[p.id].git.length);
    if (missing.length === people.length){
      problems.push("iP: no rows matched; check the ids in TEAM");
      ip = null;
    } else if (missing.length){
      problems.push(`iP: no row for ${missing.map(p => p.id).join(", ")}; check those ids in TEAM`);
    }
  }

  return {
    team: cfg.team,
    sources: {ip: src.ip, participation: src.part, forum: src.forum},
    sourceUpdated: ip    ? ip.updated    : "unavailable",
    partUpdated:   part  ? part.updated  : "unavailable",
    forumUpdated:  forum ? forum.updated : "unavailable",
    forumListed:   forum ? forum.listed  : null,
    fetchedAt: new Date().toISOString(),
    problems,
    people: people.map(p => ({
      id: p.id, name: p.name,
      ...(ip ? ip.by[p.id] : {weeks: [], increments: [], git: []}),
      part:  part  ? part.by[p.id]  : {weeks: [], total: null, detail: {}},
      forum: forum ? forum.by[p.id] : {handle: p.handle, rank: null, posts: 0, watching: false},
    })),
  };
}

// ---------------------------------------------------------------------------
// Status digest (Telegram, Thursdays)
//
// The weekly badge on the iP dashboard is *commit activity*, not increments:
// each student's detail modal reads "Week 3 [Aug 21 04:00 PM - Aug 28 03:59 PM]:
// Pushed N commits". That modal is not in the served HTML; it lives in
// MarkBind's Vue render bundle (~14 MB), so it is pulled only for this weekly
// job, never on the dashboard's own refresh path.
// ---------------------------------------------------------------------------

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const join = a => a.join(" · ");

// The bundle is one big new Function("...") string, so quotes arrive escaped.
const unq = s => s.replace(/\\"/g, '"').replace(/\\n/g, "\n");

function hoistBody(js, n){
  const key = `const _hoisted_${n} = `;
  const i = js.indexOf(key);
  if (i < 0) return "";
  const j = js.indexOf("-1 /* HOISTED */)", i);
  return unq(js.slice(i + key.length, j < 0 ? i + 60000 : j));
}

// Each <li> carries a badge (status + label) and some trailing prose.
function itemsOf(body){
  const out = [];
  for (const li of body.split('_createElementVNode("li"').slice(1)){
    const b = li.match(/"badge (bg-[\w-]+)[^"]*" \}, (?:"([^"]+)"|\[[\s\S]*?"s", null, "([^"]+)"\))/);
    if (!b) continue;
    const pushed = li.match(/Pushed [\s\S]{0,120}?"code", \{[^}]*\}, "(\d+)"/);
    out.push({
      label: b[2] || b[3],
      status: IPCLS[b[1]] || "unknown",
      due: (li.match(/Due in Week (\d+)/) || [])[1] || null,
      window: (li.match(/\[([A-Z][^\]]*?\d{4}[^\]]*?)\]/) || [])[1] || null,
      commits: pushed ? +pushed[1] : (/Did not push/.test(li) ? 0 : null),
    });
  }
  return out;
}

// Inside a student's modal the panels appear in a fixed order, each contributing
// a header hoist then a body hoist: weekly, increments, admin.
function parseDetails(js, people){
  const by = {};
  for (const p of people){
    const i = js.indexOf(`id: \\"modal:ipPD-A---${p.id}\\"`);
    if (i < 0) continue;
    const refs = [...js.slice(i, i + 2000).matchAll(/_hoisted_(\d+)/g)].map(m => m[1]);
    if (refs.length < 8) continue;
    const weekly = itemsOf(hoistBody(js, refs[1]));
    if (!weekly.length) continue;
    by[p.id] = {
      weekly,
      increments: itemsOf(hoistBody(js, refs[4])),
      admin: itemsOf(hoistBody(js, refs[7])),
    };
  }
  return by;
}

const sgt = (d, opt) => new Intl.DateTimeFormat("en-SG", {timeZone: "Asia/Singapore", ...opt}).format(d);

// "Aug 21 2026 04:00 PM - Aug 28 2026 03:59 PM" -> "Fri 28 Aug, 3:59 pm"
function closes(window){
  if (!window) return null;
  const end = window.split(" - ")[1];
  const d = new Date(end + " GMT+0800");
  return isNaN(d) ? end : sgt(d, {weekday: "short", day: "numeric", month: "short",
                                  hour: "numeric", minute: "2-digit"});
}

function buildDigest(cfg, data, details){
  const L = [];
  const label = cfg.team ? `${esc(cfg.team)}: ` : "";
  const anyWeekly = cfg.people.map(p => details[p.id]).find(d => d && d.weekly.length);
  const cur = anyWeekly ? anyWeekly.weekly[anyWeekly.weekly.length - 1] : null;

  L.push(`<b>${label}weekly status</b>`);
  L.push(cur
    ? `Week ${cur.label}${closes(cur.window) ? ` · window closes ${closes(cur.window)}` : ""}`
    : sgt(new Date(), {weekday: "short", day: "numeric", month: "short"}));
  L.push("");

  // 1. Anything still undone.
  L.push("<b>⚠️ Outstanding iP items</b>");
  const clear = [];
  for (const p of data.people){
    const items = [...p.increments, ...p.git];
    const over = items.filter(i => i.status === "overdue");
    const soon = items.filter(i => i.status === "soon");
    const opt  = items.filter(i => i.status === "soon-opt");
    if (!over.length && !soon.length && !opt.length){ clear.push(p.name); continue; }
    const list = a => esc(a.map(i => i.label).join(", "));
    const bits = [];
    if (over.length) bits.push(`<b>${over.length} overdue</b> (${list(over)})`);
    if (soon.length) bits.push(`${soon.length} due soon (${list(soon)})`);
    if (opt.length)  bits.push(`${opt.length} optional due soon (${list(opt)})`);
    L.push(`• <b>${esc(p.name)}</b>: ${bits.join("; ")}`);
  }
  if (clear.length) L.push(`• all clear: ${esc(clear.join(", "))}`);

  // 2. Commit activity in this week's window, which is what the weekly badge tracks.
  if (cur){
    L.push("");
    L.push(`<b>💻 Commits pushed in week ${cur.label}</b>`);
    L.push(join(cfg.people.map(p => {
      const w = details[p.id] && details[p.id].weekly.slice(-1)[0];
      const n = w && w.commits != null ? w.commits : "?";
      return `${esc(p.name)} ${n}${n === 0 ? " ⚠️" : ""}`;
    })));
  }

  // 3. Participation so far. The denominator is how many weeks the source has
  // published, not the best score on the team, since otherwise a week the whole team
  // missed would quietly disappear from the count.
  L.push("");
  const wkLabels = [...new Set(data.people.flatMap(p => ((p.part && p.part.weeks) || []).map(w => w.label)))]
    .sort((a, b) => (+a || 0) - (+b || 0));
  const n = wkLabels.length;
  const missed = p => wkLabels.filter(l => {
    const w = ((p.part && p.part.weeks) || []).find(x => x.label === l);
    return !w || w.status !== "met";
  });
  const short = data.people.filter(p => missed(p).length);
  L.push(`<b>🗳 Participation</b>: ${n} week${n === 1 ? "" : "s"} published so far`
    + (n ? ` (week${n === 1 ? " " : "s "}${esc(wkLabels.join(", "))})` : ""));
  if (!n) L.push("no participation rows in the source yet");
  else if (!short.length) L.push(`everyone reached the bar in all ${n}`);
  else L.push(join(data.people.map(p => {
    const m = missed(p);
    return `${esc(p.name)} ${n - m.length}/${n}${m.length ? ` (missed wk ${m.join(", ")})` : ""}`;
  })));

  // 4. Forum.
  L.push("");
  L.push("<b>💬 Forum posts</b>");
  L.push(join(data.people.map(p => {
    const f = p.forum || {posts: 0};
    return `${esc(p.name)} ${f.posts}${f.watching ? " 👁" : ""}`;
  })));

  L.push("");
  L.push(cfg.self
    ? `<a href="${cfg.self}/">Full dashboard</a> · iP source updated ${esc(data.sourceUpdated)}`
    : `iP source updated ${esc(data.sourceUpdated)}`);
  if (data.problems.length) L.push(`<i>source problems: ${esc(data.problems.join("; "))}</i>`);
  return L.join("\n");
}

async function digest(cfg){
  const data = await collect(cfg);
  let details = {};
  try {
    const r = await fetch(cfg.src.vue, {cf: {cacheTtl: 3600, cacheEverything: true}});
    if (r.ok) details = parseDetails(await r.text(), cfg.people);
  } catch { /* commit counts are a bonus; the digest still goes out without them */ }
  return buildDigest(cfg, data, details);
}

// ---------------------------------------------------------------------------
// Week-ahead preview (Telegram, Fridays)
//
// Every week summary page carries the same three ordered lists (Admin, iP, tP),
// server-rendered, with each deadline in its own clock badge. No prose parsing,
// so no summariser either.
// ---------------------------------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Midnight of the current Singapore day, as a UTC timestamp to do date maths on.
function sgtDay(now){
  const f = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Singapore",
    year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(now);
  const g = t => +f.find(x => x.type === t).value;
  return Date.UTC(g("year"), g("month") - 1, g("day"));
}

// 5 is Friday for Date.getUTCDay(); this is a Singapore weekday, not a UTC one.
const isFriday = d => new Date(sgtDay(d)).getUTCDay() === 5;

const pretty = ms => {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// The course site indexes each week by the Monday its classes start, so that is
// what the schedule has to be looked up by, even though the week itself begins
// on the Friday before, at 4pm, which is when this runs.
function nextMonday(now){
  const today = sgtDay(now);
  const ahead = (8 - new Date(today).getUTCDay()) % 7 || 7;
  const d = new Date(today + ahead * 86400000);
  return {month: MONTHS[d.getUTCMonth()], day: d.getUTCDate(), pretty: pretty(+d)};
}

// Every page repeats the schedule dropdown: week number -> the Monday it starts.
function weekStarting(html, mon){
  const re = /href="[^"]*\/schedule\/week(\d+)\/index\.html"[\s\S]{0,200}?<strong>Week \d+<\/strong>\s*\[Mon,\s*(\w{3})\s*(\d{1,2})\w{2}\]/g;
  for (const m of html.matchAll(re))
    if (m[2] === mon.month && +m[3] === mon.day) return +m[1];
  return null;
}

// One <li> per task; a badge carrying a clock icon, when present, is the
// deadline (pink for hard ones, other colours for optional ones).
function tasksOf(html, heading){
  const h = html.indexOf(`<strong>${heading}:</strong>`);
  if (h < 0) return [];
  const a = html.indexOf("<ol>", h);
  const b = html.indexOf("</ol>", a);
  if (a < 0 || b < 0) return [];
  return [...html.slice(a, b).matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => {
    const li = m[1];
    const due = [...li.matchAll(/<span class="badge bg-[^"]*">([\s\S]*?)<\/span><\/span>/g)]
      .find(x => x[0].includes("fa-clock"));
    const text = strip(due ? li.replace(due[0], "") : li).replace(/\s+/g, " ").trim();
    return {text, due: due ? strip(due[1]).replace(/\s+/g, " ").trim() : null};
  }).filter(t => t.text);
}

async function weekAhead(cfg, now = new Date()){
  const label = cfg.team ? `${esc(cfg.team)}: ` : "";
  const mon = nextMonday(now);
  const nav = await grab(`${cfg.src.sched}/index.html`);
  const wk = weekStarting(nav, mon);
  if (!wk)
    return `<b>🗓 ${label}week ahead</b>\n\n`
         + `No new week begins now: nothing starts ${esc(mon.pretty)}, so it is recess or reading week.`;

  const page = await grab(`${cfg.src.sched}/week${wk}/index.html`);
  const today = sgtDay(now);
  const L = [
    `<b>🗓 ${label}week ${wk} starts now</b>`,
    `${esc(pretty(today))} 4:00 pm → ${esc(pretty(today + 7 * 86400000))} 3:59 pm`
      + ` · classes from ${esc(mon.pretty)}`,
  ];
  for (const [head, icon] of [["Admin", "📌"], ["iP", "💻"], ["tP", "👥"]]){
    const items = tasksOf(page, head);
    if (!items.length) continue;
    L.push("");
    L.push(`<b>${icon} ${head}</b>`);
    items.forEach((t, i) => L.push(
      `${i + 1}. ${esc(t.text)}${t.due ? ` · ⏰ <b>${esc(t.due)}</b>` : ""}`));
  }
  L.push("");
  L.push(`<a href="${cfg.src.sched}/week${wk}/index.html">Week ${wk} page</a>`);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

// Telegram caps one message at 4096 characters and a bad week can list a lot of
// items, so split on line boundaries rather than truncating anything.
function chunk(text, cap = 3800){
  const out = [];
  let cur = "";
  for (const line of text.split("\n")){
    if (cur && cur.length + line.length + 1 > cap){ out.push(cur); cur = ""; }
    cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function send(env, text){
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  for (const part of chunk(text)){
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: part,
        parse_mode: "HTML",
        link_preview_options: {is_disabled: true},
      }),
    });
    const body = await r.json();
    if (!body.ok) throw new Error(`telegram: ${body.description || r.status}`);
  }
}

// ---------------------------------------------------------------------------

const text = (body, status = 200) =>
  new Response(body, {status, headers: {"content-type": "text/plain; charset=utf-8"}});

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const wanted = url.pathname === "/api/data" || url.pathname === "/api/digest";

    let cfg;
    if (wanted){
      try { cfg = config(env, request); }
      catch (e){ return text(`Misconfigured: ${e.message}\nSee README.md.`, 500); }
    }

    if (url.pathname === "/api/data"){
      const data = await collect(cfg);
      return new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    // Preview or fire either digest by hand. The page is public, so this needs
    // the shared key to stop anyone spamming the group chat.
    if (url.pathname === "/api/digest"){
      if (!env.DIGEST_KEY || url.searchParams.get("key") !== env.DIGEST_KEY)
        return text("forbidden", 403);
      // ?at=<ISO> pretends the preview is being built at another moment, so the
      // week it lands on can be checked without waiting for Friday.
      const at = url.searchParams.get("at");
      const when = at ? new Date(at) : new Date();
      if (isNaN(when)) return text(`?at= is not a date I can read: ${at}`, 400);
      const body = url.searchParams.get("type") === "week"
        ? await weekAhead(cfg, when)
        : await digest(cfg);
      if (url.searchParams.get("send") !== "1") return text(body);
      try { await send(env, body); return text("sent\n\n" + body); }
      catch (e){ return text("failed: " + e.message, 502); }
    }

    // Anything else is a static asset (the dashboard page itself).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx){
    let cfg;
    try { cfg = config(env, null); }
    catch (e){ console.error(`cron ${event.cron} misconfigured: ${e.message}`); throw e; }

    // Which digest to send is read off the day the firing lands on, so the
    // schedule lives only in wrangler.toml with no second copy to keep in step.
    // A course week turns over on Friday at 4pm, so that is the one firing where
    // "the week ahead" means anything; any other day is a status report.
    const week = isFriday(new Date(event.scheduledTime || Date.now()));
    // Shows up in `wrangler tail` and Workers Logs, so a missed or misrouted
    // firing can be told apart from a broken handler after the fact.
    console.log(`cron ${event.cron} -> ${week ? "week-ahead" : "status"} digest`);
    ctx.waitUntil(
      (week ? weekAhead(cfg) : digest(cfg))
        .then(body => send(env, body))
        .then(() => console.log("posted to telegram"))
        .catch(e => { console.error("digest failed:", e.message); throw e; }));
  },
};
