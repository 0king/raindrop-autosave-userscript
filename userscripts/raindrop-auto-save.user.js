// ==UserScript==
// @name         Raindrop.io Auto-Save Tab URL
// @namespace    https://raindrop.io/
// @version      1.1.0
// @description  Automatically saves loaded and SPA-navigated tab URLs to Raindrop.io using the extension's save pipeline.
// @author       Raindrop.io Community
// @match        http://*/*
// @match        https://*/*
// @exclude      *://raindrop.io/*
// @exclude      *://*.raindrop.io/*
// @exclude      http://localhost/*
// @exclude      https://localhost/*
// @exclude      http://127.0.0.1/*
// @exclude      https://127.0.0.1/*
// @noframes
// @run-at       document-idle
// @connect      api.raindrop.io
// @connect      rdl.ink
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Constants & Configuration Keys
    // -------------------------------------------------------------------------
    const APP_BASE_URL = 'https://app.raindrop.io';
    const API_ENDPOINT_URL = 'https://api.raindrop.io/v1/';
    const WORKERS_BASE_URL = 'https://rdl.ink';
    const LEGACY_WORKERS_BASE_URL = 'https://stella.raindrop.io';
    const RENDER_URL = `${WORKERS_BASE_URL}/render`;

    const API_RETRIES = 3;
    const API_TIMEOUT = 30000;

    const STORAGE_KEYS = {
        enabled: 'raindrop_enabled',
        token: 'raindrop_token',
        collectionId: 'raindrop_collection_id',
        excludes: 'raindrop_excludes',
        spaDelayMs: 'raindrop_spa_delay_ms',
        overlayTimeoutMs: 'raindrop_overlay_timeout_ms',
        debug: 'raindrop_debug'
    };

    const DEFAULT_SPA_DELAY_MS = 1500;
    const DEFAULT_OVERLAY_TIMEOUT_MS = 8000;
    const INITIAL_LOAD_SETTLE_MS = 150;
    const URL_WATCH_INTERVAL_MS = 1000;

    const DEFAULT_EXCLUDE_PATTERNS = [
        '*://accounts.google.com/*',
        '*://login.microsoftonline.com/*',
        '*://login.live.com/*',
        '*://appleid.apple.com/*',
        '*://*.auth0.com/*',
        '*://*.okta.com/*',
        '*://github.com/login*',
        '*://github.com/sessions/*',
        '/^https?:\\/\\/(auth|login|signin|sso|oauth|accounts|checkout)\\.[^/]+\\//i',
        '/^https?:\\/\\/[^/]+\\/(login|signin|sign-in|log-in|logout|signout|signup|sign-up|register|sso|oauth2?|auth|authorize|callback|forgot-password|reset-password|checkout|billing|payment)(\\/|\\?|$)/i',
        '/^https?:\\/\\/[^/]+\\/(oauth2?\\/authorize|oauth2?\\/token|saml\\/|openid-connect\\/)/i',
        '/^https?:\\/\\/(www\\.)?google\\.[a-z.]+\\/search(\\/|\\?|$)/i',
        '/^https?:\\/\\/(www\\.)?bing\\.com\\/search(\\/|\\?|$)/i',
        '/^https?:\\/\\/(www\\.)?duckduckgo\\.com\\/(\\?.*q=|$)/i',
        '/^https?:\\/\\/search\\.yahoo\\.com\\/search/i',
        '/^https?:\\/\\/(www\\.)?baidu\\.com\\/s(\\?|$)/i',
        '/^https?:\\/\\/yandex\\.[a-z.]+\\/search/i',
        '/^https?:\\/\\/search\\.brave\\.com\\/search/i',
        '/^https?:\\/\\/kagi\\.com\\/search/i',
        '*://standardnotes.com/*',
        'https://app.standardnotes.com/*',
        'https://app.simplenote.com/*',
        'https://simplenote.com/*',
        'https://mail.yahoo.com/*',
        'https://mail.google.com/*',
        'https://x.com/home',
        'https://instagram.com',
        'https://reddit.com',
        'https://youtube.com'
    ];

    const HTML_ENTITIES = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: '\u00a0',
        ndash: '\u2013',
        mdash: '\u2014',
        lsquo: '\u2018',
        rsquo: '\u2019',
        ldquo: '\u201c',
        rdquo: '\u201d',
        hellip: '\u2026',
        copy: '\u00a9',
        reg: '\u00ae',
        trade: '\u2122',
        times: '\u00d7',
        divide: '\u00f7',
        plusmn: '\u00b1',
        bull: '\u2022',
        middot: '\u00b7',
        laquo: '\u00ab',
        raquo: '\u00bb',
        euro: '\u20ac',
        pound: '\u00a3',
        yen: '\u00a5',
        cent: '\u00a2',
        sect: '\u00a7',
        deg: '\u00b0',
        prime: '\u2032',
        Prime: '\u2033',
        larr: '\u2190',
        uarr: '\u2191',
        rarr: '\u2192',
        darr: '\u2193',
        harr: '\u2194'
    };

    // -------------------------------------------------------------------------
    // Storage Helpers
    // -------------------------------------------------------------------------
    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key, fallback);
                return value === undefined ? fallback : value;
            }
        } catch (e) {
            logWarn('GM_getValue failed', { key, error: e });
        }
        return fallback;
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
            }
        } catch (e) {
            logWarn('GM_setValue failed', { key, error: e });
        }
    }

    function isEnabled() {
        return Boolean(gmGet(STORAGE_KEYS.enabled, true));
    }

    function isDebugEnabled() {
        return Boolean(gmGet(STORAGE_KEYS.debug, false));
    }

    function getToken() {
        const raw = gmGet(STORAGE_KEYS.token, '');
        return typeof raw === 'string' ? raw.trim() : '';
    }

    function getConfiguredCollectionId() {
        const raw = gmGet(STORAGE_KEYS.collectionId, 'auto');
        if (raw === null || raw === undefined || raw === '' || String(raw).trim().toLowerCase() === 'auto') {
            return 'auto';
        }
        const parsed = parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(parsed) || parsed === 0 || parsed === -99) {
            return 'auto';
        }
        return String(parsed);
    }

    function getExcludes() {
        const stored = gmGet(STORAGE_KEYS.excludes, null);
        if (Array.isArray(stored)) {
            return stored.map((s) => String(s || '').trim()).filter(Boolean);
        }
        return [...DEFAULT_EXCLUDE_PATTERNS];
    }

    function getSpaDelayMs() {
        const raw = Number(gmGet(STORAGE_KEYS.spaDelayMs, DEFAULT_SPA_DELAY_MS));
        return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SPA_DELAY_MS;
    }

    function getOverlayTimeoutMs() {
        const raw = Number(gmGet(STORAGE_KEYS.overlayTimeoutMs, DEFAULT_OVERLAY_TIMEOUT_MS));
        return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_OVERLAY_TIMEOUT_MS;
    }

    // -------------------------------------------------------------------------
    // Logging & Redaction Helpers
    // -------------------------------------------------------------------------
    const LOG_PREFIX = '[Raindrop Auto-Save]';

    function sanitizeLogText(text) {
        let out = String(text || '').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
        try {
            if (typeof GM_getValue === 'function') {
                const rawToken = GM_getValue(STORAGE_KEYS.token, '');
                const token = typeof rawToken === 'string' ? rawToken.trim() : '';
                if (token && token.length >= 6) {
                    out = out.split(token).join('[REDACTED]');
                }
            }
        } catch (e) {}
        return out;
    }

    function sanitizeHeaders(headers) {
        if (!headers || typeof headers !== 'object') return undefined;
        const clean = {};
        for (const [k, v] of Object.entries(headers)) {
            if (String(k).toLowerCase() === 'authorization') {
                clean[k] = String(v).toLowerCase().startsWith('bearer ') ? 'Bearer [REDACTED]' : '[REDACTED]';
            } else {
                clean[k] = sanitizeLogText(v);
            }
        }
        return clean;
    }

    function formatLogDetails(details) {
        if (!details || typeof details !== 'object') return undefined;
        const payload = {};
        if (details.url !== undefined) payload.url = sanitizeLogText(details.url);
        if (details.method !== undefined) payload.method = String(details.method);
        if (details.status !== undefined) payload.status = details.status;
        if (details.attempt !== undefined) payload.attempt = details.attempt;
        if (details.headers !== undefined) payload.headers = sanitizeHeaders(details.headers);

        for (const [k, v] of Object.entries(details)) {
            if (k === 'error' || k === 'url' || k === 'method' || k === 'status' || k === 'attempt' || k === 'headers') {
                continue;
            }
            payload[k] = typeof v === 'string' ? sanitizeLogText(v) : v;
        }

        const err = details.error;
        if (err) {
            if (payload.status === undefined && err.status !== undefined) {
                payload.status = err.status;
            }
            if (err.code !== undefined || err.error !== undefined) {
                payload.code = err.code !== undefined ? err.code : err.error;
            }
            payload.message = sanitizeLogText(err.errorMessage || err.message || String(err));
            if (err.stack) {
                payload.stack = sanitizeLogText(err.stack);
            }
        }

        return payload;
    }

    function logError(message, details) {
        try {
            if (typeof console === 'undefined' || typeof console.error !== 'function') return;
            const payload = formatLogDetails(details);
            if (payload) console.error(LOG_PREFIX, sanitizeLogText(message), payload);
            else console.error(LOG_PREFIX, sanitizeLogText(message));
        } catch (e) {}
    }

    function logWarn(message, details) {
        try {
            if (typeof console === 'undefined') return;
            const fn = typeof console.warn === 'function' ? console.warn : console.log;
            if (typeof fn !== 'function') return;
            const payload = formatLogDetails(details);
            if (payload) fn.call(console, LOG_PREFIX, sanitizeLogText(message), payload);
            else fn.call(console, LOG_PREFIX, sanitizeLogText(message));
        } catch (e) {}
    }

    function logDebug(message, details) {
        if (!isDebugEnabled()) return;
        try {
            if (typeof console === 'undefined') return;
            const fn = typeof console.debug === 'function' ? console.debug : console.log;
            if (typeof fn !== 'function') return;
            const payload = formatLogDetails(details);
            if (payload) fn.call(console, `${LOG_PREFIX}[debug]`, sanitizeLogText(message), payload);
            else fn.call(console, `${LOG_PREFIX}[debug]`, sanitizeLogText(message));
        } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Exclusion & Eligibility Checks
    // -------------------------------------------------------------------------
    function escapeRegExp(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function compileExcludeMatcher(pattern) {
        const raw = String(pattern || '').trim();
        if (!raw) return null;

        if (raw.startsWith('/')) {
            const lastSlash = raw.lastIndexOf('/');
            if (lastSlash > 0) {
                const body = raw.slice(1, lastSlash);
                const flags = raw.slice(lastSlash + 1);
                try {
                    const re = new RegExp(body, flags);
                    return (url) => re.test(url);
                } catch (e) {
                    logWarn('Invalid exclusion regex pattern', { pattern: raw, error: e });
                    return null;
                }
            }
        }

        if (raw.includes('*') || raw.includes('?')) {
            const regexStr = '^' + raw
                .split(/(\*|\?)/)
                .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : escapeRegExp(part)))
                .join('') + '$';
            try {
                const re = new RegExp(regexStr, 'i');
                return (url) => re.test(url);
            } catch (e) {
                logWarn('Invalid exclusion wildcard pattern', { pattern: raw, error: e });
                return null;
            }
        }

        const needle = raw.toLowerCase();
        return (url) => url.toLowerCase().includes(needle);
    }

    function isBuiltInExcludedHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        if (!host) return true;
        if (host === 'raindrop.io' || host.endsWith('.raindrop.io')) return true;
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') {
            return true;
        }
        return false;
    }

    function isUrlExcluded(url, options = {}) {
        const ignoreUserPatterns = Boolean(options.ignoreUserPatterns);

        try {
            if (typeof window !== 'undefined' && window.top !== window.self) {
                return true;
            }
        } catch (e) {
            return true;
        }

        if (typeof document !== 'undefined' && document.prerendering) {
            return true;
        }

        const targetUrl = String(url || '');
        if (!targetUrl) return true;

        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch (e) {
            return true;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return true;
        }

        if (isBuiltInExcludedHost(parsed.hostname)) {
            return true;
        }

        if (ignoreUserPatterns) {
            return false;
        }

        const patterns = getExcludes();
        for (const pattern of patterns) {
            const matcher = compileExcludeMatcher(pattern);
            if (matcher && matcher(parsed.href)) {
                return true;
            }
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // API Transport & Auth Wrapper (mirrors src/data/modules/api.js)
    // -------------------------------------------------------------------------
    class ApiError extends Error {
        constructor({ status, error, errorMessage } = {}) {
            let msg = errorMessage;
            if (!msg) {
                switch (status) {
                    case 401: msg = 'Login is required'; break;
                    case 408: msg = 'timeout'; break;
                    case 400: msg = 'validation failed'; break;
                    case 404: msg = 'not found'; break;
                    default: msg = 'failed to load'; break;
                }
            }
            super(msg);
            this.name = 'ApiError';
            this.code = error;
            this.error = error;
            this.status = status;
            this.errorMessage = msg;
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function resolveApiUrl(path) {
        if (/^https?:\/\//i.test(path)) return path;
        if (path.startsWith('/')) return `${APP_BASE_URL}${path}`;
        return `${API_ENDPOINT_URL}${path}`;
    }

    function parseApiResponse(res, finalUrl) {
        const status = typeof res.status === 'number' ? res.status : 0;
        const text = typeof res.responseText === 'string' ? res.responseText : '';
        const headers = String(res.responseHeaders || '').toLowerCase();

        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch (e) {
                if (status >= 200 && status < 300 && headers.includes('text/plain')) {
                    return text;
                }
                if (status >= 200 && status < 300) {
                    throw new ApiError({
                        status,
                        errorMessage: `${e.message} ${finalUrl}`
                    });
                }
            }
        } else {
            json = {};
        }

        // checkJSON parity with src/data/modules/api.js
        if (json && typeof json === 'object') {
            if (typeof json.auth === 'boolean' && json.auth === false) {
                throw new ApiError({
                    status: 401,
                    error: json.error,
                    errorMessage: json.errorMessage || 'Login is required'
                });
            }
        }

        if (status < 200 || status >= 300) {
            throw new ApiError({
                status: status || 500,
                error: json && json.error,
                errorMessage: (json && json.errorMessage) || res.statusText || 'fail_fetch_status'
            });
        }

        if (json && typeof json === 'object' && !json.result) {
            if (json.error || json.errorMessage || (typeof json.status === 'number' && json.status >= 300)) {
                throw new ApiError({
                    status: json.status || status,
                    error: json.error,
                    errorMessage: json.errorMessage
                });
            }
        }

        return json;
    }

    function gmRequestOnce(method, finalUrl, data, options = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new ApiError({ status: 0, errorMessage: 'GM_xmlhttpRequest unavailable' }));
                return;
            }

            const token = getToken();
            const headers = {
                Accept: 'application/json',
                ...(options.headers || {})
            };

            let body;
            if (data !== undefined && method !== 'GET' && method !== 'HEAD') {
                headers['Content-Type'] = headers['Content-Type'] || 'application/json';
                body = typeof data === 'string' ? data : JSON.stringify(data);
            }

            const reqOptions = {
                method,
                url: finalUrl,
                headers,
                timeout: typeof options.timeout === 'number' ? options.timeout : API_TIMEOUT,
                onload(res) {
                    try {
                        resolve(parseApiResponse(res, finalUrl));
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror(res) {
                    reject(new ApiError({
                        status: (res && res.status) || 0,
                        errorMessage: (res && res.statusText) || 'failed to load'
                    }));
                },
                ontimeout() {
                    reject(new ApiError({ status: 408 }));
                },
                onabort() {
                    reject(new ApiError({ status: 0, errorMessage: 'aborted' }));
                }
            };

            if (body !== undefined) {
                reqOptions.data = body;
            }

            if (token) {
                headers.Authorization = `Bearer ${token}`;
            } else {
                // Cookie fallback requires credentials; browser profiles with strict third-party
                // cookie partitioning may still withhold cookies, producing a 401 handled by UI.
                reqOptions.anonymous = false;
                reqOptions.withCredentials = true;
            }

            GM_xmlhttpRequest(reqOptions);
        });
    }

    async function apiRequest(method, path, data, options = {}) {
        const upperMethod = String(method || 'GET').toUpperCase();
        const finalUrl = resolveApiUrl(path);
        const retries = typeof options.retries === 'number'
            ? options.retries
            : (upperMethod === 'GET' ? API_RETRIES : 0);

        let lastError;
        for (let i = 0; i <= retries; i++) {
            try {
                logDebug('API request', {
                    method: upperMethod,
                    url: finalUrl,
                    attempt: i + 1,
                    authMode: getToken() ? 'bearer' : 'cookie'
                });
                return await gmRequestOnce(upperMethod, finalUrl, data, options);
            } catch (err) {
                lastError = err instanceof ApiError
                    ? err
                    : new ApiError({ status: err && err.status, errorMessage: (err && err.message) || '' });

                const nonRetryableClientErr = Boolean(
                    lastError.status && lastError.status >= 400 && lastError.status < 500 && lastError.status !== 408
                );

                // Stop immediately on 4xx client/auth errors except 408 timeout
                if (nonRetryableClientErr) {
                    break;
                }

                if (i < retries) {
                    const backoff = Math.min(500 * (2 ** i), 5000) + Math.random() * 250;
                    logWarn('API request failed; retrying', {
                        method: upperMethod,
                        url: finalUrl,
                        attempt: i + 1,
                        nextRetryMs: Math.round(backoff),
                        error: lastError
                    });
                    await sleep(backoff);
                }
            }
        }

        const message = lastError && lastError.message && !lastError.message.includes(finalUrl)
            ? `${lastError.message} ${finalUrl}`
            : (lastError && lastError.message) || `failed to load ${finalUrl}`;

        const finalError = new ApiError({
            status: lastError && lastError.status,
            error: lastError && lastError.error,
            errorMessage: message
        });

        logError('API request failed', {
            method: upperMethod,
            url: finalUrl,
            headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
            error: finalError
        });

        throw finalError;
    }

    // -------------------------------------------------------------------------
    // Metadata & Thumbnail Extraction (mirrors src/target/extension/getMeta/parse.js)
    // -------------------------------------------------------------------------
    function samePath(pathname) {
        const trim = (path) => String(path || '').replace(/\/+$/, '');
        return trim(pathname) == trim(location.pathname);
    }

    function softNavigated() {
        try {
            const doc = performance.getEntriesByType('navigation')[0];
            return doc ? !samePath(new URL(doc.name).pathname) : false;
        } catch (e) {
            return false;
        }
    }

    function similarURL(url) {
        if (!url) return false;
        try {
            const { pathname, search } = new URL(url, location.href);
            if (search && search != location.search) return false;
            return samePath(pathname);
        } catch (e) {
            return false;
        }
    }

    function canParseURL(url) {
        if (!url) return false;
        if (typeof URL.canParse === 'function') {
            try {
                return URL.canParse(url);
            } catch (e) {}
        }
        try {
            new URL(url);
            return true;
        } catch (e) {
            return false;
        }
    }

    function getMeta(...keys) {
        const selector = keys.map((key) => `meta[name="${key}"], meta[property="${key}"]`).join(', ');
        const nodes = [...document.querySelectorAll(selector)];
        const elem = nodes.at ? nodes.at(-1) : nodes[nodes.length - 1];
        const content = elem && (elem.content !== undefined ? elem.content : (elem.getAttribute && elem.getAttribute('content')));
        if (!elem || !content) return null;
        return String(content).trim().slice(0, 10000);
    }

    function getJsonLd() {
        let item = {};

        search:
        for (const elem of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const json = JSON.parse(elem.textContent);

                for (const one of Array.isArray(json) ? json : [json]) {
                    if (!one || !String(one['@context']).includes('schema.org')) continue;
                    if (one.url && !similarURL(one.url)) continue;
                    if (one['@id'] && canParseURL(one['@id']) && !similarURL(one['@id'])) continue;

                    if (one.name || one.headline) {
                        if (softNavigated() && !one.url && !(one['@id'] && canParseURL(one['@id']))) continue;
                        item = one;
                    } else if (Array.isArray(one['@graph'])) {
                        item = one['@graph'].find((graph) => graph && similarURL(graph.url)) || {};
                    }

                    if (Object.keys(item).length) break search;
                }
            } catch (e) {
                logDebug('Skipping malformed JSON-LD script block', { url: location.href, error: e });
            }
        }

        const img = [].concat(item.image || [])[0];
        item.image = { url: (img && img.url) || img };
        if (!item.image.url && Array.isArray(item.thumbnailUrl) && item.thumbnailUrl.length) {
            item.image = { url: item.thumbnailUrl[0] };
        }

        return item;
    }

    function grabImages() {
        const images = [];

        try {
            for (const img of document.querySelectorAll('img')) {
                if (images.length >= 9) break;
                const src = img.src || (img.getAttribute && img.getAttribute('src')) || '';
                if (!img.complete || !src || src.includes('.svg') || src.startsWith('data:image/svg+xml')) continue;
                if (!img.offsetParent) continue;
                if (typeof img.closest === 'function' && img.closest('header, footer, aside')) continue;

                const width = Math.min(img.naturalWidth || 0, img.width || 0);
                const height = Math.min(img.naturalHeight || 0, img.height || 0);

                if (width > 100 && height > 100) {
                    let url;
                    try {
                        url = new URL(img.currentSrc || src, location.href).href;
                    } catch (e) {
                        logDebug('Failed to resolve image URL', { src, url: location.href, error: e });
                    }
                    if (url) images.push(url);
                }
            }
        } catch (e) {
            logWarn('Failed to scan page images', { url: location.href, error: e });
        }

        return images;
    }

    function decodeHtmlEntities(str) {
        return String(str || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (full, entity) => {
            if (entity.startsWith('#x') || entity.startsWith('#X')) {
                const code = parseInt(entity.slice(2), 16);
                if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
                    try { return String.fromCodePoint(code); } catch (e) { return full; }
                }
                return full;
            }
            if (entity.startsWith('#')) {
                const code = parseInt(entity.slice(1), 10);
                if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
                    try { return String.fromCodePoint(code); } catch (e) { return full; }
                }
                return full;
            }
            return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, entity)
                ? HTML_ENTITIES[entity]
                : full;
        });
    }

    function htmlDecode(input) {
        const raw = input || '';
        if (!raw) return '';
        try {
            if (typeof DOMParser !== 'undefined') {
                const doc = new DOMParser().parseFromString(raw, 'text/html');
                if (doc && doc.documentElement) {
                    return doc.documentElement.textContent;
                }
            }
        } catch (e) {
            // Sites enforcing Trusted Types CSP (e.g., YouTube, GitHub) throw on DOMParser.parseFromString
            logDebug('DOMParser blocked or failed; using entity decode fallback', { url: location.href, error: e });
        }
        return decodeHtmlEntities(raw);
    }

    function getItem() {
        const trustMeta = !softNavigated()
            || similarURL(getMeta('twitter:url', 'og:url'))
            || getMeta('twitter:title', 'og:title') == String(document.title || '').trim();
        const meta = (...keys) => (trustMeta ? getMeta(...keys) : null);
        const ld = getJsonLd();

        const rawDocTitle = String(document.title || '');
        const strippedHost = escapeRegExp(String(location.hostname || '').replace('www.', ''));
        const hostPrefixRegex = strippedHost ? new RegExp(`^${strippedHost}.`, 'i') : null;
        const fallbackDocTitle = (hostPrefixRegex ? rawDocTitle.replace(hostPrefixRegex, '') : rawDocTitle).trim();

        const item = {
            link: location.href,
            title: meta('twitter:title', 'og:title')
                || meta('title')
                || htmlDecode(ld.name || ld.headline)
                || fallbackDocTitle,
            excerpt: meta('twitter:description', 'og:description')
                || meta('description')
                || htmlDecode(ld.description),
            cover: meta('twitter:image', 'twitter:image:src', 'og:image', 'og:image:src')
                || (ld.image && ld.image.url)
        };

        if (!item.title || /^home$/i.test(item.title)) {
            item.title = rawDocTitle;
        }

        if (item.excerpt == item.title) {
            item.excerpt = '';
        }

        if (item.cover) {
            try {
                item.cover = new URL(item.cover, location.href).href;
            } catch (e) {
                logWarn('Ignoring invalid meta cover URL', { cover: item.cover, url: location.href, error: e });
                delete item.cover;
            }
        }

        const images = [
            ...(item.cover ? [item.cover] : []),
            ...grabImages()
        ].filter((value, index, self) => self.indexOf(value) === index);

        if (images.length) {
            item.media = images.map((link) => ({
                type: 'image',
                link
            }));

            if (!item.cover) {
                item.cover = images[0];
            }
        }

        if (item.title) {
            item.title = item.title.slice(0, 1000);
        }

        if (item.excerpt) {
            item.excerpt = item.excerpt.slice(0, 10000);
        }

        for (const key in item) {
            if (!item[key]) {
                delete item[key];
            }
        }

        return item;
    }

    function extractPageMeta() {
        try {
            return getItem();
        } catch (e) {
            logWarn('Metadata extraction failed; falling back to URL and title', {
                url: typeof location !== 'undefined' ? location.href : '',
                error: e
            });
            return {
                link: location.href,
                title: document.title
            };
        }
    }

    // -------------------------------------------------------------------------
    // Thumbnail URL Formatting (mirrors thumb.js / screenshot.js / url.js)
    // -------------------------------------------------------------------------
    function normalizeThumbInput(s = '') {
        let val = '';
        try {
            val = String(s || '').trim();
        } catch (e) {
            val = '';
        }
        if (val.indexOf('data:') === 0) return '';
        if (val.indexOf('//') === 0) return 'http:' + val;
        if (val.indexOf('/') === 0) return APP_BASE_URL + val;
        return val;
    }

    function getThumbUri(url = '') {
        const finalURL = normalizeThumbInput(url);
        if (!finalURL) return '';
        if (finalURL.includes(WORKERS_BASE_URL) || finalURL.includes(LEGACY_WORKERS_BASE_URL)) {
            return finalURL.replace(/width=\d+/, 'a');
        }
        return `${RENDER_URL}/${encodeURIComponent(finalURL)}`;
    }

    function getScreenshotUri(url = '') {
        const val = String(url || '');
        if (val.includes(WORKERS_BASE_URL) || val.includes(LEGACY_WORKERS_BASE_URL)) {
            return val;
        }
        return `${RENDER_URL}/${encodeURIComponent(val)}`;
    }

    function getPreviewImageSrc(link, pageLink) {
        if (!link) return '';
        if (link === '<screenshot>') {
            return pageLink ? `${getScreenshotUri(pageLink)}?mode=crop&width=128&height=96` : '';
        }
        return link;
    }

    function getRdlFallbackSrc(link, pageLink) {
        if (!link) return '';
        if (link === '<screenshot>') {
            return pageLink ? `${getScreenshotUri(pageLink)}?mode=crop&width=128&height=96` : '';
        }
        const thumbUri = getThumbUri(link);
        return thumbUri ? `${thumbUri}?mode=crop&width=128&height=96` : '';
    }

    function fetchRdlBlobUrl(rdlUrl) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function' || !rdlUrl || !rdlUrl.startsWith(WORKERS_BASE_URL)) {
                reject(new Error('Blob fallback unavailable'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: rdlUrl,
                responseType: 'blob',
                timeout: API_TIMEOUT,
                onload(res) {
                    if (res.status >= 200 && res.status < 300 && res.response && typeof URL.createObjectURL === 'function') {
                        try {
                            resolve(URL.createObjectURL(res.response));
                            return;
                        } catch (e) {}
                    }
                    reject(new Error('Failed to load rdl blob'));
                },
                onerror() {
                    reject(new Error('Failed to load rdl blob'));
                },
                ontimeout() {
                    reject(new Error('Timeout loading rdl blob'));
                }
            });
        });
    }

    // -------------------------------------------------------------------------
    // Bookmark Normalization & Candidate Image Aggregation
    // -------------------------------------------------------------------------
    function getBookmarkCollectionId(item) {
        if (!item || typeof item !== 'object') return -1;
        const raw = item.collectionId !== undefined
            ? item.collectionId
            : (item.collection && item.collection.$id);
        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed !== 0 ? parsed : -1;
    }

    function getBookmarkDomainPreview(link) {
        try {
            const parsed = new URL(link);
            const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
            return `${parsed.hostname.replace(/^www\./, '')}${path}`;
        } catch (e) {
            return String(link || '');
        }
    }

    function normalizeTagsList(tags) {
        if (!Array.isArray(tags)) return [];
        const seen = new Set();
        const out = [];
        for (const raw of tags) {
            const clean = String(raw || '').trim();
            if (!clean || seen.has(clean)) continue;
            seen.add(clean);
            out.push(clean);
        }
        return out;
    }

    function parseTagInput(raw) {
        return normalizeTagsList(String(raw || '').split(','));
    }

    function mergeTags(existingTags, incomingTags) {
        return normalizeTagsList([
            ...normalizeTagsList(existingTags),
            ...normalizeTagsList(incomingTags)
        ]);
    }

    function buildCandidateImages(bookmark, cachedScrapedMeta) {
        const seen = new Set();
        const candidates = [];

        const pushLink = (raw) => {
            const link = typeof raw === 'string' ? raw.trim() : '';
            if (!link || seen.has(link)) return;
            seen.add(link);
            candidates.push(link);
        };

        if (bookmark) {
            pushLink(bookmark.cover);
            if (Array.isArray(bookmark.media)) {
                for (const m of bookmark.media) {
                    if (m && m.link) pushLink(m.link);
                }
            }
        }

        if (cachedScrapedMeta) {
            pushLink(cachedScrapedMeta.cover);
            if (Array.isArray(cachedScrapedMeta.media)) {
                for (const m of cachedScrapedMeta.media) {
                    if (m && m.link) pushLink(m.link);
                }
            }
        }

        const freshMeta = extractPageMeta();
        if (freshMeta) {
            pushLink(freshMeta.cover);
            if (Array.isArray(freshMeta.media)) {
                for (const m of freshMeta.media) {
                    if (m && m.link) pushLink(m.link);
                }
            }
        }

        return candidates;
    }

    // -------------------------------------------------------------------------
    // Top-Right Closed Shadow DOM Overlay UI (Progress -> Screen 1 -> Screen 2)
    // -------------------------------------------------------------------------
    const OVERLAY_CSS = `
        :host, * {
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        }
        .card {
            pointer-events: auto;
            width: 344px;
            max-width: calc(100vw - 32px);
            background: #ffffff;
            color: #1c1e21;
            border: 1px solid #eab308;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(15, 23, 42, 0.16);
            overflow: hidden;
            font-size: 13px;
            line-height: 1.4;
        }
        .card[data-screen="saving"] {
            width: auto;
            min-width: 210px;
            max-width: 300px;
        }
        .card[data-screen="picker"],
        .card[data-screen="settings"] {
            width: 344px;
        }
        @media (prefers-color-scheme: dark) {
            .card {
                background: #1d2025;
                color: #f1f3f5;
                border-color: #eab308;
                box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
            }
            .header {
                border-bottom-color: rgba(255, 255, 255, 0.08) !important;
            }
            .muted, .excerpt, .link-preview, .field-hint {
                color: #9aa4b2 !important;
            }
            .icon-btn {
                color: #cbd5e1 !important;
            }
            .icon-btn:hover {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            .thumb-btn {
                background: #2a2f37 !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
            }
            .thumb-option {
                background: #2a2f37 !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
            }
            .action-btn {
                background: rgba(255, 255, 255, 0.1) !important;
                color: #f1f3f5 !important;
            }
            .field-input, .field-textarea, .tag-input {
                background: #2a2f37 !important;
                color: #f1f3f5 !important;
                border-color: rgba(255, 255, 255, 0.16) !important;
            }
            .fav-btn {
                border-color: rgba(255, 255, 255, 0.16) !important;
                color: #cbd5e1 !important;
            }
            .fav-btn:hover:not(:disabled) {
                background: rgba(244, 63, 94, 0.16) !important;
                border-color: rgba(251, 113, 133, 0.4) !important;
                color: #fda4af !important;
            }
            .fav-btn[aria-pressed="true"] {
                background: rgba(244, 63, 94, 0.2) !important;
                border-color: rgba(251, 113, 133, 0.45) !important;
                color: #fb7185 !important;
            }
            .tags-section {
                border-top-color: rgba(255, 255, 255, 0.08) !important;
            }
            .tag-chip {
                background: rgba(56, 189, 248, 0.16) !important;
                color: #7dd3fc !important;
            }
            .tag-remove:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.14) !important;
            }
            .tag-add-btn {
                background: rgba(56, 189, 248, 0.18) !important;
                color: #7dd3fc !important;
            }
            .tag-add-btn:hover:not(:disabled) {
                background: rgba(56, 189, 248, 0.28) !important;
            }
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 9px 12px;
            border-bottom: 1px solid rgba(15, 23, 42, 0.08);
        }
        .card[data-screen="saving"] .header {
            border-bottom: none;
            padding: 10px 12px;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1;
        }
        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .status-saved { color: #16a34a; }
        .status-existing { color: #0284c7; }
        .status-error { color: #dc2626; }
        .status-info { color: inherit; }
        .icon-btn {
            appearance: none;
            border: none;
            background: transparent;
            color: #475569;
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            padding: 0;
            flex-shrink: 0;
        }
        .icon-btn:hover {
            background: rgba(15, 23, 42, 0.07);
        }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(12, 132, 228, 0.25);
            border-top-color: #0c84e4;
            border-radius: 50%;
            animation: rd-spin 0.75s linear infinite;
            flex-shrink: 0;
        }
        @keyframes rd-spin {
            to { transform: rotate(360deg); }
        }
        .body {
            padding: 12px;
        }
        .saved-row {
            display: flex;
            align-items: flex-start;
            gap: 11px;
        }
        .thumb-btn {
            position: relative;
            width: 78px;
            height: 60px;
            flex-shrink: 0;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid rgba(15, 23, 42, 0.12);
            background: #f1f5f9;
            padding: 0;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .thumb-btn:hover .thumb-badge {
            opacity: 1;
        }
        .thumb-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }
        .thumb-placeholder {
            font-size: 11px;
            color: #64748b;
            text-align: center;
            padding: 4px;
        }
        .thumb-badge {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(15, 23, 42, 0.72);
            color: #ffffff;
            font-size: 10px;
            font-weight: 600;
            text-align: center;
            padding: 2px 4px;
            opacity: 0.88;
            transition: opacity 0.15s ease;
        }
        .details {
            min-width: 0;
            flex: 1;
        }
        .title {
            font-weight: 600;
            font-size: 13px;
            margin: 0 0 3px 0;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            word-break: break-word;
        }
        .link-preview {
            font-size: 11px;
            color: #64748b;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 4px;
        }
        .excerpt {
            font-size: 12px;
            color: #475569;
            margin: 0 0 6px 0;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            word-break: break-word;
        }
        .footer-links {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 10px;
            font-size: 11.5px;
        }
        .open-link {
            color: #0284c7;
            text-decoration: none;
            font-weight: 500;
        }
        .open-link:hover {
            text-decoration: underline;
        }
        .fav-btn {
            appearance: none;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 8px;
            border-radius: 999px;
            border: 1px solid rgba(15, 23, 42, 0.14);
            background: transparent;
            color: #475569;
            font-size: 11.5px;
            font-weight: 600;
            line-height: 1.25;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }
        .fav-btn:hover:not(:disabled) {
            background: rgba(225, 29, 72, 0.08);
            border-color: rgba(225, 29, 72, 0.35);
            color: #be123c;
        }
        .fav-btn[aria-pressed="true"] {
            background: rgba(225, 29, 72, 0.12);
            border-color: rgba(225, 29, 72, 0.35);
            color: #e11d48;
        }
        .fav-btn:disabled {
            cursor: wait;
            opacity: 0.65;
        }
        .tags-section {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid rgba(15, 23, 42, 0.08);
        }
        .tags-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
            margin-bottom: 7px;
        }
        .tag-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            max-width: 100%;
            padding: 2px 6px 2px 8px;
            border-radius: 999px;
            background: rgba(12, 132, 228, 0.1);
            color: #0369a1;
            font-size: 11.5px;
            font-weight: 500;
            line-height: 1.3;
        }
        .tag-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .tag-remove {
            appearance: none;
            border: none;
            background: transparent;
            color: inherit;
            opacity: 0.7;
            cursor: pointer;
            padding: 0 2px;
            font-size: 13px;
            line-height: 1;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .tag-remove:hover:not(:disabled) {
            opacity: 1;
            background: rgba(15, 23, 42, 0.1);
        }
        .tag-remove:disabled {
            cursor: wait;
            opacity: 0.45;
        }
        .tags-input-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .tag-input {
            flex: 1;
            min-width: 0;
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid rgba(15, 23, 42, 0.16);
            border-radius: 6px;
            background: #ffffff;
            color: #1c1e21;
            font-family: inherit;
        }
        .tag-input:focus {
            outline: none;
            border-color: #0c84e4;
            box-shadow: 0 0 0 2px rgba(12, 132, 228, 0.18);
        }
        .tag-add-btn {
            appearance: none;
            border: none;
            border-radius: 6px;
            width: 28px;
            height: 28px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: rgba(12, 132, 228, 0.12);
            color: #0369a1;
            font-size: 16px;
            font-weight: 600;
            line-height: 1;
            cursor: pointer;
            padding: 0;
            flex-shrink: 0;
        }
        .tag-add-btn:hover:not(:disabled) {
            background: rgba(12, 132, 228, 0.22);
        }
        .tag-add-btn:disabled {
            cursor: wait;
            opacity: 0.65;
        }
        .grid-wrap {
            max-height: 270px;
            overflow-y: auto;
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
        }
        .thumb-option {
            position: relative;
            height: 68px;
            padding: 0;
            border-radius: 8px;
            border: 2px solid rgba(15, 23, 42, 0.12);
            background: #f1f5f9;
            overflow: hidden;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .thumb-option:hover:not(:disabled) {
            border-color: #0284c7;
        }
        .thumb-option[aria-pressed="true"] {
            border-color: #0c84e4;
            box-shadow: 0 0 0 2px rgba(12, 132, 228, 0.25);
        }
        .thumb-option:disabled {
            cursor: wait;
            opacity: 0.7;
        }
        .thumb-option img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }
        .tile-spinner {
            position: absolute;
            inset: 0;
            background: rgba(15, 23, 42, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .error-banner {
            margin-top: 8px;
            padding: 6px 8px;
            border-radius: 6px;
            background: rgba(220, 38, 38, 0.12);
            color: #dc2626;
            font-size: 12px;
        }
        .error-msg {
            margin: 0 0 10px 0;
            word-break: break-word;
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        .action-btn {
            appearance: none;
            border: none;
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            background: rgba(12, 132, 228, 0.12);
            color: #0369a1;
        }
        .action-btn:hover {
            background: rgba(12, 132, 228, 0.2);
        }
        .action-btn.primary {
            background: #0c84e4;
            color: #ffffff !important;
        }
        .action-btn.primary:hover {
            background: #0272cc;
        }
        .header-actions {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
        }
        .settings-body {
            max-height: 75vh;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .toggle-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .check-label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
        }
        .field {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .field-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .field-label {
            font-size: 11.5px;
            font-weight: 600;
        }
        .field-hint {
            font-size: 11px;
            color: #64748b;
        }
        .input-inline {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .field-input, .field-textarea {
            width: 100%;
            min-width: 0;
            padding: 6px 8px;
            font-size: 12px;
            border: 1px solid rgba(15, 23, 42, 0.16);
            border-radius: 6px;
            background: #ffffff;
            color: #1c1e21;
            font-family: inherit;
        }
        .field-textarea {
            resize: vertical;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
            line-height: 1.35;
        }
        .success-banner {
            padding: 6px 8px;
            border-radius: 6px;
            background: rgba(22, 163, 74, 0.14);
            color: #15803d;
            font-size: 12px;
            font-weight: 500;
        }
        .muted {
            color: #64748b;
            font-size: 12px;
            margin: 0;
        }
    `;

    function createOverlayUI(callbacks) {
        let host = null;
        let shadow = null;
        let styleEl = null;
        let rootEl = null;
        let dismissTimer = null;
        let pickerOpened = false;
        let autoHideCancelledPermanently = false;
        let isHovered = false;
        let isTagInputFocused = false;
        let activeScreen = 'idle';
        let currentBookmark = null;
        let currentWasExisting = false;
        let currentCandidates = [];
        let isUpdatingThumb = false;
        let isUpdatingFavorite = false;
        let pendingTagOps = 0;
        let renderEpoch = 0;
        let returnView = { type: 'none' };
        const objectUrls = new Set();

        function revokeObjectUrls() {
            if (typeof URL.revokeObjectURL !== 'function') {
                objectUrls.clear();
                return;
            }
            for (const url of objectUrls) {
                try { URL.revokeObjectURL(url); } catch (e) {}
            }
            objectUrls.clear();
        }

        function clearDismissTimer() {
            if (dismissTimer !== null) {
                clearTimeout(dismissTimer);
                dismissTimer = null;
            }
        }

        function scheduleAutoDismiss() {
            clearDismissTimer();
            if (
                autoHideCancelledPermanently ||
                pickerOpened ||
                isHovered ||
                isTagInputFocused ||
                isUpdatingFavorite ||
                pendingTagOps > 0
            ) {
                return;
            }
            if (activeScreen !== 'saved' && activeScreen !== 'existing') return;
            const timeoutMs = getOverlayTimeoutMs();
            if (timeoutMs <= 0) return;
            dismissTimer = setTimeout(() => {
                hide();
            }, timeoutMs);
        }

        function ensureMounted() {
            const connected = host && (host.isConnected === true || (host.isConnected === undefined && host.parentNode));
            if (connected) return;

            const container = document.documentElement || document.body;
            if (host && shadow && rootEl) {
                if (container) container.appendChild(host);
                return;
            }

            host = document.createElement('div');
            host.setAttribute('data-raindrop-autosave-overlay', 'true');
            host.style.cssText = 'all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; pointer-events: none;';

            shadow = host.attachShadow({ mode: 'closed' });

            styleEl = document.createElement('style');
            styleEl.textContent = OVERLAY_CSS;
            shadow.appendChild(styleEl);

            rootEl = document.createElement('div');
            shadow.appendChild(rootEl);

            if (container) {
                container.appendChild(host);
            }
        }

        function clearRoot() {
            revokeObjectUrls();
            if (!rootEl) return;
            while (rootEl.firstChild) {
                rootEl.removeChild(rootEl.firstChild);
            }
        }

        function el(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined && text !== null) node.textContent = String(text);
            return node;
        }

        function attachImageWithFallback(imgEl, rawLink, pageLink, onFinalFail) {
            const primarySrc = getPreviewImageSrc(rawLink, pageLink);
            if (!primarySrc) {
                if (typeof onFinalFail === 'function') onFinalFail();
                return;
            }

            let triedFallback = false;
            imgEl.src = primarySrc;
            imgEl.addEventListener('error', async () => {
                if (triedFallback) {
                    if (typeof onFinalFail === 'function') onFinalFail();
                    return;
                }
                triedFallback = true;

                const rdlSrc = primarySrc.startsWith(WORKERS_BASE_URL)
                    ? primarySrc
                    : getRdlFallbackSrc(rawLink, pageLink);

                if (rdlSrc) {
                    try {
                        const blobUrl = await fetchRdlBlobUrl(rdlSrc);
                        objectUrls.add(blobUrl);
                        imgEl.src = blobUrl;
                        return;
                    } catch (e) {
                        logWarn('Thumbnail rdl.ink blob fallback failed', { url: rdlSrc, pageUrl: pageLink, error: e });
                    }
                }

                if (typeof onFinalFail === 'function') onFinalFail();
            });
        }

        function buildCard(screenName) {
            ensureMounted();
            clearRoot();
            isTagInputFocused = false;
            isUpdatingFavorite = false;
            pendingTagOps = 0;
            renderEpoch++;
            activeScreen = screenName;

            const card = el('div', 'card');
            card.setAttribute('data-screen', screenName);
            card.addEventListener('mouseenter', () => {
                isHovered = true;
                clearDismissTimer();
            });
            card.addEventListener('mouseleave', () => {
                isHovered = false;
                scheduleAutoDismiss();
            });

            rootEl.appendChild(card);
            return card;
        }

        function buildCloseBtn() {
            const btn = el('button', 'icon-btn', '×');
            btn.type = 'button';
            btn.setAttribute('data-role', 'close-btn');
            btn.setAttribute('aria-label', 'Close');
            btn.title = 'Close';
            btn.addEventListener('click', () => hide());
            return btn;
        }

        function buildSettingsBtn() {
            const btn = el('button', 'icon-btn', '⚙');
            btn.type = 'button';
            btn.setAttribute('data-role', 'settings-btn');
            btn.setAttribute('aria-label', 'Settings');
            btn.title = 'Settings';
            btn.addEventListener('click', () => showSettings());
            return btn;
        }

        function buildHeaderActions({ includeSettings = true } = {}) {
            const wrap = el('div', 'header-actions');
            if (includeSettings) wrap.appendChild(buildSettingsBtn());
            wrap.appendChild(buildCloseBtn());
            return wrap;
        }

        function restoreReturnView() {
            const target = returnView;
            activeScreen = 'idle';
            if (!target || target.type === 'none') {
                hide();
                return;
            }
            if (target.type === 'saved' || target.type === 'existing') {
                showSaved(target.bookmark, {
                    existing: target.type === 'existing',
                    candidates: target.candidates
                });
                return;
            }
            if (target.type === 'error') {
                showError(target.err, target.url);
                return;
            }
            if (target.type === 'saving') {
                showSaving(target.text);
                return;
            }
            hide();
        }

        function showSaving(text = 'Saving to Raindrop…') {
            pickerOpened = false;
            autoHideCancelledPermanently = false;
            clearDismissTimer();
            returnView = { type: 'saving', text };

            const card = buildCard('saving');
            const header = el('div', 'header');
            const left = el('div', 'header-left');
            left.appendChild(el('span', 'spinner'));
            const status = el('span', 'status-pill status-info', text);
            status.setAttribute('data-role', 'status');
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildHeaderActions());
            card.appendChild(header);
        }

        function showNotice(text) {
            pickerOpened = false;
            returnView = { type: 'none' };
            const card = buildCard('saving');
            const header = el('div', 'header');
            const left = el('div', 'header-left');
            const status = el('span', 'status-pill status-info', text);
            status.setAttribute('data-role', 'status');
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildHeaderActions());
            card.appendChild(header);

            clearDismissTimer();
            const timeoutMs = getOverlayTimeoutMs();
            if (timeoutMs > 0) {
                dismissTimer = setTimeout(() => hide(), Math.min(timeoutMs, 3500));
            }
        }

        function showSaved(bookmark, { existing = false, candidates = [], forceRender = false } = {}) {
            currentBookmark = bookmark;
            currentWasExisting = existing;
            currentCandidates = Array.isArray(candidates) ? candidates : [];
            pickerOpened = false;
            isUpdatingThumb = false;

            const screenName = existing ? 'existing' : 'saved';
            returnView = {
                type: screenName,
                bookmark: currentBookmark,
                candidates: currentCandidates
            };

            // Avoid interrupting active Settings editing if a background save finishes
            if (activeScreen === 'settings' && !forceRender) return;

            const card = buildCard(screenName);
            const cardEpoch = renderEpoch;

            const header = el('div', 'header');
            const left = el('div', 'header-left');
            const statusText = existing ? '✓ Already saved' : '✓ Saved';
            const status = el('span', `status-pill ${existing ? 'status-existing' : 'status-saved'}`, statusText);
            status.setAttribute('data-role', 'status');
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildHeaderActions());
            card.appendChild(header);

            const body = el('div', 'body');
            const row = el('div', 'saved-row');

            const thumbBtn = el('button', 'thumb-btn');
            thumbBtn.type = 'button';
            thumbBtn.setAttribute('data-role', 'thumb-btn');
            thumbBtn.title = 'Click to pick another thumbnail';

            const renderPlaceholder = () => {
                while (thumbBtn.firstChild) thumbBtn.removeChild(thumbBtn.firstChild);
                thumbBtn.appendChild(el('span', 'thumb-placeholder', 'No cover'));
                thumbBtn.appendChild(el('span', 'thumb-badge', 'Change'));
            };

            if (bookmark && bookmark.cover) {
                const img = el('img', 'thumb-img');
                img.setAttribute('data-role', 'thumb-img');
                img.alt = '';
                attachImageWithFallback(img, bookmark.cover, bookmark.link, renderPlaceholder);
                thumbBtn.appendChild(img);
                thumbBtn.appendChild(el('span', 'thumb-badge', 'Change'));
            } else {
                renderPlaceholder();
            }

            thumbBtn.addEventListener('click', () => {
                pickerOpened = true;
                autoHideCancelledPermanently = true;
                clearDismissTimer();
                const latestCandidates = typeof callbacks.getCandidates === 'function'
                    ? callbacks.getCandidates(currentBookmark)
                    : currentCandidates;
                showPicker(currentBookmark, latestCandidates);
            });

            const details = el('div', 'details');
            const titleEl = el('div', 'title', (bookmark && bookmark.title) || (bookmark && bookmark.link) || 'Saved bookmark');
            titleEl.setAttribute('data-role', 'title');
            details.appendChild(titleEl);

            const previewEl = el('div', 'link-preview', getBookmarkDomainPreview(bookmark && bookmark.link));
            previewEl.setAttribute('data-role', 'link-preview');
            details.appendChild(previewEl);

            if (bookmark && bookmark.excerpt) {
                const excerptEl = el('p', 'excerpt', bookmark.excerpt);
                excerptEl.setAttribute('data-role', 'excerpt');
                details.appendChild(excerptEl);
            }

            const actionErrEl = el('div', 'error-banner');
            actionErrEl.setAttribute('data-role', 'action-error');
            actionErrEl.style.display = 'none';

            const showActionError = (msg) => {
                actionErrEl.textContent = msg;
                actionErrEl.style.display = 'block';
            };

            const hideActionError = () => {
                actionErrEl.textContent = '';
                actionErrEl.style.display = 'none';
            };

            if (bookmark && bookmark._id) {
                const footer = el('div', 'footer-links');

                const favBtn = el('button', 'fav-btn');
                favBtn.type = 'button';
                favBtn.setAttribute('data-role', 'favorite-btn');

                const syncFavoriteButton = () => {
                    const isFav = Boolean(currentBookmark && currentBookmark.important);
                    favBtn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
                    favBtn.setAttribute('aria-busy', isUpdatingFavorite ? 'true' : 'false');
                    favBtn.disabled = isUpdatingFavorite;
                    favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
                    favBtn.textContent = isFav ? '♥ Favorited' : '♡ Favorite';
                };

                syncFavoriteButton();

                favBtn.addEventListener('click', async () => {
                    if (isUpdatingFavorite || !currentBookmark || !currentBookmark._id) return;
                    isUpdatingFavorite = true;
                    clearDismissTimer();
                    hideActionError();
                    syncFavoriteButton();

                    try {
                        const updated = await callbacks.onToggleFavorite(currentBookmark);
                        if (cardEpoch !== renderEpoch) return;
                        currentBookmark = updated || currentBookmark;
                        if (returnView && (returnView.type === 'saved' || returnView.type === 'existing')) {
                            returnView.bookmark = currentBookmark;
                        }
                    } catch (err) {
                        logError('Failed to toggle favorite', {
                            url: currentBookmark && currentBookmark.link,
                            bookmarkId: currentBookmark && currentBookmark._id,
                            error: err
                        });
                        if (cardEpoch !== renderEpoch) return;
                        showActionError((err && err.message) || 'Failed to update favorite status.');
                    } finally {
                        if (cardEpoch === renderEpoch) {
                            isUpdatingFavorite = false;
                            syncFavoriteButton();
                            scheduleAutoDismiss();
                        }
                    }
                });

                const openLink = el('a', 'open-link', 'Open in Raindrop ↗');
                openLink.setAttribute('data-role', 'open-link');
                const cid = getBookmarkCollectionId(bookmark);
                openLink.href = `${APP_BASE_URL}/my/${cid}/item/${encodeURIComponent(bookmark._id)}/edit`;
                openLink.target = '_blank';
                openLink.rel = 'noopener noreferrer';

                footer.appendChild(favBtn);
                footer.appendChild(openLink);
                details.appendChild(footer);
            }

            row.appendChild(thumbBtn);
            row.appendChild(details);
            body.appendChild(row);

            if (bookmark && bookmark._id) {
                const tagsSection = el('div', 'tags-section');
                tagsSection.setAttribute('data-role', 'tags-section');

                const chipsWrap = el('div', 'tags-chips');
                chipsWrap.setAttribute('data-role', 'tags-list');

                const inputRow = el('div', 'tags-input-row');
                const tagInput = el('input', 'tag-input');
                tagInput.type = 'text';
                tagInput.autocomplete = 'off';
                tagInput.autocapitalize = 'none';
                tagInput.spellcheck = false;
                tagInput.placeholder = 'Add tags (comma-separated)…';
                tagInput.setAttribute('data-role', 'tag-input');
                tagInput.setAttribute('aria-label', 'Add tags');

                const addTagBtn = el('button', 'tag-add-btn', '+');
                addTagBtn.type = 'button';
                addTagBtn.setAttribute('data-role', 'tag-add-btn');
                addTagBtn.setAttribute('aria-label', 'Add tags');
                addTagBtn.title = 'Add tags (Enter or comma)';

                const syncTagControlsBusy = () => {
                    const busy = pendingTagOps > 0;
                    addTagBtn.disabled = busy;
                    addTagBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
                    addTagBtn.textContent = busy ? '…' : '+';
                };

                const syncTagChips = () => {
                    while (chipsWrap.firstChild) {
                        chipsWrap.removeChild(chipsWrap.firstChild);
                    }
                    const tags = normalizeTagsList(currentBookmark && currentBookmark.tags);
                    if (!tags.length) {
                        chipsWrap.style.display = 'none';
                        return;
                    }
                    chipsWrap.style.display = 'flex';
                    for (const tag of tags) {
                        const chip = el('span', 'tag-chip');
                        chip.setAttribute('data-role', 'tag-chip');
                        chip.setAttribute('data-tag', tag);
                        chip.appendChild(el('span', 'tag-label', tag));

                        const removeBtn = el('button', 'tag-remove', '×');
                        removeBtn.type = 'button';
                        removeBtn.setAttribute('data-role', 'tag-remove-btn');
                        removeBtn.setAttribute('aria-label', `Remove tag ${tag}`);
                        removeBtn.title = `Remove "${tag}"`;

                        removeBtn.addEventListener('click', async () => {
                            if (!currentBookmark || !currentBookmark._id) return;
                            removeBtn.disabled = true;
                            pendingTagOps++;
                            clearDismissTimer();
                            hideActionError();
                            syncTagControlsBusy();

                            try {
                                const updated = await callbacks.onRemoveTag(currentBookmark, tag);
                                if (cardEpoch !== renderEpoch) return;
                                currentBookmark = updated || currentBookmark;
                                if (returnView && (returnView.type === 'saved' || returnView.type === 'existing')) {
                                    returnView.bookmark = currentBookmark;
                                }
                                syncTagChips();
                            } catch (err) {
                                logError('Failed to remove tag', {
                                    url: currentBookmark && currentBookmark.link,
                                    bookmarkId: currentBookmark && currentBookmark._id,
                                    tag,
                                    error: err
                                });
                                if (cardEpoch !== renderEpoch) return;
                                removeBtn.disabled = false;
                                showActionError((err && err.message) || 'Failed to remove tag.');
                            } finally {
                                if (cardEpoch === renderEpoch) {
                                    pendingTagOps = Math.max(0, pendingTagOps - 1);
                                    syncTagControlsBusy();
                                    scheduleAutoDismiss();
                                }
                            }
                        });

                        chip.appendChild(removeBtn);
                        chipsWrap.appendChild(chip);
                    }
                };

                const submitTagInput = async () => {
                    if (!currentBookmark || !currentBookmark._id) return;
                    const parsed = parseTagInput(tagInput.value);
                    tagInput.value = '';
                    if (!parsed.length) return;

                    const existingTags = normalizeTagsList(currentBookmark.tags);
                    const merged = mergeTags(existingTags, parsed);
                    if (merged.length === existingTags.length) {
                        hideActionError();
                        scheduleAutoDismiss();
                        return;
                    }

                    pendingTagOps++;
                    clearDismissTimer();
                    hideActionError();
                    syncTagControlsBusy();

                    try {
                        const updated = await callbacks.onAddTags(currentBookmark, parsed);
                        if (cardEpoch !== renderEpoch) return;
                        currentBookmark = updated || currentBookmark;
                        if (returnView && (returnView.type === 'saved' || returnView.type === 'existing')) {
                            returnView.bookmark = currentBookmark;
                        }
                        syncTagChips();
                    } catch (err) {
                        logError('Failed to add tags', {
                            url: currentBookmark && currentBookmark.link,
                            bookmarkId: currentBookmark && currentBookmark._id,
                            tags: parsed,
                            error: err
                        });
                        if (cardEpoch !== renderEpoch) return;
                        if (!tagInput.value.trim()) {
                            tagInput.value = parsed.join(', ');
                        }
                        showActionError((err && err.message) || 'Failed to add tags.');
                    } finally {
                        if (cardEpoch === renderEpoch) {
                            pendingTagOps = Math.max(0, pendingTagOps - 1);
                            syncTagControlsBusy();
                            scheduleAutoDismiss();
                        }
                    }
                };

                tagInput.addEventListener('focus', () => {
                    isTagInputFocused = true;
                    clearDismissTimer();
                });

                tagInput.addEventListener('blur', () => {
                    isTagInputFocused = false;
                    scheduleAutoDismiss();
                });

                tagInput.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        submitTagInput();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        tagInput.blur();
                    }
                });

                tagInput.addEventListener('keyup', (e) => e.stopPropagation());
                tagInput.addEventListener('keypress', (e) => e.stopPropagation());

                tagInput.addEventListener('input', () => {
                    if (tagInput.value.endsWith(',')) {
                        submitTagInput();
                    }
                });

                addTagBtn.addEventListener('click', () => {
                    if (!tagInput.value.trim()) {
                        tagInput.focus();
                        return;
                    }
                    submitTagInput();
                });

                syncTagChips();
                inputRow.appendChild(tagInput);
                inputRow.appendChild(addTagBtn);
                tagsSection.appendChild(chipsWrap);
                tagsSection.appendChild(inputRow);
                tagsSection.appendChild(actionErrEl);
                body.appendChild(tagsSection);
            }

            card.appendChild(body);

            scheduleAutoDismiss();
        }

        function showPicker(bookmark, candidates, pickerErrorMsg = '') {
            currentBookmark = bookmark;
            currentCandidates = Array.isArray(candidates) ? candidates : [];
            pickerOpened = true;
            autoHideCancelledPermanently = true;
            clearDismissTimer();

            const card = buildCard('picker');

            const header = el('div', 'header');
            const left = el('div', 'header-left');

            const backBtn = el('button', 'icon-btn', '←');
            backBtn.type = 'button';
            backBtn.setAttribute('data-role', 'back-btn');
            backBtn.setAttribute('aria-label', 'Back');
            backBtn.title = 'Back';
            backBtn.addEventListener('click', () => {
                showSaved(currentBookmark, {
                    existing: currentWasExisting,
                    candidates: currentCandidates
                });
            });

            const status = el('span', 'status-pill status-info', 'Pick thumbnail');
            status.setAttribute('data-role', 'status');

            left.appendChild(backBtn);
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildCloseBtn());
            card.appendChild(header);

            const body = el('div', 'body');

            if (!currentCandidates.length) {
                body.appendChild(el('p', 'muted', 'No candidate thumbnails found on this page.'));
            } else {
                const grid = el('div', 'grid-wrap');
                grid.setAttribute('data-role', 'thumb-grid');
                const optionButtons = [];

                for (const link of currentCandidates) {
                    const optionBtn = el('button', 'thumb-option');
                    optionBtn.type = 'button';
                    optionBtn.setAttribute('data-role', 'thumb-option');
                    optionBtn.setAttribute('data-link', link);
                    const isSelected = Boolean(currentBookmark && currentBookmark.cover === link);
                    optionBtn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
                    optionBtn.title = link;

                    const img = el('img');
                    img.alt = '';
                    attachImageWithFallback(img, link, currentBookmark && currentBookmark.link, () => {
                        img.remove();
                        optionBtn.appendChild(el('span', 'thumb-placeholder', 'Broken'));
                    });
                    optionBtn.appendChild(img);

                    optionBtn.addEventListener('click', async () => {
                        if (isUpdatingThumb) return;
                        isUpdatingThumb = true;

                        for (const btn of optionButtons) {
                            btn.disabled = true;
                        }
                        const spinnerWrap = el('div', 'tile-spinner');
                        spinnerWrap.appendChild(el('span', 'spinner'));
                        optionBtn.appendChild(spinnerWrap);

                        try {
                            const updated = await callbacks.onSelectThumbnail(currentBookmark, link);
                            currentBookmark = updated || currentBookmark;
                            showSaved(currentBookmark, {
                                existing: currentWasExisting,
                                candidates: currentCandidates
                            });
                        } catch (err) {
                            logError('Failed to update thumbnail', {
                                url: currentBookmark && currentBookmark.link,
                                bookmarkId: currentBookmark && currentBookmark._id,
                                candidateLink: link,
                                error: err
                            });
                            isUpdatingThumb = false;
                            showPicker(
                                currentBookmark,
                                currentCandidates,
                                (err && err.message) || 'Failed to update thumbnail'
                            );
                        }
                    });

                    optionButtons.push(optionBtn);
                    grid.appendChild(optionBtn);
                }

                body.appendChild(grid);
            }

            if (pickerErrorMsg) {
                const errEl = el('div', 'error-banner', pickerErrorMsg);
                errEl.setAttribute('data-role', 'picker-error');
                body.appendChild(errEl);
            }

            card.appendChild(body);
        }

        function showError(err, url) {
            pickerOpened = false;
            clearDismissTimer();
            returnView = { type: 'error', err, url };

            if (activeScreen === 'settings') return;

            const isAuth = Boolean(err && err.status === 401);
            const card = buildCard('error');

            const header = el('div', 'header');
            const left = el('div', 'header-left');
            const status = el(
                'span',
                'status-pill status-error',
                isAuth ? 'Raindrop auth required' : 'Raindrop save error'
            );
            status.setAttribute('data-role', 'status');
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildHeaderActions());
            card.appendChild(header);

            const body = el('div', 'body');
            const msg = isAuth
                ? 'Auth required — click to set your Raindrop API token or sign in on app.raindrop.io.'
                : ((err && err.message) || 'Failed to save URL to Raindrop.');
            const msgEl = el('p', 'error-msg', msg);
            msgEl.setAttribute('data-role', 'error-message');
            body.appendChild(msgEl);

            const actions = el('div', 'actions');

            if (isAuth) {
                const tokenBtn = el('button', 'action-btn', 'Auth required — click to set API token');
                tokenBtn.type = 'button';
                tokenBtn.setAttribute('data-role', 'auth-token-btn');
                tokenBtn.addEventListener('click', () => {
                    showSettings({ focusToken: true });
                });
                actions.appendChild(tokenBtn);

                const loginLink = el('a', 'open-link', 'Sign in ↗');
                loginLink.href = `${APP_BASE_URL}/account/login`;
                loginLink.target = '_blank';
                loginLink.rel = 'noopener noreferrer';
                actions.appendChild(loginLink);
            } else {
                const retryBtn = el('button', 'action-btn', 'Retry');
                retryBtn.type = 'button';
                retryBtn.setAttribute('data-role', 'retry-btn');
                retryBtn.addEventListener('click', () => {
                    callbacks.onRetry(url);
                });
                actions.appendChild(retryBtn);
            }

            body.appendChild(actions);
            card.appendChild(body);
        }

        function showSettings({ focusToken = false, feedback = '', feedbackKind = '' } = {}) {
            pickerOpened = false;
            clearDismissTimer();

            const wasErrorAuth = Boolean(returnView && returnView.type === 'error' && returnView.err && returnView.err.status === 401);
            const errorRetryUrl = returnView && returnView.type === 'error' ? returnView.url : '';
            const card = buildCard('settings');

            const header = el('div', 'header');
            const left = el('div', 'header-left');

            const backBtn = el('button', 'icon-btn', '←');
            backBtn.type = 'button';
            backBtn.setAttribute('data-role', 'back-btn');
            backBtn.setAttribute('aria-label', 'Back');
            backBtn.title = 'Back';
            backBtn.addEventListener('click', () => restoreReturnView());

            const status = el('span', 'status-pill status-info', 'Raindrop Settings');
            status.setAttribute('data-role', 'status');

            left.appendChild(backBtn);
            left.appendChild(status);
            header.appendChild(left);
            header.appendChild(buildCloseBtn());
            card.appendChild(header);

            const body = el('div', 'body settings-body');
            const form = el('form', 'settings-body');
            form.setAttribute('data-role', 'settings-form');

            // 1. Auto-save & Debug toggles
            const toggleRow = el('div', 'toggle-row');

            const enabledLabel = el('label', 'check-label');
            const enabledInput = el('input');
            enabledInput.type = 'checkbox';
            enabledInput.checked = isEnabled();
            enabledInput.setAttribute('data-role', 'setting-enabled');
            enabledLabel.appendChild(enabledInput);
            enabledLabel.appendChild(el('span', '', 'Auto-save enabled'));

            const debugLabel = el('label', 'check-label');
            const debugInput = el('input');
            debugInput.type = 'checkbox';
            debugInput.checked = isDebugEnabled();
            debugInput.setAttribute('data-role', 'setting-debug');
            debugLabel.appendChild(debugInput);
            debugLabel.appendChild(el('span', '', 'Debug logs'));

            toggleRow.appendChild(enabledLabel);
            toggleRow.appendChild(debugLabel);
            form.appendChild(toggleRow);

            // 2. API Test Token
            const hasToken = Boolean(getToken());
            let clearTokenRequested = false;

            const tokenField = el('div', 'field');
            tokenField.appendChild(el('label', 'field-label', 'API Test Token'));
            const tokenHint = el(
                'span',
                'field-hint',
                hasToken ? 'Token configured (leave blank to keep).' : 'Not set (using cookie auth fallback).'
            );
            tokenHint.setAttribute('data-role', 'token-hint');

            const tokenRow = el('div', 'input-inline');
            const tokenInput = el('input', 'field-input');
            tokenInput.type = 'password';
            tokenInput.autocomplete = 'off';
            tokenInput.value = '';
            tokenInput.placeholder = hasToken ? '•••••••• (unchanged)' : 'Paste Raindrop test token…';
            tokenInput.setAttribute('data-role', 'setting-token');
            tokenInput.addEventListener('input', () => {
                if (tokenInput.value.trim()) {
                    clearTokenRequested = false;
                    tokenHint.textContent = 'New token will be saved.';
                }
            });

            const clearTokenBtn = el('button', 'action-btn', 'Clear');
            clearTokenBtn.type = 'button';
            clearTokenBtn.setAttribute('data-role', 'clear-token-btn');
            clearTokenBtn.disabled = !hasToken;
            clearTokenBtn.addEventListener('click', () => {
                clearTokenRequested = true;
                tokenInput.value = '';
                tokenHint.textContent = 'Token will be cleared on Save (cookie auth mode).';
            });

            tokenRow.appendChild(tokenInput);
            tokenRow.appendChild(clearTokenBtn);
            tokenField.appendChild(tokenRow);
            tokenField.appendChild(tokenHint);
            form.appendChild(tokenField);

            // 3. Target Collection ID & Delays
            const colField = el('div', 'field');
            colField.appendChild(el('label', 'field-label', 'Target Collection ID'));
            const colInput = el('input', 'field-input');
            colInput.type = 'text';
            colInput.value = getConfiguredCollectionId();
            colInput.placeholder = 'auto, -1 (Unsorted), or numeric ID';
            colInput.setAttribute('data-role', 'setting-collection');
            colField.appendChild(colInput);
            form.appendChild(colField);

            const delayRow = el('div', 'field-row');

            const timeoutField = el('div', 'field');
            timeoutField.appendChild(el('label', 'field-label', 'Auto-Hide (ms)'));
            const timeoutInput = el('input', 'field-input');
            timeoutInput.type = 'number';
            timeoutInput.min = '0';
            timeoutInput.step = '500';
            timeoutInput.value = String(getOverlayTimeoutMs());
            timeoutInput.setAttribute('data-role', 'setting-timeout');
            timeoutField.appendChild(timeoutInput);

            const spaField = el('div', 'field');
            spaField.appendChild(el('label', 'field-label', 'SPA Delay (ms)'));
            const spaInput = el('input', 'field-input');
            spaInput.type = 'number';
            spaInput.min = '0';
            spaInput.step = '100';
            spaInput.value = String(getSpaDelayMs());
            spaInput.setAttribute('data-role', 'setting-spa-delay');
            spaField.appendChild(spaInput);

            delayRow.appendChild(timeoutField);
            delayRow.appendChild(spaField);
            form.appendChild(delayRow);

            // 4. Excluded URL Patterns
            const excludesField = el('div', 'field');
            excludesField.appendChild(el('label', 'field-label', 'Excluded URL Patterns (one per line)'));
            const excludesInput = el('textarea', 'field-textarea');
            excludesInput.rows = 3;
            excludesInput.value = getExcludes().join('\n');
            excludesInput.setAttribute('data-role', 'setting-excludes');
            excludesField.appendChild(excludesInput);
            form.appendChild(excludesField);

            // Feedback area
            const feedbackEl = el('div', feedback ? (feedbackKind === 'error' ? 'error-banner' : 'success-banner') : '');
            feedbackEl.setAttribute('data-role', 'settings-feedback');
            if (feedback) {
                feedbackEl.textContent = feedback;
            } else {
                feedbackEl.style.display = 'none';
            }
            form.appendChild(feedbackEl);

            // Actions row
            const actions = el('div', 'actions');

            const saveBtn = el('button', 'action-btn primary', 'Save Settings');
            saveBtn.type = 'submit';
            saveBtn.setAttribute('data-role', 'save-settings-btn');

            const saveNowBtn = el('button', 'action-btn', 'Save / Refresh Tab');
            saveNowBtn.type = 'button';
            saveNowBtn.setAttribute('data-role', 'save-now-btn');
            saveNowBtn.addEventListener('click', () => {
                callbacks.onSaveNow();
            });

            actions.appendChild(saveBtn);
            actions.appendChild(saveNowBtn);
            form.appendChild(actions);

            form.addEventListener('submit', (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();

                const result = callbacks.onSaveSettings({
                    enabled: Boolean(enabledInput.checked),
                    debug: Boolean(debugInput.checked),
                    tokenInput: tokenInput.value,
                    clearToken: clearTokenRequested,
                    collectionId: colInput.value,
                    overlayTimeoutMs: timeoutInput.value,
                    spaDelayMs: spaInput.value,
                    excludes: excludesInput.value
                });

                if (!result || !result.ok) {
                    feedbackEl.className = 'error-banner';
                    feedbackEl.style.display = 'block';
                    feedbackEl.textContent = (result && result.error) || 'Failed to save settings.';
                    return;
                }

                if (wasErrorAuth && result.tokenUpdated && errorRetryUrl) {
                    callbacks.onRetry(errorRetryUrl);
                    return;
                }

                showSettings({
                    feedback: result.message || 'Settings saved.',
                    feedbackKind: 'success'
                });
            });

            body.appendChild(form);
            card.appendChild(body);

            if (focusToken && typeof tokenInput.focus === 'function') {
                tokenInput.focus();
            }
        }

        function hide() {
            clearDismissTimer();
            pickerOpened = false;
            autoHideCancelledPermanently = false;
            isHovered = false;
            isTagInputFocused = false;
            isUpdatingThumb = false;
            isUpdatingFavorite = false;
            pendingTagOps = 0;
            renderEpoch++;
            activeScreen = 'idle';
            returnView = { type: 'none' };
            clearRoot();
            if (host && host.parentNode) {
                host.parentNode.removeChild(host);
            }
            host = null;
            shadow = null;
            styleEl = null;
            rootEl = null;
        }

        function getState() {
            return {
                activeScreen,
                pickerOpened,
                bookmark: currentBookmark,
                candidates: currentCandidates,
                shadowRoot: shadow,
                host
            };
        }

        return {
            showSaving,
            showNotice,
            showSaved,
            showPicker,
            showError,
            showSettings,
            hide,
            getState
        };
    }

    // -------------------------------------------------------------------------
    // Save Pipeline (mirrors draftLoad / createBookmark / enrichCreated / cover)
    // -------------------------------------------------------------------------
    const attemptedUrls = new Set();
    const savedBookmarksByUrl = new Map();
    const bookmarksById = new Map();
    const scrapedMetaByUrl = new Map();
    const inFlightPromises = new Map();
    const bookmarkUpdateQueues = new Map();

    function cacheSavedBookmark(url, item) {
        if (!item) return;
        if (url) {
            savedBookmarksByUrl.set(url, item);
        }
        if (item.link) {
            savedBookmarksByUrl.set(item.link, item);
        }
        if (item._id !== undefined && item._id !== null) {
            bookmarksById.set(item._id, item);
            for (const [cachedUrl, cachedItem] of savedBookmarksByUrl.entries()) {
                if (cachedItem && cachedItem._id === item._id) {
                    savedBookmarksByUrl.set(cachedUrl, item);
                }
            }
        }
    }

    function getLatestCachedBookmark(bookmark) {
        if (!bookmark) return bookmark;
        if (bookmark._id !== undefined && bookmark._id !== null && bookmarksById.has(bookmark._id)) {
            return bookmarksById.get(bookmark._id);
        }
        if (bookmark.link && savedBookmarksByUrl.has(bookmark.link)) {
            return savedBookmarksByUrl.get(bookmark.link);
        }
        return bookmark;
    }

    let sessionUserCollectionId = null;
    let sessionCollectionResolved = false;
    let pendingSaveTimer = null;
    let lastObservedUrl = typeof location !== 'undefined' ? location.href : '';
    let uiEpoch = 0;

    function applyOverlaySettings(values) {
        const colRaw = String(values.collectionId || '').trim();
        let nextCollection = 'auto';
        if (colRaw && colRaw.toLowerCase() !== 'auto') {
            const parsedCol = parseInt(colRaw, 10);
            if (!/^-?\d+$/.test(colRaw) || !Number.isFinite(parsedCol) || parsedCol === 0 || parsedCol === -99) {
                return { ok: false, error: 'Invalid collection ID. Use "auto", -1, or a valid collection number.' };
            }
            nextCollection = String(parsedCol);
        }

        const timeoutStr = String(values.overlayTimeoutMs ?? '').trim();
        const nextTimeout = parseInt(timeoutStr, 10);
        if (!/^\d+$/.test(timeoutStr) || !Number.isFinite(nextTimeout) || nextTimeout < 0) {
            return { ok: false, error: 'Invalid auto-hide delay. Enter a non-negative integer in ms.' };
        }

        const spaStr = String(values.spaDelayMs ?? '').trim();
        const nextSpaDelay = parseInt(spaStr, 10);
        if (!/^\d+$/.test(spaStr) || !Number.isFinite(nextSpaDelay) || nextSpaDelay < 0) {
            return { ok: false, error: 'Invalid SPA delay. Enter a non-negative integer in ms.' };
        }

        const nextExcludes = String(values.excludes || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        for (const pattern of nextExcludes) {
            if (!compileExcludeMatcher(pattern)) {
                return { ok: false, error: `Invalid exclude pattern: ${pattern}` };
            }
        }

        const prevToken = getToken();
        const prevCollection = getConfiguredCollectionId();
        const nextEnabled = Boolean(values.enabled);
        const nextDebug = Boolean(values.debug);

        let tokenUpdated = false;
        const trimmedToken = String(values.tokenInput || '').trim();
        if (trimmedToken) {
            gmSet(STORAGE_KEYS.token, trimmedToken);
            tokenUpdated = trimmedToken !== prevToken;
            invalidateCollectionCache();
        } else if (values.clearToken && prevToken) {
            gmSet(STORAGE_KEYS.token, '');
            tokenUpdated = true;
            invalidateCollectionCache();
        }

        if (nextCollection !== prevCollection) {
            invalidateCollectionCache();
        }

        gmSet(STORAGE_KEYS.enabled, nextEnabled);
        gmSet(STORAGE_KEYS.debug, nextDebug);
        gmSet(STORAGE_KEYS.collectionId, nextCollection);
        gmSet(STORAGE_KEYS.overlayTimeoutMs, nextTimeout);
        gmSet(STORAGE_KEYS.spaDelayMs, nextSpaDelay);
        gmSet(STORAGE_KEYS.excludes, nextExcludes);

        if (!nextEnabled) {
            cancelPendingSave();
        }

        if (nextDebug) {
            logDebug('Settings updated via overlay', {
                enabled: nextEnabled,
                collectionId: nextCollection,
                overlayTimeoutMs: nextTimeout,
                spaDelayMs: nextSpaDelay,
                excludeCount: nextExcludes.length
            });
        }

        return {
            ok: true,
            tokenUpdated,
            message: nextEnabled ? 'Settings saved.' : 'Settings saved (auto-save paused).'
        };
    }

    const overlay = createOverlayUI({
        getCandidates(bookmark) {
            const cachedMeta = bookmark && bookmark.link ? scrapedMetaByUrl.get(bookmark.link) : null;
            return buildCandidateImages(bookmark, cachedMeta);
        },
        async onSelectThumbnail(bookmark, link) {
            return selectThumbnail(bookmark, link);
        },
        async onToggleFavorite(bookmark) {
            return toggleFavorite(bookmark);
        },
        async onAddTags(bookmark, tags) {
            return addBookmarkTags(bookmark, tags);
        },
        async onRemoveTag(bookmark, tag) {
            return removeBookmarkTag(bookmark, tag);
        },
        onSaveSettings(values) {
            return applyOverlaySettings(values);
        },
        onSaveNow() {
            const url = typeof location !== 'undefined' ? location.href : '';
            if (!url) return;
            attemptedUrls.delete(url);
            saveCurrentUrl(url, { force: true, manual: true });
        },
        onRetry(url) {
            if (url) attemptedUrls.delete(url);
            saveCurrentUrl(url, { force: true });
        }
    });

    function invalidateCollectionCache() {
        sessionUserCollectionId = null;
        sessionCollectionResolved = false;
    }

    async function resolveTargetCollectionId() {
        const configured = getConfiguredCollectionId();
        if (configured !== 'auto') {
            return parseInt(configured, 10);
        }

        if (sessionCollectionResolved) {
            return sessionUserCollectionId;
        }

        try {
            const res = await apiRequest('GET', 'user');
            const config = (res && res.user && res.user.config) || {};
            let resolved = parseInt(config.add_default_collection || config.last_collection || -1, 10);
            if (!Number.isFinite(resolved) || resolved === 0 || resolved === -99) {
                resolved = -1;
            }
            sessionUserCollectionId = resolved;
            sessionCollectionResolved = true;
            return resolved;
        } catch (err) {
            if (err && err.status === 401) throw err;
            logWarn('Failed to resolve user default collection; falling back to Unsorted (-1)', {
                url: typeof location !== 'undefined' ? location.href : '',
                error: err
            });
            sessionUserCollectionId = -1;
            sessionCollectionResolved = true;
            return -1;
        }
    }

    async function enrichCreated(url, createdItem) {
        if (!url || !createdItem || !createdItem._id) return createdItem;

        try {
            const parse = await apiRequest('GET', `import/url/parse?url=${encodeURIComponent(url)}`);
            if (!parse || parse.error || !parse.item) return createdItem;

            const changed = {};
            if (parse.item.media && parse.item.media.length) {
                if (!createdItem.media || !createdItem.media.length) {
                    changed.media = parse.item.media;
                }
                if (!createdItem.cover) {
                    changed.cover = parse.item.media[0].link;
                }
            }

            if (parse.item.type && (!createdItem.type || (createdItem.type === 'link' && parse.item.type !== 'link'))) {
                changed.type = parse.item.type;
            }

            if (!Object.keys(changed).length) {
                return createdItem;
            }

            logDebug('Enriching created bookmark via PUT', { url, bookmarkId: createdItem._id, fields: Object.keys(changed) });
            const updateRes = await apiRequest('PUT', `raindrop/${createdItem._id}`, changed);
            return {
                ...createdItem,
                ...changed,
                ...(updateRes && updateRes.item ? updateRes.item : {})
            };
        } catch (e) {
            logWarn('Post-create metadata enrichment failed (non-fatal)', {
                url,
                bookmarkId: createdItem._id,
                error: e
            });
            return createdItem;
        }
    }

    function enqueueBookmarkMutation(bookmark, buildPatch) {
        if (!bookmark || !bookmark._id) {
            return Promise.reject(new Error('Cannot update bookmark before it is saved.'));
        }

        const bookmarkId = bookmark._id;
        const prevQueue = bookmarkUpdateQueues.get(bookmarkId) || Promise.resolve();

        const nextOp = prevQueue.catch(() => {}).then(async () => {
            const latest = getLatestCachedBookmark(bookmark);
            const patch = buildPatch(latest);
            if (!patch || !patch.payload) {
                return latest;
            }

            const res = await apiRequest('PUT', `raindrop/${bookmarkId}`, patch.payload);
            const serverItem = res && res.item ? res.item : {};
            const updated = {
                ...latest,
                ...(patch.fallback || {}),
                ...serverItem
            };

            if (typeof patch.finalize === 'function') {
                Object.assign(updated, patch.finalize(updated, serverItem, latest));
            }

            cacheSavedBookmark(updated.link, updated);

            return updated;
        });

        bookmarkUpdateQueues.set(bookmarkId, nextOp);
        const cleanup = () => {
            if (bookmarkUpdateQueues.get(bookmarkId) === nextOp) {
                bookmarkUpdateQueues.delete(bookmarkId);
            }
        };
        nextOp.then(cleanup, cleanup);

        return nextOp;
    }

    function selectThumbnail(bookmark, link) {
        return enqueueBookmarkMutation(bookmark, (latest) => {
            const currentMedia = Array.isArray(latest.media) ? latest.media : [];
            const nextMedia = currentMedia.some((m) => m && m.link === link)
                ? currentMedia
                : [...currentMedia, { link }];

            return {
                payload: { cover: link, media: nextMedia },
                fallback: { cover: link, media: nextMedia },
                finalize: (_updated, serverItem) => ({
                    cover: serverItem.cover || link,
                    media: Array.isArray(serverItem.media) && serverItem.media.length
                        ? serverItem.media
                        : nextMedia
                })
            };
        });
    }

    function toggleFavorite(bookmark) {
        return enqueueBookmarkMutation(bookmark, (latest) => {
            const nextImportant = !Boolean(latest.important);
            logDebug('Toggling bookmark favorite', {
                url: latest.link,
                bookmarkId: latest._id,
                important: nextImportant
            });
            return {
                payload: { important: nextImportant },
                fallback: { important: nextImportant },
                finalize: (_updated, serverItem) => ({
                    important: typeof serverItem.important === 'boolean'
                        ? serverItem.important
                        : nextImportant
                })
            };
        });
    }

    function addBookmarkTags(bookmark, tagsInput) {
        const incoming = Array.isArray(tagsInput)
            ? normalizeTagsList(tagsInput)
            : parseTagInput(tagsInput);
        if (!incoming.length) {
            return Promise.resolve(getLatestCachedBookmark(bookmark));
        }

        return enqueueBookmarkMutation(bookmark, (latest) => {
            const currentTags = normalizeTagsList(latest.tags);
            const nextTags = mergeTags(currentTags, incoming);
            if (nextTags.length === currentTags.length) {
                return null;
            }
            logDebug('Adding bookmark tags', {
                url: latest.link,
                bookmarkId: latest._id,
                tags: nextTags
            });
            return {
                payload: { tags: nextTags },
                fallback: { tags: nextTags },
                finalize: (_updated, serverItem) => ({
                    tags: Array.isArray(serverItem.tags)
                        ? normalizeTagsList(serverItem.tags)
                        : nextTags
                })
            };
        });
    }

    function removeBookmarkTag(bookmark, tagToRemove) {
        const target = String(tagToRemove || '').trim();
        if (!target) {
            return Promise.resolve(getLatestCachedBookmark(bookmark));
        }

        return enqueueBookmarkMutation(bookmark, (latest) => {
            const currentTags = normalizeTagsList(latest.tags);
            const nextTags = currentTags.filter((tag) => tag !== target);
            if (nextTags.length === currentTags.length) {
                return null;
            }
            logDebug('Removing bookmark tag', {
                url: latest.link,
                bookmarkId: latest._id,
                removed: target,
                tags: nextTags
            });
            return {
                payload: { tags: nextTags },
                fallback: { tags: nextTags },
                finalize: (_updated, serverItem) => ({
                    tags: Array.isArray(serverItem.tags)
                        ? normalizeTagsList(serverItem.tags)
                        : nextTags
                })
            };
        });
    }

    function saveCurrentUrl(targetUrl = location.href, options = {}) {
        const force = Boolean(options.force);
        const manual = Boolean(options.manual);
        const url = String(targetUrl || '');

        if (!manual && !isEnabled()) return Promise.resolve(null);
        if (isUrlExcluded(url, { ignoreUserPatterns: manual })) return Promise.resolve(null);

        if (inFlightPromises.has(url)) {
            return inFlightPromises.get(url);
        }

        if (!force && attemptedUrls.has(url)) {
            return Promise.resolve(savedBookmarksByUrl.get(url) || null);
        }

        if (manual && savedBookmarksByUrl.has(url)) {
            const cached = savedBookmarksByUrl.get(url);
            overlay.showSaved(cached, {
                existing: true,
                forceRender: true,
                candidates: buildCandidateImages(cached, scrapedMetaByUrl.get(url))
            });
            return Promise.resolve(cached);
        }

        attemptedUrls.add(url);
        const myEpoch = ++uiEpoch;

        overlay.showSaving('Saving to Raindrop…');

        const run = (async () => {
            try {
                const meta = extractPageMeta();
                scrapedMetaByUrl.set(url, meta);

                // Step 1: Server duplicate check (draftLoad preventDuplicate: true)
                const existsRes = await apiRequest('GET', `import/url/exists?url=${encodeURIComponent(url)}`);
                const ids = Array.isArray(existsRes && existsRes.ids) ? existsRes.ids : [];

                if (ids.length > 0) {
                    const loadRes = await apiRequest('GET', `raindrop/${ids[0]}`);
                    const existingItem = (loadRes && loadRes.item) || { _id: ids[0], link: url, ...meta };
                    cacheSavedBookmark(url, existingItem);

                    if (myEpoch === uiEpoch) {
                        overlay.showSaved(existingItem, {
                            existing: true,
                            candidates: buildCandidateImages(existingItem, meta)
                        });
                    }
                    return existingItem;
                }

                // Step 2: Resolve collectionId (auto -> user.config or -1)
                const collectionId = await resolveTargetCollectionId();

                // Step 3: Build item & create bookmark (createBookmark parity)
                let item = {
                    collectionId,
                    ...meta,
                    link: url
                };

                if (item.title) {
                    item.pleaseParse = { weight: 1 };
                } else {
                    const parsed = await apiRequest('GET', `import/url/parse?url=${encodeURIComponent(url)}`);
                    if (parsed && parsed.item) {
                        item = {
                            ...item,
                            ...parsed.item,
                            collectionId: item.collectionId,
                            link: item.link
                        };
                    }
                }

                let createRes;
                try {
                    createRes = await apiRequest('POST', 'raindrop', item);
                } catch (err) {
                    if (err && err.status === 401) throw err;
                    if (item.collectionId !== -1) {
                        logWarn('Bookmark creation failed in target collection; retrying in Unsorted (-1)', {
                            url,
                            collectionId: item.collectionId,
                            error: err
                        });
                        createRes = await apiRequest('POST', 'raindrop', {
                            ...item,
                            collectionId: -1
                        });
                    } else {
                        throw err;
                    }
                }

                let createdItem = (createRes && createRes.item) || { ...item };

                // Step 4: Post-create metadata enrichment (enrichCreated parity)
                createdItem = await enrichCreated(url, createdItem);
                cacheSavedBookmark(url, createdItem);
                logDebug('Bookmark saved', { url, bookmarkId: createdItem._id, collectionId: getBookmarkCollectionId(createdItem) });

                if (myEpoch === uiEpoch) {
                    overlay.showSaved(createdItem, {
                        existing: false,
                        candidates: buildCandidateImages(createdItem, meta)
                    });
                }

                return createdItem;
            } catch (err) {
                logError('Auto-save failed', { url, error: err });
                if (myEpoch === uiEpoch) {
                    overlay.showError(err, url);
                }
                return null;
            } finally {
                if (inFlightPromises.get(url) === run) {
                    inFlightPromises.delete(url);
                }
            }
        })();

        inFlightPromises.set(url, run);
        return run;
    }

    // -------------------------------------------------------------------------
    // Load & SPA Lifecycle Watcher
    // -------------------------------------------------------------------------
    function cancelPendingSave() {
        if (pendingSaveTimer !== null) {
            clearTimeout(pendingSaveTimer);
            pendingSaveTimer = null;
        }
    }

    function scheduleSave(delayMs = getSpaDelayMs(), targetUrl = location.href) {
        cancelPendingSave();
        if (!isEnabled()) {
            logDebug('Auto-save skipped (paused)', { url: targetUrl });
            return;
        }
        if (isUrlExcluded(targetUrl)) {
            logDebug('Auto-save skipped (excluded URL or context)', { url: targetUrl });
            return;
        }
        if (attemptedUrls.has(targetUrl)) {
            logDebug('Auto-save skipped (already attempted in session)', { url: targetUrl });
            return;
        }

        const waitMs = Math.max(0, Number(delayMs) || 0);
        logDebug('Scheduled save', { url: targetUrl, delayMs: waitMs });
        pendingSaveTimer = setTimeout(() => {
            pendingSaveTimer = null;
            return saveCurrentUrl(targetUrl);
        }, waitMs);
    }

    function handleUrlChange() {
        const nextUrl = location.href;
        if (nextUrl === lastObservedUrl) return;
        logDebug('Detected SPA URL transition', { from: lastObservedUrl, to: nextUrl });
        lastObservedUrl = nextUrl;
        uiEpoch++;
        cancelPendingSave();
        overlay.hide();
        scheduleSave(getSpaDelayMs(), nextUrl);
    }

    function startOnReady() {
        const triggerInitial = () => {
            lastObservedUrl = location.href;
            scheduleSave(Math.min(INITIAL_LOAD_SETTLE_MS, getSpaDelayMs()), location.href);
        };

        const waitForLoad = () => {
            if (document.readyState === 'complete') {
                triggerInitial();
            } else {
                window.addEventListener('load', triggerInitial, { once: true });
            }
        };

        if (document.prerendering) {
            document.addEventListener('prerenderingchange', waitForLoad, { once: true });
        } else {
            waitForLoad();
        }
    }

    function initNavigationHooks() {
        window.addEventListener('popstate', handleUrlChange);
        window.addEventListener('hashchange', handleUrlChange);

        if (window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('navigatesuccess', handleUrlChange);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'hidden') {
                handleUrlChange();
            }
        });

        if (typeof MutationObserver === 'function' && (document.documentElement || document)) {
            const observer = new MutationObserver(() => {
                if (document.visibilityState === 'hidden') return;
                if (location.href !== lastObservedUrl) {
                    handleUrlChange();
                }
            });
            observer.observe(document.documentElement || document, {
                childList: true,
                subtree: true
            });
        }

        setInterval(() => {
            if (document.visibilityState !== 'hidden' && location.href !== lastObservedUrl) {
                handleUrlChange();
            }
        }, URL_WATCH_INTERVAL_MS);
    }

    // -------------------------------------------------------------------------
    // Userscript Menu Command (single uncluttering entry)
    // -------------------------------------------------------------------------
    function buildDefaultSiteExcludePattern(targetUrl) {
        try {
            const parsed = new URL(String(targetUrl || ''));
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return `*://${parsed.host}/*`;
            }
        } catch (e) {}
        return String(targetUrl || '').trim();
    }

    function promptExcludeCurrentTab() {
        const currentUrl = typeof location !== 'undefined' ? location.href : '';
        const sitePattern = buildDefaultSiteExcludePattern(currentUrl);
        const input = typeof window.prompt === 'function'
            ? window.prompt(
                `Add URL exclusion pattern to skip future auto-saves.\nPrefilled site wildcard: ${sitePattern}\nCurrent tab URL: ${currentUrl}`,
                sitePattern
            )
            : null;

        if (input === null) return;

        const trimmed = String(input).trim();
        if (!trimmed) {
            overlay.showNotice('No exclusion pattern added.');
            return;
        }

        if (!compileExcludeMatcher(trimmed)) {
            overlay.showNotice('Invalid exclusion pattern (syntax error).');
            return;
        }

        const existing = getExcludes();
        const added = !existing.includes(trimmed);
        if (added) {
            gmSet(STORAGE_KEYS.excludes, [...existing, trimmed]);
        }

        cancelPendingSave();
        uiEpoch++;
        logDebug('Excluded current tab via menu command', {
            pattern: trimmed,
            added,
            url: currentUrl
        });

        overlay.showNotice(
            added
                ? `Excluded ${trimmed} (saved bookmarks kept).`
                : `Already excluded: ${trimmed}`
        );
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand('Raindrop: Exclude Current Site / URL', () => {
            promptExcludeCurrentTab();
        });
    }

    // -------------------------------------------------------------------------
    // Bootstrap (and test-harness hook when running inside isolated Node VM)
    // -------------------------------------------------------------------------
    if (typeof globalThis !== 'undefined' && typeof globalThis.__RAINDROP_AUTOSAVE_TEST_EXPORT__ === 'function') {
        globalThis.__RAINDROP_AUTOSAVE_TEST_EXPORT__({
            extractPageMeta,
            getItem,
            getMeta,
            getJsonLd,
            grabImages,
            htmlDecode,
            softNavigated,
            similarURL,
            samePath,
            isUrlExcluded,
            isDebugEnabled,
            apiRequest,
            ApiError,
            resolveTargetCollectionId,
            enrichCreated,
            selectThumbnail,
            toggleFavorite,
            addBookmarkTags,
            removeBookmarkTag,
            normalizeTagsList,
            parseTagInput,
            mergeTags,
            saveCurrentUrl,
            scheduleSave,
            handleUrlChange,
            buildCandidateImages,
            getBookmarkCollectionId,
            buildDefaultSiteExcludePattern,
            promptExcludeCurrentTab,
            overlay,
            attemptedUrls,
            savedBookmarksByUrl,
            invalidateCollectionCache,
            logError,
            logWarn,
            logDebug,
            STORAGE_KEYS,
            DEFAULT_EXCLUDE_PATTERNS
        });
    }

    registerMenuCommands();
    initNavigationHooks();
    startOnReady();
})();
