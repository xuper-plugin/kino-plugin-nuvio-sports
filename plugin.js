// Nuvio Sports: live sports events and 24/7 sports networks from the Nuvio Live Sports Stremio addon
// (https://nuviosports.xyz), as channels in Kino's En vivo tab. The addon builds its answer from a base64url JSON
// "configuration" segment in the URL; the settings below fill it in.

const HOST = "https://nuviosports.xyz";
const PAGE = 100; // the addon answers 100 items per page and takes `skip`
const MAX_SKIP = 1000;
const RETRY_WINDOW_MS = 2 * 60 * 1000; // a channel opened again within this window means the copy served did not play
const BAD_COPY_MS = 10 * 60 * 1000;

// One entry per catalog of the addon. `sport` is the name the "sports" setting uses; a category without one is always
// listed. "Upcoming" lists events not on air yet: it works as a schedule, its copies appear when the event starts.
const CATEGORIES = [
  { id: "live", catalog: "nuvio_sports_live", title: "catLive", genre: "deportes" },
  { id: "upcoming", catalog: "nuvio_sports_upcoming", title: "catUpcoming", genre: "deportes" },
  { id: "football", catalog: "nuvio_sports_football", sport: "football", title: "catFootball", genre: "deportes" },
  { id: "basketball", catalog: "nuvio_sports_basketball", sport: "basketball", title: "catBasketball", genre: "deportes" },
  { id: "tennis", catalog: "nuvio_sports_tennis", sport: "tennis", title: "catTennis", genre: "deportes" },
  { id: "motorsport", catalog: "nuvio_sports_motorsport", sport: "motorsport", title: "catMotorsport", genre: "deportes" },
  { id: "mma", catalog: "nuvio_sports_mma", sport: "mma", title: "catMma", genre: "deportes" },
  { id: "baseball", catalog: "nuvio_sports_baseball", sport: "baseball", title: "catBaseball", genre: "deportes" },
  { id: "hockey", catalog: "nuvio_sports_hockey", sport: "hockey", title: "catHockey", genre: "deportes" },
  { id: "rugby", catalog: "nuvio_sports_rugby", sport: "rugby", title: "catRugby", genre: "deportes" },
  { id: "americanfootball", catalog: "nuvio_sports_american_football", sport: "americanfootball", title: "catAmericanFootball", genre: "deportes" },
  { id: "golf", catalog: "nuvio_sports_golf", sport: "golf", title: "catGolf", genre: "deportes" },
  { id: "cricket", catalog: "nuvio_sports_cricket", sport: "cricket", title: "catCricket", genre: "deportes" },
  { id: "college", catalog: "nuvio_sports_college", sport: "college", title: "catCollege", genre: "deportes" },
  { id: "other", catalog: "nuvio_sports_other", sport: "other", title: "catOther", genre: "deportes" },
  { id: "networks", catalog: "nuvio_sports_networks", title: "catNetworks", genre: "deportes" },
];
// Catalogs whose events are searched by name (the sport catalogs are subsets of "live").
const SEARCHED = ["live", "upcoming", "networks"];

// Every text the person reads, in Spanish and English: Kino does not translate a plugin's texts. kino.lang is the
// person's language ("es-CO"); anything that is not Spanish reads English.
const TEXTS = {
  es: {
    catLive: "En vivo ahora",
    catUpcoming: "Próximos",
    catFootball: "Fútbol",
    catBasketball: "Baloncesto",
    catTennis: "Tenis",
    catMotorsport: "Motor",
    catMma: "MMA",
    catBaseball: "Béisbol",
    catHockey: "Hockey",
    catRugby: "Rugby",
    catAmericanFootball: "Fútbol americano",
    catGolf: "Golf",
    catCricket: "Críquet",
    catCollege: "Deporte universitario",
    catOther: "Otros deportes",
    catNetworks: "TV deportiva 24/7",
    unavailable: "Nuvio Sports no responde ahora. Intenta de nuevo en un rato.",
    noSignal: "Este canal no tiene señal ahora mismo. Si el evento aún no empieza, vuelve más tarde.",
  },
  en: {
    catLive: "Live now",
    catUpcoming: "Upcoming",
    catFootball: "Soccer",
    catBasketball: "Basketball",
    catTennis: "Tennis",
    catMotorsport: "Motorsport",
    catMma: "MMA",
    catBaseball: "Baseball",
    catHockey: "Hockey",
    catRugby: "Rugby",
    catAmericanFootball: "American football",
    catGolf: "Golf",
    catCricket: "Cricket",
    catCollege: "College sports",
    catOther: "Other sports",
    catNetworks: "24/7 sports TV",
    unavailable: "Nuvio Sports is not answering right now. Try again in a moment.",
    noSignal: "This channel has no signal right now. If the event has not started yet, come back later.",
  },
};

function t(key) {
  const lang = String(kino.lang || "").toLowerCase().startsWith("es") ? "es" : "en";
  return TEXTS[lang][key] || TEXTS.es[key] || key;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** UTF-8 bytes of [s] as base64url without padding (the engine has neither Buffer nor btoa). */
function base64url(s) {
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(s))) bytes.push(ch.charCodeAt(0));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function setting(key, fallback) {
  const v = kino.config.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** The addon's base URL for the person's current settings. */
function base() {
  const cfg = {
    timezone: setting("timezone", "UTC"),
    languages: setting("languages", "Spanish"),
    replayFilter: "disabled",
    webStreams: "disabled", // embed pages cannot play in the player
    sports: setting("sports", "all").toLowerCase().replace(/\s+/g, ""),
  };
  const teams = setting("teams", "");
  if (teams) cfg.teams = teams;
  return HOST + "/" + base64url(JSON.stringify(cfg));
}

// A call has about 20 s and kino.fetch waits 15 s by default, so one slow answer used up the whole call. Two attempts fit; only
// a network error, a timeout or a 5xx is worth asking again (the addon sits behind a tunnel that blinks). The first time a
// channel is asked the addon looks for its copies and can take 16 s: its streams get 12 s and then 6 s for a second ask, which
// finds them already looked for.
const FETCH_MS = [8000, 8000];
const STREAM_MS = [12000, 6000];

async function getJson(path, budgets = FETCH_MS) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await kino.fetch(base() + path, { headers: { Accept: "application/json" }, timeoutMs: budgets[attempt] });
      if (r.ok) return r.json();
      last = kino.error("unavailable", "Nuvio Sports answered " + r.status, { userMessage: t("unavailable") });
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// A list page stays fresh as long as the addon says (2 min); when the addon does not answer, the last good page is served
// for 30 min (24 h for the 24/7 networks, which do not change). The first page of the three main lists also survives a restart.
const FRESH_MS = 2 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const STALE_NETWORKS_MS = 24 * 60 * 60 * 1000;
const KEPT = ["live", "upcoming", "networks"];
const PAGES = new Map();

function savedPage(cat, skip) {
  if (skip || !KEPT.includes(cat.id)) return null;
  try {
    const s = JSON.parse(kino.storage.get("page:" + cat.id) || "null");
    return s && s.page ? s : null;
  } catch {
    return null;
  }
}

async function catalogPage(cat, skip) {
  const key = cat.id + ":" + skip;
  const mem = PAGES.get(key);
  if (mem && Date.now() - mem.at < FRESH_MS) return mem.page;
  try {
    const data = await getJson("/catalog/tv/" + cat.catalog + (skip ? "/skip=" + skip : "") + ".json");
    const metas = Array.isArray(data.metas) ? data.metas : [];
    const more = metas.length >= PAGE && skip + PAGE < MAX_SKIP;
    const page = { items: metas.map((m) => channelOf(m, cat.id)), next: more ? String(skip + PAGE) : null };
    PAGES.set(key, { at: Date.now(), page });
    if (!skip && KEPT.includes(cat.id)) {
      try { kino.storage.set("page:" + cat.id, JSON.stringify({ at: Date.now(), page }), { ttlMs: STALE_NETWORKS_MS }); } catch { /* storage full: not kept */ }
    }
    return page;
  } catch (e) {
    const old = mem || savedPage(cat, skip);
    if (old && Date.now() - old.at < (cat.id === "networks" ? STALE_NETWORKS_MS : STALE_MS)) {
      kino.log("served a saved page of " + cat.id + ": " + (e && e.code));
      return old.page;
    }
    throw e;
  }
}

function channelOf(m, categoryId) {
  return {
    id: m.id,
    title: String(m.name || m.id).replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 120),
    ref: m.id,
    categoryId,
    logo: [m.logo, m.poster].find((u) => typeof u === "string" && u.startsWith("https://")),
  };
}

export async function home() {
  return [];
}

/** The sport names the person picked (lowercase, no spaces or underscores), or null for all of them. */
function pickedSports() {
  const v = setting("sports", "all").toLowerCase().replace(/[\s_]+/g, "");
  if (v === "all") return null;
  return v.split(",").filter(Boolean);
}

export async function liveCategories() {
  const picked = pickedSports();
  return CATEGORIES.filter((c) => !c.sport || !picked || picked.includes(c.sport)).map((c) => ({
    id: c.id,
    title: t(c.title),
    genre: c.genre,
  }));
}

export async function liveChannels({ categoryId, cursor }) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return { items: [] };
  const skip = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
  return catalogPage(cat, skip);
}

export async function liveSearch({ query }) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) return { items: [] };
  const seen = new Set();
  const items = [];
  const lists = await Promise.all(
    CATEGORIES.filter((c) => SEARCHED.includes(c.id)).map((c) => getJson("/catalog/tv/" + c.catalog + "/search=" + q + ".json").then((d) => [c, d.metas || []], () => [c, []])),
  );
  for (const [c, metas] of lists) {
    for (const m of metas) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      items.push({ ...channelOf(m, c.id), adult: false });
    }
  }
  return { items: items.slice(0, 100) };
}

/** Lower is better: the position of the stream's language among the person's preferred ones. */
function languageRank(s, wanted) {
  const lang = String(s.language || "").toLowerCase();
  const i = wanted.indexOf(lang);
  return i < 0 ? wanted.length : i;
}

export async function resolve(ref) {
  if (typeof ref !== "string" || !/^nuvio_sport_[\w.-]+$/.test(ref)) throw kino.error("not_found");
  const data = await getJson("/stream/tv/" + encodeURIComponent(ref) + ".json", STREAM_MS);
  const wanted = setting("languages", "Spanish").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  const streams = (data.streams || [])
    .filter((s) => typeof s.url === "string" && /^https?:\/\//.test(s.url))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => languageRank(a.s, wanted) - languageRank(b.s, wanted) || (b.s.score || 0) - (a.s.score || 0) || a.i - b.i)
    .map((x) => x.s);
  if (!streams.length) throw kino.error("not_found", "no streams", { userMessage: t("noSignal") });

  // Kino calls resolve again when a channel is cut: opening the same channel within RETRY_WINDOW_MS marks the copy
  // served last as bad for BAD_COPY_MS, and the next one is served. When every copy is bad the memory starts over.
  const key = "try:" + ref;
  let bad = [];
  try {
    const last = JSON.parse(kino.storage.get(key) || "null");
    if (last && Array.isArray(last.bad)) bad = last.bad.filter((x) => Date.now() - x.t < BAD_COPY_MS);
    if (last && last.url && Date.now() - last.t < RETRY_WINDOW_MS) bad.push({ url: last.url, t: Date.now() });
  } catch {
    bad = [];
  }
  let fresh = streams.filter((s) => !bad.some((x) => x.url === s.url));
  if (!fresh.length) {
    bad = [];
    fresh = streams;
  }
  const pick = fresh[0];
  try {
    kino.storage.set(key, JSON.stringify({ t: Date.now(), url: pick.url, bad: bad.slice(-8) }), { ttlMs: BAD_COPY_MS });
  } catch {
    // the memory is a nicety: the channel plays without it
  }

  const req = (pick.behaviorHints && pick.behaviorHints.proxyHeaders && pick.behaviorHints.proxyHeaders.request) || {};
  const headers = {};
  for (const k of ["Referer", "Origin", "User-Agent"]) if (typeof req[k] === "string" && req[k]) headers[k] = req[k];
  return { url: pick.url, mime: "application/vnd.apple.mpegurl", headers };
}
