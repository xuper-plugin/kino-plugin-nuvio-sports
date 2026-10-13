// Nuvio Sports: live sports events and 24/7 sports networks from the Nuvio Live Sports Stremio addon
// (https://nuviosports.xyz), as channels in Kino's En vivo tab. The addon builds its answer from a base64url JSON
// "configuration" segment in the URL; the settings below fill it in.

const HOST = "https://nuviosports.xyz";
const PAGE = 100; // the addon answers 100 items per page and takes `skip`
const MAX_SKIP = 1000;
const RETRY_WINDOW_MS = 2 * 60 * 1000;

// One entry per catalog of the addon that lists something playable now ("Upcoming" lists events not yet on air).
const CATEGORIES = [
  { id: "live", catalog: "nuvio_sports_live", title: "En vivo ahora", genre: "deportes" },
  { id: "football", catalog: "nuvio_sports_football", title: "Fútbol", genre: "deportes" },
  { id: "motorsport", catalog: "nuvio_sports_motorsport", title: "Motor", genre: "deportes" },
  { id: "networks", catalog: "nuvio_sports_networks", title: "TV deportiva 24/7", genre: "deportes" },
];

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
    sources: "none",
  };
  const teams = setting("teams", "");
  if (teams) cfg.teams = teams;
  return HOST + "/" + base64url(JSON.stringify(cfg));
}

async function getJson(path) {
  const r = await kino.fetch(base() + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw kino.error("unavailable", "Nuvio Sports respondió " + r.status);
  return r.json();
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

export async function liveCategories() {
  return CATEGORIES.map((c) => ({ id: c.id, title: c.title, genre: c.genre }));
}

export async function liveChannels({ categoryId, cursor }) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return { items: [] };
  const skip = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
  const extra = skip ? "/skip=" + skip : "";
  const data = await getJson("/catalog/tv/" + cat.catalog + extra + ".json");
  const metas = Array.isArray(data.metas) ? data.metas : [];
  const more = metas.length >= PAGE && skip + PAGE < MAX_SKIP;
  return { items: metas.map((m) => channelOf(m, cat.id)), next: more ? String(skip + PAGE) : null };
}

export async function liveSearch({ query }) {
  const q = encodeURIComponent(String(query || "").trim());
  if (!q) return { items: [] };
  const seen = new Set();
  const items = [];
  const lists = await Promise.all(
    CATEGORIES.map((c) => getJson("/catalog/tv/" + c.catalog + "/search=" + q + ".json").then((d) => [c, d.metas || []], () => [c, []])),
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
  const data = await getJson("/stream/tv/" + encodeURIComponent(ref) + ".json");
  const wanted = setting("languages", "Spanish").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  const streams = (data.streams || [])
    .filter((s) => typeof s.url === "string" && /^https?:\/\//.test(s.url))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => languageRank(a.s, wanted) - languageRank(b.s, wanted) || (b.s.score || 0) - (a.s.score || 0) || a.i - b.i)
    .map((x) => x.s);
  if (!streams.length) throw kino.error("not_found", "sin señal", { userMessage: "Este canal no tiene señal ahora mismo" });

  // Kino calls resolve again when a channel is cut: a second call soon after the first moves on to the next copy.
  const key = "try:" + ref;
  let n = 0;
  try {
    const last = JSON.parse(kino.storage.get(key) || "null");
    if (last && Date.now() - last.t < RETRY_WINDOW_MS) n = last.n + 1;
    kino.storage.set(key, JSON.stringify({ t: Date.now(), n }), { ttlMs: RETRY_WINDOW_MS });
  } catch {
    n = 0;
  }
  const pick = streams[n % streams.length];

  const req = (pick.behaviorHints && pick.behaviorHints.proxyHeaders && pick.behaviorHints.proxyHeaders.request) || {};
  const headers = {};
  for (const k of ["Referer", "Origin", "User-Agent"]) if (typeof req[k] === "string" && req[k]) headers[k] = req[k];
  return { url: pick.url, mime: "application/vnd.apple.mpegurl", headers };
}
