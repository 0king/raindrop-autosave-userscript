# Raindrop.io Userscripts

## `raindrop-auto-save.user.js`

Automatically saves the active browser tab URL to [Raindrop.io](https://raindrop.io/) once a page finishes loading and after single-page application (SPA) route transitions, without requiring a click.

### How It Mirrors the Official Extension

In the Raindrop.io browser extension, bookmark saving is driven by internal Redux/Saga functions ([`draftLoad`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/draft.js#L25-L98), `draftCommit`, [`createBookmark`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/single.js#L73-L115), and [`enrichCreated`](file:///media/d_drive/dev/web/raindrop-app/src/data/sagas/bookmarks/draft.js#L146-L196)) running inside the extension's isolated origin. Because [the extension manifest](file:///media/d_drive/dev/web/raindrop-app/src/target/extension/manifest/index.js) exposes no `externally_connectable` or public web message bridge, a standalone userscript cannot call those extension functions directly from web pages.

Instead, [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js) replicates the exact same pipeline over the Raindrop v1 REST API via `GM_xmlhttpRequest`:

1. **DOM Metadata & Image Extraction** ([`parse.js`](file:///media/d_drive/dev/web/raindrop-app/src/target/extension/getMeta/parse.js) parity):
   - Protects against stale SSR `<meta>` and JSON-LD tags after SPA transitions (`softNavigated`, `samePath`, `similarURL`, and `.at(-1)` last-tag precedence).
   - Extracts `title`, `excerpt`, `cover`, and up to 9 visible non-SVG `<img>` candidates (`>100×100` outside `header`, `footer`, `aside`) with Trusted-Types-safe HTML entity decoding.
2. **Duplicate Check & Existing Bookmark Loading** (`draftLoad` with `preventDuplicate: true`):
   - Queries `GET https://api.raindrop.io/v1/import/url/exists?url=...`.
   - If `ids.length > 0`, loads the existing item via `GET https://api.raindrop.io/v1/raindrop/{id}` instead of creating a duplicate, and opens Screen 1 with `"Already saved"` status so you can still inspect it or change its cover thumbnail.
3. **Collection Resolution & Bookmark Creation** (`createBookmark`):
   - Resolves the target collection (`auto` reads `user.config.add_default_collection || user.config.last_collection || -1` from `GET /v1/user`; falls back to `-1` Unsorted).
   - Submits `POST https://api.raindrop.io/v1/raindrop` with `pleaseParse: { weight: 1 }` (or pre-parses via `GET /v1/import/url/parse` when no title was extracted).
   - Retries once with `collectionId: -1` if creation fails for a non-auth reason on a non-Unsorted collection.
4. **Post-Create Metadata Enrichment** (`enrichCreated`):
   - Calls `GET /v1/import/url/parse?url=...` and updates missing `cover`, `media`, or `type` via `PUT /v1/raindrop/{id}`.
5. **Top-Right Closed Shadow DOM Overlay & Thumbnail Picker** ([`cover.js`](file:///media/d_drive/dev/web/raindrop-app/src/co/bookmarks/edit/form/cover.js) / [`thumb.js`](file:///media/d_drive/dev/web/raindrop-app/src/data/modules/format/thumb.js) parity):
   - **Progress**: shows `"Saving to Raindrop…"` while running.
   - **Screen 1 (Complete / Already Saved)**: shows save status, title, domain preview, excerpt, clickable cover thumbnail, one-click **Favorite** toggle button (`♡ Favorite` / `♥ Favorited` next to `"Open in Raindrop ↗"`, updating `important` via `PUT /v1/raindrop/{id}`), and an inline **Tags** editor (removable tag chips `×` plus free-form comma-separated input saving immediately on `Enter`, `,`, or `+` via `PUT /v1/raindrop/{id}`). Auto-hides after `8000 ms` unless hovered or while the tag input is focused, and resets the countdown after Favorite or Tag updates.
   - **Screen 2 (Thumbnail Picker)**: clicking the thumbnail switches the same top-right card to a grid of deduplicated Raindrop `media` and detected page images; clicking any image calls `PUT /v1/raindrop/{id}` with `{ cover, media }` and returns to Screen 1.

---

### Installation

#### Violentmonkey (Chrome, Edge, Firefox)
1. Install the [Violentmonkey](https://violentmonkey.github.io/) extension.
2. Open the Violentmonkey Dashboard → **+** (Create a new script) or **Install from URL** / drag-and-drop `userscripts/raindrop-auto-save.user.js`.
3. Paste or load the full contents of [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js) and save (`Ctrl+S`).

#### Tampermonkey (Chrome, Edge, Firefox, Safari)
1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the Tampermonkey Dashboard → **Utilities** → **Import from file** (or **+** new script) and load [`raindrop-auto-save.user.js`](file:///media/d_drive/dev/web/raindrop-app/userscripts/raindrop-auto-save.user.js).
3. Accept the `@connect api.raindrop.io` and `@connect rdl.ink` permissions if prompted on first request.

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
| **Auto-Hide (ms)** | `raindrop_overlay_timeout_ms` | `8000` | Milliseconds before Screen 1 auto-dismisses (`0` keeps it open; pauses on hover or tag input focus, resets on Favorite/Tag updates). |
| **SPA Delay (ms)** | `raindrop_spa_delay_ms` | `1500` | Debounce settle delay in milliseconds after SPA URL transitions before metadata extraction runs. |
| **Excluded URL Patterns** | `raindrop_excludes` | Auth/SSO/search patterns | Newline-separated wildcards (`*://example.com/*`) or `/regex/flags`. |
| **Save / Refresh Tab** | — | — | Manually trigger saving or reopen Screen 1 for the current tab URL. |

#### Debugging & Error Logging
- Actionable errors and non-fatal fallbacks (API/auth failures, collection `-1` retry warnings, `enrichCreated` failures, thumbnail `PUT` / `rdl.ink` blob errors, invalid exclusion patterns, `GM_*` storage errors, and top-level metadata extraction fallbacks) are always logged to the browser console with the `[Raindrop Auto-Save]` prefix, including URL, HTTP method/status, sanitized error message, and stack trace (`Authorization` Bearer tokens are automatically redacted).
- Enable **Debug logs** (`raindrop_debug`) in **⚙ Settings** to also log exclusion skips, SPA debounce scheduling, API attempts/retries, enrichment diffs, and expected Trusted Types `DOMParser` / malformed JSON-LD fallbacks via `console.debug`.

#### Default Exclusions
To avoid saving sensitive or noisy pages automatically, the script skips:
- Non-HTTP(S) schemes, iframes (`@noframes` + `window.top !== window.self`), and prerendering pages (`document.prerendering`).
- `raindrop.io`, `*.raindrop.io`, `localhost`, `127.0.0.1`, `[::1]`, and `0.0.0.0`.
- Common OAuth/SSO/login/signup/checkout URLs and major search engine result pages (configurable via **Edit Excluded URL Patterns**).

---

### Privacy & Security Notes

- Runs without `@grant unsafeWindow` and without inline script injection.
- Renders its top-right UI inside an isolated **closed Shadow DOM** constructed solely with `document.createElement` and `textContent` (no `innerHTML`), preserving compatibility with strict Content Security Policy (CSP) and Trusted Types sites such as GitHub and YouTube.
- Only connects to `api.raindrop.io` (and `rdl.ink` as an image-fetch fallback when strict `img-src` CSP blocks Raindrop thumbnail rendering).
