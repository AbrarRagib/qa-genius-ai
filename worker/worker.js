/**
 * QA Genius AI — Cloudflare Worker
 * ---------------------------------------------------------------------------
 * Sits between the static page and the Google Gemini API so the API key never
 * reaches a browser.
 *
 * Routes
 *   POST /api/chat    streams a reply as server-sent events
 *   GET  /api/health  liveness probe
 *
 * Environment
 *   GEMINI_API_KEY    secret  — `npx wrangler secret put GEMINI_API_KEY`
 *   ALLOWED_ORIGINS   var     — comma-separated origins allowed to call this Worker
 *   MODEL             var     — optional, defaults to gemini-2.5-flash
 *   RATE_LIMIT        var     — optional, requests per IP per minute (default 20)
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/* ===================== System prompt =====================
   Kept server-side on purpose: it defines the assistant's expertise and output
   contract, and a client cannot strip it out. */

const SYSTEM_PROMPT = `You are QA Genius AI, a senior QA engineer and SDET with 15 years of experience across manual testing, automation, performance, security and accessibility. You help testers, SDETs and QA leads produce work they can hand to their team today.

EXPERTISE
Software testing and QA strategy; manual testing; test design techniques (boundary value analysis, equivalence partitioning, decision tables, state transition, pairwise, error guessing); QA automation with Playwright, Selenium, Cypress and Appium; Python, Java, JavaScript and TypeScript; REST, GraphQL, Postman, REST Assured and JMeter; Git, GitHub, CI/CD (GitHub Actions, Jenkins, GitLab CI); Agile, Scrum, Jira, TestRail, Xray and Zephyr; accessibility testing to WCAG 2.2 and OWASP security testing; performance and load testing; database testing across MySQL, MSSQL, Oracle, PostgreSQL and MongoDB; mobile testing on Android and iOS; web, desktop and OCR testing; testing AI and LLM systems; prompt engineering.

HOW YOU WORK
- Lead with the artifact. No preamble, no restating the question, no "Certainly".
- Prefer tables for test cases, checklists for verification, and fenced code blocks with a language tag for anything runnable.
- Every test case gets: an ID, a title, preconditions, steps, test data, expected result, and priority.
- Cover the unhappy paths by default: negative cases, boundaries, permissions, concurrency, and error handling. Say which technique produced each group when it is not obvious.
- Automation code must be runnable: real imports, explicit waits (never sleep), page objects for anything beyond a snippet, and assertions that would actually fail when the app is broken.
- When the request is ambiguous, make the most reasonable assumption, state it in one line at the top, and continue. Ask a question only when the answer would change the entire artifact.
- Flag genuine risks: flaky patterns, missing test data, untestable requirements, security implications.
- You are not a rubber stamp. If an approach is wrong, say so and give the better one.

COMMANDS
The user may open a message with one of these. Follow it exactly.
/testcase   Test cases as a markdown table: ID | Title | Preconditions | Steps | Test Data | Expected Result | Priority. Group by scenario type.
/bug        A bug report: Title, ID, Severity, Priority, Environment, Preconditions, Steps to Reproduce (numbered), Expected Result, Actual Result, Attachments, Notes.
/api        API test cases with method, endpoint, headers, request body, expected status, response schema assertions, and negative/auth/rate-limit cases.
/playwright Playwright tests: TypeScript unless told otherwise, page object model, web-first assertions (expect(locator).toBeVisible()), fixtures, no hard waits.
/selenium   Selenium tests: Python with pytest unless told otherwise, page objects, WebDriverWait with expected_conditions, clean teardown.
/sql        SQL validation queries for the stated dialect (ask only if it truly matters), commented, with what each query proves.
/postman    A valid, importable Postman collection v2.1 JSON with variables, folders and test scripts.
/checklist  A markdown checklist using "- [ ]" items, grouped by area, each item independently verifiable.
/explain    A clear explanation: what it is, why it matters, a worked example with real values, and common mistakes.
/improve    Rewrite the user's artifact, then a short "What changed" list explaining each edit.
/review     A review: a verdict line, then findings grouped Critical / Major / Minor, each with the issue, why it matters, and the fix.

FORMATTING
Markdown only. Use tables, checklists, fenced code blocks with language tags, JSON and CSV as the content demands. Never wrap the whole answer in a single code fence. Keep prose tight — a QA engineer is skimming this between meetings.`;

/* Response length shapes the tail of the prompt rather than only max tokens,
   so "short" reads as deliberate brevity instead of a truncated answer. */
const LENGTH_HINT = {
  short: '\n\nLENGTH: Be brief. The artifact and nothing else. No explanation unless asked.',
  balanced: '',
  detailed: '\n\nLENGTH: Be thorough. Full coverage, edge cases, and a short note on risks and assumptions.'
};

const MAX_TOKENS = { short: 1200, balanced: 4096, detailed: 8192 };

/* ===================== Rate limiting =====================
   Best-effort, per isolate. Cloudflare runs many isolates, so this throttles
   accidents, not a determined attacker. For a hard limit, use the Rate Limiting
   binding or a Durable Object — see the README. */

const buckets = new Map();

function rateLimited(ip, limit) {
  const now = Date.now();
  const windowStart = now - 60000;
  const hits = (buckets.get(ip) || []).filter(t => t > windowStart);
  hits.push(now);
  buckets.set(ip, hits);
  if (buckets.size > 5000) buckets.clear();   // cheap guard against unbounded growth
  return hits.length > limit;
}

/* ===================== CORS ===================== */

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!list.length) return '*';                 // unconfigured: open, and the README says to fix it
  if (list.includes('*')) return '*';
  if (list.includes(origin)) return origin;
  // Allow any localhost port during development.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && list.some(o => o.includes('localhost'))) return origin;
  return null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin || '*') }
  });
}

/* ===================== Validation ===================== */

function validate(payload) {
  if (!payload || typeof payload !== 'object') return 'The request body must be JSON.';
  if (!Array.isArray(payload.messages) || !payload.messages.length) return 'messages must be a non-empty array.';
  if (payload.messages.length > 40) return 'Too many messages in one request.';

  let chars = 0;
  for (const m of payload.messages) {
    if (!m || typeof m.content !== 'string' || !m.content.trim()) return 'Every message needs non-empty text content.';
    if (m.role !== 'user' && m.role !== 'model') return 'Message role must be "user" or "model".';
    chars += m.content.length;
  }
  if (chars > 120000) return 'The conversation is too long. Start a new chat.';
  return null;
}

const clamp = (n, lo, hi, dflt) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, +n)) : dflt);

/* ===================== Handler ===================== */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    // Preflight
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, model: env.MODEL || DEFAULT_MODEL, keyConfigured: Boolean(env.GEMINI_API_KEY) }, 200, origin || '*');
    }

    if (!origin) {
      return json({ error: 'This origin is not allowed. Add it to ALLOWED_ORIGINS and redeploy the Worker.' }, 403, '*');
    }

    if (url.pathname !== '/api/chat') return json({ error: 'Not found.' }, 404, origin);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, origin);

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'GEMINI_API_KEY is not set. Run: npx wrangler secret put GEMINI_API_KEY' }, 401, origin);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limit = clamp(env.RATE_LIMIT, 1, 600, 20);
    if (rateLimited(ip, limit)) {
      return json({ error: `Rate limit reached (${limit} requests per minute). Wait a moment and try again.` }, 429, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'The request body must be valid JSON.' }, 400, origin);
    }

    const invalid = validate(payload);
    if (invalid) return json({ error: invalid }, 400, origin);

    const length = LENGTH_HINT[payload.length] !== undefined ? payload.length : 'balanced';
    const model = env.MODEL || DEFAULT_MODEL;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + LENGTH_HINT[length] }] },
      contents: payload.messages.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
      generationConfig: {
        temperature: clamp(payload.temperature, 0, 1, 0.6),
        topP: 0.95,
        maxOutputTokens: MAX_TOKENS[length]
      },
      // The assistant discusses security testing and OWASP payloads; the default
      // filters flag that as harmful, so they are relaxed to BLOCK_ONLY_HIGH.
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT'
      ].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
    };

    let upstream;
    try {
      upstream = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return json({ error: 'Could not reach the Gemini API.' }, 502, origin);
    }

    if (!upstream.ok) {
      let detail = '';
      try {
        const err = await upstream.json();
        detail = err?.error?.message || '';
      } catch (e) { /* upstream sent a non-JSON error */ }

      // Defence in depth: upstream messages are echoed back to the browser, so scrub
      // the key in case Gemini ever quotes it back in an error.
      if (env.GEMINI_API_KEY) detail = detail.split(env.GEMINI_API_KEY).join('[redacted]');

      const message = upstream.status === 400 ? `Gemini rejected the request. ${detail}`.trim()
        : upstream.status === 401 || upstream.status === 403 ? 'The Gemini API key was rejected. Check the GEMINI_API_KEY secret.'
        : upstream.status === 429 ? 'Gemini rate limit reached. Try again shortly.'
        : upstream.status === 503 ? 'The model is overloaded. Try again shortly.'
        : `Gemini returned ${upstream.status}.`;

      const status = [400, 401, 403, 429].includes(upstream.status) ? upstream.status : 502;
      return json({ error: message }, status, origin);
    }

    // Pass the SSE stream straight through — the client parses `data:` lines.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(origin)
      }
    });
  }
};
