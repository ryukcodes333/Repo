# Shadow Cards — v3 Changes

## Files changed
| File | Destination |
|------|-------------|
| `backend/src/routes/cards.ts` | `shadow-cards/backend/src/routes/cards.ts` |
| `bot/cards.js` | `shadow-garden-bot/commands/cards.js` |

---

## backend/src/routes/cards.ts  (full rewrite)

### Why only ~4 % of cards had names
Shoob CDN URLs fall into three formats:
- **Readable** `Name;TierNum;Series.png` — only very early 2019 cards (~4%)
- **Timestamp** `1591047632750.png` — 2020 era cards
- **SHA-256 hash** `6525dc8b...64chars.png` — all 2021+ cards

The Shoob REST API and Socket.io endpoint both require Authorization.
There is no public JSON API for card metadata.

### What was fixed
1. **Event cards added** — `event_cards.1.xml` (6 134 cards) is now scraped  
   alongside `cards.1.xml`; event-card IDs inside `/card-events/{event}/{id}`  
   paths are extracted with a separate regex.
2. **Tier always extracted** — CDN path `/images/cards/{tierNum}/` is parsed  
   for every card so tier is correct even when the filename is a hash.
3. **Image URL fixed** — `imageUrl` is now always  
   `https://api.shoob.gg/site/api/card/{id}` (direct PNG, no redirect, no auth  
   needed). No more broken images from expired CDN hash URLs.
4. **Fallback name improved** — hash/timestamp cards get `"T4 Card #abc123"`  
   instead of the raw 64-char hash.
5. **`POST /api/cards/enrich`** — new endpoint. Body: `{id, name, series, tier}`.  
   Bot calls this silently every time it sees a real card. Enriched cards are  
   flagged and returned first in search results.
6. **`POST /api/cards/enrich/bulk`** — same as above but accepts an array  
   (up to 500 cards). Useful for importing a card list.
7. **`GET /api/cards/index-status`** — now also returns `enriched` count.
8. **`GET /api/cards/stats`** — now returns `enrichedCount`.
9. Persistence (`shoob-index.json`) preserves the `enriched` flag across  
   restarts — enriched names are never overwritten by CDN scraping.

---

## bot/commands/cards.js

### Changes
1. **`apiPost(path, body)`** helper added — makes authenticated POST requests  
   to the API server.
2. **`enrichCard(card)`** added — called silently after every spawn, claim,  
   and `.ci` lookup. Skips cards that still have fallback names. This is how  
   the name database grows over time without any manual work.
3. **`.register` command added** — staff only.  
   Usage: `.register <24-hex-id> <tier> <name> | <series>`  
   Manually teaches the API a card name/series if you know it.  
   Example: `.register 5d57536cc1fc102f955f99fe T2 Oz Vessalius | Pandora Hearts`
4. **`.cards` output** now shows *Named* count (enriched cards).
5. **`.ss` error message** improved — tells users that only seen cards are  
   fully searchable.
6. **`.card` collection viewer** now also proxies the image URL through the  
   image-proxy route (was using the raw URL before).

---

## How card names grow over time

Every time a card is spawned or claimed through the bot, its real name is
registered to the API. After normal usage for a few weeks most popular cards
will have proper names. You can also bulk-register by POSTing to
`/api/cards/enrich/bulk` with an array of `{id, name, series, tier}` objects.
