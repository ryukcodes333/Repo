import { Router, Request, Response } from "express";
import * as https from "https";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

const router = Router();

const SITEMAP_INDEX_URL = "https://shoob.gg/sitemap.xml";
const CARDR_BASE = "https://api.shoob.gg/site/api/cardr/";
const CARD_IMG_BASE = "https://api.shoob.gg/site/api/card/";
const CACHE_FILE = path.join(process.cwd(), "shoob-index.json");
const SITEMAP_POLL_INTERVAL_MS = 60 * 60 * 1000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://shoob.gg/",
  "Accept": "*/*",
};

interface ShoobCard {
  id: string;
  name: string;
  series: string;
  tier: string;
  rarity: string;
  imageUrl: string;
  thumbnailUrl: string;
  totalIssues: number;
  enriched?: boolean;
}

const TIER_NUM_TO_CODE: Record<string, string> = {
  "1": "T1", "2": "T2", "3": "T3", "4": "T4",
  "5": "T5", "6": "T6", "7": "TS", "8": "TZ",
};
const TIER_RARITY: Record<string, string> = {
  T1: "Common", T2: "Uncommon", T3: "Rare", T4: "Epic",
  T5: "Legendary", T6: "Mythic", TS: "Shadow", TZ: "Void",
};

// ---------------------------------------------------------------
// Fallback IDs
// ---------------------------------------------------------------
const FALLBACK_IDS = [
  "5d1e825ba5f79d12c938c108","5d1e825ba5f79d12c938c109",
  "5d1e825ba5f79d12c938c10b","5d1e825ba5f79d12c938c10c",
  "5d1e825ba5f79d12c938c10d","5d1e825ba5f79d12c938c10e",
  "5d1e825ba5f79d12c938c10f","5d1e825ba5f79d12c938c110",
  "5d1e825ba5f79d12c938c111","5d1e825ba5f79d12c938c112",
  "5d1e825ba5f79d12c938c113","5d1e825ba5f79d12c938c115",
  "5d1e825ba5f79d12c938c116","5d1e825ba5f79d12c938c117",
  "5d1e825ba5f79d12c938c118",
];

// --- State ---
let allCardIds: string[] = [];
let knownIdSet = new Set<string>();
let cardIndex = new Map<string, ShoobCard>();
let indexedCount = 0;
let isIndexing = false;
let sitemapLoaded = false;
let lastPollTime: Date | null = null;
let newCardsSinceLastPoll = 0;

// ---------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------
function saveIndex() {
  try {
    const obj: Record<string, ShoobCard> = {};
    for (const [k, v] of cardIndex) obj[k] = v;
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function loadIndex() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, ShoobCard>;
    for (const [k, v] of Object.entries(raw)) cardIndex.set(k, v);
    indexedCount = cardIndex.size;
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------
// CDN URL parser → ShoobCard
//
// Shoob CDN URLs come in several formats:
//   Readable : .../cards/4/Kakashi_Hatake;4;Naruto,suffix.png  → name+series+tier
//   Timestamp: .../cards/2/1591047632750.png                   → tier only
//   Hash MD5 : .../cards/3/60a76e48ab2c89dd1d6348afb2df7775.png → tier only
//   Hash SHA : .../cards/1/6525dc8b...64chars.png               → tier only
//   EventCard: .../eventcards/2/1572422926224.png               → tier only
//
// Tier is ALWAYS in the path segment before the filename.
// ---------------------------------------------------------------
function parseCdnUrl(cdnUrl: string, cardId: string): ShoobCard {
  const imageUrl = CARD_IMG_BASE + cardId;

  // Extract tier from URL path segment: /images/cards/{tier}/ or /images/eventcards/{tier}/
  const tierMatch = cdnUrl.match(/\/(?:event)?cards\/(\d+)\//);
  const tierNum = tierMatch?.[1] ?? "1";
  const tier = TIER_NUM_TO_CODE[tierNum] ?? "T1";
  const rarity = TIER_RARITY[tier] ?? "Common";

  // Try to parse readable filename: Name;TierNum;Series,Extra
  const filename = decodeURIComponent(cdnUrl.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? "");
  const readableMatch = filename.match(/^(.+?);(\d+);(.+?)(?:,.*)?$/);
  if (readableMatch) {
    const name = readableMatch[1].replace(/_/g, " ").trim();
    const series = readableMatch[3].replace(/_/g, " ").trim();
    const fileTier = TIER_NUM_TO_CODE[readableMatch[2]] ?? tier;
    return {
      id: cardId, name, series,
      tier: fileTier, rarity: TIER_RARITY[fileTier] ?? rarity,
      imageUrl, thumbnailUrl: imageUrl,
      totalIssues: Math.max(1, Math.ceil(Math.random() * 50)),
      enriched: false,
    };
  }

  // Fallback: tier is known, name/series are unknown
  const shortId = cardId.slice(-6);
  return {
    id: cardId,
    name: `${tier} Card #${shortId}`,
    series: "Unknown",
    tier, rarity, imageUrl, thumbnailUrl: imageUrl,
    totalIssues: 1,
    enriched: false,
  };
}

// ---------------------------------------------------------------
// Fast native-HTTPS redirect resolver
// ---------------------------------------------------------------
function fetchLocation(id: string): Promise<string> {
  return new Promise((resolve) => {
    const req = https.get(
      `${CARDR_BASE}${id}`,
      { headers: HEADERS, timeout: 8000 },
      (res) => { resolve(res.headers.location ?? ""); res.destroy(); }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

async function resolveCard(id: string): Promise<ShoobCard | null> {
  // Prefer enriched data in index
  const cached = cardIndex.get(id);
  if (cached?.enriched) return cached;
  if (cached) return cached;

  const location = await fetchLocation(id);
  if (!location) {
    // Can't resolve via cardr — make a minimal card with just the image URL
    const fallback: ShoobCard = {
      id, name: `Card #${id.slice(-6)}`, series: "Unknown",
      tier: "T1", rarity: "Common",
      imageUrl: CARD_IMG_BASE + id,
      thumbnailUrl: CARD_IMG_BASE + id,
      totalIssues: 1, enriched: false,
    };
    cardIndex.set(id, fallback);
    indexedCount++;
    return fallback;
  }
  const card = parseCdnUrl(location, id);
  cardIndex.set(id, card);
  indexedCount++;
  return card;
}

async function resolveBatch(ids: string[]): Promise<ShoobCard[]> {
  const results = await Promise.all(ids.map(resolveCard));
  return results.filter((c): c is ShoobCard => c !== null);
}

// ---------------------------------------------------------------
// Sitemap helpers
// ---------------------------------------------------------------
function extractIdsFromXml(xml: string): string[] {
  const ids: string[] = [];
  // Regular cards: /cards/info/{id}
  const reCard = /cards\/info\/([a-f0-9]{24})/g;
  // Event cards: /card-events/{event}/{id}
  const reEvent = /card-events\/[^/]+\/([a-f0-9]{24})/g;
  let m: RegExpExecArray | null;
  while ((m = reCard.exec(xml)) !== null) ids.push(m[1]);
  while ((m = reEvent.exec(xml)) !== null) ids.push(m[1]);
  return ids;
}

async function fetchOneSitemapUrl(url: string): Promise<string[]> {
  try {
    const { data } = await axios.get(url, { timeout: 25000, headers: HEADERS });
    return extractIdsFromXml(data as string);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// fetchSitemapIds — reads the sitemap index and fetches all
// card + event_card sitemaps found there
// ---------------------------------------------------------------
async function fetchSitemapIds(): Promise<string[]> {
  const sitemapUrls: string[] = [];
  try {
    const { data: indexXml } = await axios.get(SITEMAP_INDEX_URL, { timeout: 20000, headers: HEADERS });
    // Match both cards and event_cards sitemaps
    const urlRe = /https:\/\/shoob\.gg\/sitemap\/(?:cards|event_cards)\.[^<"\s]+\.xml/g;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(indexXml as string)) !== null) {
      if (!sitemapUrls.includes(m[0])) sitemapUrls.push(m[0]);
    }
  } catch { /* fall through */ }

  // If index gave us nothing, try known files directly
  if (sitemapUrls.length === 0) {
    sitemapUrls.push(
      "https://shoob.gg/sitemap/cards.1.xml",
      "https://shoob.gg/sitemap/event_cards.1.xml"
    );
  }

  // Fetch all sitemap pages in parallel
  const allIds: string[] = [];
  const seen = new Set<string>();
  const BATCH = 5;
  for (let i = 0; i < sitemapUrls.length; i += BATCH) {
    const batch = sitemapUrls.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(fetchOneSitemapUrl));
    for (const ids of results) {
      for (const id of ids) {
        if (!seen.has(id)) { seen.add(id); allIds.push(id); }
      }
    }
  }

  return allIds;
}

// ---------------------------------------------------------------
// Background full-index (120 concurrent)
// ---------------------------------------------------------------
async function indexIds(ids: string[]) {
  if (isIndexing) return;
  isIndexing = true;

  const unindexed = ids.filter((id) => !cardIndex.has(id) || !cardIndex.get(id)!.enriched);
  const CONCURRENCY = 120;

  for (let i = 0; i < unindexed.length; i += CONCURRENCY) {
    const batch = unindexed.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (id) => {
      if (cardIndex.get(id)?.enriched) return;
      const loc = await fetchLocation(id);
      if (loc) {
        if (!cardIndex.get(id)?.enriched) {
          cardIndex.set(id, parseCdnUrl(loc, id));
          indexedCount++;
        }
      } else if (!cardIndex.has(id)) {
        cardIndex.set(id, {
          id, name: `Card #${id.slice(-6)}`, series: "Unknown",
          tier: "T1", rarity: "Common",
          imageUrl: CARD_IMG_BASE + id,
          thumbnailUrl: CARD_IMG_BASE + id,
          totalIssues: 1, enriched: false,
        });
        indexedCount++;
      }
    }));
    if (i % (CONCURRENCY * 5) === 0) saveIndex();
  }

  saveIndex();
  isIndexing = false;
}

// ---------------------------------------------------------------
// Sitemap poll — detects new cards
// ---------------------------------------------------------------
async function pollSitemap() {
  const freshIds = await fetchSitemapIds();
  if (!freshIds.length) return;

  const brandNewIds = freshIds.filter((id) => !knownIdSet.has(id));
  if (brandNewIds.length > 0) {
    newCardsSinceLastPoll += brandNewIds.length;
    for (const id of brandNewIds) knownIdSet.add(id);
    allCardIds = [...allCardIds, ...brandNewIds];
    indexIds(brandNewIds).catch(() => { /* silent */ });
  }

  lastPollTime = new Date();
}

// ---------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------
async function initialLoad() {
  loadIndex();

  const ids = await fetchSitemapIds();
  const fallback = ids.length ? ids : FALLBACK_IDS;
  allCardIds = fallback;
  for (const id of fallback) knownIdSet.add(id);
  sitemapLoaded = true;
  lastPollTime = new Date();

  // Prewarm first 200 if not already cached (with enriched cards prioritized)
  const toWarm = allCardIds
    .filter((id) => !cardIndex.has(id))
    .slice(0, 200);
  for (let i = 0; i < toWarm.length; i += 40) {
    await resolveBatch(toWarm.slice(i, i + 40));
  }

  // Full background index
  indexIds(allCardIds).catch(() => { /* silent */ });

  setInterval(() => {
    pollSitemap().catch(() => { /* silent */ });
  }, SITEMAP_POLL_INTERVAL_MS);
}

initialLoad().catch(() => { /* silent */ });

// ---------------------------------------------------------------
// Search — searches enriched cards first, then CDN-parsed names
// ---------------------------------------------------------------
async function searchCards(query: string, tier: string): Promise<ShoobCard[]> {
  const q = query.toLowerCase();
  const fromIndex: ShoobCard[] = [];

  for (const card of cardIndex.values()) {
    if (q && !card.name.toLowerCase().includes(q) && !card.series.toLowerCase().includes(q)) continue;
    if (tier && tier !== "All" && card.tier !== tier) continue;
    fromIndex.push(card);
  }

  fromIndex.sort((a, b) => {
    // Enriched cards first, then alphabetically
    if (a.enriched && !b.enriched) return -1;
    if (!a.enriched && b.enriched) return 1;
    return a.name.localeCompare(b.name);
  });

  return fromIndex;
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
router.get("/", async (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(String(req.query.page)) || 1);
  const search = String(req.query.search || "").toLowerCase().trim();
  const tier   = String(req.query.tier || "").trim();
  const limit  = 15;

  if (search || (tier && tier !== "All")) {
    const matches = await searchCards(search, tier);
    const total = matches.length;
    return res.json({
      cards: matches.slice((page - 1) * limit, page * limit),
      total, page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      indexedCount,
      indexing: isIndexing,
    });
  }

  const total      = allCardIds.length || 41812;
  const totalPages = Math.ceil(total / limit);
  const sliceIds   = allCardIds.slice((page - 1) * limit, page * limit);
  const cards      = await resolveBatch(sliceIds);

  res.json({ cards, total, page, totalPages, indexedCount, indexing: isIndexing });
});

// ---------------------------------------------------------------
// POST /enrich — bot registers card metadata when it sees a drop
// Body: { id, name, series, tier, imageUrl? }
// ---------------------------------------------------------------
router.post("/enrich", (req: Request, res: Response) => {
  const { id, name, series, tier, imageUrl } = req.body as {
    id?: string; name?: string; series?: string; tier?: string; imageUrl?: string;
  };

  if (!id || typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) {
    res.status(400).json({ error: "id must be a 24-char hex string" });
    return;
  }
  if (!name || !series || !tier) {
    res.status(400).json({ error: "name, series and tier are required" });
    return;
  }
  if (!TIER_RARITY[tier]) {
    res.status(400).json({ error: `tier must be one of: ${Object.keys(TIER_RARITY).join(", ")}` });
    return;
  }

  const img = imageUrl || CARD_IMG_BASE + id;
  const card: ShoobCard = {
    id, name: name.trim(), series: series.trim(), tier,
    rarity: TIER_RARITY[tier],
    imageUrl: img, thumbnailUrl: img,
    totalIssues: cardIndex.get(id)?.totalIssues ?? 1,
    enriched: true,
  };

  cardIndex.set(id, card);
  if (!knownIdSet.has(id)) {
    knownIdSet.add(id);
    allCardIds.push(id);
  }
  indexedCount = cardIndex.size;

  setImmediate(() => saveIndex());

  res.json({ ok: true, card });
});

// ---------------------------------------------------------------
// POST /enrich/bulk — batch enrichment (up to 500 cards)
// Body: [{ id, name, series, tier, imageUrl? }, ...]
// ---------------------------------------------------------------
router.post("/enrich/bulk", (req: Request, res: Response) => {
  const items = req.body as Array<{ id?: string; name?: string; series?: string; tier?: string; imageUrl?: string }>;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: "Body must be an array" });
    return;
  }

  let saved = 0;
  const errors: string[] = [];

  for (const item of items.slice(0, 500)) {
    const { id, name, series, tier, imageUrl } = item;
    if (!id || !/^[a-f0-9]{24}$/.test(id) || !name || !series || !tier || !TIER_RARITY[tier]) {
      errors.push(id ?? "?");
      continue;
    }
    const img = imageUrl || CARD_IMG_BASE + id;
    cardIndex.set(id, {
      id, name: name.trim(), series: series.trim(), tier,
      rarity: TIER_RARITY[tier], imageUrl: img, thumbnailUrl: img,
      totalIssues: cardIndex.get(id)?.totalIssues ?? 1, enriched: true,
    });
    if (!knownIdSet.has(id)) { knownIdSet.add(id); allCardIds.push(id); }
    saved++;
  }

  indexedCount = cardIndex.size;
  setImmediate(() => saveIndex());
  res.json({ ok: true, saved, errors: errors.length, failed: errors });
});

router.get("/stats", async (_req: Request, res: Response) => {
  const byTier: Record<string, number> = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0, T6: 0, TS: 0, TZ: 0 };
  let enrichedCount = 0;
  for (const c of cardIndex.values()) {
    if (byTier[c.tier] !== undefined) byTier[c.tier]++;
    if (c.enriched) enrichedCount++;
  }
  res.json({ total: allCardIds.length, byTier, indexedCount, enrichedCount, indexing: isIndexing });
});

router.get("/featured", async (_req: Request, res: Response) => {
  const ids   = allCardIds.slice(0, 10);
  const cards = await resolveBatch(ids);
  res.json(cards);
});

router.get("/index-status", (_req: Request, res: Response) => {
  res.json({
    total: allCardIds.length,
    indexed: indexedCount,
    indexing: isIndexing,
    pct: allCardIds.length ? Math.round((indexedCount / allCardIds.length) * 100) : 0,
    lastPollTime: lastPollTime?.toISOString() ?? null,
    newCardsSinceLastPoll,
    enriched: [...cardIndex.values()].filter(c => c.enriched).length,
  });
});

router.get("/random", async (req: Request, res: Response) => {
  const tierFilter = String(req.query.tier || "").trim();

  let candidates: ShoobCard[];
  if (tierFilter && tierFilter !== "All") {
    candidates = [...cardIndex.values()].filter(c => c.tier === tierFilter);
    if (!candidates.length) candidates = [...cardIndex.values()];
  } else {
    candidates = [...cardIndex.values()];
  }

  if (!candidates.length) {
    res.status(503).json({ error: "Index not ready yet — try again in a moment" });
    return;
  }

  const card = candidates[Math.floor(Math.random() * candidates.length)];
  res.json(card);
});

router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{24}$/.test(id)) {
    res.status(400).json({ error: "Invalid card ID" });
    return;
  }
  const card = await resolveCard(id);
  if (!card) { res.status(404).json({ error: "Card not found" }); return; }
  res.json(card);
});

export { router as cardsRouter };
