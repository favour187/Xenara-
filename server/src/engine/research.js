// Xenara Research — lets Xenara gather resources & data from the open web.
//
// Capabilities:
//   1. Web search (no API key needed by default via DuckDuckGo; optional
//      pluggable providers: Tavily, Brave — configured via env vars).
//   2. Fetch a page and extract clean, readable text.
//
// All network access is best-effort and time-limited so a slow site can't
// hang a chat response.

// A realistic browser User-Agent. Search engines serve their anti-bot landing
// page (no results) to obvious crawler UAs, so we present as a normal browser.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0';

const FETCH_TIMEOUT_MS = Number(process.env.XENARA_FETCH_TIMEOUT_MS || 9000);

async function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return ' ';
      }
    });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Search providers
// ---------------------------------------------------------------------------

function detectProvider() {
  if (process.env.XENARA_SEARCH_PROVIDER) return process.env.XENARA_SEARCH_PROVIDER;
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_API_KEY) return 'brave';
  return 'bing'; // keyless default (HTML scrape)
}

// Bing's result links are wrapped in a tracking redirect that base64-encodes
// the real destination after "u=a1". Decode it back to the original URL.
function unwrapBingUrl(href) {
  const u = href.replace(/&amp;/g, '&');
  const m = u.match(/u=a1([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch {
      /* ignore */
    }
  }
  return u;
}

// Keyless Bing HTML scrape — robust default provider.
async function searchBing(query, limit) {
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit + 3, 20)}`,
    { headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } }
  );
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  const html = await res.text();

  const results = [];
  const titleRe = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

  let m;
  let i = 0;
  while ((m = titleRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapBingUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    if (/^https?:\/\/(www\.)?bing\.com/.test(url)) continue; // skip internal
    results.push({ title, url, snippet: snippets[i] || '' });
    i++;
  }
  return results;
}

async function searchTavily(query, limit) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content || '',
  }));
}

async function searchBrave(query, limit) {
  const res = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY } }
  );
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: stripTags(r.description || ''),
  }));
}

function cleanDdgUrl(url) {
  // DuckDuckGo wraps targets in a redirect: /l/?uddg=<encoded>
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (uddg) url = decodeURIComponent(uddg[1]);
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

// Parse the rich html.duckduckgo.com results page.
function parseDdgHtml(html, limit) {
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = cleanDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    results.push({ title, url, snippet: snippets[i] || '' });
    i++;
  }
  return results;
}

// Parse the lightweight lite.duckduckgo.com results page (fallback).
function parseDdgLite(html, limit) {
  const results = [];
  const linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    const url = cleanDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    results.push({ title, url, snippet: snippets[i] || '' });
    i++;
  }
  return results;
}

// DuckDuckGo — no API key required. Tries the rich HTML endpoint first,
// then falls back to the lite endpoint if needed.
async function searchDuckDuckGo(query, limit) {
  const body = `q=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  try {
    const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers,
      body,
    });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseDdgHtml(html, limit);
      if (parsed.length) return parsed;
    }
  } catch {
    /* try lite */
  }

  const res = await fetchWithTimeout('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  return parseDdgLite(html, limit);
}

export function searchProviderInfo() {
  const provider = detectProvider();
  return {
    enabled: process.env.XENARA_WEB !== 'off',
    provider,
    keyless: provider === 'duckduckgo',
  };
}

export async function webSearch(query, limit = 5) {
  const provider = detectProvider();
  try {
    if (provider === 'tavily') return await searchTavily(query, limit);
    if (provider === 'brave') return await searchBrave(query, limit);
    if (provider === 'duckduckgo') return await searchDuckDuckGo(query, limit);
    return await searchBing(query, limit);
  } catch (err) {
    // Fall back across keyless providers if the primary fails.
    for (const fb of [searchBing, searchDuckDuckGo]) {
      try {
        const r = await fb(query, limit);
        if (r.length) return r;
      } catch {
        /* try next */
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Page fetching / readable extraction
// ---------------------------------------------------------------------------

export async function fetchReadable(url, maxChars = 4000) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Fetch ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('html') && !type.includes('text')) {
    throw new Error(`Unsupported content type: ${type}`);
  }
  let html = await res.text();

  // Remove non-content elements.
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ');

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : url;

  // Prefer <article> / <main> if present.
  const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0]
    || html.match(/<main[\s\S]*?<\/main>/i)?.[0]
    || html;

  const text = stripTags(article);
  return {
    url,
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

// ---------------------------------------------------------------------------
// High-level: gather context for a query
// ---------------------------------------------------------------------------

export async function gatherContext(query, { maxResults = 5, readTop = 3, maxCharsPer = 2200 } = {}) {
  const results = await webSearch(query, maxResults);
  if (!results.length) return { query, sources: [], context: '' };

  // Fetch readable text for the top N results in parallel.
  const toRead = results.slice(0, readTop);
  const reads = await Promise.allSettled(
    toRead.map((r) => fetchReadable(r.url, maxCharsPer))
  );

  const sources = results.map((r, i) => {
    const read = i < reads.length && reads[i].status === 'fulfilled' ? reads[i].value : null;
    return {
      n: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      content: read?.text || r.snippet || '',
    };
  });

  const context = sources
    .map(
      (s) =>
        `[#${s.n}] ${s.title}\nURL: ${s.url}\n${(s.content || '').slice(0, maxCharsPer)}`
    )
    .join('\n\n---\n\n');

  return { query, sources, context };
}
