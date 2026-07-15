<div align="center">

<img src="assets/icons/logo.svg" width="72" alt="QA Genius AI">

# QA Genius AI

**AI QA assistant for modern software testing.**

Generate test cases, automate QA workflows, analyze bugs, write automation scripts, create API tests and improve software quality using AI.

[Live demo](https://your-username.github.io/qa-genius-ai/) · [Report a bug](https://github.com/your-username/qa-genius-ai/issues)

![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/Vanilla_JS-F7DF1E?logo=javascript&logoColor=black)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?logo=cloudflare&logoColor=white)
![Gemini](https://img.shields.io/badge/Google_Gemini-4285F4?logo=google&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## What it is

A ChatGPT-style chat interface with a QA engineer's brain behind it. The front end is three static files with no build step and no dependencies. A Cloudflare Worker sits between the page and the Google Gemini API so that **your API key never reaches a browser**.

Ask it for login test cases and you get a table you can paste into TestRail. Ask for a Playwright spec and you get page objects and web-first assertions, not a snippet with `sleep(5)` in it.

## Features

| | |
|---|---|
| **Chat** | Streaming responses, markdown, tables, syntax highlighting, copy buttons, typing indicator, stop generation, retry |
| **History** | Conversations saved in your browser, grouped by recency, searchable, deletable |
| **Prompts** | 18 starter cards across test design, automation, API & data, quality gates and concepts |
| **Commands** | 11 slash commands — type `/` to filter |
| **Export** | PDF, Markdown, JSON, plain text |
| **Settings** | Dark / light / auto theme, font size, temperature, response length, endpoint override |
| **Built right** | Responsive to 390px, WCAG-minded, keyboard navigable, respects `prefers-reduced-motion`, SEO tags and structured data |

## Screens

The landing page opens with a live test-run panel. The chat is a standard three-pane app: history on the left, stream in the middle, composer at the bottom.

## Architecture

```
Browser (GitHub Pages)          Cloudflare Worker            Google
┌──────────────────┐            ┌──────────────────┐        ┌──────────┐
│ index.html       │  POST      │ CORS allowlist   │  SSE   │  Gemini  │
│ styles.css       │ ─────────▶ │ rate limit       │ ─────▶ │   API    │
│ script.js        │            │ validation       │        └──────────┘
│                  │ ◀───────── │ system prompt    │ ◀──────
│ localStorage     │   SSE      │ GEMINI_API_KEY   │
└──────────────────┘            └──────────────────┘
      no key                      key lives here
```

The key is a Worker secret. The client only ever knows the Worker's URL.

## Setup

You need a [Google AI Studio API key](https://aistudio.google.com/app/apikey) (free tier is fine) and a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine).

### 1. Deploy the Worker

```bash
git clone https://github.com/your-username/qa-genius-ai.git
cd qa-genius-ai/worker

npx wrangler login          # opens a browser to authorise
npx wrangler deploy         # prints your Worker URL
```

Copy the URL it prints, for example `https://qa-genius-ai.your-name.workers.dev`.

### 2. Add your API key as a secret

```bash
npx wrangler secret put GEMINI_API_KEY
# paste the key when prompted — it is encrypted and never written to disk
```

> **Never** put the key in `wrangler.toml`, `script.js`, or anywhere else in the repo. `wrangler.toml` is committed to git; secrets are not.

### 3. Lock the Worker to your origin

Edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://your-username.github.io"
MODEL = "gemini-2.5-flash"
RATE_LIMIT = "20"
```

Then redeploy:

```bash
npx wrangler deploy
```

Any request from another origin now gets a 403.

### 4. Point the app at your Worker

In `script.js`, set the endpoint near the top:

```js
const CONFIG = {
  API_ENDPOINT: 'https://qa-genius-ai.your-name.workers.dev/api/chat',
  ...
};
```

You can also paste it into **Settings → Worker endpoint** at runtime, which only affects your own device — handy for testing before you commit.

### 5. Publish to GitHub Pages

Push to `main`, then either:

- **Simple:** *Settings → Pages → Source → Deploy from a branch → `main` / root*, or
- **Actions:** *Settings → Pages → Source → GitHub Actions* — the included [`pages.yml`](.github/workflows/pages.yml) workflow does the rest.

Your site is live at `https://your-username.github.io/qa-genius-ai/`.

> The repo includes a `.nojekyll` file so GitHub Pages serves the folder as-is.

### Verify

```bash
curl https://qa-genius-ai.your-name.workers.dev/api/health
# {"ok":true,"model":"gemini-2.5-flash","keyConfigured":true}
```

If `keyConfigured` is `false`, step 2 did not take.

## Local development

Serve the front end over HTTP — opening `index.html` from the file system works, but the clipboard API needs a secure context:

```bash
python3 -m http.server 8000
# http://localhost:8000
```

Run the Worker locally:

```bash
cd worker
cp .dev.vars.example .dev.vars      # then paste your key into .dev.vars
npx wrangler dev                     # http://localhost:8787
```

`localhost` is already in the default `ALLOWED_ORIGINS`. Point **Settings → Worker endpoint** at `http://localhost:8787/api/chat` and you have the full stack running locally.

## Commands

Type `/` in the composer to filter the list.

| Command | Produces |
|---------|----------|
| `/testcase` | Test cases in a table with steps, data and expected results |
| `/bug` | A bug report with repro steps, severity and environment |
| `/api` | REST or GraphQL test cases with payloads and assertions |
| `/playwright` | Playwright specs with page objects and web-first assertions |
| `/selenium` | Selenium code with explicit waits and page objects |
| `/sql` | SQL validation queries for the dialect you name |
| `/postman` | An importable Postman collection as JSON |
| `/checklist` | A checklist you can tick through |
| `/explain` | A concept explained with a worked example |
| `/improve` | Your artifact rewritten, with the changes called out |
| `/review` | A review with findings ranked by severity |

## Example questions

- Generate complete login page test cases.
- Write Playwright automation for login.
- Create a Selenium Python framework.
- Explain boundary value analysis.
- Explain equivalence partitioning.
- Generate API test cases.
- Generate SQL validation queries.
- Write a JMeter test plan.
- Generate an accessibility checklist.
- Review my bug report.

## Templates it generates

Bug report · Test plan · Test strategy · Test cases · Regression checklist · Smoke checklist · Sanity checklist · API checklist · Accessibility checklist · Security checklist · Release checklist · Performance checklist

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send |
| `Shift` + `Enter` | New line |
| `/` | Open the command palette |
| `↑` `↓` | Move through the palette |
| `Ctrl` / `Cmd` + `K` | New chat |
| `Esc` | Close the drawer, or stop generating |

## Configuration

### Front end — `script.js`

| Key | Default | Meaning |
|-----|---------|---------|
| `API_ENDPOINT` | — | Your Worker's `/api/chat` URL |
| `HISTORY_TURNS` | `20` | Turns sent to the model per request |
| `MAX_CHATS` | `60` | Conversations kept in local storage |
| `REQUEST_TIMEOUT` | `90000` | Milliseconds before a request is abandoned |

### Worker — `wrangler.toml`

| Variable | Type | Meaning |
|----------|------|---------|
| `GEMINI_API_KEY` | secret | Your Gemini key. Set with `wrangler secret put` |
| `ALLOWED_ORIGINS` | var | Comma-separated origins allowed to call the Worker |
| `MODEL` | var | `gemini-2.5-flash` (fast) or `gemini-2.5-pro` (stronger reasoning) |
| `RATE_LIMIT` | var | Requests per IP per minute |

## Project structure

```
qa-genius-ai/
├── index.html              # landing page + chat application
├── styles.css              # design tokens, both themes, all components
├── script.js               # state, markdown, highlighting, streaming, export
├── site.webmanifest
├── .nojekyll               # tell GitHub Pages to serve the folder as-is
├── assets/
│   ├── icons/              # logo.svg, favicon.svg, apple-touch-icon.png
│   └── images/             # og-image.png
├── worker/
│   ├── worker.js           # Gemini proxy: CORS, rate limit, system prompt
│   ├── wrangler.toml       # Worker config (no secrets)
│   ├── package.json
│   └── .dev.vars.example
├── .github/workflows/
│   └── pages.yml           # optional GitHub Pages deployment
├── LICENSE
└── README.md
```

## Security

- **The API key lives only in the Worker**, as an encrypted secret. It is never sent to the browser and never appears in the repo.
- **CORS is an allowlist.** Requests from unlisted origins are refused.
- **Rate limiting** is per IP, best-effort. Because Workers run in many isolates, a determined caller can exceed it — see below for a hard limit.
- **Model output is escaped before rendering.** The markdown renderer escapes all HTML before producing any markup, and `javascript:` and `data:` URLs are stripped, so a prompt-injected response cannot execute script.
- **Upstream errors are scrubbed** of the API key before they reach the client.
- **Nothing leaves your browser** except the messages you send. There is no account, no analytics, no server-side storage.

For a hard rate limit, bind Cloudflare's rate limiting API in `wrangler.toml` (a commented example is included) or use a Durable Object.

## Browser support

Chrome, Edge, Firefox and Safari — current versions. Uses `fetch` streaming, `<dialog>`, CSS `color-mix()` and `backdrop-filter`.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| *"This origin is not allowed"* | Your Pages URL is missing from `ALLOWED_ORIGINS`. Add it and redeploy. |
| *"GEMINI_API_KEY is not set"* | Run `npx wrangler secret put GEMINI_API_KEY`, then redeploy. |
| *"Rate limit reached"* | You hit `RATE_LIMIT`, or Gemini's own free-tier limit. Wait, or raise the value. |
| Nothing happens on send | `API_ENDPOINT` still points at the placeholder. Set it, or use Settings → Worker endpoint. |
| *"Storage is blocked"* toast | Private browsing or blocked cookies. The app still works; chats just are not saved. |
| Fonts look wrong | Google Fonts is blocked on your network. The page falls back to system fonts. |
| Copy button does nothing | The clipboard API needs HTTPS or `localhost`. Serve over HTTP, not `file://`. |

## Contributing

Issues and pull requests are welcome. Keep the front end dependency-free — no framework, no build step.

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
<sub>Answers are drafts. Review generated tests and code before you run them.</sub>
</div>
