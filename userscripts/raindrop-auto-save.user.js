// ==UserScript==
// @name         Raindrop.io Auto-Save Tab URL
// @namespace    https://raindrop.io/
// @version      1.2.0
// @description  Automatically saves loaded, background, and SPA-navigated tab URLs to Raindrop.io using the extension's save pipeline.
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
// @run-at       document-start
// @connect      api.raindrop.io
// @connect      rdl.ink
// @connect      *
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
        blockedThumbnails: 'raindrop_blocked_thumbnails',
        spaDelayMs: 'raindrop_spa_delay_ms',
        overlayTimeoutMs: 'raindrop_overlay_timeout_ms',
        debug: 'raindrop_debug'
    };

    const DEFAULT_SPA_DELAY_MS = 1500;
    const DEFAULT_OVERLAY_TIMEOUT_MS = 8000;
    const INITIAL_LOAD_SETTLE_MS = 150;
    const URL_WATCH_INTERVAL_MS = 1000;
    const SCREENSHOT_MAX_OUTPUT_WIDTH = 1280;
    const SCREENSHOT_JPEG_QUALITY = 0.88;
    const CAPTURE_READY_TIMEOUT_MS = 8000;
    const CAPTURE_SETTLE_MS = 250;
    const SVG_IMAGE_TIMEOUT_MS = 5000;
    const POSTER_FETCH_TIMEOUT_MS = 5000;
    const MAX_CAPTURE_ELEMENTS = 6000;
    const MIN_VISUAL_CONTENT_PIXELS = 24;

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
        'https://yandex.com/*',
        'https://bing.com/*',
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

    const DEFAULT_BLOCKED_THUMBNAILS = [
        'https://abs.twimg.com/x-web/assets/og/default-og.a2e144f0cf66.jpg',
        'https://abs.twimg.com/rweb/ssr/default/v2/og/image.png'
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

    function normalizePatternList(input, { deduplicate = false } = {}) {
        let source = input;
        if (typeof source === 'string' && source.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(source);
                if (Array.isArray(parsed)) source = parsed;
            } catch (e) {}
        }
        const rawList = Array.isArray(source)
            ? source
            : String(source || '').split(/\r?\n/);
        const cleaned = rawList.map((s) => String(s || '').trim()).filter(Boolean);
        if (!deduplicate) return cleaned;
        const seen = new Set();
        const out = [];
        for (const item of cleaned) {
            if (seen.has(item)) continue;
            seen.add(item);
            out.push(item);
        }
        return out;
    }

    function readStoredPatternList(key) {
        const stored = gmGet(key, null);
        if (Array.isArray(stored)) {
            return { found: true, value: stored };
        }
        if (typeof stored === 'string' && stored.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    return { found: true, value: parsed };
                }
            } catch (e) {}
        }
        return { found: false, value: null };
    }

    function getExcludes() {
        const stored = readStoredPatternList(STORAGE_KEYS.excludes);
        if (stored.found) {
            return normalizePatternList(stored.value);
        }
        return [...DEFAULT_EXCLUDE_PATTERNS];
    }

    function getBlockedThumbnails() {
        const stored = readStoredPatternList(STORAGE_KEYS.blockedThumbnails);
        if (stored.found) {
            return normalizePatternList(stored.value, { deduplicate: true });
        }
        return [...DEFAULT_BLOCKED_THUMBNAILS];
    }

    function addBlockedThumbnailPattern(pattern) {
        const clean = String(pattern || '').trim();
        if (!clean || clean === '<screenshot>') return false;
        const existing = getBlockedThumbnails();
        if (existing.includes(clean)) return false;
        gmSet(STORAGE_KEYS.blockedThumbnails, [...existing, clean]);
        return true;
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

    function safeDecodeUri(str) {
        const raw = String(str || '');
        if (!raw.includes('%')) return raw;
        return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (chunk) => {
            try {
                return decodeURIComponent(chunk);
            } catch (e) {
                return chunk.replace(/%[0-9A-Fa-f]{2}/g, (hex) => {
                    try { return decodeURIComponent(hex); } catch (_e) { return hex; }
                });
            }
        });
    }

    function extractRdlInnerUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        const match = raw.match(/^https?:\/\/(?:rdl\.ink|stella\.raindrop\.io)\/render\/([^?#]+)/i);
        if (!match || !match[1]) return '';
        const decoded = safeDecodeUri(match[1]).trim();
        if (/^(?:https?:)?\/\//i.test(decoded)) {
            return decoded;
        }
        return '';
    }

    function compileUrlPatternMatcher(pattern, kindLabel = 'exclusion') {
        const raw = String(pattern || '').trim();
        if (!raw) return null;

        const matchesRdlRenderTarget = /^(?:https?:|\*:)\/\/(?:rdl\.ink|stella\.raindrop\.io)\/render\//i.test(raw);

        if (raw.startsWith('/')) {
            const lastSlash = raw.lastIndexOf('/');
            if (lastSlash > 0) {
                const body = raw.slice(1, lastSlash);
                const flags = raw.slice(lastSlash + 1);
                try {
                    const re = new RegExp(body, flags);
                    const matcher = (url) => {
                        if (re.global || re.sticky) re.lastIndex = 0;
                        return re.test(url);
                    };
                    matcher.matchesRdlRenderTarget = false;
                    return matcher;
                } catch (e) {
                    logWarn(`Invalid ${kindLabel} regex pattern`, { pattern: raw, error: e });
                    return null;
                }
            }
        }

        if (raw.includes('*') || raw.includes('?')) {
            const parts = raw.split(/(\*|\?)/);
            const rawRegexStr = '^' + parts
                .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : escapeRegExp(part)))
                .join('') + '$';
            const decodedRegexStr = '^' + parts
                .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : escapeRegExp(safeDecodeUri(part))))
                .join('') + '$';
            try {
                const rawRe = new RegExp(rawRegexStr, 'i');
                const decodedRe = new RegExp(decodedRegexStr, 'i');
                const matcher = (url) => {
                    const target = String(url || '');
                    return rawRe.test(target) || decodedRe.test(safeDecodeUri(target));
                };
                matcher.matchesRdlRenderTarget = matchesRdlRenderTarget;
                return matcher;
            } catch (e) {
                logWarn(`Invalid ${kindLabel} wildcard pattern`, { pattern: raw, error: e });
                return null;
            }
        }

        const rawNeedle = raw.toLowerCase();
        const decodedNeedle = safeDecodeUri(raw).toLowerCase();
        const matcher = (url) => {
            const target = String(url || '');
            return target.toLowerCase().includes(rawNeedle)
                || safeDecodeUri(target).toLowerCase().includes(decodedNeedle);
        };
        matcher.matchesRdlRenderTarget = matchesRdlRenderTarget;
        return matcher;
    }

    function compileExcludeMatcher(pattern) {
        return compileUrlPatternMatcher(pattern, 'exclusion');
    }

    function getBlockedThumbnailMatchers(patterns = getBlockedThumbnails()) {
        const matchers = [];
        for (const pattern of patterns) {
            const matcher = compileUrlPatternMatcher(pattern, 'blocked thumbnail');
            if (matcher) matchers.push(matcher);
        }
        return matchers;
    }

    function isThumbnailBlocked(url, matchers) {
        const raw = typeof url === 'string' ? url.trim() : '';
        if (!raw || raw === '<screenshot>') return false;

        const compiled = Array.isArray(matchers) ? matchers : getBlockedThumbnailMatchers();
        if (!compiled.length) return false;

        const variants = [raw];
        if (raw.startsWith('//')) {
            variants.push(`https:${raw}`, `http:${raw}`);
        }
        const inner = extractRdlInnerUrl(raw);
        if (inner) {
            variants.push(inner);
            if (inner.startsWith('//')) {
                variants.push(`https:${inner}`, `http:${inner}`);
            }
        }

        let rdlWrapped = null;
        return compiled.some((matcher) => {
            if (variants.some((candidate) => matcher(candidate))) {
                return true;
            }
            if (matcher.matchesRdlRenderTarget) {
                if (rdlWrapped === null) {
                    rdlWrapped = getThumbUri(raw) || '';
                }
                if (rdlWrapped && matcher(rdlWrapped)) {
                    return true;
                }
            }
            return false;
        });
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

    function isFormDataBody(data) {
        if (!data || typeof data !== 'object') return false;
        if (typeof FormData !== 'undefined' && data instanceof FormData) return true;
        return typeof data.append === 'function'
            && Object.prototype.toString.call(data) === '[object FormData]';
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
            const formDataBody = isFormDataBody(data);
            if (data !== undefined && method !== 'GET' && method !== 'HEAD') {
                if (formDataBody) {
                    body = data;
                } else {
                    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
                    body = typeof data === 'string' ? data : JSON.stringify(data);
                }
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

    function grabImages(blockedMatchers = getBlockedThumbnailMatchers()) {
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
                    if (url) {
                        if (isThumbnailBlocked(url, blockedMatchers)) {
                            logDebug('Blocked page image candidate', { imageUrl: url, url: location.href });
                            continue;
                        }
                        images.push(url);
                    }
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
        const blockedMatchers = getBlockedThumbnailMatchers();

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
                if (isThumbnailBlocked(item.cover, blockedMatchers)) {
                    logDebug('Blocked meta/JSON-LD cover image', { cover: item.cover, url: location.href });
                    delete item.cover;
                }
            } catch (e) {
                logWarn('Ignoring invalid meta cover URL', { cover: item.cover, url: location.href, error: e });
                delete item.cover;
            }
        }

        const images = [
            ...(item.cover ? [item.cover] : []),
            ...grabImages(blockedMatchers)
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
    // Client-Side Simple Full-Viewport Page Screenshot Capture
    // -------------------------------------------------------------------------
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XHTML_NS = 'http://www.w3.org/1999/xhtml';

    const SKIP_CAPTURE_TAGS = new Set([
        'SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TEMPLATE', 'BASE', 'AUDIO'
    ]);

    const SNAPSHOT_CSS_PROPS = [
        'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear', 'z-index',
        'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'overflow-x', 'overflow-y', 'transform', 'transform-origin', 'opacity', 'visibility',
        'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'align-self',
        'flex-grow', 'flex-shrink', 'flex-basis', 'row-gap', 'column-gap',
        'grid-template-columns', 'grid-template-rows', 'grid-column-start', 'grid-column-end',
        'grid-row-start', 'grid-row-end',
        'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
        'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
        'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
        'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
        'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
        'box-shadow', 'color', 'font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform',
        'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'object-fit', 'object-position',
        'list-style-type', 'border-collapse', 'border-spacing'
    ];

    function sanitizeMediaAndCover(item, matchers = getBlockedThumbnailMatchers()) {
        if (!item || typeof item !== 'object') {
            return { cover: '', media: [], blockedCount: 0, coverBlocked: false, mediaBlocked: false };
        }

        let blockedCount = 0;
        const rawMedia = Array.isArray(item.media) ? item.media : [];
        const cleanMedia = [];
        let mediaBlocked = false;
        for (const entry of rawMedia) {
            const link = entry && typeof entry.link === 'string' ? entry.link.trim() : '';
            if (!link) continue;
            if (isThumbnailBlocked(link, matchers)) {
                blockedCount++;
                mediaBlocked = true;
                continue;
            }
            cleanMedia.push(entry);
        }

        const rawCover = typeof item.cover === 'string' ? item.cover.trim() : '';
        const coverBlocked = Boolean(rawCover && isThumbnailBlocked(rawCover, matchers));
        if (coverBlocked) {
            blockedCount++;
        }

        let cleanCover = coverBlocked ? '' : rawCover;
        if (!cleanCover && cleanMedia.length) {
            cleanCover = String(cleanMedia[0].link || '').trim();
        }

        return {
            cover: cleanCover,
            media: cleanMedia,
            blockedCount,
            coverBlocked,
            mediaBlocked
        };
    }

    function hasBookmarkThumbnail(item) {
        if (!item || typeof item !== 'object') return false;
        const matchers = getBlockedThumbnailMatchers();
        if (typeof item.cover === 'string' && item.cover.trim() && !isThumbnailBlocked(item.cover, matchers)) {
            return true;
        }
        if (Array.isArray(item.media) && item.media.some((m) => m && typeof m.link === 'string' && m.link.trim() && !isThumbnailBlocked(m.link, matchers))) {
            return true;
        }
        return false;
    }

    function getViewportCaptureRect() {
        const docEl = typeof document !== 'undefined' ? document.documentElement : null;
        const vw = Math.max(
            1,
            Math.round((typeof window !== 'undefined' && window.innerWidth) || (docEl && docEl.clientWidth) || 1280)
        );
        const vh = Math.max(
            1,
            Math.round((typeof window !== 'undefined' && window.innerHeight) || (docEl && docEl.clientHeight) || 800)
        );
        const x = 0;
        const y = 0;
        const width = vw;
        const height = vh;
        const scrollX = typeof window !== 'undefined' ? (window.scrollX || window.pageXOffset || 0) : 0;
        const scrollY = typeof window !== 'undefined' ? (window.scrollY || window.pageYOffset || 0) : 0;
        const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1));
        const scale = Math.min(dpr, SCREENSHOT_MAX_OUTPUT_WIDTH / width);
        const outWidth = Math.max(1, Math.round(width * scale));
        const outHeight = Math.max(1, Math.round(height * scale));
        return { vw, vh, x, y, width, height, scrollX, scrollY, scale, outWidth, outHeight };
    }

    function getCenterCropRect() {
        return getViewportCaptureRect();
    }

    function parseCssColorAlpha(colorStr) {
        const raw = String(colorStr || '').trim().toLowerCase();
        if (!raw || raw === 'transparent' || raw === 'none') return 0;
        const rgbaMatch = raw.match(/^rgba?\(\s*[\d.]+\s*[,\s]\s*[\d.]+\s*[,\s]\s*[\d.]+(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
        if (rgbaMatch) {
            if (rgbaMatch[1] === undefined) return 1;
            const alpha = rgbaMatch[1].endsWith('%')
                ? parseFloat(rgbaMatch[1]) / 100
                : parseFloat(rgbaMatch[1]);
            return Number.isFinite(alpha) ? alpha : 1;
        }
        return 1;
    }

    function safeGetComputedStyle(el, pseudoElt) {
        try {
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                return pseudoElt ? window.getComputedStyle(el, pseudoElt) : window.getComputedStyle(el);
            }
        } catch (e) {}
        return null;
    }

    function getEffectivePageBackground() {
        const docEl = typeof document !== 'undefined' ? document.documentElement : null;
        const body = typeof document !== 'undefined' ? document.body : null;
        const bodyStyle = body ? safeGetComputedStyle(body) : null;
        const docStyle = docEl ? safeGetComputedStyle(docEl) : null;

        if (bodyStyle && parseCssColorAlpha(bodyStyle.backgroundColor) > 0) {
            return bodyStyle.backgroundColor;
        }
        if (docStyle && parseCssColorAlpha(docStyle.backgroundColor) > 0) {
            return docStyle.backgroundColor;
        }
        const scheme = String((docStyle && docStyle.colorScheme) || (bodyStyle && bodyStyle.colorScheme) || '').toLowerCase();
        if (scheme === 'dark' || scheme.startsWith('dark ')) {
            return '#121212';
        }
        return '#ffffff';
    }

    function isOverlayHostElement(node) {
        return Boolean(
            node
            && node.nodeType === 1
            && typeof node.getAttribute === 'function'
            && node.getAttribute('data-raindrop-autosave-overlay') === 'true'
        );
    }

    function rectsIntersect(a, b, margin = 24) {
        if (!a || !b) return true;
        return !(
            a.right < b.left - margin
            || a.left > b.right + margin
            || a.bottom < b.top - margin
            || a.top > b.bottom + margin
        );
    }

    function stripInvalidXmlChars(str) {
        return String(str || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
    }

    function splitCssLayers(value) {
        const layers = [];
        let depth = 0;
        let quote = '';
        let start = 0;
        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (quote) {
                if (ch === '\\') {
                    i++;
                } else if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '(') {
                depth++;
            } else if (ch === ')') {
                depth = Math.max(0, depth - 1);
            } else if (ch === ',' && depth === 0) {
                layers.push(value.slice(start, i).trim());
                start = i + 1;
            }
        }
        layers.push(value.slice(start).trim());
        return layers.filter(Boolean);
    }

    function sanitizeCssBackgroundImage(value) {
        const raw = String(value || '').trim();
        if (!raw || raw === 'none') return '';
        if (!/url\(/i.test(raw)) return raw;
        const safeLayers = splitCssLayers(raw).filter((layer) => {
            if (!/url\(/i.test(layer)) return true;
            return /^url\(\s*['"]?data:/i.test(layer);
        });
        return safeLayers.length ? safeLayers.join(', ') : 'none';
    }

    function safeImageToDataUrl(sourceEl, maxDim = 800) {
        if (!sourceEl || typeof document === 'undefined') return null;
        try {
            const tag = String(sourceEl.tagName || '').toUpperCase();
            if (tag === 'CANVAS') {
                if (!sourceEl.width || !sourceEl.height) return null;
                return sourceEl.toDataURL('image/png');
            }

            let srcW = 0;
            let srcH = 0;
            if (tag === 'IMG') {
                const rawSrc = sourceEl.currentSrc || (typeof sourceEl.getAttribute === 'function' && sourceEl.getAttribute('src')) || sourceEl.src || '';
                if (rawSrc.startsWith('data:')) return rawSrc;
                if (!sourceEl.complete || !sourceEl.naturalWidth || !sourceEl.naturalHeight) return null;
                srcW = sourceEl.naturalWidth;
                srcH = sourceEl.naturalHeight;
            } else if (tag === 'VIDEO') {
                if ((sourceEl.readyState || 0) < 2 || !sourceEl.videoWidth || !sourceEl.videoHeight) return null;
                srcW = sourceEl.videoWidth;
                srcH = sourceEl.videoHeight;
            } else {
                return null;
            }

            const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
            const w = Math.max(1, Math.round(srcW * scale));
            const h = Math.max(1, Math.round(srcH * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(sourceEl, 0, 0, w, h);
            return canvas.toDataURL('image/png');
        } catch (e) {
            return null;
        }
    }

    function isSourceDrawableSafe(sourceEl) {
        if (!sourceEl || typeof document === 'undefined') return false;
        try {
            const tag = String(sourceEl.tagName || '').toUpperCase();
            if (tag === 'CANVAS') {
                if (!sourceEl.width || !sourceEl.height) return false;
                sourceEl.toDataURL('image/png');
                return true;
            }
            if (tag === 'IMG' || tag === 'VIDEO') {
                if (tag === 'IMG') {
                    if (!sourceEl.complete || !sourceEl.naturalWidth || !sourceEl.naturalHeight) return false;
                    const rawSrc = sourceEl.currentSrc || (typeof sourceEl.getAttribute === 'function' && sourceEl.getAttribute('src')) || sourceEl.src || '';
                    if (rawSrc.startsWith('data:')) return true;
                } else {
                    if ((sourceEl.readyState || 0) < 2 || !sourceEl.videoWidth || !sourceEl.videoHeight) return false;
                }
                const probe = document.createElement('canvas');
                probe.width = 1;
                probe.height = 1;
                const pctx = probe.getContext && probe.getContext('2d');
                if (!pctx) return false;
                pctx.drawImage(sourceEl, 0, 0, 1, 1);
                pctx.getImageData(0, 0, 1, 1);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function isVideoShowingPoster(videoEl) {
        if (!videoEl) return false;
        const paused = videoEl.paused !== false;
        const currentTime = Number(videoEl.currentTime) || 0;
        const playedLen = (videoEl.played && typeof videoEl.played.length === 'number')
            ? videoEl.played.length
            : 0;
        const ended = Boolean(videoEl.ended);
        return paused && currentTime === 0 && playedLen === 0 && !ended;
    }

    function resolveVideoPosterUrl(videoEl, blockedMatchers = getBlockedThumbnailMatchers()) {
        if (!videoEl) return '';
        const hasGetAttr = typeof videoEl.getAttribute === 'function';
        const attrPoster = hasGetAttr ? videoEl.getAttribute('poster') : null;
        if (attrPoster !== null && !String(attrPoster).trim()) {
            return '';
        }
        const rawPoster = String((attrPoster !== null ? attrPoster : videoEl.poster) || '').trim();
        if (!rawPoster) return '';

        let resolved;
        try {
            const base = (videoEl.baseURI && String(videoEl.baseURI))
                || (typeof location !== 'undefined' && location.href)
                || '';
            resolved = base ? new URL(rawPoster, base).href : new URL(rawPoster).href;
        } catch (e) {
            return '';
        }

        if (!/^(https?:|data:|blob:)/i.test(resolved)) {
            return '';
        }

        if (isThumbnailBlocked(resolved, blockedMatchers)) {
            logDebug('Blocked video poster thumbnail candidate', {
                poster: resolved,
                url: typeof location !== 'undefined' ? location.href : ''
            });
            return '';
        }

        return resolved;
    }

    function isSameOriginUrl(url) {
        if (typeof location === 'undefined' || !location.origin || location.origin === 'null') {
            return false;
        }
        try {
            return new URL(url, location.href).origin === location.origin;
        } catch (e) {
            return false;
        }
    }

    function getHeaderValue(headersText, headerName) {
        const target = String(headerName || '').toLowerCase();
        if (!headersText || !target) return '';
        const lines = String(headersText).split(/\r?\n/);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx <= 0) continue;
            if (line.slice(0, idx).trim().toLowerCase() === target) {
                return line.slice(idx + 1).trim();
            }
        }
        return '';
    }

    function drawDrawableToCleanCanvas(drawable, srcW, srcH, maxDim = 800) {
        if (!drawable || !srcW || !srcH || typeof document === 'undefined') return null;
        try {
            const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
            const w = Math.max(1, Math.round(srcW * scale));
            const h = Math.max(1, Math.round(srcH * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(drawable, 0, 0, w, h);
            if (typeof ctx.getImageData === 'function') {
                ctx.getImageData(0, 0, 1, 1);
            }
            const dataUrl = typeof canvas.toDataURL === 'function'
                ? canvas.toDataURL('image/png')
                : '';
            if (dataUrl && !dataUrl.startsWith('data:image/')) {
                return null;
            }
            return { canvas, dataUrl: dataUrl || null };
        } catch (e) {
            return null;
        }
    }

    function loadImageElement(src, options = {}) {
        if (!src || typeof Image === 'undefined') return Promise.resolve(null);
        const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : POSTER_FETCH_TIMEOUT_MS;
        return new Promise((resolve) => {
            const loader = new Image();
            let done = false;
            const finish = (result) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                loader.onload = null;
                loader.onerror = null;
                resolve(result);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            if (options.crossOrigin) {
                loader.crossOrigin = options.crossOrigin;
            }
            loader.onload = async () => {
                if (typeof loader.decode === 'function') {
                    try { await loader.decode(); } catch (e) {}
                }
                const w = loader.naturalWidth || loader.width || 0;
                const h = loader.naturalHeight || loader.height || 0;
                finish(w > 0 && h > 0 ? loader : null);
            };
            loader.onerror = () => finish(null);
            try {
                loader.src = src;
            } catch (e) {
                finish(null);
            }
        });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve) => {
            if (!blob || typeof FileReader === 'undefined') {
                resolve(null);
                return;
            }
            try {
                const reader = new FileReader();
                reader.onload = () => {
                    const res = typeof reader.result === 'string' ? reader.result : '';
                    resolve(res.startsWith('data:') ? res : null);
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            } catch (e) {
                resolve(null);
            }
        });
    }

    function dataUriToBlob(dataUri) {
        if (typeof Blob === 'undefined' || typeof dataUri !== 'string') return null;
        const commaIdx = dataUri.indexOf(',');
        if (commaIdx < 0 || !dataUri.startsWith('data:')) return null;
        const header = dataUri.slice(5, commaIdx);
        const payload = dataUri.slice(commaIdx + 1);
        const isBase64 = /;base64$/i.test(header);
        const mime = header.replace(/;base64$/i, '').trim() || 'application/octet-stream';
        try {
            if (isBase64) {
                if (typeof atob !== 'function') return null;
                const bin = atob(payload);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) {
                    bytes[i] = bin.charCodeAt(i);
                }
                return new Blob([bytes], { type: mime });
            }
            return new Blob([decodeURIComponent(payload)], { type: mime });
        } catch (e) {
            return null;
        }
    }

    function fetchPosterBlobViaGm(posterUrl) {
        if (typeof GM_xmlhttpRequest !== 'function' || !/^https?:\/\//i.test(String(posterUrl || ''))) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            let done = false;
            const finish = (result) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                logDebug('Timed out fetching video poster via GM_xmlhttpRequest', { posterUrl });
                finish(null);
            }, POSTER_FETCH_TIMEOUT_MS + 500);

            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: posterUrl,
                    responseType: 'blob',
                    timeout: POSTER_FETCH_TIMEOUT_MS,
                    headers: { Accept: 'image/*,*/*;q=0.8' },
                    onload(res) {
                        const status = typeof res.status === 'number' ? res.status : 0;
                        if (status < 200 || status >= 300 || !res.response) {
                            logDebug('Video poster fetch returned non-2xx or empty body', { posterUrl, status });
                            finish(null);
                            return;
                        }
                        const headerCt = getHeaderValue(res.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
                        let blob = res.response;
                        if (
                            typeof Blob !== 'undefined'
                            && !(blob instanceof Blob)
                            && (blob instanceof ArrayBuffer || ArrayBuffer.isView(blob))
                        ) {
                            blob = new Blob([blob], { type: headerCt || 'application/octet-stream' });
                        }
                        if (!blob || (typeof blob.size === 'number' && blob.size <= 0)) {
                            finish(null);
                            return;
                        }
                        const effectiveType = String(blob.type || headerCt || '').split(';')[0].trim().toLowerCase();
                        if (effectiveType && !effectiveType.startsWith('image/') && effectiveType !== 'application/octet-stream') {
                            logDebug('Ignoring non-image video poster response', { posterUrl, contentType: effectiveType });
                            finish(null);
                            return;
                        }
                        finish(blob);
                    },
                    onerror(res) {
                        logDebug('Failed to fetch video poster via GM_xmlhttpRequest', {
                            posterUrl,
                            status: (res && res.status) || 0
                        });
                        finish(null);
                    },
                    ontimeout() {
                        logDebug('Video poster GM_xmlhttpRequest timed out', { posterUrl });
                        finish(null);
                    },
                    onabort() {
                        finish(null);
                    }
                });
            } catch (e) {
                logDebug('Exception starting GM_xmlhttpRequest for video poster', { posterUrl, error: e });
                finish(null);
            }
        });
    }

    function renderImageElementToPosterAsset(img, maxDim = 800, fallbackDataUrl = null) {
        if (!img) return null;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const rendered = drawDrawableToCleanCanvas(img, w, h, maxDim);
        if (!rendered) return null;
        return {
            dataUrl: rendered.dataUrl || fallbackDataUrl,
            drawable: rendered.canvas,
            cleanup: null
        };
    }

    async function decodePosterBlobToAsset(blob, maxDim = 800) {
        if (!blob) return null;
        const mime = String(blob.type || '').toLowerCase();

        if (typeof createImageBitmap === 'function' && !mime.includes('svg')) {
            try {
                const bitmap = await createImageBitmap(blob);
                if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
                    const rendered = drawDrawableToCleanCanvas(bitmap, bitmap.width, bitmap.height, maxDim);
                    if (rendered) {
                        if (typeof bitmap.close === 'function') {
                            try { bitmap.close(); } catch (e) {}
                        }
                        return { dataUrl: rendered.dataUrl, drawable: rendered.canvas, cleanup: null };
                    }
                    return {
                        dataUrl: null,
                        drawable: bitmap,
                        cleanup: typeof bitmap.close === 'function'
                            ? () => { try { bitmap.close(); } catch (e) {} }
                            : null
                    };
                }
                if (bitmap && typeof bitmap.close === 'function') {
                    try { bitmap.close(); } catch (e) {}
                }
            } catch (e) {}
        }

        let objectUrl = '';
        try {
            if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                objectUrl = URL.createObjectURL(blob);
            }
        } catch (e) {
            objectUrl = '';
        }

        const dataUrlFromBlob = await blobToDataUrl(blob);
        const validImageDataUrl = dataUrlFromBlob && dataUrlFromBlob.startsWith('data:image/') ? dataUrlFromBlob : null;
        try {
            let img = objectUrl ? await loadImageElement(objectUrl) : null;
            if (!img && dataUrlFromBlob) {
                img = await loadImageElement(dataUrlFromBlob);
            }
            const asset = renderImageElementToPosterAsset(img, maxDim, validImageDataUrl);
            if (asset) return asset;
        } finally {
            if (objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                try { URL.revokeObjectURL(objectUrl); } catch (e) {}
            }
        }

        if (validImageDataUrl) {
            return { dataUrl: validImageDataUrl, drawable: null, cleanup: null };
        }
        return null;
    }

    async function loadPosterAsset(posterUrl, maxDim = 800) {
        if (!posterUrl) return null;

        if (posterUrl.startsWith('data:')) {
            const validDataUrl = /^data:image\//i.test(posterUrl) ? posterUrl : null;
            const img = await loadImageElement(posterUrl);
            if (img) {
                return renderImageElementToPosterAsset(img, maxDim, validDataUrl) || {
                    dataUrl: validDataUrl,
                    drawable: img,
                    cleanup: null
                };
            }
            const blob = dataUriToBlob(posterUrl);
            if (blob) {
                const decoded = await decodePosterBlobToAsset(blob, maxDim);
                if (decoded) return decoded;
            }
            return validDataUrl ? { dataUrl: validDataUrl, drawable: null, cleanup: null } : null;
        }

        if (posterUrl.startsWith('blob:')) {
            return renderImageElementToPosterAsset(await loadImageElement(posterUrl), maxDim);
        }

        const sameOrigin = isSameOriginUrl(posterUrl);
        let hadTaintedSameOrigin = false;
        if (sameOrigin) {
            const img = await loadImageElement(posterUrl);
            if (img) {
                const asset = renderImageElementToPosterAsset(img, maxDim);
                if (asset) return asset;
                hadTaintedSameOrigin = true;
            }
        }

        if (typeof GM_xmlhttpRequest === 'function') {
            const blob = await fetchPosterBlobViaGm(posterUrl);
            if (blob) {
                const decoded = await decodePosterBlobToAsset(blob, maxDim);
                if (decoded) return decoded;
            }
        }

        if (!sameOrigin || hadTaintedSameOrigin) {
            return renderImageElementToPosterAsset(
                await loadImageElement(posterUrl, { crossOrigin: 'anonymous' }),
                maxDim
            );
        }

        return null;
    }

    function collectVisibleVideoElements(root, viewportBounds) {
        const videos = [];
        if (!root) return videos;
        const seen = new Set();
        const stack = [root];
        let visited = 0;

        while (stack.length && visited < MAX_CAPTURE_ELEMENTS) {
            const node = stack.pop();
            if (!node || node.nodeType !== 1 || seen.has(node)) continue;
            seen.add(node);
            if (isOverlayHostElement(node)) continue;

            const tag = String(node.tagName || '').toUpperCase();
            if (SKIP_CAPTURE_TAGS.has(tag) || tag === 'SOURCE') continue;

            const cs = safeGetComputedStyle(node);
            if (cs && (cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0)) continue;

            visited++;

            if (tag === 'VIDEO') {
                if (!cs || cs.visibility !== 'hidden') {
                    const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
                    if (
                        (!box || !viewportBounds || rectsIntersect(box, viewportBounds, 100))
                        && (!box || (box.width > 0 && box.height > 0))
                    ) {
                        videos.push(node);
                    }
                }
                continue;
            }

            const children = collectChildNodesForCapture(node);
            for (let i = children.length - 1; i >= 0; i--) {
                if (children[i] && children[i].nodeType === 1) {
                    stack.push(children[i]);
                }
            }
        }

        return videos;
    }

    async function resolveVideoElementAsset(videoEl, blockedMatchers = getBlockedThumbnailMatchers(), options = {}) {
        if (!videoEl) return { dataUrl: null, drawable: null, cleanup: null };

        const needDataUrl = options.needDataUrl !== false;
        const showingPoster = isVideoShowingPoster(videoEl);
        const posterUrl = resolveVideoPosterUrl(videoEl, blockedMatchers);
        const loadPoster = typeof options.loadPoster === 'function'
            ? options.loadPoster
            : (url) => loadPosterAsset(url);
        const isUsable = (asset) => Boolean(asset && (needDataUrl ? asset.dataUrl : asset.drawable));

        const tryLiveVideoFrame = () => {
            if (needDataUrl) {
                const dataUrl = safeImageToDataUrl(videoEl);
                return dataUrl ? { dataUrl, drawable: videoEl, cleanup: null } : null;
            }
            return isSourceDrawableSafe(videoEl)
                ? { dataUrl: null, drawable: videoEl, cleanup: null }
                : null;
        };

        const tryPosterAsset = async () => {
            if (!posterUrl) return null;
            const posterAsset = await loadPoster(posterUrl);
            if (isUsable(posterAsset)) return posterAsset;
            if (posterAsset && typeof posterAsset.cleanup === 'function') {
                try { posterAsset.cleanup(); } catch (e) {}
            }
            return null;
        };

        const resolved = (showingPoster && posterUrl)
            ? ((await tryPosterAsset()) || tryLiveVideoFrame())
            : (tryLiveVideoFrame() || (await tryPosterAsset()));

        return resolved || { dataUrl: null, drawable: null, cleanup: null };
    }

    async function resolveViewportVideoAssets(viewportBounds, options = {}) {
        const assets = new Map();
        const root = options.root || (typeof document !== 'undefined' ? document.body : null);
        if (!root) return assets;

        const videos = collectVisibleVideoElements(root, viewportBounds);
        if (!videos.length) return assets;

        const blockedMatchers = options.blockedMatchers || getBlockedThumbnailMatchers();
        const posterCache = new Map();
        const loadPosterCached = (posterUrl) => {
            if (!posterCache.has(posterUrl)) {
                posterCache.set(posterUrl, loadPosterAsset(posterUrl).catch(() => null));
            }
            return posterCache.get(posterUrl);
        };

        await Promise.all(videos.map(async (videoEl) => {
            try {
                const resolved = await resolveVideoElementAsset(videoEl, blockedMatchers, {
                    needDataUrl: options.needDataUrl !== false,
                    loadPoster: loadPosterCached
                });
                assets.set(videoEl, resolved);
            } catch (e) {
                assets.set(videoEl, { dataUrl: null, drawable: null, cleanup: null });
            }
        }));

        return assets;
    }

    function cleanupVideoAssets(videoAssets) {
        if (!videoAssets || typeof videoAssets.values !== 'function') return;
        const seenCleanups = new Set();
        for (const asset of videoAssets.values()) {
            if (asset && typeof asset.cleanup === 'function' && !seenCleanups.has(asset.cleanup)) {
                seenCleanups.add(asset.cleanup);
                try { asset.cleanup(); } catch (e) {}
            }
        }
    }

    function parsePseudoTextContent(rawContent) {
        const raw = String(rawContent || '').trim();
        if (!raw || raw === 'none' || raw === 'normal' || raw === 'open-quote' || raw === 'close-quote') {
            return '';
        }
        const match = raw.match(/^(['"])([\s\S]*)\1$/);
        if (!match) return '';
        return match[2].replace(/\\(["'\\])/g, '$1');
    }

    function buildComputedCssText(cs, overrides = {}) {
        const parts = [];
        if (cs) {
            for (const prop of SNAPSHOT_CSS_PROPS) {
                if (Object.prototype.hasOwnProperty.call(overrides, prop)) continue;
                let val = cs.getPropertyValue(prop);
                if (!val) continue;
                if (prop === 'background-image') {
                    val = sanitizeCssBackgroundImage(val);
                    if (!val || val === 'none') continue;
                }
                parts.push(`${prop}:${val}`);
            }
        }
        for (const [prop, val] of Object.entries(overrides)) {
            if (val !== undefined && val !== null && val !== '') {
                parts.push(`${prop}:${val}`);
            }
        }
        return stripInvalidXmlChars(parts.join(';'));
    }

    function createSnapshotPlaceholder(cs, box) {
        const placeholder = document.createElementNS(XHTML_NS, 'div');
        const overrides = {
            display: cs && cs.display === 'inline' ? 'inline-block' : ((cs && cs.display) || 'block')
        };
        if (box && box.width > 0 && (!cs || cs.width === 'auto')) {
            overrides.width = `${box.width}px`;
        }
        if (box && box.height > 0 && (!cs || cs.height === 'auto')) {
            overrides.height = `${box.height}px`;
        }
        placeholder.setAttribute('style', buildComputedCssText(cs, overrides));
        return placeholder;
    }

    function collectChildNodesForCapture(el) {
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
            return [...el.shadowRoot.childNodes];
        }
        if (String(el.tagName || '').toUpperCase() === 'SLOT' && typeof el.assignedNodes === 'function') {
            const assigned = el.assignedNodes({ flatten: true });
            if (assigned && assigned.length) return assigned;
        }
        return [...el.childNodes];
    }

    function cloneSvgForSnapshot(svgNode, state, viewportBounds) {
        if (!svgNode || state.count >= MAX_CAPTURE_ELEMENTS) return null;
        const cs = safeGetComputedStyle(svgNode);
        if (cs && (cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0)) return null;

        const box = typeof svgNode.getBoundingClientRect === 'function' ? svgNode.getBoundingClientRect() : null;
        if (box && viewportBounds && !rectsIntersect(box, viewportBounds, 40)) {
            return createSnapshotPlaceholder(cs, box);
        }

        state.count++;
        const clone = svgNode.cloneNode(true);
        const queue = [clone];
        while (queue.length) {
            const cur = queue.shift();
            if (!cur || cur.nodeType !== 1) continue;
            const tag = String(cur.tagName || '').toLowerCase();
            if (tag === 'script' || tag === 'foreignobject') {
                cur.remove();
                continue;
            }
            if (tag === 'image') {
                const href = cur.getAttribute('href') || cur.getAttribute('xlink:href') || '';
                if (href && !href.startsWith('data:')) {
                    cur.remove();
                    continue;
                }
            }
            if (tag === 'use') {
                const href = cur.getAttribute('href') || cur.getAttribute('xlink:href') || '';
                if (href.startsWith('#') && typeof document.getElementById === 'function') {
                    const target = document.getElementById(href.slice(1));
                    if (target && !svgNode.contains(target)) {
                        const defs = document.createElementNS(SVG_NS, 'defs');
                        defs.appendChild(target.cloneNode(true));
                        clone.insertBefore(defs, clone.firstChild);
                    }
                }
            }
            if (cur.children && cur.children.length) {
                queue.push(...cur.children);
            }
        }

        const svgOverrides = {};
        if (cs) {
            const fill = cs.getPropertyValue('fill');
            const stroke = cs.getPropertyValue('stroke');
            if (fill) svgOverrides.fill = fill;
            if (stroke) svgOverrides.stroke = stroke;
        }
        if (box && box.width > 0) svgOverrides.width = `${box.width}px`;
        if (box && box.height > 0) svgOverrides.height = `${box.height}px`;
        clone.setAttribute('style', buildComputedCssText(cs, svgOverrides));
        return clone;
    }

    function createPseudoSpan(el, pseudoElt) {
        const pcs = safeGetComputedStyle(el, pseudoElt);
        if (!pcs || pcs.display === 'none') return null;
        const text = parsePseudoTextContent(pcs.content);
        if (!text) return null;
        const span = document.createElementNS(XHTML_NS, 'span');
        span.textContent = stripInvalidXmlChars(text);
        span.setAttribute('style', buildComputedCssText(pcs));
        return span;
    }

    function cloneNodeForSnapshot(node, state, viewportBounds) {
        if (!node || state.count >= MAX_CAPTURE_ELEMENTS) return null;
        if (node.nodeType === 3) {
            const cleanText = stripInvalidXmlChars(node.nodeValue || '');
            return cleanText ? document.createTextNode(cleanText) : null;
        }
        if (node.nodeType !== 1) return null;
        if (isOverlayHostElement(node)) return null;

        const tag = String(node.tagName || '').toUpperCase();
        if (SKIP_CAPTURE_TAGS.has(tag) || tag === 'SOURCE') return null;
        if (node.namespaceURI === SVG_NS) {
            return cloneSvgForSnapshot(node, state, viewportBounds);
        }

        const cs = safeGetComputedStyle(node);
        if (cs && (cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0)) return null;

        const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;

        state.count++;

        if (tag === 'IMG' || tag === 'CANVAS' || tag === 'VIDEO') {
            if (box && viewportBounds && !rectsIntersect(box, viewportBounds, 100)) {
                return createSnapshotPlaceholder(cs, box);
            }
            const hasPreResolved = tag === 'VIDEO' && state && state.videoAssets && state.videoAssets.has(node);
            const dataUrl = hasPreResolved
                ? ((state.videoAssets.get(node) && state.videoAssets.get(node).dataUrl) || null)
                : safeImageToDataUrl(node);
            if (!dataUrl) {
                return createSnapshotPlaceholder(cs, box);
            }
            const imgClone = document.createElementNS(XHTML_NS, 'img');
            imgClone.setAttribute('src', dataUrl);
            const imgOverrides = {};
            if (box && box.width > 0) imgOverrides.width = `${box.width}px`;
            if (box && box.height > 0) imgOverrides.height = `${box.height}px`;
            if (tag === 'VIDEO' && (!cs || !cs.getPropertyValue('object-fit'))) {
                imgOverrides['object-fit'] = 'contain';
            }
            imgClone.setAttribute('style', buildComputedCssText(cs, imgOverrides));
            return imgClone;
        }

        if (tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED') {
            return createSnapshotPlaceholder(cs, box);
        }

        const clone = document.createElementNS(XHTML_NS, tag.toLowerCase());
        const overrides = {};

        if (cs && cs.position === 'sticky' && box) {
            overrides.position = 'fixed';
            overrides.left = `${box.left}px`;
            overrides.top = `${box.top}px`;
            overrides.right = 'auto';
            overrides.bottom = 'auto';
            overrides.width = `${box.width}px`;
            overrides.height = `${box.height}px`;
            overrides['margin-top'] = '0';
            overrides['margin-right'] = '0';
            overrides['margin-bottom'] = '0';
            overrides['margin-left'] = '0';
        }

        const scrollTop = Number(node.scrollTop) || 0;
        const scrollLeft = Number(node.scrollLeft) || 0;
        if ((scrollTop > 0 || scrollLeft > 0) && node !== document.body && node !== document.documentElement) {
            overrides['overflow-x'] = 'hidden';
            overrides['overflow-y'] = 'hidden';
        }

        clone.setAttribute('style', buildComputedCssText(cs, overrides));

        if (tag === 'INPUT') {
            const inputType = String(node.type || 'text').toLowerCase();
            clone.setAttribute('type', inputType);
            if (inputType === 'checkbox' || inputType === 'radio') {
                if (node.checked) clone.setAttribute('checked', 'checked');
            } else if (inputType !== 'password') {
                clone.setAttribute('value', stripInvalidXmlChars(node.value || ''));
            }
            if (node.placeholder) {
                clone.setAttribute('placeholder', stripInvalidXmlChars(node.placeholder));
            }
            return clone;
        }

        if (tag === 'TEXTAREA') {
            clone.textContent = stripInvalidXmlChars(node.value || '');
            return clone;
        }

        if (tag === 'SELECT') {
            const options = [...(node.options || [])];
            const selectedOpt = options.find((opt) => opt.selected) || options[0];
            if (selectedOpt) {
                const optEl = document.createElementNS(XHTML_NS, 'option');
                optEl.setAttribute('selected', 'selected');
                optEl.textContent = stripInvalidXmlChars(selectedOpt.textContent || '');
                clone.appendChild(optEl);
            }
            return clone;
        }

        const contentTarget = ((scrollTop > 0 || scrollLeft > 0) && node !== document.body && node !== document.documentElement)
            ? (() => {
                const wrap = document.createElementNS(XHTML_NS, 'div');
                wrap.setAttribute('style', `margin-left:${-scrollLeft}px;margin-top:${-scrollTop}px;`);
                clone.appendChild(wrap);
                return wrap;
            })()
            : clone;

        const beforeSpan = createPseudoSpan(node, '::before');
        if (beforeSpan) contentTarget.appendChild(beforeSpan);

        for (const child of collectChildNodesForCapture(node)) {
            if (state.count >= MAX_CAPTURE_ELEMENTS) break;
            const clonedChild = cloneNodeForSnapshot(child, state, viewportBounds);
            if (clonedChild) {
                contentTarget.appendChild(clonedChild);
            }
        }

        const afterSpan = createPseudoSpan(node, '::after');
        if (afterSpan) contentTarget.appendChild(afterSpan);

        return clone;
    }

    function canvasHasVisualContent(ctx, width, height) {
        if (!ctx || !width || !height) return false;
        if (typeof ctx.getImageData !== 'function') return true;
        try {
            const imgData = ctx.getImageData(0, 0, width, height).data;
            if (!imgData || imgData.length < 4) return false;

            const totalPixels = width * height;
            const step = Math.max(1, Math.min(4, Math.floor(Math.sqrt(totalPixels / 15000))));
            const r0 = imgData[0];
            const g0 = imgData[1];
            const b0 = imgData[2];
            const a0 = imgData[3];

            let opaqueCount = 0;
            let diffCount = 0;

            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const idx = (y * width + x) * 4;
                    const r = imgData[idx];
                    const g = imgData[idx + 1];
                    const b = imgData[idx + 2];
                    const a = imgData[idx + 3];
                    if (a > 0) opaqueCount++;
                    const delta = Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) + Math.abs(a - a0);
                    if (delta > 16) {
                        diffCount++;
                        if (diffCount >= MIN_VISUAL_CONTENT_PIXELS && opaqueCount > 0) {
                            return true;
                        }
                    }
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function compositeCanvasBackground(ctx, width, height, backgroundColor) {
        if (!ctx || !backgroundColor) return;
        const prevOp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = prevOp || 'source-over';
    }

    function canvasToScreenshotBlob(canvas) {
        return new Promise((resolve) => {
            if (!canvas) {
                resolve(null);
                return;
            }
            try {
                if (typeof canvas.toBlob === 'function') {
                    canvas.toBlob((blob) => {
                        if (blob && blob.size > 0) {
                            resolve(blob);
                            return;
                        }
                        try {
                            canvas.toBlob((pngBlob) => {
                                resolve(pngBlob && pngBlob.size > 0 ? pngBlob : null);
                            }, 'image/png');
                        } catch (e) {
                            resolve(null);
                        }
                    }, 'image/jpeg', SCREENSHOT_JPEG_QUALITY);
                    return;
                }
                if (typeof canvas.toDataURL === 'function' && typeof Blob !== 'undefined') {
                    const dataUrl = canvas.toDataURL('image/jpeg', SCREENSHOT_JPEG_QUALITY);
                    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
                    if (match && typeof atob === 'function') {
                        const bin = atob(match[2]);
                        const bytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) {
                            bytes[i] = bin.charCodeAt(i);
                        }
                        resolve(new Blob([bytes], { type: match[1] }));
                        return;
                    }
                }
            } catch (e) {}
            resolve(null);
        });
    }

    async function captureViaForeignObject(rect, options = {}) {
        if (
            typeof document === 'undefined'
            || typeof XMLSerializer === 'undefined'
            || typeof Image === 'undefined'
            || !document.body
        ) {
            return null;
        }

        const viewportBounds = {
            left: 0,
            top: 0,
            right: rect.width,
            bottom: rect.height
        };
        const ownsVideoAssets = !(options && options.videoAssets);
        const videoAssets = (options && options.videoAssets)
            || await resolveViewportVideoAssets(viewportBounds, { needDataUrl: true });

        try {
            const effectiveBg = getEffectivePageBackground();
            const bodyStyle = safeGetComputedStyle(document.body);
            const docStyle = safeGetComputedStyle(document.documentElement);
            const bodyRect = typeof document.body.getBoundingClientRect === 'function'
                ? document.body.getBoundingClientRect()
                : { left: -rect.scrollX, top: -rect.scrollY, width: rect.width };

            const svgRoot = document.createElementNS(SVG_NS, 'svg');
            svgRoot.setAttribute('xmlns', SVG_NS);
            svgRoot.setAttribute('width', String(rect.width));
            svgRoot.setAttribute('height', String(rect.height));
            svgRoot.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

            const fo = document.createElementNS(SVG_NS, 'foreignObject');
            fo.setAttribute('x', '0');
            fo.setAttribute('y', '0');
            fo.setAttribute('width', String(rect.width));
            fo.setAttribute('height', String(rect.height));

            const viewportBox = document.createElementNS(XHTML_NS, 'div');
            viewportBox.setAttribute('xmlns', XHTML_NS);
            viewportBox.setAttribute('style', buildComputedCssText(docStyle, {
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                overflow: 'hidden',
                position: 'relative',
                transform: 'none',
                'margin-top': '0',
                'margin-right': '0',
                'margin-bottom': '0',
                'margin-left': '0',
                'padding-top': '0',
                'padding-right': '0',
                'padding-bottom': '0',
                'padding-left': '0',
                'background-color': 'transparent'
            }));

            const scrollFrame = document.createElementNS(XHTML_NS, 'div');
            scrollFrame.setAttribute('style', buildComputedCssText(bodyStyle, {
                position: 'absolute',
                left: `${bodyRect.left}px`,
                top: `${bodyRect.top}px`,
                width: `${Math.max(1, bodyRect.width || rect.width)}px`,
                height: 'auto',
                'box-sizing': 'border-box',
                transform: 'none',
                'margin-top': '0',
                'margin-right': '0',
                'margin-bottom': '0',
                'margin-left': '0',
                'overflow-x': 'visible',
                'overflow-y': 'visible',
                'background-color': bodyStyle && parseCssColorAlpha(bodyStyle.backgroundColor) > 0
                    ? bodyStyle.backgroundColor
                    : 'transparent'
            }));

            const state = { count: 0, videoAssets };
            for (const child of [...document.body.childNodes]) {
                if (state.count >= MAX_CAPTURE_ELEMENTS) break;
                const cloned = cloneNodeForSnapshot(child, state, viewportBounds);
                if (cloned) {
                    scrollFrame.appendChild(cloned);
                }
            }

            viewportBox.appendChild(scrollFrame);
            fo.appendChild(viewportBox);
            svgRoot.appendChild(fo);

            const svgXml = stripInvalidXmlChars(new XMLSerializer().serializeToString(svgRoot));
            const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgXml)}`;

            const img = await new Promise((resolve) => {
                const loader = new Image();
                let done = false;
                const finish = (result) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(result);
                };
                const timer = setTimeout(() => finish(null), SVG_IMAGE_TIMEOUT_MS);
                loader.onload = () => finish(loader);
                loader.onerror = () => finish(null);
                loader.src = svgDataUrl;
            });

            if (!img) return null;
            if (typeof img.decode === 'function') {
                try { await img.decode(); } catch (e) {}
            }

            const canvas = document.createElement('canvas');
            canvas.width = rect.outWidth;
            canvas.height = rect.outHeight;
            const ctx = canvas.getContext && canvas.getContext('2d');
            if (!ctx) return null;

            ctx.drawImage(img, 0, 0, rect.outWidth, rect.outHeight);
            if (!canvasHasVisualContent(ctx, rect.outWidth, rect.outHeight)) {
                return null;
            }

            compositeCanvasBackground(ctx, rect.outWidth, rect.outHeight, effectiveBg);

            const blob = await canvasToScreenshotBlob(canvas);
            if (!blob) return null;
            return { blob, method: 'foreignObject', width: rect.outWidth, height: rect.outHeight };
        } finally {
            if (ownsVideoAssets) {
                cleanupVideoAssets(videoAssets);
            }
        }
    }

    function traceRoundedRect(ctx, x, y, w, h, r) {
        const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
        ctx.beginPath();
        if (radius <= 0) {
            ctx.rect(x, y, w, h);
            return;
        }
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        ctx.lineTo(x + w, y + h - radius);
        ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        ctx.lineTo(x + radius, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    function findLineEndIndex(range, textNode, startIdx, maxLen) {
        let low = startIdx + 1;
        let high = maxLen;
        let best = low;
        while (low <= high) {
            const mid = (low + high) >> 1;
            range.setStart(textNode, startIdx);
            range.setEnd(textNode, mid);
            const rects = range.getClientRects();
            if (rects.length <= 1) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return best;
    }

    function drawTextNodeOnCanvas(ctx, textNode, cs, viewportBounds) {
        const rawText = String(nodeValueSafe(textNode) || '');
        if (!rawText.trim()) return;
        if (!cs || parseCssColorAlpha(cs.color) <= 0) return;

        const fontStyle = cs.fontStyle || 'normal';
        const fontWeight = cs.fontWeight || '400';
        const fontSize = cs.fontSize || '14px';
        const fontFamily = cs.fontFamily || 'sans-serif';
        ctx.font = `${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`;
        ctx.fillStyle = cs.color;
        ctx.textBaseline = 'middle';

        const preserveWs = cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap' || cs.whiteSpace === 'break-spaces';
        if (typeof document.createRange !== 'function') return;

        try {
            const range = document.createRange();
            range.selectNodeContents(textNode);
            if (typeof range.getClientRects !== 'function') return;
            const allRects = range.getClientRects();
            if (!allRects || !allRects.length) return;

            if (allRects.length === 1) {
                const r = allRects[0];
                if (!rectsIntersect(r, viewportBounds, 8)) return;
                const lineText = preserveWs ? rawText : rawText.replace(/\s+/g, ' ').trim();
                if (lineText) {
                    ctx.fillText(lineText, r.left, r.top + r.height / 2);
                }
                return;
            }

            const maxLen = Math.min(rawText.length, 1500);
            let idx = 0;
            let guard = 0;
            while (idx < maxLen && guard < 60) {
                guard++;
                const endIdx = findLineEndIndex(range, textNode, idx, maxLen);
                range.setStart(textNode, idx);
                range.setEnd(textNode, endIdx);
                const lineRects = range.getClientRects();
                const r = lineRects && lineRects[0];
                if (r && rectsIntersect(r, viewportBounds, 8)) {
                    const slice = rawText.slice(idx, endIdx);
                    const lineText = preserveWs ? slice : slice.replace(/\s+/g, ' ').trim();
                    if (lineText) {
                        ctx.fillText(lineText, r.left, r.top + r.height / 2);
                    }
                }
                if (endIdx <= idx) break;
                idx = endIdx;
            }
        } catch (e) {}
    }

    function nodeValueSafe(textNode) {
        try {
            return textNode.nodeValue;
        } catch (e) {
            return '';
        }
    }

    async function captureViaDirectCanvas(rect, options = {}) {
        if (typeof document === 'undefined' || !document.body) return null;

        const canvas = document.createElement('canvas');
        canvas.width = rect.outWidth;
        canvas.height = rect.outHeight;
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return null;

        const viewportBounds = {
            left: 0,
            top: 0,
            right: rect.width,
            bottom: rect.height
        };
        const ownsVideoAssets = !(options && options.videoAssets);
        const videoAssets = (options && options.videoAssets)
            || await resolveViewportVideoAssets(viewportBounds, { needDataUrl: false });

        try {
            ctx.save();
            ctx.scale(rect.scale, rect.scale);

            let visited = 0;
            const paintElement = (el) => {
                if (!el || visited >= MAX_CAPTURE_ELEMENTS) return;
                if (el.nodeType !== 1 || isOverlayHostElement(el)) return;
                const tag = String(el.tagName || '').toUpperCase();
                if (SKIP_CAPTURE_TAGS.has(tag) || tag === 'SOURCE') return;

                const cs = safeGetComputedStyle(el);
                if (cs && (cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0)) {
                    return;
                }

                const box = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
                const clipX = Boolean(cs && (cs.overflowX === 'hidden' || cs.overflowX === 'clip'));
                const clipY = Boolean(cs && (cs.overflowY === 'hidden' || cs.overflowY === 'clip'));
                if (box) {
                    if (clipX && (box.right < -8 || box.left > rect.width + 8)) return;
                    if (clipY && (box.bottom < -8 || box.top > rect.height + 8)) return;
                }

                visited++;

                const isVisibleSelf = !cs || cs.visibility !== 'hidden';
                const radius = cs ? (parseFloat(cs.borderTopLeftRadius || '0') || 0) : 0;

                if (isVisibleSelf && box && box.width > 0 && box.height > 0 && cs && rectsIntersect(box, viewportBounds, 8)) {
                    const bgAlpha = parseCssColorAlpha(cs.backgroundColor);
                    if (bgAlpha > 0) {
                        ctx.fillStyle = cs.backgroundColor;
                        traceRoundedRect(ctx, box.left, box.top, box.width, box.height, radius);
                        ctx.fill();
                    }

                    const borderW = parseFloat(cs.borderTopWidth || '0') || 0;
                    if (borderW > 0 && cs.borderTopStyle !== 'none' && parseCssColorAlpha(cs.borderTopColor) > 0) {
                        ctx.strokeStyle = cs.borderTopColor;
                        ctx.lineWidth = Math.min(borderW, 6);
                        traceRoundedRect(ctx, box.left, box.top, box.width, box.height, radius);
                        ctx.stroke();
                    }

                    if (tag === 'IMG' || tag === 'CANVAS') {
                        if (isSourceDrawableSafe(el)) {
                            try {
                                ctx.drawImage(el, box.left, box.top, box.width, box.height);
                            } catch (e) {}
                        }
                    } else if (tag === 'VIDEO') {
                        const asset = videoAssets && videoAssets.has(el) ? videoAssets.get(el) : null;
                        const drawable = asset
                            ? asset.drawable
                            : (isSourceDrawableSafe(el) ? el : null);
                        if (drawable) {
                            try {
                                ctx.drawImage(drawable, box.left, box.top, box.width, box.height);
                            } catch (e) {}
                        }
                    }
                }

                if (tag === 'VIDEO') return;

                const shouldClipChildren = Boolean(clipX && clipY && box && box.width > 0 && box.height > 0 && el !== document.body);
                if (shouldClipChildren) {
                    ctx.save();
                    traceRoundedRect(ctx, box.left, box.top, box.width, box.height, radius);
                    ctx.clip();
                }

                for (const child of collectChildNodesForCapture(el)) {
                    if (visited >= MAX_CAPTURE_ELEMENTS) break;
                    if (child.nodeType === 3) {
                        if (isVisibleSelf) {
                            drawTextNodeOnCanvas(ctx, child, cs, viewportBounds);
                        }
                    } else if (child.nodeType === 1) {
                        paintElement(child);
                    }
                }

                if (shouldClipChildren) {
                    ctx.restore();
                }
            };

            paintElement(document.body);
            ctx.restore();

            if (!canvasHasVisualContent(ctx, rect.outWidth, rect.outHeight)) {
                return null;
            }

            compositeCanvasBackground(ctx, rect.outWidth, rect.outHeight, getEffectivePageBackground());

            const blob = await canvasToScreenshotBlob(canvas);
            if (!blob) return null;
            return { blob, method: 'directCanvas', width: rect.outWidth, height: rect.outHeight };
        } finally {
            if (ownsVideoAssets) {
                cleanupVideoAssets(videoAssets);
            }
        }
    }

    async function captureSimpleViewportScreenshot() {
        const rect = getViewportCaptureRect();
        let sharedVideoAssets = null;
        try {
            sharedVideoAssets = await resolveViewportVideoAssets({
                left: 0,
                top: 0,
                right: rect.width,
                bottom: rect.height
            }, { needDataUrl: true });
        } catch (e) {
            sharedVideoAssets = null;
        }

        try {
            try {
                const primary = await captureViaForeignObject(rect, sharedVideoAssets ? { videoAssets: sharedVideoAssets } : undefined);
                if (primary && primary.blob) {
                    return primary;
                }
            } catch (err) {
                logWarn('ForeignObject screenshot capture failed; falling back to direct canvas', {
                    url: typeof location !== 'undefined' ? location.href : '',
                    error: err
                });
            }

            try {
                const secondary = await captureViaDirectCanvas(rect, sharedVideoAssets ? { videoAssets: sharedVideoAssets } : undefined);
                if (secondary && secondary.blob) {
                    return secondary;
                }
            } catch (err) {
                logWarn('Direct canvas screenshot capture failed', {
                    url: typeof location !== 'undefined' ? location.href : '',
                    error: err
                });
            }

            return null;
        } finally {
            cleanupVideoAssets(sharedVideoAssets);
        }
    }

    async function captureCenterPageScreenshot() {
        return captureSimpleViewportScreenshot();
    }

    async function waitForPageReadyForCapture(targetUrl, options = {}) {
        const maxWaitMs = typeof options.maxWaitMs === 'number' ? options.maxWaitMs : CAPTURE_READY_TIMEOUT_MS;
        const settleMs = typeof options.settleMs === 'number' ? options.settleMs : CAPTURE_SETTLE_MS;
        const url = String(targetUrl || '');

        if (typeof location !== 'undefined' && url && location.href !== url) {
            return { ready: false, navigatedAway: true, timedOut: false };
        }

        let timedOut = false;
        if (typeof document !== 'undefined' && document.readyState !== 'complete') {
            await new Promise((resolve) => {
                let finished = false;
                let maxTimer = null;
                let urlPoll = null;

                const finish = (didTimeout) => {
                    if (finished) return;
                    finished = true;
                    timedOut = Boolean(didTimeout);
                    if (maxTimer !== null) clearTimeout(maxTimer);
                    if (urlPoll !== null) clearInterval(urlPoll);
                    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                        window.removeEventListener('load', onReady);
                    }
                    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                        document.removeEventListener('readystatechange', onReadyStateChange);
                    }
                    resolve();
                };

                const onReady = () => finish(false);
                const onReadyStateChange = () => {
                    if (document.readyState === 'complete') finish(false);
                };

                if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
                    window.addEventListener('load', onReady, { once: true });
                }
                if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
                    document.addEventListener('readystatechange', onReadyStateChange);
                }

                urlPoll = setInterval(() => {
                    if (typeof location !== 'undefined' && url && location.href !== url) {
                        finish(false);
                    } else if (typeof document !== 'undefined' && document.readyState === 'complete') {
                        finish(false);
                    }
                }, 200);

                maxTimer = setTimeout(() => finish(true), Math.max(0, maxWaitMs));
            });
        }

        if (typeof location !== 'undefined' && url && location.href !== url) {
            return { ready: false, navigatedAway: true, timedOut };
        }

        if (!timedOut && settleMs > 0) {
            await sleep(settleMs);
        }

        if (typeof location !== 'undefined' && url && location.href !== url) {
            return { ready: false, navigatedAway: true, timedOut };
        }

        if (
            typeof document !== 'undefined'
            && document.visibilityState === 'visible'
            && typeof requestAnimationFrame === 'function'
        ) {
            await new Promise((resolve) => {
                const safety = setTimeout(resolve, 100);
                requestAnimationFrame(() => {
                    clearTimeout(safety);
                    resolve();
                });
            });
        }

        const navigatedAway = typeof location !== 'undefined' && Boolean(url) && location.href !== url;
        return { ready: !navigatedAway, navigatedAway, timedOut };
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
        const blockedMatchers = getBlockedThumbnailMatchers();

        const pushLink = (raw) => {
            const link = typeof raw === 'string' ? raw.trim() : '';
            if (!link || seen.has(link) || isThumbnailBlocked(link, blockedMatchers)) return;
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
        .card[data-screen="saving"],
        .card[data-screen="notice"] {
            width: auto;
            min-width: 210px;
            max-width: 300px;
        }
        .mini-bar {
            pointer-events: auto;
            display: inline-flex;
            align-items: center;
            gap: 2px;
            padding: 3px;
            background: #ffffff;
            color: #1c1e21;
            border: 1px solid #eab308;
            border-radius: 999px;
            box-shadow: 0 8px 22px rgba(15, 23, 42, 0.16);
        }
        .mini-btn {
            appearance: none;
            border: none;
            background: transparent;
            color: #475569;
            width: 24px;
            height: 24px;
            border-radius: 999px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            padding: 0;
            flex-shrink: 0;
            transition: background 0.15s ease, color 0.15s ease;
        }
        .mini-btn:hover {
            background: rgba(15, 23, 42, 0.08);
        }
        .mini-btn:focus-visible {
            outline: 2px solid #0c84e4;
            outline-offset: 1px;
        }
        .mini-show-btn {
            color: #0c84e4;
        }
        .mini-show-btn:hover {
            background: rgba(12, 132, 228, 0.12);
            color: #0284c7;
        }
        .mini-remove-btn:hover {
            background: rgba(220, 38, 38, 0.1);
            color: #dc2626;
        }
        .mini-icon {
            width: 15px;
            height: 15px;
            display: block;
            flex-shrink: 0;
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
            .mini-bar {
                background: #1d2025;
                color: #f1f3f5;
                border-color: #eab308;
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
            }
            .mini-btn {
                color: #cbd5e1 !important;
            }
            .mini-btn:hover {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            .mini-show-btn {
                color: #38bdf8 !important;
            }
            .mini-show-btn:hover {
                background: rgba(56, 189, 248, 0.16) !important;
                color: #7dd3fc !important;
            }
            .mini-remove-btn:hover {
                background: rgba(248, 113, 113, 0.16) !important;
                color: #fca5a5 !important;
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
            .thumb-option.capture-tile {
                background: rgba(56, 189, 248, 0.1) !important;
                border-color: rgba(125, 211, 252, 0.35) !important;
                color: #7dd3fc !important;
            }
            .thumb-option.capture-tile:hover:not(:disabled) {
                border-color: #38bdf8 !important;
                background: rgba(56, 189, 248, 0.18) !important;
            }
            .picker-hint {
                color: #9aa4b2 !important;
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
            .fav-btn,
            .delete-btn {
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
            .delete-btn:hover:not(:disabled) {
                background: rgba(248, 113, 113, 0.16) !important;
                border-color: rgba(248, 113, 113, 0.45) !important;
                color: #fca5a5 !important;
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
        .card[data-screen="saving"] .header,
        .card[data-screen="notice"] .header {
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
        .fav-btn,
        .delete-btn {
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
        .delete-btn:hover:not(:disabled) {
            background: rgba(220, 38, 38, 0.08);
            border-color: rgba(220, 38, 38, 0.35);
            color: #dc2626;
        }
        .fav-btn:disabled,
        .delete-btn:disabled {
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
        .thumb-tile {
            position: relative;
            height: 68px;
        }
        .thumb-option {
            position: relative;
            width: 100%;
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
        .thumb-block-btn {
            position: absolute;
            top: 4px;
            right: 4px;
            z-index: 2;
            appearance: none;
            border: 1px solid rgba(255, 255, 255, 0.28);
            border-radius: 999px;
            padding: 1px 6px;
            height: 18px;
            background: rgba(15, 23, 42, 0.8);
            color: #ffffff;
            font-size: 10px;
            font-weight: 600;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0.85;
            transition: opacity 0.15s ease, background 0.15s ease;
        }
        .thumb-tile:hover .thumb-block-btn,
        .thumb-block-btn:focus-visible {
            opacity: 1;
        }
        .thumb-block-btn:hover:not(:disabled) {
            background: #dc2626;
            border-color: rgba(255, 255, 255, 0.55);
        }
        .thumb-block-btn:disabled {
            cursor: wait;
            opacity: 0.35;
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
        .thumb-option.capture-tile {
            flex-direction: column;
            gap: 4px;
            border-style: dashed;
            border-color: rgba(12, 132, 228, 0.45);
            background: rgba(12, 132, 228, 0.06);
            color: #0369a1;
            font-size: 11px;
            font-weight: 600;
            line-height: 1.2;
            padding: 4px;
        }
        .thumb-option.capture-tile:hover:not(:disabled) {
            background: rgba(12, 132, 228, 0.13);
            border-color: #0284c7;
        }
        .capture-tile-icon {
            width: 18px;
            height: 18px;
            display: block;
            flex-shrink: 0;
        }
        .picker-hint {
            margin: 0 0 8px 0;
            font-size: 12px;
            color: #64748b;
        }
        .thumb-placeholder-stack {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            padding: 4px;
            font-size: 10.5px;
            color: #64748b;
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
        let dismissDeadline = null;
        let pausedDismissRemainingMs = null;
        let pickerOpened = false;
        let autoHideCancelledPermanently = false;
        let isHovered = false;
        let isTagInputFocused = false;
        let activeScreen = 'idle';
        let currentBookmark = null;
        let currentWasExisting = false;
        let currentCandidates = [];
        let currentPickerErrorMsg = '';
        let currentSettingsOptions = null;
        let minimizedView = null;
        let isUpdatingThumb = false;
        let isUpdatingFavorite = false;
        let isDeletingBookmark = false;
        let isCapturingScreenshot = false;
        let activeThumbBtn = null;
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

        function isPageHidden() {
            return typeof document !== 'undefined'
                && (document.visibilityState === 'hidden' || document.hidden === true);
        }

        function clearDismissTimer({ preserveRemaining = false } = {}) {
            if (dismissTimer !== null) {
                if (preserveRemaining && dismissDeadline !== null) {
                    pausedDismissRemainingMs = Math.max(0, dismissDeadline - Date.now());
                } else if (!preserveRemaining) {
                    pausedDismissRemainingMs = null;
                }
                clearTimeout(dismissTimer);
                dismissTimer = null;
                dismissDeadline = null;
            } else if (!preserveRemaining) {
                pausedDismissRemainingMs = null;
            }
        }

        function scheduleAutoDismiss() {
            if (isPageHidden()) {
                if (dismissTimer !== null) {
                    clearDismissTimer({ preserveRemaining: true });
                }
                return;
            }
            if (
                autoHideCancelledPermanently ||
                pickerOpened ||
                isHovered ||
                isTagInputFocused ||
                isUpdatingFavorite ||
                isDeletingBookmark ||
                isCapturingScreenshot ||
                pendingTagOps > 0
            ) {
                clearDismissTimer();
                return;
            }
            if (activeScreen !== 'saved' && activeScreen !== 'existing') {
                clearDismissTimer();
                return;
            }
            const timeoutMs = getOverlayTimeoutMs();
            if (timeoutMs <= 0) {
                clearDismissTimer();
                return;
            }

            const delayMs = pausedDismissRemainingMs !== null
                ? Math.min(timeoutMs, Math.max(500, pausedDismissRemainingMs))
                : timeoutMs;

            clearDismissTimer();
            dismissDeadline = Date.now() + delayMs;
            dismissTimer = setTimeout(() => {
                dismissTimer = null;
                dismissDeadline = null;
                pausedDismissRemainingMs = null;
                minimize();
            }, delayMs);
        }

        function handleVisibilityChange() {
            if (isPageHidden()) {
                if (dismissTimer !== null) {
                    clearDismissTimer({ preserveRemaining: true });
                }
                return;
            }
            if (activeScreen !== 'idle') {
                ensureMounted();
            }
            if (activeScreen === 'saved' || activeScreen === 'existing') {
                scheduleAutoDismiss();
            }
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
            clearDismissTimer();
            ensureMounted();
            clearRoot();
            minimizedView = null;
            if (screenName !== 'picker') currentPickerErrorMsg = '';
            if (screenName !== 'settings') currentSettingsOptions = null;
            isTagInputFocused = false;
            isUpdatingFavorite = false;
            isDeletingBookmark = false;
            activeThumbBtn = null;
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
                if (
                    target.bookmark
                    && target.bookmark._id
                    && sanitizeMediaAndCover(target.bookmark).blockedCount > 0
                    && typeof callbacks.onSaveNow === 'function'
                ) {
                    callbacks.onSaveNow();
                    return;
                }
                const latestCandidates = typeof callbacks.getCandidates === 'function'
                    ? callbacks.getCandidates(target.bookmark)
                    : target.candidates;
                showSaved(target.bookmark, {
                    existing: target.type === 'existing',
                    candidates: latestCandidates,
                    capturingScreenshot: Boolean(target.capturingScreenshot),
                    preserveAutoHide: true
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
            autoHideCancelledPermanently = false;
            isHovered = false;
            returnView = { type: 'none' };
            const card = buildCard('notice');
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

        function renderThumbButtonContent(thumbBtn, bookmark, capturing = false) {
            if (!thumbBtn) return;
            while (thumbBtn.firstChild) {
                thumbBtn.removeChild(thumbBtn.firstChild);
            }

            const renderPlaceholder = () => {
                while (thumbBtn.firstChild) thumbBtn.removeChild(thumbBtn.firstChild);
                if (capturing) {
                    const stack = el('span', 'thumb-placeholder-stack');
                    stack.setAttribute('data-role', 'thumb-capturing');
                    stack.appendChild(el('span', 'spinner'));
                    stack.appendChild(el('span', '', 'Capturing…'));
                    thumbBtn.appendChild(stack);
                } else {
                    thumbBtn.appendChild(el('span', 'thumb-placeholder', 'No cover'));
                }
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
        }

        function showSaved(bookmark, {
            existing = false,
            candidates = [],
            forceRender = false,
            capturingScreenshot = false,
            preserveAutoHide = false
        } = {}) {
            currentBookmark = bookmark;
            currentWasExisting = existing;
            currentCandidates = Array.isArray(candidates) ? candidates : [];
            pickerOpened = false;
            if (!preserveAutoHide) {
                autoHideCancelledPermanently = false;
            }
            isUpdatingThumb = false;
            isCapturingScreenshot = Boolean(capturingScreenshot);

            const screenName = existing ? 'existing' : 'saved';
            returnView = {
                type: screenName,
                bookmark: currentBookmark,
                candidates: currentCandidates,
                capturingScreenshot: isCapturingScreenshot
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
            activeThumbBtn = thumbBtn;
            renderThumbButtonContent(thumbBtn, bookmark, isCapturingScreenshot);

            thumbBtn.addEventListener('click', () => {
                if (isDeletingBookmark) return;
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

                const deleteBtn = el('button', 'delete-btn', 'Delete');
                deleteBtn.type = 'button';
                deleteBtn.setAttribute('data-role', 'delete-btn');
                deleteBtn.setAttribute('aria-label', 'Delete bookmark');
                deleteBtn.title = 'Move bookmark to Trash';

                const syncFavoriteButton = () => {
                    const isFav = Boolean(currentBookmark && currentBookmark.important);
                    favBtn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
                    favBtn.setAttribute('aria-busy', isUpdatingFavorite ? 'true' : 'false');
                    favBtn.disabled = isUpdatingFavorite || isDeletingBookmark;
                    favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
                    favBtn.textContent = isFav ? '♥ Fav' : '♡ Fav';
                };

                const syncDeleteButton = () => {
                    deleteBtn.setAttribute('aria-busy', isDeletingBookmark ? 'true' : 'false');
                    deleteBtn.disabled = isDeletingBookmark;
                    deleteBtn.textContent = isDeletingBookmark ? 'Deleting…' : 'Delete';
                };

                syncFavoriteButton();
                syncDeleteButton();

                favBtn.addEventListener('click', async () => {
                    if (isUpdatingFavorite || isDeletingBookmark || !currentBookmark || !currentBookmark._id) return;
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

                deleteBtn.addEventListener('click', async () => {
                    if (isDeletingBookmark || !currentBookmark || !currentBookmark._id) return;
                    isDeletingBookmark = true;
                    clearDismissTimer();
                    hideActionError();
                    syncDeleteButton();
                    syncFavoriteButton();

                    let deleted = false;
                    try {
                        await callbacks.onDeleteBookmark(currentBookmark);
                        deleted = true;
                        if (cardEpoch !== renderEpoch) return;
                        currentBookmark = null;
                        showNotice('Deleted');
                    } catch (err) {
                        logError('Failed to delete bookmark', {
                            url: currentBookmark && currentBookmark.link,
                            bookmarkId: currentBookmark && currentBookmark._id,
                            error: err
                        });
                        if (cardEpoch !== renderEpoch) return;
                        showActionError((err && err.message) || 'Failed to delete bookmark.');
                    } finally {
                        if (!deleted && cardEpoch === renderEpoch) {
                            isDeletingBookmark = false;
                            syncDeleteButton();
                            syncFavoriteButton();
                            scheduleAutoDismiss();
                        }
                    }
                });

                const openLink = el('a', 'open-link', 'Open ↗');
                openLink.setAttribute('data-role', 'open-link');
                openLink.title = 'Open in Raindrop';
                const cid = getBookmarkCollectionId(bookmark);
                openLink.href = `${APP_BASE_URL}/my/${cid}/item/${encodeURIComponent(bookmark._id)}/edit`;
                openLink.target = '_blank';
                openLink.rel = 'noopener noreferrer';

                footer.appendChild(favBtn);
                footer.appendChild(deleteBtn);
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
                            if (isDeletingBookmark || !currentBookmark || !currentBookmark._id) return;
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
                    if (isDeletingBookmark || !currentBookmark || !currentBookmark._id) return;
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

        function finishAutoScreenshot(bookmark, candidates) {
            isCapturingScreenshot = false;
            if (bookmark) {
                currentBookmark = bookmark;
            }
            if (Array.isArray(candidates)) {
                currentCandidates = candidates;
            }
            if (returnView && (returnView.type === 'saved' || returnView.type === 'existing')) {
                returnView.bookmark = currentBookmark;
                returnView.candidates = currentCandidates;
                returnView.capturingScreenshot = false;
            }
            if (minimizedView && (minimizedView.type === 'saved' || minimizedView.type === 'existing' || minimizedView.type === 'picker')) {
                minimizedView.bookmark = currentBookmark;
                minimizedView.candidates = currentCandidates;
                if (minimizedView.type !== 'picker') {
                    minimizedView.capturingScreenshot = false;
                }
            }

            if (activeScreen === 'saved' && activeThumbBtn) {
                renderThumbButtonContent(activeThumbBtn, currentBookmark, false);
                scheduleAutoDismiss();
            } else if (activeScreen === 'picker' && !isUpdatingThumb) {
                showPicker(currentBookmark, currentCandidates);
            }
        }

        function createCaptureTileIcon() {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('class', 'capture-tile-icon');
            svg.setAttribute('aria-hidden', 'true');

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z');
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '13');
            circle.setAttribute('r', '4');

            svg.appendChild(path);
            svg.appendChild(circle);
            return svg;
        }

        function showPicker(bookmark, candidates, pickerErrorMsg = '') {
            currentBookmark = bookmark;
            currentCandidates = Array.isArray(candidates) ? candidates : [];
            currentPickerErrorMsg = pickerErrorMsg || '';
            pickerOpened = true;
            autoHideCancelledPermanently = true;
            clearDismissTimer();

            const card = buildCard('picker');
            const pickerEpoch = renderEpoch;

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
                    candidates: currentCandidates,
                    capturingScreenshot: isCapturingScreenshot,
                    preserveAutoHide: true
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
                body.appendChild(el('p', 'picker-hint', 'No candidate thumbnails found on this page.'));
            }

            const grid = el('div', 'grid-wrap');
            grid.setAttribute('data-role', 'thumb-grid');
            const optionButtons = [];
            const blockButtons = [];

            const lockGridWithSpinner = (targetBtn) => {
                for (const btn of optionButtons) {
                    btn.disabled = true;
                }
                for (const btn of blockButtons) {
                    btn.disabled = true;
                }
                const spinnerWrap = el('div', 'tile-spinner');
                spinnerWrap.appendChild(el('span', 'spinner'));
                targetBtn.appendChild(spinnerWrap);
            };

            for (const link of currentCandidates) {
                const tileWrap = el('div', 'thumb-tile');
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
                    lockGridWithSpinner(optionBtn);

                    try {
                        const updated = await callbacks.onSelectThumbnail(currentBookmark, link);
                        if (pickerEpoch !== renderEpoch) return;
                        currentBookmark = updated || currentBookmark;
                        const refreshedCandidates = typeof callbacks.getCandidates === 'function'
                            ? callbacks.getCandidates(currentBookmark)
                            : currentCandidates;
                        showSaved(currentBookmark, {
                            existing: currentWasExisting,
                            candidates: refreshedCandidates,
                            preserveAutoHide: true
                        });
                    } catch (err) {
                        logError('Failed to update thumbnail', {
                            url: currentBookmark && currentBookmark.link,
                            bookmarkId: currentBookmark && currentBookmark._id,
                            candidateLink: link,
                            error: err
                        });
                        if (pickerEpoch !== renderEpoch) return;
                        isUpdatingThumb = false;
                        showPicker(
                            currentBookmark,
                            currentCandidates,
                            (err && err.message) || 'Failed to update thumbnail'
                        );
                    }
                });

                optionButtons.push(optionBtn);
                tileWrap.appendChild(optionBtn);

                if (link !== '<screenshot>' && typeof callbacks.onBlockThumbnail === 'function') {
                    const blockBtn = el('button', 'thumb-block-btn', 'Block');
                    blockBtn.type = 'button';
                    blockBtn.setAttribute('data-role', 'thumb-block-btn');
                    blockBtn.setAttribute('data-link', link);
                    blockBtn.setAttribute('aria-label', `Block thumbnail ${link}`);
                    blockBtn.title = 'Block this image URL from being picked as thumbnail';

                    blockBtn.addEventListener('click', async (e) => {
                        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                        if (e && typeof e.preventDefault === 'function') e.preventDefault();
                        if (isUpdatingThumb) return;
                        isUpdatingThumb = true;
                        lockGridWithSpinner(optionBtn);

                        try {
                            const result = await callbacks.onBlockThumbnail(currentBookmark, link);
                            if (pickerEpoch !== renderEpoch) return;
                            if (result && result.bookmark) {
                                currentBookmark = result.bookmark;
                            }
                            const refreshedCandidates = (result && Array.isArray(result.candidates))
                                ? result.candidates
                                : (typeof callbacks.getCandidates === 'function'
                                    ? callbacks.getCandidates(currentBookmark)
                                    : currentCandidates.filter((c) => c !== link));

                            if (returnView && (returnView.type === 'saved' || returnView.type === 'existing')) {
                                returnView.bookmark = currentBookmark;
                                returnView.candidates = refreshedCandidates;
                            }

                            if (result && result.tookScreenshot) {
                                isCapturingScreenshot = false;
                                showSaved(currentBookmark, {
                                    existing: currentWasExisting,
                                    candidates: refreshedCandidates,
                                    preserveAutoHide: true
                                });
                                return;
                            }

                            isUpdatingThumb = false;
                            showPicker(currentBookmark, refreshedCandidates);
                        } catch (err) {
                            logError('Failed to block thumbnail', {
                                url: currentBookmark && currentBookmark.link,
                                bookmarkId: currentBookmark && currentBookmark._id,
                                candidateLink: link,
                                error: err
                            });
                            if (pickerEpoch !== renderEpoch) return;
                            isUpdatingThumb = false;
                            const refreshedCandidates = typeof callbacks.getCandidates === 'function'
                                ? callbacks.getCandidates(currentBookmark)
                                : currentCandidates.filter((c) => c !== link);
                            showPicker(
                                currentBookmark,
                                refreshedCandidates,
                                (err && err.message) || 'Failed to block thumbnail'
                            );
                        }
                    });

                    blockButtons.push(blockBtn);
                    tileWrap.appendChild(blockBtn);
                }

                grid.appendChild(tileWrap);
            }

            const captureBtn = el('button', 'thumb-option capture-tile');
            captureBtn.type = 'button';
            captureBtn.setAttribute('data-role', 'capture-screenshot-btn');
            captureBtn.title = 'Capture page screenshot';
            captureBtn.appendChild(createCaptureTileIcon());
            captureBtn.appendChild(el('span', '', 'Screenshot'));

            captureBtn.addEventListener('click', async () => {
                if (isUpdatingThumb) return;
                isUpdatingThumb = true;
                lockGridWithSpinner(captureBtn);

                try {
                    const updated = await callbacks.onCaptureScreenshot(currentBookmark);
                    if (pickerEpoch !== renderEpoch) return;
                    currentBookmark = updated || currentBookmark;
                    isCapturingScreenshot = false;
                    const refreshedCandidates = typeof callbacks.getCandidates === 'function'
                        ? callbacks.getCandidates(currentBookmark)
                        : currentCandidates;
                    showSaved(currentBookmark, {
                        existing: currentWasExisting,
                        candidates: refreshedCandidates,
                        preserveAutoHide: true
                    });
                } catch (err) {
                    logError('Failed to capture screenshot thumbnail', {
                        url: currentBookmark && currentBookmark.link,
                        bookmarkId: currentBookmark && currentBookmark._id,
                        error: err
                    });
                    if (pickerEpoch !== renderEpoch) return;
                    isUpdatingThumb = false;
                    showPicker(
                        currentBookmark,
                        currentCandidates,
                        (err && err.message) || 'Failed to capture screenshot'
                    );
                }
            });

            optionButtons.push(captureBtn);
            grid.appendChild(captureBtn);
            body.appendChild(grid);

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
            currentSettingsOptions = {
                focusToken: Boolean(focusToken),
                feedback: feedback || '',
                feedbackKind: feedbackKind || ''
            };

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

            // 5. Blocked Thumbnail URL Patterns
            const blockedThumbsField = el('div', 'field');
            blockedThumbsField.appendChild(el('label', 'field-label', 'Blocked Thumbnail URL Patterns (one per line)'));
            const blockedThumbsInput = el('textarea', 'field-textarea');
            blockedThumbsInput.rows = 3;
            blockedThumbsInput.placeholder = 'https://abs.twimg.com/.../default-og.jpg\n*://example.com/default-og*';
            blockedThumbsInput.value = getBlockedThumbnails().join('\n');
            blockedThumbsInput.setAttribute('data-role', 'setting-blocked-thumbnails');
            blockedThumbsField.appendChild(blockedThumbsInput);
            blockedThumbsField.appendChild(el(
                'span',
                'field-hint',
                'Matching image URLs are skipped as thumbnails; takes a screenshot if no image remains. Supports * / ? wildcards, /regex/flags, or substring.'
            ));
            form.appendChild(blockedThumbsField);

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
                    excludes: excludesInput.value,
                    blockedThumbnails: blockedThumbsInput.value
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

        function createDropletIcon() {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('class', 'mini-icon');
            svg.setAttribute('aria-hidden', 'true');

            const drop = document.createElementNS(SVG_NS, 'path');
            drop.setAttribute('fill', 'currentColor');
            drop.setAttribute('d', 'M12 2.5C12 2.5 5.5 10.1 5.5 14.5a6.5 6.5 0 0 0 13 0c0-4.4-6.5-12-6.5-12z');

            const highlight = document.createElementNS(SVG_NS, 'path');
            highlight.setAttribute('fill', 'none');
            highlight.setAttribute('stroke', '#ffffff');
            highlight.setAttribute('stroke-width', '1.6');
            highlight.setAttribute('stroke-linecap', 'round');
            highlight.setAttribute('opacity', '0.75');
            highlight.setAttribute('d', 'M9.2 14.4a2.9 2.9 0 0 0 2.6 2.9');

            svg.appendChild(drop);
            svg.appendChild(highlight);
            return svg;
        }

        function createCloseIcon() {
            const svg = document.createElementNS(SVG_NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2.2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('class', 'mini-icon');
            svg.setAttribute('aria-hidden', 'true');

            const line1 = document.createElementNS(SVG_NS, 'line');
            line1.setAttribute('x1', '6');
            line1.setAttribute('y1', '6');
            line1.setAttribute('x2', '18');
            line1.setAttribute('y2', '18');

            const line2 = document.createElementNS(SVG_NS, 'line');
            line2.setAttribute('x1', '18');
            line2.setAttribute('y1', '6');
            line2.setAttribute('x2', '6');
            line2.setAttribute('y2', '18');

            svg.appendChild(line1);
            svg.appendChild(line2);
            return svg;
        }

        function captureCurrentViewSnapshot() {
            if (activeScreen === 'saved' || activeScreen === 'existing') {
                return {
                    type: activeScreen,
                    bookmark: currentBookmark,
                    candidates: currentCandidates,
                    capturingScreenshot: isCapturingScreenshot
                };
            }
            if (activeScreen === 'picker') {
                return {
                    type: 'picker',
                    bookmark: currentBookmark,
                    candidates: currentCandidates,
                    pickerErrorMsg: currentPickerErrorMsg
                };
            }
            if (activeScreen === 'settings') {
                return {
                    type: 'settings',
                    settingsOptions: currentSettingsOptions || {}
                };
            }
            if (activeScreen === 'error') {
                return {
                    type: 'error',
                    err: returnView && returnView.type === 'error' ? returnView.err : null,
                    url: returnView && returnView.type === 'error' ? returnView.url : ''
                };
            }
            return null;
        }

        function minimize() {
            if (activeScreen === 'minimized') return;
            const snapshot = captureCurrentViewSnapshot();
            if (!snapshot) {
                hide();
                return;
            }

            clearDismissTimer();
            pickerOpened = false;
            isHovered = false;
            isTagInputFocused = false;
            isUpdatingThumb = false;
            isUpdatingFavorite = false;
            isDeletingBookmark = false;
            activeThumbBtn = null;
            pendingTagOps = 0;
            renderEpoch++;
            minimizedView = snapshot;
            activeScreen = 'minimized';

            ensureMounted();
            clearRoot();

            const bar = el('div', 'mini-bar');
            bar.setAttribute('data-screen', 'minimized');
            bar.setAttribute('data-role', 'mini-bar');

            const showBtn = el('button', 'mini-btn mini-show-btn');
            showBtn.type = 'button';
            showBtn.setAttribute('data-role', 'show-overlay-btn');
            showBtn.setAttribute('aria-label', 'Show Raindrop overlay');
            showBtn.title = 'Show Raindrop overlay';
            showBtn.appendChild(createDropletIcon());
            showBtn.addEventListener('click', () => restoreMinimized());

            const removeBtn = el('button', 'mini-btn mini-remove-btn');
            removeBtn.type = 'button';
            removeBtn.setAttribute('data-role', 'remove-overlay-btn');
            removeBtn.setAttribute('aria-label', 'Remove overlay from page');
            removeBtn.title = 'Remove overlay from page';
            removeBtn.appendChild(createCloseIcon());
            removeBtn.addEventListener('click', () => hide());

            bar.appendChild(showBtn);
            bar.appendChild(removeBtn);
            rootEl.appendChild(bar);
        }

        function restoreMinimized() {
            if (activeScreen !== 'minimized' || !minimizedView) return;
            const target = minimizedView;
            minimizedView = null;
            autoHideCancelledPermanently = true;
            clearDismissTimer();

            if (target.type === 'saved' || target.type === 'existing') {
                const latestCandidates = typeof callbacks.getCandidates === 'function'
                    ? callbacks.getCandidates(target.bookmark)
                    : target.candidates;
                showSaved(target.bookmark, {
                    existing: target.type === 'existing',
                    candidates: latestCandidates,
                    forceRender: true,
                    capturingScreenshot: isCapturingScreenshot,
                    preserveAutoHide: true
                });
                return;
            }
            if (target.type === 'picker') {
                const latestCandidates = typeof callbacks.getCandidates === 'function'
                    ? callbacks.getCandidates(target.bookmark)
                    : target.candidates;
                showPicker(target.bookmark, latestCandidates, target.pickerErrorMsg || '');
                return;
            }
            if (target.type === 'settings') {
                showSettings(target.settingsOptions || {});
                return;
            }
            if (target.type === 'error') {
                showError(target.err, target.url);
                return;
            }
            hide();
        }

        function hide() {
            clearDismissTimer();
            pickerOpened = false;
            autoHideCancelledPermanently = false;
            isHovered = false;
            isTagInputFocused = false;
            isUpdatingThumb = false;
            isUpdatingFavorite = false;
            isDeletingBookmark = false;
            isCapturingScreenshot = false;
            activeThumbBtn = null;
            pendingTagOps = 0;
            renderEpoch++;
            activeScreen = 'idle';
            minimizedView = null;
            currentPickerErrorMsg = '';
            currentSettingsOptions = null;
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
                canRestore: Boolean(minimizedView),
                minimizedViewType: minimizedView ? minimizedView.type : null,
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
            finishAutoScreenshot,
            showPicker,
            showError,
            showSettings,
            minimize,
            restore: restoreMinimized,
            hide,
            handleVisibilityChange,
            getState
        };
    }

    // -------------------------------------------------------------------------
    // Save Pipeline (mirrors draftLoad / createBookmark / enrichCreated / cover)
    // -------------------------------------------------------------------------
    const attemptedUrls = new Set();
    const savedBookmarksByUrl = new Map();
    const bookmarksById = new Map();
    const deletedBookmarkIds = new Set();
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

    function evictCachedBookmark(bookmark) {
        if (!bookmark) return;
        const bookmarkId = bookmark._id;
        if (bookmarkId !== undefined && bookmarkId !== null) {
            bookmarksById.delete(bookmarkId);
            for (const [cachedUrl, cachedItem] of savedBookmarksByUrl.entries()) {
                if (cachedItem && cachedItem._id === bookmarkId) {
                    savedBookmarksByUrl.delete(cachedUrl);
                }
            }
        }
        if (bookmark.link && savedBookmarksByUrl.get(bookmark.link) === bookmark) {
            savedBookmarksByUrl.delete(bookmark.link);
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
    let pendingSaveUrl = null;
    let pendingSaveDueAt = 0;
    let initialSaveTriggered = false;
    let domObserverAttached = false;
    let domReadyListenerCleanup = null;
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

        const nextExcludes = normalizePatternList(values.excludes);
        for (const pattern of nextExcludes) {
            if (!compileExcludeMatcher(pattern)) {
                return { ok: false, error: `Invalid exclude pattern: ${pattern}` };
            }
        }

        const hasBlockedThumbnailsField = Object.prototype.hasOwnProperty.call(values, 'blockedThumbnails');
        let nextBlockedThumbnails;
        if (hasBlockedThumbnailsField) {
            nextBlockedThumbnails = normalizePatternList(values.blockedThumbnails, { deduplicate: true });
            for (const pattern of nextBlockedThumbnails) {
                if (!compileUrlPatternMatcher(pattern, 'blocked thumbnail')) {
                    return { ok: false, error: `Invalid blocked thumbnail pattern: ${pattern}` };
                }
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
        if (hasBlockedThumbnailsField) {
            gmSet(STORAGE_KEYS.blockedThumbnails, nextBlockedThumbnails);
        }

        if (!nextEnabled) {
            cancelPendingSave();
        }

        if (nextDebug) {
            logDebug('Settings updated via overlay', {
                enabled: nextEnabled,
                collectionId: nextCollection,
                overlayTimeoutMs: nextTimeout,
                spaDelayMs: nextSpaDelay,
                excludeCount: nextExcludes.length,
                blockedThumbnailCount: hasBlockedThumbnailsField
                    ? nextBlockedThumbnails.length
                    : getBlockedThumbnails().length
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
        async onBlockThumbnail(bookmark, link) {
            return blockThumbnailUrl(bookmark, link);
        },
        async onCaptureScreenshot(bookmark) {
            const targetUrl = (bookmark && bookmark.link) || (typeof location !== 'undefined' ? location.href : '');
            return captureAndSaveScreenshot(bookmark, targetUrl, {
                allowClientCapture: typeof location === 'undefined' || !targetUrl || location.href === targetUrl
            });
        },
        async onToggleFavorite(bookmark) {
            return toggleFavorite(bookmark);
        },
        async onDeleteBookmark(bookmark) {
            const res = await deleteBookmark(bookmark);
            uiEpoch++;
            return res;
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

    async function enrichCreated(url, createdItem, options = {}) {
        if (!url || !createdItem || !createdItem._id) return createdItem;

        const matchers = getBlockedThumbnailMatchers();
        const createdSanitized = sanitizeMediaAndCover(createdItem, matchers);
        const changed = {};
        let parsedBlockedCount = 0;

        if (createdSanitized.mediaBlocked) {
            changed.media = createdSanitized.media;
        }
        if (createdSanitized.coverBlocked) {
            changed.cover = createdSanitized.cover;
        }

        try {
            const parse = await apiRequest('GET', `import/url/parse?url=${encodeURIComponent(url)}`);
            if (parse && !parse.error && parse.item) {
                const parsedSanitized = sanitizeMediaAndCover(parse.item, matchers);
                parsedBlockedCount = parsedSanitized.blockedCount;
                if (parsedBlockedCount > 0) {
                    logDebug('Filtered blocked thumbnails from import/url/parse', {
                        url,
                        bookmarkId: createdItem._id,
                        blockedCount: parsedBlockedCount
                    });
                }

                const effectiveMedia = changed.media !== undefined
                    ? changed.media
                    : (Array.isArray(createdItem.media) ? createdItem.media : []);
                const effectiveCover = changed.cover !== undefined
                    ? changed.cover
                    : (typeof createdItem.cover === 'string' ? createdItem.cover.trim() : '');

                if (parsedSanitized.media.length && !effectiveMedia.length) {
                    changed.media = parsedSanitized.media;
                }
                if (!effectiveCover && parsedSanitized.cover) {
                    changed.cover = parsedSanitized.cover;
                }

                if (parse.item.type && (!createdItem.type || (createdItem.type === 'link' && parse.item.type !== 'link'))) {
                    changed.type = parse.item.type;
                }
                if (!createdItem.excerpt && parse.item.excerpt) {
                    changed.excerpt = String(parse.item.excerpt).slice(0, 10000);
                }
            }
        } catch (e) {
            logWarn('Post-create metadata enrichment failed (non-fatal)', {
                url,
                bookmarkId: createdItem._id,
                error: e
            });
        }

        const finalEffectiveCover = changed.cover !== undefined
            ? changed.cover
            : (createdSanitized.coverBlocked ? '' : createdItem.cover);

        if (
            createdSanitized.blockedCount > 0
            || parsedBlockedCount > 0
            || (options.sentPleaseParse && !finalEffectiveCover)
        ) {
            changed.pleaseParse = null;
        }

        if (!Object.keys(changed).length) {
            return createdItem;
        }

        try {
            logDebug('Enriching created bookmark via PUT', { url, bookmarkId: createdItem._id, fields: Object.keys(changed) });
            const updateRes = await apiRequest('PUT', `raindrop/${createdItem._id}`, changed);
            const merged = {
                ...createdItem,
                ...changed,
                ...(updateRes && updateRes.item ? updateRes.item : {})
            };
            if (changed.cover === '' && isThumbnailBlocked(merged.cover, matchers)) {
                merged.cover = '';
            }
            if (Array.isArray(changed.media) && !changed.media.length && Array.isArray(merged.media)) {
                const hasOnlyBlocked = merged.media.every((m) => !m || !m.link || isThumbnailBlocked(m.link, matchers));
                if (hasOnlyBlocked) merged.media = [];
            }
            return merged;
        } catch (e) {
            logWarn('Post-create metadata update failed (non-fatal)', {
                url,
                bookmarkId: createdItem._id,
                error: e
            });
            if (createdSanitized.blockedCount > 0) {
                return {
                    ...createdItem,
                    ...changed
                };
            }
            return createdItem;
        }
    }

    function enqueueBookmarkMutation(bookmark, buildPatch) {
        if (!bookmark || !bookmark._id) {
            return Promise.reject(new Error('Cannot update bookmark before it is saved.'));
        }

        const bookmarkId = bookmark._id;
        if (deletedBookmarkIds.has(bookmarkId)) {
            return Promise.reject(new Error('Bookmark was deleted.'));
        }
        const prevQueue = bookmarkUpdateQueues.get(bookmarkId) || Promise.resolve();

        const nextOp = prevQueue.catch(() => {}).then(async () => {
            if (deletedBookmarkIds.has(bookmarkId)) {
                throw new Error('Bookmark was deleted.');
            }
            const latest = getLatestCachedBookmark(bookmark);
            const patch = await buildPatch(latest);
            if (!patch || (!patch.payload && typeof patch.send !== 'function')) {
                return latest;
            }
            if (deletedBookmarkIds.has(bookmarkId)) {
                throw new Error('Bookmark was deleted.');
            }

            const res = typeof patch.send === 'function'
                ? await patch.send(latest)
                : await apiRequest('PUT', `raindrop/${bookmarkId}`, patch.payload);
            if (deletedBookmarkIds.has(bookmarkId)) {
                throw new Error('Bookmark was deleted.');
            }
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

    function uploadBookmarkCover(bookmark, blobOrFile, filename = 'screenshot.jpg') {
        if (!blobOrFile) {
            return Promise.reject(new Error('No screenshot image provided.'));
        }
        if (typeof FormData === 'undefined') {
            return Promise.reject(new Error('FormData unavailable for cover upload.'));
        }

        return enqueueBookmarkMutation(bookmark, (latest) => {
            const formData = new FormData();
            if (typeof File !== 'undefined' && blobOrFile instanceof File) {
                formData.append('cover', blobOrFile);
            } else {
                formData.append('cover', blobOrFile, filename);
            }

            return {
                send: () => apiRequest('PUT', `raindrop/${latest._id}/cover`, formData, {
                    timeout: Math.max(API_TIMEOUT, 60000)
                }),
                finalize: (_updated, serverItem) => ({
                    cover: serverItem.cover || latest.cover,
                    media: Array.isArray(serverItem.media) && serverItem.media.length
                        ? serverItem.media
                        : latest.media
                })
            };
        });
    }

    async function captureAndSaveScreenshot(bookmark, targetUrl, options = {}) {
        if (!bookmark || !bookmark._id) {
            throw new Error('Cannot attach screenshot before bookmark is saved.');
        }

        const allowClientCapture = options.allowClientCapture !== false;
        const samePage = typeof location === 'undefined' || !targetUrl || location.href === targetUrl;

        if (allowClientCapture && samePage) {
            const captured = await captureSimpleViewportScreenshot();
            if (captured && captured.blob) {
                try {
                    logDebug('Uploading viewport page screenshot cover', {
                        url: targetUrl || bookmark.link,
                        bookmarkId: bookmark._id,
                        method: captured.method,
                        width: captured.width,
                        height: captured.height,
                        sizeBytes: captured.blob.size
                    });
                    return await uploadBookmarkCover(bookmark, captured.blob, 'screenshot.jpg');
                } catch (err) {
                    if (err && err.status === 401) {
                        throw err;
                    }
                    logWarn('Cover upload failed; falling back to Raindrop <screenshot>', {
                        url: targetUrl || bookmark.link,
                        bookmarkId: bookmark._id,
                        error: err
                    });
                }
            }
        }

        logDebug('Applying Raindrop server <screenshot> fallback', {
            url: targetUrl || bookmark.link,
            bookmarkId: bookmark._id
        });
        return selectThumbnail(bookmark, '<screenshot>', {
            stripBlocked: Boolean(options.stripBlocked)
        });
    }

    function selectThumbnail(bookmark, link, options = {}) {
        return enqueueBookmarkMutation(bookmark, (latest) => {
            const matchers = options.stripBlocked ? getBlockedThumbnailMatchers() : null;
            const rawMedia = Array.isArray(latest.media) ? latest.media : [];
            const currentMedia = matchers
                ? rawMedia.filter((m) => m && m.link && !isThumbnailBlocked(m.link, matchers))
                : rawMedia;
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

    async function reconcileBookmarkBlockedThumbnails(bookmark, targetUrl, options = {}) {
        const matchers = getBlockedThumbnailMatchers();
        const latest = getLatestCachedBookmark(bookmark);
        const cachedMeta = targetUrl ? scrapedMetaByUrl.get(targetUrl) : null;

        if (cachedMeta) {
            const sanitizedMeta = sanitizeMediaAndCover(cachedMeta, matchers);
            if (sanitizedMeta.blockedCount > 0) {
                const nextMeta = { ...cachedMeta };
                if (sanitizedMeta.cover) nextMeta.cover = sanitizedMeta.cover;
                else delete nextMeta.cover;
                if (sanitizedMeta.media.length) nextMeta.media = sanitizedMeta.media;
                else delete nextMeta.media;
                scrapedMetaByUrl.set(targetUrl, nextMeta);
            }
        }

        const latestSanitized = sanitizeMediaAndCover(latest, matchers);
        const candidatesAfter = buildCandidateImages(latest, targetUrl ? scrapedMetaByUrl.get(targetUrl) : null);
        const remainingImages = candidatesAfter.filter((c) => c && c !== '<screenshot>');

        const currentCover = String((latest && latest.cover) || '').trim();
        const coverBlockedNow = Boolean(currentCover && isThumbnailBlocked(currentCover, matchers));
        const shouldReplaceCover = coverBlockedNow
            || (Boolean(options.forceReplaceEmptyCover) && !currentCover && remainingImages.length === 0);

        let updatedBookmark = latest;
        let needsScreenshot = false;

        if (latest && latest._id) {
            if (shouldReplaceCover) {
                if (remainingImages.length > 0) {
                    const nextCover = remainingImages[0];
                    updatedBookmark = await enqueueBookmarkMutation(latest, (cur) => {
                        const curSanitized = sanitizeMediaAndCover(cur, matchers);
                        const nextMedia = curSanitized.media.some((m) => m && m.link === nextCover)
                            ? curSanitized.media
                            : [...curSanitized.media, { link: nextCover }];
                        return {
                            payload: { cover: nextCover, media: nextMedia, pleaseParse: null },
                            fallback: { cover: nextCover, media: nextMedia },
                            finalize: (_u, serverItem) => ({
                                cover: (serverItem.cover && !isThumbnailBlocked(serverItem.cover, matchers))
                                    ? serverItem.cover
                                    : nextCover,
                                media: Array.isArray(serverItem.media)
                                    ? serverItem.media.filter((m) => m && m.link && !isThumbnailBlocked(m.link, matchers))
                                    : nextMedia
                            })
                        };
                    });
                } else {
                    if (coverBlockedNow || latestSanitized.mediaBlocked) {
                        updatedBookmark = await enqueueBookmarkMutation(latest, (cur) => {
                            const curSanitized = sanitizeMediaAndCover(cur, matchers);
                            return {
                                payload: { cover: '', media: curSanitized.media, pleaseParse: null },
                                fallback: { cover: '', media: curSanitized.media },
                                finalize: (_u, serverItem) => ({
                                    cover: (serverItem.cover && !isThumbnailBlocked(serverItem.cover, matchers))
                                        ? serverItem.cover
                                        : '',
                                    media: Array.isArray(serverItem.media)
                                        ? serverItem.media.filter((m) => m && m.link && !isThumbnailBlocked(m.link, matchers))
                                        : curSanitized.media
                                })
                            };
                        });
                    }
                    needsScreenshot = true;
                }
            } else if (latestSanitized.mediaBlocked) {
                updatedBookmark = await enqueueBookmarkMutation(latest, (cur) => {
                    const curSanitized = sanitizeMediaAndCover(cur, matchers);
                    return {
                        payload: { media: curSanitized.media, pleaseParse: null },
                        fallback: { media: curSanitized.media },
                        finalize: (_u, serverItem) => ({
                            media: Array.isArray(serverItem.media)
                                ? serverItem.media.filter((m) => m && m.link && !isThumbnailBlocked(m.link, matchers))
                                : curSanitized.media
                        })
                    };
                });
            }
        }

        const finalCandidates = buildCandidateImages(
            updatedBookmark,
            targetUrl ? scrapedMetaByUrl.get(targetUrl) : null
        );

        return {
            bookmark: updatedBookmark,
            candidates: finalCandidates,
            needsScreenshot,
            replacedCover: shouldReplaceCover
        };
    }

    async function blockThumbnailUrl(bookmark, linkToBlock, options = {}) {
        const target = String(linkToBlock || '').trim();
        if (!target || target === '<screenshot>') {
            throw new Error('Cannot block this thumbnail.');
        }

        const added = addBlockedThumbnailPattern(target);
        logDebug('Blocked thumbnail URL', {
            url: bookmark && bookmark.link,
            bookmarkId: bookmark && bookmark._id,
            blockedUrl: target,
            added
        });

        const latest = getLatestCachedBookmark(bookmark);
        const targetUrl = (latest && latest.link) || (typeof location !== 'undefined' ? location.href : '');
        const reconciled = await reconcileBookmarkBlockedThumbnails(latest, targetUrl, {
            forceReplaceEmptyCover: true
        });

        let updatedBookmark = reconciled.bookmark;
        let tookScreenshot = false;

        if (reconciled.needsScreenshot && updatedBookmark && updatedBookmark._id) {
            const allowClientCapture = options.allowClientCapture !== undefined
                ? Boolean(options.allowClientCapture)
                : (typeof location === 'undefined' || !targetUrl || location.href === targetUrl);
            updatedBookmark = await captureAndSaveScreenshot(updatedBookmark, targetUrl, {
                allowClientCapture,
                stripBlocked: true
            });
            tookScreenshot = true;
        }

        const finalCandidates = buildCandidateImages(
            updatedBookmark,
            targetUrl ? scrapedMetaByUrl.get(targetUrl) : null
        );

        return {
            bookmark: updatedBookmark,
            candidates: finalCandidates,
            tookScreenshot,
            replacedCover: reconciled.replacedCover
        };
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

    function deleteBookmark(bookmark) {
        if (!bookmark || !bookmark._id) {
            return Promise.reject(new Error('Cannot delete bookmark before it is saved.'));
        }

        const bookmarkId = bookmark._id;
        const prevQueue = bookmarkUpdateQueues.get(bookmarkId) || Promise.resolve();

        const nextOp = prevQueue.catch(() => {}).then(async () => {
            const latest = getLatestCachedBookmark(bookmark);
            if (deletedBookmarkIds.has(bookmarkId)) {
                evictCachedBookmark(latest);
                return { result: true, deletedId: bookmarkId };
            }

            logDebug('Deleting bookmark', {
                url: latest && latest.link,
                bookmarkId
            });

            const res = await apiRequest('DELETE', `raindrop/${encodeURIComponent(bookmarkId)}`);
            deletedBookmarkIds.add(bookmarkId);
            evictCachedBookmark(latest);

            return {
                ...(res && typeof res === 'object' ? res : {}),
                result: true,
                deletedId: bookmarkId
            };
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

    async function attachAutoScreenshot(bookmark, url, meta, myEpoch) {
        let finalItem = bookmark;
        try {
            const readyInfo = await waitForPageReadyForCapture(url);
            if (bookmark._id !== undefined && bookmark._id !== null && deletedBookmarkIds.has(bookmark._id)) {
                return finalItem;
            }
            const allowClientCapture = Boolean(readyInfo && readyInfo.ready)
                && (typeof location === 'undefined' || location.href === url);
            const latestItem = getLatestCachedBookmark(bookmark);

            if (!hasBookmarkThumbnail(latestItem)) {
                const updatedItem = await captureAndSaveScreenshot(latestItem, url, {
                    allowClientCapture,
                    stripBlocked: true
                });
                if (updatedItem && !(bookmark._id !== undefined && bookmark._id !== null && deletedBookmarkIds.has(bookmark._id))) {
                    finalItem = updatedItem;
                    cacheSavedBookmark(url, finalItem);
                }
            } else {
                finalItem = latestItem;
            }
        } catch (screenshotErr) {
            if (bookmark._id !== undefined && bookmark._id !== null && deletedBookmarkIds.has(bookmark._id)) {
                return finalItem;
            }
            if (screenshotErr && screenshotErr.status === 401) {
                throw screenshotErr;
            }
            logWarn('Auto-screenshot fallback failed (bookmark remains saved)', {
                url,
                bookmarkId: bookmark && bookmark._id,
                error: screenshotErr
            });
        } finally {
            if (myEpoch === uiEpoch && !(bookmark._id !== undefined && bookmark._id !== null && deletedBookmarkIds.has(bookmark._id))) {
                overlay.finishAutoScreenshot(finalItem, buildCandidateImages(finalItem, meta));
            }
        }
        return finalItem;
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

        if (manual && savedBookmarksByUrl.has(url)) {
            const cached = savedBookmarksByUrl.get(url);
            if (!sanitizeMediaAndCover(cached).blockedCount) {
                overlay.showSaved(cached, {
                    existing: true,
                    forceRender: true,
                    candidates: buildCandidateImages(cached, scrapedMetaByUrl.get(url))
                });
                return Promise.resolve(cached);
            }
            attemptedUrls.delete(url);
        }

        if (!force && attemptedUrls.has(url)) {
            return Promise.resolve(savedBookmarksByUrl.get(url) || null);
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
                    let existingItem = (loadRes && loadRes.item) || { _id: ids[0], link: url, ...meta };
                    if (existingItem._id !== undefined && existingItem._id !== null) {
                        deletedBookmarkIds.delete(existingItem._id);
                    }
                    cacheSavedBookmark(url, existingItem);

                    let needsExistingScreenshot = false;
                    const existingSanitized = sanitizeMediaAndCover(existingItem);
                    if (existingSanitized.blockedCount > 0) {
                        logDebug('Stripping blocked thumbnails from existing bookmark on revisit', {
                            url,
                            bookmarkId: existingItem._id,
                            blockedCount: existingSanitized.blockedCount
                        });
                        try {
                            const reconciled = await reconcileBookmarkBlockedThumbnails(existingItem, url, {
                                forceReplaceEmptyCover: Boolean(
                                    existingSanitized.mediaBlocked && !String(existingItem.cover || '').trim()
                                )
                            });
                            if (reconciled && reconciled.bookmark) {
                                existingItem = reconciled.bookmark;
                                cacheSavedBookmark(url, existingItem);
                            }
                            needsExistingScreenshot = Boolean(reconciled && reconciled.needsScreenshot);
                        } catch (stripErr) {
                            if (stripErr && stripErr.status === 401) throw stripErr;
                            logWarn('Failed to strip blocked thumbnails from existing bookmark (non-fatal)', {
                                url,
                                bookmarkId: existingItem && existingItem._id,
                                error: stripErr
                            });
                        }
                    }

                    if (myEpoch === uiEpoch) {
                        overlay.showSaved(existingItem, {
                            existing: true,
                            candidates: buildCandidateImages(existingItem, meta),
                            capturingScreenshot: needsExistingScreenshot
                        });
                    }

                    if (!needsExistingScreenshot) {
                        return existingItem;
                    }

                    return await attachAutoScreenshot(existingItem, url, meta, myEpoch);
                }

                // Step 2: Resolve collectionId (auto -> user.config or -1)
                const collectionId = await resolveTargetCollectionId();

                // Step 3: Build item & create bookmark (createBookmark parity)
                let item = {
                    collectionId,
                    ...meta,
                    link: url
                };

                const hasBlockedPatterns = getBlockedThumbnails().length > 0;
                let suppressServerParse = !item.cover && hasBlockedPatterns;

                if (item.title) {
                    if (!suppressServerParse) {
                        item.pleaseParse = { weight: 1 };
                    }
                } else {
                    const parsed = await apiRequest('GET', `import/url/parse?url=${encodeURIComponent(url)}`);
                    if (parsed && parsed.item) {
                        const sanitizedParsed = sanitizeMediaAndCover(parsed.item);
                        const parsedItem = { ...parsed.item };
                        if (sanitizedParsed.blockedCount > 0) {
                            logDebug('Filtered blocked thumbnails from pre-create parse', {
                                url,
                                blockedCount: sanitizedParsed.blockedCount
                            });
                            if (sanitizedParsed.cover) parsedItem.cover = sanitizedParsed.cover;
                            else delete parsedItem.cover;
                            if (sanitizedParsed.media.length) parsedItem.media = sanitizedParsed.media;
                            else delete parsedItem.media;
                        }
                        item = {
                            ...item,
                            ...parsedItem,
                            collectionId: item.collectionId,
                            link: item.link
                        };
                        if (!item.cover && hasBlockedPatterns) {
                            suppressServerParse = true;
                        }
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
                createdItem = await enrichCreated(url, createdItem, {
                    sentPleaseParse: Boolean(item.pleaseParse),
                    suppressServerParse
                });
                if (createdItem && createdItem._id !== undefined && createdItem._id !== null) {
                    deletedBookmarkIds.delete(createdItem._id);
                }
                cacheSavedBookmark(url, createdItem);
                logDebug('Bookmark saved', { url, bookmarkId: createdItem._id, collectionId: getBookmarkCollectionId(createdItem) });

                const needsScreenshot = !hasBookmarkThumbnail(createdItem);

                if (myEpoch === uiEpoch) {
                    overlay.showSaved(createdItem, {
                        existing: false,
                        candidates: buildCandidateImages(createdItem, meta),
                        capturingScreenshot: needsScreenshot
                    });
                }

                if (!needsScreenshot) {
                    return createdItem;
                }

                // Step 5: Auto-capture simple viewport page screenshot when no thumbnail was found
                return await attachAutoScreenshot(createdItem, url, meta, myEpoch);
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
    function isDomReady() {
        return typeof document !== 'undefined'
            && (document.readyState === 'interactive' || document.readyState === 'complete');
    }

    function cancelPendingSave() {
        if (pendingSaveTimer !== null) {
            clearTimeout(pendingSaveTimer);
            pendingSaveTimer = null;
        }
        pendingSaveUrl = null;
        pendingSaveDueAt = 0;
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
        if (waitMs === 0) {
            return saveCurrentUrl(targetUrl);
        }
        pendingSaveUrl = targetUrl;
        pendingSaveDueAt = Date.now() + waitMs;
        pendingSaveTimer = setTimeout(() => {
            pendingSaveTimer = null;
            pendingSaveUrl = null;
            pendingSaveDueAt = 0;
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

    function attachDomMutationObserver() {
        if (domObserverAttached) return;
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
        const target = document.documentElement || document;
        if (!target) return;

        domObserverAttached = true;
        const observer = new MutationObserver(() => {
            if (document.visibilityState === 'hidden') return;
            if (location.href !== lastObservedUrl) {
                handleUrlChange();
            }
        });
        observer.observe(target, {
            childList: true,
            subtree: true
        });
    }

    function cleanupDomReadyListeners() {
        if (typeof domReadyListenerCleanup === 'function') {
            domReadyListenerCleanup();
            domReadyListenerCleanup = null;
        }
    }

    function triggerInitialSave() {
        if (initialSaveTriggered) return;
        if (typeof document !== 'undefined' && document.prerendering) return;
        initialSaveTriggered = true;
        cleanupDomReadyListeners();
        attachDomMutationObserver();
        lastObservedUrl = location.href;
        scheduleSave(Math.min(INITIAL_LOAD_SETTLE_MS, getSpaDelayMs()), location.href);
    }

    function waitForDomReady() {
        if (initialSaveTriggered) return;
        if (typeof document !== 'undefined' && document.prerendering) return;
        if (isDomReady()) {
            triggerInitialSave();
            return;
        }
        if (domReadyListenerCleanup) return;

        const onReadyStateChange = () => {
            if (isDomReady()) {
                triggerInitialSave();
            }
        };

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', triggerInitialSave, { once: true });
            document.addEventListener('readystatechange', onReadyStateChange);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('load', triggerInitialSave, { once: true });
            window.addEventListener('pageshow', triggerInitialSave, { once: true });
        }

        domReadyListenerCleanup = () => {
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('DOMContentLoaded', triggerInitialSave);
                document.removeEventListener('readystatechange', onReadyStateChange);
            }
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('load', triggerInitialSave);
                window.removeEventListener('pageshow', triggerInitialSave);
            }
        };
    }

    function startOnReady() {
        if (typeof document !== 'undefined' && document.prerendering) {
            document.addEventListener('prerenderingchange', waitForDomReady, { once: true });
        } else {
            waitForDomReady();
        }
    }

    function initNavigationHooks() {
        window.addEventListener('popstate', handleUrlChange);
        window.addEventListener('hashchange', handleUrlChange);

        if (window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('navigatesuccess', handleUrlChange);
        }

        document.addEventListener('visibilitychange', () => {
            overlay.handleVisibilityChange();
            if (document.visibilityState !== 'hidden') {
                if (!initialSaveTriggered && !document.prerendering && isDomReady()) {
                    triggerInitialSave();
                } else if (
                    pendingSaveTimer !== null
                    && pendingSaveUrl === location.href
                    && Date.now() >= pendingSaveDueAt
                ) {
                    const targetUrl = pendingSaveUrl;
                    cancelPendingSave();
                    saveCurrentUrl(targetUrl);
                }
                handleUrlChange();
            }
        });

        window.addEventListener('pageshow', (event) => {
            if (!initialSaveTriggered && !document.prerendering && isDomReady()) {
                triggerInitialSave();
            } else if (event && event.persisted) {
                handleUrlChange();
            }
            overlay.handleVisibilityChange();
        });

        if (isDomReady()) {
            attachDomMutationObserver();
        }

        setInterval(() => {
            if (!initialSaveTriggered && !document.prerendering && isDomReady()) {
                triggerInitialSave();
            }
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
            blockThumbnailUrl,
            getBlockedThumbnails,
            isThumbnailBlocked,
            safeDecodeUri,
            extractRdlInnerUrl,
            sanitizeMediaAndCover,
            reconcileBookmarkBlockedThumbnails,
            uploadBookmarkCover,
            captureAndSaveScreenshot,
            captureSimpleViewportScreenshot,
            captureCenterPageScreenshot,
            captureViaForeignObject,
            captureViaDirectCanvas,
            isVideoShowingPoster,
            resolveVideoPosterUrl,
            loadPosterAsset,
            resolveVideoElementAsset,
            resolveViewportVideoAssets,
            canvasHasVisualContent,
            getViewportCaptureRect,
            getCenterCropRect,
            hasBookmarkThumbnail,
            waitForPageReadyForCapture,
            toggleFavorite,
            deleteBookmark,
            addBookmarkTags,
            removeBookmarkTag,
            normalizeTagsList,
            parseTagInput,
            mergeTags,
            saveCurrentUrl,
            scheduleSave,
            handleUrlChange,
            startOnReady,
            initNavigationHooks,
            isDomReady,
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
            DEFAULT_EXCLUDE_PATTERNS,
            DEFAULT_BLOCKED_THUMBNAILS
        });
    }

    registerMenuCommands();
    initNavigationHooks();
    startOnReady();
})();
