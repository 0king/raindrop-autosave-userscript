# Raindrop.io Userscripts

## `raindrop-auto-save.user.js`

Automatically saves active and newly opened background browser tab URLs to [Raindrop.io](https://raindrop.io/) once the page DOM is ready (`@run-at document-start` + `DOMContentLoaded` / `readyState` without blocking on `window.load`) and after single-page application (SPA) route transitions, without requiring a click.

### How It Mirrors the Official Extension

In the Raindrop.io browser extension, bookmark saving is driven by internal Redux/Saga functions ([`draftLoad`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/draft.js#L25-L98), `draftCommit`, [`createBookmark`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/single.js#L73-L115), and [`enrichCreated`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/draft.js#L146-L196)) running inside the extension's isolated origin. Because [the extension manifest](file:///media/d_drive/dev/web/raindrop-app/src/target/extension/manifest/index.js) exposes no `externally_connectable` or public web message bridge, a standalone userscript cannot call those extension functions directly from web pages.

Instead, [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js) replicates the exact same pipeline over the Raindrop v1 REST API via `GM_xmlhttpRequest`:

1. **DOM Metadata & Image Extraction** ([`parse.js`](file:///media/d_drive/dev/web/raindrop-app/src/target/extension/getMeta/parse.js) parity):
   - Protects against stale SSR `<meta>` and JSON-LD tags after SPA transitions (`softNavigated`, `samePath`, `similarURL`, and `.at(-1)` last-tag precedence).
   - Extracts `title`, `excerpt`, `cover`, and up to 9 visible non-SVG `<img>` candidates (`>100×100` outside `header`, `footer`, `aside`) with Trusted-Types-safe HTML entity decoding, skipping any image URL matching **Blocked Thumbnail URLs**.
2. **Duplicate Check & Existing Bookmark Loading** (`draftLoad` with `preventDuplicate: true`):
   - Queries `GET https://api.raindrop.io/v1/import/url/exists?url=...`.
   - If `ids.length > 0`, loads the existing item via `GET https://api.raindrop.io/v1/raindrop/{id}` instead of creating a duplicate, strips any `cover`/`media` entries matching **Blocked Thumbnail URLs** (switching to the next unblocked image or capturing a screenshot if none remain), and opens Screen 1 with `"Already saved"` status so you can still inspect it or change its cover thumbnail.
3. **Collection Resolution & Bookmark Creation** (`createBookmark`):
   - Resolves the target collection (`auto` reads `user.config.add_default_collection || user.config.last_collection || -1` from `GET /v1/user`, cached across tabs in `raindrop_cached_user_collection` with a 10-minute TTL keyed by auth fingerprint; falls back to `-1` Unsorted).
   - Submits `POST https://api.raindrop.io/v1/raindrop` with `pleaseParse: { weight: 1 }` (or pre-parses once via `GET /v1/import/url/parse` when no title was extracted, reusing the parsed payload in enrichment).
   - Retries once with `collectionId: -1` if creation fails for a non-auth reason on a non-Unsorted collection.
4. **Post-Create Metadata Enrichment & Auto-Screenshot Fallback** (`enrichCreated` + [`draftCoverUpload`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/draft.js#L121-L139) parity):
   - Reuses pre-parsed metadata when already fetched, or calls `GET /v1/import/url/parse?url=...`, filters out blocked thumbnail URLs (suppressing background `pleaseParse` when blocked rules leave no cover or strip blocked images), and updates missing `cover`, `media`, `excerpt`, or `type` via `PUT /v1/raindrop/{id}`.
   - If neither client DOM extraction nor `enrichCreated` finds any unblocked `cover` or `media` (including when all detected/parsed images were blocked), waits for `document.readyState === 'complete'` (plus a short paint settle, up to `8000 ms` so background saves still create the bookmark immediately at DOM interactive), captures a simple full-viewport client-side DOM/Canvas screenshot (`0,0` to viewport width/height, JPEG), and uploads it via `PUT /v1/raindrop/{id}/cover` (`FormData`, skipping CORS-blocked `<img>` tags and excluding the overlay itself).
   - Uses a two-tier self-contained renderer (SVG `<foreignObject>` with computed styles omitting redundant default/inherited CSS and pruning clipped off-viewport subtrees, plus a pure 2D Canvas DOM painter fallback for strict `img-src` CSP sites) with banded blank/solid-frame pixel-variance detection (`canvasHasVisualContent`) so blank frames fall back cleanly to Raindrop's server `<screenshot>` (`PUT /v1/raindrop/{id}`) instead of uploading an empty screen.
   - For `<video>` elements, captures the `poster` image when the video has not started playing (`paused` at `t = 0` and unplayed) or as a fallback if the video frame is unavailable or CORS-tainted, skipping poster URLs matching **Blocked Thumbnail URLs** and fetching cross-origin posters via `GM_xmlhttpRequest` (`@connect *`).

### Performance & Resource Architecture

- **Settings & Matcher Caching (`GM_addValueChangeListener`)**: Caches `GM_getValue` preferences and compiled wildcard/regex matchers in memory per tab, refreshing automatically across tabs via `GM_addValueChangeListener` (with `visibilitychange`/`focus` fallback) and caching the resolved `"auto"` collection ID in `raindrop_cached_user_collection` for 10 minutes.
- **Idle/Background Tab Suspension**: Exits early on iframes/non-HTTP(S)/built-in excluded hosts, suspends the `1000 ms` URL poll and burst-throttled `MutationObserver` whenever auto-save is paused (`raindrop_enabled = false`) or the tab is hidden after initial load (and skips `MutationObserver` when the Navigation API is available), waking automatically on `visibilitychange` or `GM_addValueChangeListener`.
- **Bounded SPA Session Caches**: Uses LRU-bounded maps/sets for session bookmark (`150`), scraped metadata (`100`), attempted URL (`1000`), and deleted ID (`500`) caches, and deterministically zeros temporary capture `<canvas>` buffers and stale blob URLs after use.
5. **Top-Right Closed Shadow DOM Overlay & Thumbnail Picker** ([`cover.js`](file:///media/d_drive/dev/web/raindrop-app/src/co/bookmarks/edit/form/cover.js) / [`thumb.js`](file:///media/d_drive/dev/web/raindrop-app/src/data/modules/format/thumb.js) parity):
   - **Progress**: shows `"Saving to Raindrop…"` while running.
   - **Screen 1 (Complete / Already Saved)**: shows save status, title, domain preview, excerpt, clickable cover thumbnail (showing `"Capturing…"` and deferring auto-hide while the fallback screenshot runs, then updating in place without disrupting tag input), one-click **Favorite** toggle button (`♡ Fav` / `♥ Fav`, updating `important` via `PUT /v1/raindrop/{id}`), one-click **Delete** button (`Delete`, calling `DELETE /v1/raindrop/{id}` to move the bookmark to Trash, clearing the cached bookmark and showing a brief `"Deleted"` notice without auto-re-saving in the current session), `"Open ↗"` link to Raindrop, and an inline **Tags** editor (removable tag chips `×` plus free-form comma-separated input saving immediately on `Enter`, `,`, or `+` via `PUT /v1/raindrop/{id}`). After `8000 ms` (unless hovered, while the tag input is focused, while auto-screenshot capture is running, or while the tab is hidden in the background — resetting the countdown after Favorite or Tag updates), the card collapses into a compact top-right icon pill with two icon-only buttons: a Raindrop droplet icon to reopen the overlay (keeping it open without a second auto-hide) and an `×` icon to remove the overlay from the page completely. Clicking `×` on the expanded card or letting a brief notice (`"Deleted"`, exclusion notices) expire removes the overlay from the page immediately, and SPA navigation resets it for the new URL.
   - **Screen 2 (Thumbnail Picker)**: clicking the thumbnail switches the same top-right card to a grid of deduplicated unblocked Raindrop `media` and detected page images plus a **Screenshot** tile (always available even when thumbnails exist) to capture and upload a viewport screenshot on demand; clicking any image calls `PUT /v1/raindrop/{id}` with `{ cover, media }` and returns to Screen 1, and clicking the **Block** button on an image tile adds that URL to `raindrop_blocked_thumbnails` (automatically switching the bookmark to the next unblocked image, or capturing and uploading a screenshot if no image remains). Revisiting an already-saved page also strips blocked thumbnails from its saved `cover`/`media`.

---

### Installation

#### Violentmonkey (Chrome, Edge, Firefox)
1. Install the [Violentmonkey](https://violentmonkey.github.io/) extension.
2. Open the Violentmonkey Dashboard → **+** (Create a new script) or **Install from URL** / drag-and-drop `userscripts/raindrop-auto-save.user.js`.
3. Paste or load the full contents of [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js) and save (`Ctrl+S`).

#### Tampermonkey (Chrome, Edge, Firefox, Safari)
1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the Tampermonkey Dashboard → **Utilities** → **Import from file** (or **+** new script) and load [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js).
3. Accept the `@connect` permissions (`api.raindrop.io`, `rdl.ink`, and `*` for cross-origin `<video poster>` screenshot capture) if prompted on first request.
4. **Firefox background-tab notes**: The script injects at `@run-at document-start` and triggers once the DOM becomes interactive so Firefox's `document_idle` / subresource throttling in background tabs does not stall saves. If you test in Private Windows, ensure **Run in Private Windows** is enabled for Tampermonkey in `about:addons`; if a tab-suspending add-on defers background page loads entirely until focus, the script also catches up automatically when the tab becomes visible. In Tampermonkey's **Settings** (**Config mode: Advanced**), setting **Content Script API** to **UserScripts API** (or **UserScripts API Dynamic**) can also avoid extension-messaging delays on Firefox background tabs.

---

### Authentication Setup

The script supports **dual-mode authentication**:

1. **API Test Token (Recommended)**
   - Open [Raindrop.io App Integrations Settings](https://app.raindrop.io/settings/integrations).
   - Under **For Developers**, click **+ Create new app**, open it, and click **Create test token**.
   - Click the **⚙** button in the top-right overlay header (or the **Auth required** button when `401` appears) to open the in-page **Raindrop Settings** panel, paste the token into **API Test Token**, and click **Save Settings**.
   - All requests will authenticate with `Authorization: Bearer <token>`.

2. **Browser Session Cookie Fallback**
   - Leave the API token blank (or click **Clear** in Settings) to use browser session cookies (`withCredentials: true`, `anonymous: false`) while logged in at `https://app.raindrop.io`.
   - Note: Browsers with strict third-party cookie partitioning (e.g., Firefox Enhanced Tracking Protection or Safari) may withhold cookies on cross-origin `GM_xmlhttpRequest` calls, returning `401`. If that happens, switch to the Test Token method above.

---

### Menu Command & In-Overlay Settings

To keep the Violentmonkey/Tampermonkey extension menu clean, only one command is registered in the browser menu:

- **Raindrop: Exclude Current Site / URL** — Opens a prompt prefilled with `*://<host>/*` (displaying the full tab URL so you can confirm or edit it to an exact URL or `/regex/flags`), saves the pattern to `raindrop_excludes`, cancels any pending save, and updates the overlay without deleting any already-saved bookmark in Raindrop.

All other preferences and actions are accessed via the **⚙ Settings** icon in the top-right overlay header (available on the progress, saved/existing, and error screens):

| Setting / Action | Storage Key | Default | Description |
| --- | --- | --- | --- |
| **Auto-save enabled** | `raindrop_enabled` | `true` | Pause/resume automatic saving without uninstalling. |
| **Debug logs** | `raindrop_debug` | `false` | Enable/disable verbose `[Raindrop Auto-Save][debug]` trace logs in DevTools console. |
| **API Test Token** | `raindrop_token` | `""` | Set a Bearer test token or click **Clear** to fall back to session cookies. |
| **Target Collection ID** | `raindrop_collection_id` | `"auto"` | `"auto"` mirrors `add_default_collection \|\| last_collection \|\| -1`; `-1` saves to Unsorted; or set a numeric collection ID. |
| **Auto-Hide (ms)** | `raindrop_overlay_timeout_ms` | `8000` | Milliseconds before Screen 1 collapses into the top-right two-icon pill (`0` keeps it open; pauses on hover or tag input focus, resets on Favorite/Tag updates). |
| **SPA Delay (ms)** | `raindrop_spa_delay_ms` | `1500` | Debounce settle delay in milliseconds after SPA URL transitions before metadata extraction runs. |
| **Excluded URL Patterns** | `raindrop_excludes` | Auth/SSO/search patterns | Newline-separated wildcards (`*://example.com/*`) or `/regex/flags`. |
| **Blocked Thumbnail URL Patterns** | `raindrop_blocked_thumbnails` | Twitter/X generic OG URLs (`default-og.a2e144f0cf66.jpg`, `rweb/ssr/default/v2/og/image.png`) | Newline-separated wildcards (`*` / `?`), `/regex/flags`, or substrings skipped from thumbnail selection; triggers auto-screenshot if no unblocked image remains. |
| **Save / Refresh Tab** | — | — | Manually trigger saving or reopen Screen 1 for the current tab URL. |

#### Debugging & Error Logging
- Actionable errors and non-fatal fallbacks (API/auth failures, collection `-1` retry warnings, `enrichCreated` failures, thumbnail/cover `PUT` / screenshot capture / `rdl.ink` blob errors, invalid exclusion patterns, `GM_*` storage errors, and top-level metadata extraction fallbacks) are always logged to the browser console with the `[Raindrop Auto-Save]` prefix, including URL, HTTP method/status, sanitized error message, and stack trace (`Authorization` Bearer tokens are automatically redacted).
- Enable **Debug logs** (`raindrop_debug`) in **⚙ Settings** to also log exclusion skips, SPA debounce scheduling, API attempts/retries, enrichment diffs, and expected Trusted Types `DOMParser` / malformed JSON-LD fallbacks via `console.debug`.

#### Default Exclusions
To avoid saving sensitive or noisy pages automatically, the script skips:
- Non-HTTP(S) schemes, iframes (`@noframes` + `window.top !== window.self`), and prerendering pages (`document.prerendering`).
- `raindrop.io`, `*.raindrop.io`, `localhost`, `127.0.0.1`, `[::1]`, and `0.0.0.0`.
- Common OAuth/SSO/login/signup/checkout URLs and major search engine result pages (configurable via **Edit Excluded URL Patterns**).

---

### Privacy & Security Notes

- Runs without `@grant unsafeWindow`, without external `@require` scripts, and without inline script injection.
- Renders its top-right UI inside an isolated **closed Shadow DOM** constructed solely with `document.createElement` and `textContent` (no `innerHTML`), preserving compatibility with strict Content Security Policy (CSP) and Trusted Types sites such as GitHub and YouTube.
- Client-side screenshot capture skips CORS-blocked `<img>` and CSS `url()` resources without fetching arbitrary hosts, fetches cross-origin `<video poster>` images via `GM_xmlhttpRequest` (`@connect *`) while skipping URLs matching **Blocked Thumbnail URLs**, omits `<input type="password">` values, excludes the Raindrop overlay from captures, and builds SVG snapshots without `innerHTML`.
- Connects to `api.raindrop.io`, `rdl.ink` (as an image-fetch fallback when strict `img-src` CSP blocks Raindrop thumbnail rendering), and external `<video poster>` image hosts during screenshot capture (`@connect *`).
