/* ==========================================================================
   QA Genius AI — script.js
   --------------------------------------------------------------------------
   Vanilla ES6. No framework, no build step, no runtime dependencies.

   Modules, in order:
     CONFIG    endpoint + defaults          Store     safe localStorage
     State     chats and settings           MD        markdown -> HTML
     HL        syntax highlighting          Prompts   starter cards
     Commands  slash commands               API       Worker transport
     UI        rendering                    App       wiring + boot

   Security note: the Gemini API key lives in the Cloudflare Worker as an
   environment secret. It is never referenced here, and must never be.
   ========================================================================== */
(function () {
  'use strict';

  /* ============================ CONFIG ============================ */

  const CONFIG = {
    // Replace with your deployed Worker route. Settings can override it per device.
    API_ENDPOINT: 'https://qa-genius-ai.abrarragib.workers.dev/api/chat',
    STORAGE_KEY: 'qagenius.chats',
    SETTINGS_KEY: 'qagenius.settings',
    MAX_CHATS: 60,
    // Only the last N turns go to the model — keeps latency and cost predictable.
    HISTORY_TURNS: 20,
    REQUEST_TIMEOUT: 90000
  };

  const DEFAULT_SETTINGS = {
    theme: 'auto',
    fontSize: 15,
    temperature: 0.6,
    length: 'balanced',
    endpoint: ''
  };

  /* ============================ Store ============================
     localStorage throws in private mode and inside some embedded views.
     Every call is guarded; an in-memory map keeps the app usable either way. */

  const Store = (function () {
    const memory = new Map();
    let usable = true;
    try {
      localStorage.setItem('qagenius.probe', '1');
      localStorage.removeItem('qagenius.probe');
    } catch (e) {
      usable = false;
    }
    return {
      get(key, fallback) {
        try {
          const raw = usable ? localStorage.getItem(key) : memory.get(key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch (e) {
          return fallback;
        }
      },
      set(key, value) {
        const raw = JSON.stringify(value);
        try {
          if (usable) localStorage.setItem(key, raw);
          else memory.set(key, raw);
          return true;
        } catch (e) {
          // Quota exceeded — fall back to memory so the session survives.
          memory.set(key, raw);
          return false;
        }
      },
      remove(key) {
        try { if (usable) localStorage.removeItem(key); } catch (e) { /* noop */ }
        memory.delete(key);
      },
      get persistent() { return usable; }
    };
  })();

  /* ============================ State ============================ */

  const State = {
    chats: Store.get(CONFIG.STORAGE_KEY, []),
    settings: Object.assign({}, DEFAULT_SETTINGS, Store.get(CONFIG.SETTINGS_KEY, {})),
    currentId: null,
    streaming: false,
    stopped: false,     // true only when the user pressed Stop, not on a timeout
    controller: null,

    save() { Store.set(CONFIG.STORAGE_KEY, this.chats.slice(0, CONFIG.MAX_CHATS)); },
    saveSettings() { Store.set(CONFIG.SETTINGS_KEY, this.settings); },

    current() { return this.chats.find(c => c.id === this.currentId) || null; },

    createChat() {
      const chat = { id: uid(), title: 'New chat', messages: [], created: Date.now(), updated: Date.now() };
      this.chats.unshift(chat);
      this.currentId = chat.id;
      this.save();
      return chat;
    },

    deleteChat(id) {
      const i = this.chats.findIndex(c => c.id === id);
      if (i === -1) return;
      this.chats.splice(i, 1);
      if (this.currentId === id) this.currentId = this.chats.length ? this.chats[0].id : null;
      this.save();
    },

    addMessage(role, content) {
      const chat = this.current() || this.createChat();
      const msg = { id: uid(), role, content, ts: Date.now() };
      chat.messages.push(msg);
      chat.updated = Date.now();
      // First user line names the chat — cheaper and clearer than asking the model.
      if (role === 'user' && chat.messages.filter(m => m.role === 'user').length === 1) {
        chat.title = titleFrom(content);
      }
      this.save();
      return msg;
    }
  };

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function titleFrom(text) {
    const clean = text.replace(/^\/\w+\s*/, '').replace(/\s+/g, ' ').trim();
    return clean.length > 48 ? clean.slice(0, 48).trimEnd() + '…' : (clean || 'New chat');
  }

  /* ============================ HL — syntax highlighting ============================
     A small tokenizer covering the languages QA work actually produces. Each grammar
     is one alternation of named groups; first match wins, which is why comments and
     strings are declared before keywords. */

  const HL = (function () {
    const KW = {
      js: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|of|in|yield|static|get|set|delete|void',
      py: 'def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|pass|lambda|yield|assert|global|nonlocal|del|and|or|not|is|in|None|True|False|async|await|self',
      java: 'public|private|protected|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|static|final|void|int|long|double|float|boolean|char|String|try|catch|finally|throw|throws|import|package|null|true|false|abstract|enum|@Test|@BeforeEach|@AfterEach',
      sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|AND|OR|NOT|NULL|IS|IN|BETWEEN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|UNION|ALL|EXISTS|PRIMARY|FOREIGN|KEY|REFERENCES|DEFAULT|CONSTRAINT|WITH|TOP|ASC|DESC',
      sh: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|source|echo|cd|npm|npx|git|curl|docker|python|pip|mvn|gradle|pytest|sudo|set'
    };

    const G = {
      javascript: `(?<com>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|(?<str>"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(?<num>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|(?<key>\\b(?:${KW.js})\\b)|(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())`,
      python: `(?<com>#[^\\n]*)|(?<str>"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(?<num>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|(?<key>\\b(?:${KW.py})\\b)|(?<fn>\\b[A-Za-z_][\\w]*(?=\\s*\\())`,
      java: `(?<com>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|(?<str>"(?:\\\\.|[^"\\\\])*")|(?<num>\\b\\d[\\d_]*(?:\\.\\d+)?[LlFfDd]?\\b)|(?<key>@?\\b(?:${KW.java})\\b)|(?<fn>\\b[A-Za-z_][\\w]*(?=\\s*\\())`,
      sql: `(?<com>--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|(?<str>'(?:''|[^'])*')|(?<num>\\b\\d+(?:\\.\\d+)?\\b)|(?<key>\\b(?:${KW.sql})\\b)|(?<fn>\\b[A-Za-z_][\\w]*(?=\\s*\\())`,
      json: `(?<atr>"(?:\\\\.|[^"\\\\])*"(?=\\s*:))|(?<str>"(?:\\\\.|[^"\\\\])*")|(?<num>-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|(?<key>\\b(?:true|false|null)\\b)`,
      bash: `(?<com>#[^\\n]*)|(?<str>"(?:\\\\.|[^"\\\\])*"|'[^']*')|(?<num>\\b\\d+\\b)|(?<key>\\b(?:${KW.sh})\\b)|(?<op>--?[A-Za-z][\\w-]*)`,
      xml: `(?<com><!--[\\s\\S]*?-->)|(?<str>"(?:[^"]*)"|'(?:[^']*)')|(?<tag><\\/?[A-Za-z][\\w:.-]*|\\/?>)|(?<atr>\\b[A-Za-z_][\\w:.-]*(?=\\s*=))`,
      yaml: `(?<com>#[^\\n]*)|(?<str>"(?:\\\\.|[^"\\\\])*"|'[^']*')|(?<atr>^[ \\t]*[A-Za-z_][\\w.-]*(?=\\s*:))|(?<num>\\b\\d+(?:\\.\\d+)?\\b)|(?<key>\\b(?:true|false|null)\\b)`,
      gherkin: `(?<com>#[^\\n]*)|(?<key>^\\s*(?:Feature|Scenario Outline|Scenario|Background|Given|When|Then|And|But|Examples):?)|(?<str>"[^"]*"|<[^>]+>)|(?<num>\\b\\d+\\b)`
    };

    const ALIAS = {
      js: 'javascript', jsx: 'javascript', ts: 'javascript', typescript: 'javascript', tsx: 'javascript',
      node: 'javascript', mjs: 'javascript',
      py: 'python', python3: 'python',
      kotlin: 'java', kt: 'java', cs: 'java', csharp: 'java', groovy: 'java',
      mysql: 'sql', postgres: 'sql', postgresql: 'sql', tsql: 'sql', mssql: 'sql',
      oracle: 'sql', plsql: 'sql', sqlite: 'sql',
      shell: 'bash', sh: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', bat: 'bash',
      html: 'xml', svg: 'xml', xhtml: 'xml',
      yml: 'yaml', toml: 'yaml', ini: 'yaml', properties: 'yaml', env: 'yaml',
      feature: 'gherkin', cucumber: 'gherkin',
      jsonc: 'json', json5: 'json'
    };

    const cache = new Map();
    function rx(name) {
      if (!cache.has(name)) cache.set(name, new RegExp(G[name], 'gm'));
      const r = cache.get(name);
      r.lastIndex = 0;
      return r;
    }

    function resolve(lang) {
      const k = String(lang || '').toLowerCase().trim();
      return G[k] ? k : (G[ALIAS[k]] ? ALIAS[k] : null);
    }

    function highlight(code, lang) {
      const name = resolve(lang);
      if (!name) return esc(code);
      const re = rx(name);
      let out = '', last = 0, m;
      while ((m = re.exec(code)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }   // guard against zero-width loops
        out += esc(code.slice(last, m.index));
        const groups = m.groups || {};
        const cls = Object.keys(groups).find(k => groups[k] !== undefined);
        out += cls ? `<span class="tok-${cls}">${esc(m[0])}</span>` : esc(m[0]);
        last = m.index + m[0].length;
      }
      return out + esc(code.slice(last));
    }

    return { highlight, resolve, label: (l) => (resolve(l) ? l : (l || 'text')) };
  })();

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ============================ MD — markdown renderer ============================
     Deliberately small: headings, lists (incl. task lists), tables, fenced code,
     blockquotes, rules, and inline emphasis/code/links. Everything is escaped before
     any HTML is produced, so model output cannot inject markup. */

  const MD = (function () {
    const SENT = '\u0000';

    function render(src) {
      const blocks = [];
      let text = String(src || '');

      // 1. Pull fenced code out first, including an unterminated fence mid-stream.
      text = text.replace(/```([\w+#.-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g, (_, lang, body) => {
        blocks.push(codeBlock(body.replace(/\n$/, ''), lang));
        return `${SENT}B${blocks.length - 1}${SENT}`;
      });

      // 2. Inline code next, so its contents are never treated as markdown.
      const spans = [];
      text = text.replace(/(`+)([^`\n]+?)\1/g, (_, __, body) => {
        spans.push(`<code>${esc(body)}</code>`);
        return `${SENT}S${spans.length - 1}${SENT}`;
      });

      const html = blockPass(text.split('\n'), spans);

      // 3. Put the extracted pieces back.
      return html.replace(new RegExp(SENT + 'B(\\d+)' + SENT, 'g'), (_, i) => blocks[+i])
                 .replace(new RegExp(SENT + 'S(\\d+)' + SENT, 'g'), (_, i) => spans[+i]);
    }

    function blockPass(lines, spans) {
      let out = '', i = 0;

      while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        // Block-level placeholder (a code fence) sits alone.
        const ph = line.match(new RegExp('^' + SENT + 'B\\d+' + SENT + '$'));
        if (ph) { out += line; i++; continue; }

        // Horizontal rule
        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out += '<hr>'; i++; continue; }

        // ATX heading
        const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (h) { out += `<h${h[1].length}>${inline(h[2], spans)}</h${h[1].length}>`; i++; continue; }

        // Table: header row + delimiter row
        if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
          const res = table(lines, i, spans);
          if (res) { out += res.html; i = res.next; continue; }
        }

        // Blockquote
        if (/^ {0,3}>/.test(line)) {
          const buf = [];
          while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (buf.length && lines[i].trim()))) {
            buf.push(lines[i].replace(/^ {0,3}>\s?/, ''));
            i++;
          }
          out += `<blockquote>${blockPass(buf, spans)}</blockquote>`;
          continue;
        }

        // Lists
        if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
          const res = list(lines, i, spans);
          out += res.html; i = res.next; continue;
        }

        // Paragraph: consume until a blank line or the start of another block
        const buf = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
        if (buf.length) out += `<p>${inline(buf.join('\n'), spans).replace(/\n/g, '<br>')}</p>`;
        else i++;
      }
      return out;
    }

    function isBlockStart(l) {
      return /^ {0,3}#{1,6}\s/.test(l)
        || /^ {0,3}>/.test(l)
        || /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(l)
        || /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(l)
        || new RegExp('^' + SENT + 'B\\d+' + SENT + '$').test(l);
    }

    /* Indentation-aware list builder. Items indented by 2+ spaces nest inside the
       previous item, which is how models emit sub-steps. */
    function list(lines, start, spans) {
      const first = lines[start].match(/^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+/);
      const baseIndent = first[1].length;
      const ordered = !first[2];
      const items = [];
      let i = start;

      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/);
        if (!m) {
          // Lazy continuation of the current item
          if (items.length && lines[i].trim() && !isBlockStart(lines[i])) {
            items[items.length - 1].lines.push(lines[i].trim());
            i++; continue;
          }
          break;
        }
        const indent = m[1].length;
        if (indent < baseIndent) break;
        if (indent >= baseIndent + 2 && items.length) {
          items[items.length - 1].lines.push(lines[i].slice(baseIndent + 2));
          i++; continue;
        }
        if ((!m[2]) !== ordered) break;   // list type switched — new list
        items.push({ lines: [m[4]] });
        i++;
      }

      let html = '';
      let isTaskList = false;
      for (const it of items) {
        let head = it.lines[0];
        const rest = it.lines.slice(1);
        const task = head.match(/^\[([ xX])\]\s+(.*)$/);
        let cls = '';
        let body = '';
        if (task) {
          isTaskList = true;
          cls = ' class="task"';
          body = `<input type="checkbox" ${task[1].toLowerCase() === 'x' ? 'checked' : ''} disabled aria-label="Checklist item">${inline(task[2], spans)}`;
        } else {
          body = inline(head, spans);
        }
        if (rest.length) body += blockPass(rest, spans);
        html += `<li${cls}>${body}</li>`;
      }

      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && first[3] && +first[3] !== 1 ? ` start="${+first[3]}"` : '';
      return { html: `<${tag}${startAttr}${isTaskList ? ' class="tasks"' : ''}>${html}</${tag}>`, next: i };
    }

    function table(lines, start, spans) {
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(lines[start]);
      const align = cells(lines[start + 1]).map(c =>
        /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''
      );
      if (!head.length) return null;

      let i = start + 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && /\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }

      const th = head.map((c, n) => `<th${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(c, spans)}</th>`).join('');
      const tr = body.map(r =>
        `<tr>${head.map((_, n) => `<td${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(r[n] || '', spans)}</td>`).join('')}</tr>`
      ).join('');

      return {
        html: `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`,
        next: i
      };
    }

    function inline(text, spans) {
      let s = esc(text);
      // Images before links, since the syntax overlaps.
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (_, alt, src) => safeUrl(src) ? `<img src="${src}" alt="${alt}" loading="lazy">` : alt);
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
        (_, label, href) => safeUrl(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
      s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
      s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
      // Capture the preceding character rather than using a lookbehind: lookbehind is
      // a parse-time syntax error in older Safari, which would take the whole file down.
      s = s.replace(/(^|[^\w*_])(\*|_)(?=\S)([\s\S]*?\S)\2(?![\w*])/g, '$1<em>$3</em>');
      s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
      // Bare URLs, but never inside an attribute we just wrote.
      s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g,
        (m0, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      return s;
    }

    function safeUrl(u) { return /^(https?:|mailto:|#|\/|\.\/)/i.test(u); }

    function codeBlock(code, lang) {
      const label = esc(HL.label(lang));
      return `<div class="code-block" data-code="${encodeURIComponent(code)}">
  <div class="code-head">
    <span class="code-lang">${label}</span>
    <button class="copy-btn" type="button" data-copy>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/></svg>
      <span>Copy</span>
    </button>
  </div>
  <pre><code>${HL.highlight(code, lang)}</code></pre>
</div>`;
    }

    return { render };
  })();

  /* ============================ Prompts ============================ */

  const PROMPTS = [
    { cat: 'design', kind: 'Test design', title: 'Generate login test cases',
      text: '/testcase Generate complete test cases for a web login page with email, password, "remember me" and "forgot password". Cover positive, negative, boundary, security and accessibility scenarios.' },
    { cat: 'api', kind: 'API', title: 'Generate API test cases',
      text: '/api Generate REST API test cases for POST /api/v1/users. Include request payloads, status codes, schema assertions, auth cases and error handling.' },
    { cat: 'design', kind: 'Reporting', title: 'Write a bug report',
      text: '/bug Write a bug report: on checkout, applying an expired coupon deducts the discount anyway and the order total is wrong. Chrome 126, staging.' },
    { cat: 'design', kind: 'Checklist', title: 'Create a regression checklist',
      text: '/checklist Create a regression checklist for an e-commerce web app covering auth, catalogue, cart, checkout, payments, orders and account.' },
    { cat: 'learn', kind: 'Concept', title: 'Explain STLC',
      text: '/explain Explain the Software Testing Life Cycle: each phase, entry and exit criteria, deliverables, and who owns what.' },
    { cat: 'learn', kind: 'Concept', title: 'Explain SDLC',
      text: '/explain Explain the Software Development Life Cycle and where testing fits in Waterfall, V-model and Agile.' },
    { cat: 'automation', kind: 'Automation', title: 'Generate a Playwright test',
      text: '/playwright Write a Playwright test in TypeScript for a login flow using the page object model, web-first assertions and fixtures.' },
    { cat: 'automation', kind: 'Automation', title: 'Generate a Selenium test',
      text: '/selenium Write a Selenium test in Python with pytest, page objects and explicit waits for a login flow.' },
    { cat: 'api', kind: 'Database', title: 'Generate a SQL query',
      text: '/sql Write SQL validation queries to check order totals match the sum of their line items, and to find orphaned rows.' },
    { cat: 'api', kind: 'API', title: 'Generate a Postman collection',
      text: '/postman Generate a Postman collection JSON for a users CRUD API with environment variables and test scripts.' },
    { cat: 'gates', kind: 'Quality gate', title: 'Accessibility testing',
      text: '/checklist Create a WCAG 2.2 AA accessibility test checklist for a web app, with the tools and manual steps for each item.' },
    { cat: 'gates', kind: 'Quality gate', title: 'Performance testing',
      text: 'Write a JMeter test plan for a checkout flow at 500 concurrent users. Include thresholds, ramp-up and the metrics to watch.' },
    { cat: 'gates', kind: 'Quality gate', title: 'Security testing',
      text: '/checklist Create an OWASP Top 10 security test checklist for a web application, with a test approach for each risk.' },
    { cat: 'api', kind: 'Database', title: 'Database testing',
      text: 'Explain database testing for a MySQL-backed app: schema, constraints, transactions, CRUD, migrations and data integrity.' },
    { cat: 'design', kind: 'Test data', title: 'Generate test data',
      text: 'Generate 20 rows of realistic test data for a user registration form as CSV: name, email, phone, DOB, country, password. Include edge cases.' },
    { cat: 'learn', kind: 'Technique', title: 'Boundary value analysis',
      text: '/explain Explain boundary value analysis and apply it to an age field that accepts 18 to 60.' },
    { cat: 'learn', kind: 'Technique', title: 'Equivalence partitioning',
      text: '/explain Explain equivalence partitioning and apply it to a discount field that accepts 0 to 100 percent.' },
    { cat: 'design', kind: 'Technique', title: 'Negative testing',
      text: '/testcase Generate negative test cases for a payment form: card number, expiry, CVV and cardholder name.' }
  ];

  /* ============================ Commands ============================
     Each command expands into an instruction the Worker prepends to the turn.
     Keeping the wording here (not in the model) makes output shape predictable. */

  const COMMANDS = [
    { cmd: '/testcase', desc: 'Test cases in a table with steps and expected results' },
    { cmd: '/bug', desc: 'A bug report with repro steps and severity' },
    { cmd: '/api', desc: 'REST or GraphQL test cases with payloads' },
    { cmd: '/playwright', desc: 'Playwright specs with page objects' },
    { cmd: '/selenium', desc: 'Selenium code with explicit waits' },
    { cmd: '/sql', desc: 'SQL validation queries' },
    { cmd: '/postman', desc: 'An importable Postman collection' },
    { cmd: '/checklist', desc: 'A checklist you can tick through' },
    { cmd: '/explain', desc: 'A concept explained with an example' },
    { cmd: '/improve', desc: 'Your artifact rewritten and improved' },
    { cmd: '/review', desc: 'A review with findings by severity' }
  ];

  /* ============================ API ============================ */

  const API = {
    endpoint() { return (State.settings.endpoint || '').trim() || CONFIG.API_ENDPOINT; },

    /**
     * Streams a reply. onChunk receives text deltas.
     * Resolves with the full text, or throws a user-readable Error.
     */
    async send(messages, onChunk) {
      const controller = new AbortController();
      State.controller = controller;
      const timer = setTimeout(() => controller.abort('timeout'), CONFIG.REQUEST_TIMEOUT);

      try {
        const res = await fetch(this.endpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messages.slice(-CONFIG.HISTORY_TURNS).map(m => ({
              role: m.role === 'ai' ? 'model' : 'user',
              content: m.content
            })),
            temperature: State.settings.temperature,
            length: State.settings.length
          }),
          signal: controller.signal
        });

        if (!res.ok) throw await httpError(res);
        if (!res.body) throw new Error('The Worker returned an empty response.');

        // Server-sent events: one JSON object per `data:` line.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', full = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let json;
            try { json = JSON.parse(payload); } catch (e) { continue; }
            if (json.error) throw new Error(json.error);
            const delta = extractText(json);
            if (delta) { full += delta; onChunk(delta); }
          }
        }
        if (!full.trim()) throw new Error('The model returned nothing. Try rewording the request.');
        return full;
      } finally {
        clearTimeout(timer);
        State.controller = null;
      }
    }
  };

  function extractText(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => p.text || '').join('');
  }

  async function httpError(res) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (e) { /* body was not JSON */ }
    const map = {
      401: 'The Worker rejected the request. Check that GEMINI_API_KEY is set as a Worker secret.',
      403: 'This origin is not allowed. Add it to ALLOWED_ORIGINS in wrangler.toml and redeploy.',
      429: 'Rate limit reached. Wait a moment and try again.',
      500: 'The Worker hit an internal error.',
      502: 'The Worker could not reach the Gemini API.',
      503: 'The model is overloaded right now. Try again shortly.'
    };
    return new Error(detail || map[res.status] || `Request failed with status ${res.status}.`);
  }

  /* ============================ UI ============================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const el = {
    landing: $('#landing'),
    chatView: $('#chat-view'),
    sidebar: $('#sidebar'),
    scrim: $('#sb-scrim'),
    chatList: $('#chat-list'),
    messages: $('#messages'),
    empty: $('#chat-empty'),
    promptGrid: $('#prompt-grid'),
    input: $('#composer-input'),
    send: $('#send-btn'),
    title: $('#chat-title'),
    cmdPop: $('#cmd-pop'),
    scrollBtn: $('#scroll-bottom'),
    toasts: $('#toasts'),
    settings: $('#settings'),
    exportBtn: $('#export-btn'),
    exportMenu: $('#export-menu')
  };

  const UI = {

    /* ---- theme ---- */
    applyTheme() {
      const t = State.settings.theme;
      const resolved = t === 'auto'
        ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : t;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.setProperty('--chat-font', State.settings.fontSize + 'px');
    },

    cycleTheme() {
      const order = ['dark', 'light', 'auto'];
      State.settings.theme = order[(order.indexOf(State.settings.theme) + 1) % 3];
      State.saveSettings();
      this.applyTheme();
      this.syncSettingsForm();
      toast(`Theme: ${State.settings.theme}`, 'ok');
    },

    /* ---- views ---- */
    openChat() {
      el.chatView.hidden = false;
      el.landing.hidden = true;
      document.body.classList.add('no-scroll');
      if (!State.currentId) {
        if (State.chats.length) State.currentId = State.chats[0].id;
        else State.createChat();
      }
      this.renderChatList();
      this.renderMessages();
      if (window.innerWidth > 720) el.input.focus();
    },

    closeChat() {
      el.chatView.hidden = true;
      el.landing.hidden = false;
      document.body.classList.remove('no-scroll');
      this.closeSidebar();
    },

    openSidebar() { el.sidebar.classList.add('is-open'); el.scrim.hidden = false; },
    closeSidebar() { el.sidebar.classList.remove('is-open'); el.scrim.hidden = true; },

    /* ---- sidebar ---- */
    renderChatList(filter) {
      const q = (filter || '').toLowerCase().trim();
      const chats = State.chats.filter(c =>
        !q || c.title.toLowerCase().includes(q) || c.messages.some(m => m.content.toLowerCase().includes(q))
      );

      if (!chats.length) {
        el.chatList.innerHTML = `<p class="sb-empty">${q ? 'No chats match that.' : 'Your chats will show up here.'}</p>`;
        return;
      }

      // Group by recency — the label tells you when, so no date column is needed.
      const groups = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const day = 86400000;
      for (const c of chats) {
        const d = now - new Date(c.updated).setHours(0, 0, 0, 0);
        if (d <= 0) groups.Today.push(c);
        else if (d <= day) groups.Yesterday.push(c);
        else if (d <= day * 7) groups['Previous 7 days'].push(c);
        else groups.Older.push(c);
      }

      let html = '';
      for (const [label, list] of Object.entries(groups)) {
        if (!list.length) continue;
        html += `<p class="sb-group">${label}</p>`;
        for (const c of list) {
          html += `<div class="sb-item${c.id === State.currentId ? ' is-active' : ''}" data-id="${c.id}" role="button" tabindex="0">
            <span class="sb-item-title">${esc(c.title)}</span>
            <button class="sb-del" type="button" data-del="${c.id}" aria-label="Delete chat: ${esc(c.title)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
            </button>
          </div>`;
        }
      }
      el.chatList.innerHTML = html;
    },

    /* ---- prompt cards ---- */
    renderPrompts() {
      el.promptGrid.innerHTML = PROMPTS.map(p =>
        `<button class="prompt-card" type="button" data-cat="${p.cat}" data-text="${esc(p.text)}">
          <span class="pc-kind">${esc(p.kind)}</span>
          <span class="pc-title">${esc(p.title)}</span>
        </button>`
      ).join('');
    },

    filterPrompts(cat) {
      $$('.prompt-card').forEach(c => { c.hidden = cat !== 'all' && c.dataset.cat !== cat; });
      $$('.filter-chip').forEach(c => {
        const on = c.dataset.filter === cat;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-selected', String(on));
      });
    },

    /* ---- messages ---- */
    renderMessages() {
      const chat = State.current();
      el.title.textContent = chat ? chat.title : 'New chat';

      if (!chat || !chat.messages.length) {
        el.empty.hidden = false;
        el.messages.hidden = true;
        el.messages.innerHTML = '';
        return;
      }
      el.empty.hidden = true;
      el.messages.hidden = false;
      el.messages.innerHTML = chat.messages.map(m => this.messageHTML(m)).join('');
      this.scrollToEnd(true);
    },

    messageHTML(m) {
      const isUser = m.role === 'user';
      const body = isUser
        ? esc(m.content)
        : `<div class="md">${MD.render(m.content)}</div>`;
      return `<article class="msg ${isUser ? 'user' : 'ai'}" data-id="${m.id}">
        <div class="avatar" aria-hidden="true">${isUser ? 'YOU' : aiGlyph()}</div>
        <div class="msg-body">
          <p class="msg-role">${isUser ? 'You' : 'QA Genius'}</p>
          <div class="msg-content">${body}</div>
          <div class="msg-tools">
            <button type="button" data-copy-msg="${m.id}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/></svg>
              Copy
            </button>
            ${isUser ? '' : `<button type="button" data-retry="${m.id}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>
              Retry
            </button>`}
          </div>
        </div>
      </article>`;
    },

    /** Placeholder bubble that the stream writes into. */
    appendStreaming() {
      const wrap = document.createElement('article');
      wrap.className = 'msg ai';
      wrap.dataset.streaming = 'true';
      wrap.innerHTML = `<div class="avatar" aria-hidden="true">${aiGlyph()}</div>
        <div class="msg-body">
          <p class="msg-role">QA Genius</p>
          <div class="msg-content"><div class="md"></div>
            <span class="typing" aria-label="QA Genius is typing"><i></i><i></i><i></i></span>
          </div>
        </div>`;
      el.messages.hidden = false;
      el.empty.hidden = true;
      el.messages.appendChild(wrap);
      this.scrollToEnd(true);
      return wrap;
    },

    showError(node, message, onRetry) {
      const content = $('.msg-content', node);
      content.innerHTML = `<div class="msg-error" role="alert">
        <strong>That request did not go through</strong>
        <p>${esc(message)}</p>
        <button type="button" data-error-retry>Try again</button>
      </div>`;
      $('[data-error-retry]', content).addEventListener('click', onRetry);
    },

    /* ---- scrolling ---- */
    nearBottom() {
      const m = el.messages;
      return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
    },
    scrollToEnd(force) {
      if (force || this.nearBottom()) el.messages.scrollTop = el.messages.scrollHeight;
    },

    /* ---- settings form ---- */
    syncSettingsForm() {
      const s = State.settings;
      const radio = $(`input[name="theme"][value="${s.theme}"]`);
      if (radio) radio.checked = true;
      $('#set-font').value = s.fontSize;
      $('#set-font-out').textContent = s.fontSize + 'px';
      $('#set-temp').value = s.temperature;
      $('#set-temp-out').textContent = Number(s.temperature).toFixed(1);
      $('#set-length').value = s.length;
      $('#set-endpoint').value = s.endpoint || '';
    }
  };

  function aiGlyph() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4 4L19 7"/></svg>`;
  }

  /* ---- toasts ---- */
  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    const icon = kind === 'err'
      ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M5 12.5l4 4L19 7"/></svg>';
    node.innerHTML = icon + `<span>${esc(message)}</span>`;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Clipboard API needs a secure context; this path covers plain http and older browsers.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ============================ Export ============================ */

  const Export = {
    run(kind) {
      const chat = State.current();
      if (!chat || !chat.messages.length) { toast('Nothing to export yet.', 'err'); return; }
      const name = chat.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, 40) || 'chat';

      if (kind === 'pdf') { toast('Choose “Save as PDF” in the print dialog.', 'ok'); setTimeout(() => window.print(), 350); return; }
      if (kind === 'md') this.download(`${name}.md`, this.toMarkdown(chat), 'text/markdown');
      if (kind === 'txt') this.download(`${name}.txt`, this.toText(chat), 'text/plain');
      if (kind === 'json') this.download(`${name}.json`, JSON.stringify(chat, null, 2), 'application/json');
      toast('Exported.', 'ok');
    },

    toMarkdown(chat) {
      const head = `# ${chat.title}\n\n_Exported from QA Genius AI — ${new Date().toLocaleString()}_\n\n---\n\n`;
      return head + chat.messages.map(m =>
        `## ${m.role === 'user' ? 'You' : 'QA Genius AI'}\n\n${m.content}\n`
      ).join('\n');
    },

    toText(chat) {
      const rule = '='.repeat(60);
      return `${chat.title}\nExported from QA Genius AI — ${new Date().toLocaleString()}\n${rule}\n\n` +
        chat.messages.map(m =>
          `[${m.role === 'user' ? 'YOU' : 'QA GENIUS AI'}] ${new Date(m.ts).toLocaleString()}\n${rule}\n${m.content}\n`
        ).join('\n');
    },

    download(filename, content, mime) {
      const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  /* ============================ Chat flow ============================ */

  let cmdIndex = 0;
  let cmdMatches = [];

  async function sendMessage(text) {
    const content = (text || el.input.value).trim();
    if (!content || State.streaming) return;

    State.addMessage('user', content);
    el.input.value = '';
    autoGrow();
    hideCmdPop();
    UI.renderChatList();
    UI.renderMessages();
    el.title.textContent = State.current().title;

    await runTurn();
  }

  async function runTurn() {
    const chat = State.current();
    const node = UI.appendStreaming();
    const md = $('.md', node);
    const typing = $('.typing', node);

    setStreaming(true);

    let buffer = '';
    let frame = null;
    const paint = () => {
      frame = null;
      md.innerHTML = MD.render(buffer) + '<span class="caret" aria-hidden="true"></span>';
      UI.scrollToEnd(false);
    };

    try {
      const full = await API.send(chat.messages, (delta) => {
        if (typing.parentNode) typing.remove();
        buffer += delta;
        // One repaint per frame — markdown re-parsing every token would jank on long answers.
        if (!frame) frame = requestAnimationFrame(paint);
      });

      if (frame) cancelAnimationFrame(frame);
      State.addMessage('ai', full);
      node.remove();
      UI.renderMessages();
      UI.renderChatList();
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      if (typing.parentNode) typing.remove();

      // A user-initiated stop keeps whatever arrived; anything else is an error.
      if (err.name === 'AbortError' && State.stopped) {
        if (buffer.trim()) {
          State.addMessage('ai', buffer + '\n\n_Stopped._');
          node.remove();
          UI.renderMessages();
        } else {
          node.remove();
        }
      } else {
        const message = err.name === 'AbortError'
          ? 'The request timed out after 90 seconds.'
          : (err.message || 'Something went wrong.');
        UI.showError(node, message, () => { node.remove(); runTurn(); });
      }
    } finally {
      State.stopped = false;
      setStreaming(false);
    }
  }

  function setStreaming(on) {
    State.streaming = on;
    el.send.classList.toggle('is-streaming', on);
    el.send.disabled = on ? false : !el.input.value.trim();
    el.send.setAttribute('aria-label', on ? 'Stop generating' : 'Send message');
  }

  function stopStreaming() {
    if (State.controller) {
      State.stopped = true;
      State.controller.abort();
    }
  }

  /* ---- composer sizing ---- */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
  }

  /* ---- slash command palette ---- */
  function updateCmdPop() {
    const value = el.input.value;
    const m = value.match(/^\/(\w*)$/);
    if (!m) { hideCmdPop(); return; }

    cmdMatches = COMMANDS.filter(c => c.cmd.slice(1).startsWith(m[1].toLowerCase()));
    if (!cmdMatches.length) { hideCmdPop(); return; }

    cmdIndex = 0;
    renderCmdPop();
    el.cmdPop.hidden = false;
  }

  function renderCmdPop() {
    el.cmdPop.innerHTML = cmdMatches.map((c, i) =>
      `<button class="cmd-opt${i === cmdIndex ? ' is-on' : ''}" type="button" role="option"
        aria-selected="${i === cmdIndex}" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${esc(c.desc)}</span></button>`
    ).join('');
    const on = $('.cmd-opt.is-on', el.cmdPop);
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function hideCmdPop() { el.cmdPop.hidden = true; cmdMatches = []; }

  function pickCmd(cmd) {
    el.input.value = cmd + ' ';
    hideCmdPop();
    el.input.focus();
    autoGrow();
    el.send.disabled = false;
  }

  /* ============================ App ============================ */

  const App = {
    init() {
      UI.applyTheme();
      UI.renderPrompts();
      UI.renderChatList();
      UI.syncSettingsForm();
      this.bindLanding();
      this.bindChat();
      this.bindComposer();
      this.bindSettings();
      this.bindGlobal();

      if (!Store.persistent) {
        setTimeout(() => toast('Storage is blocked — chats will not be saved.', 'err'), 800);
      }
      // Deep link: /#chat opens the app directly.
      if (location.hash === '#chat') UI.openChat();
    },

    /* ---- landing ---- */
    bindLanding() {
      $$('[data-open-chat]').forEach(b => b.addEventListener('click', () => {
        UI.openChat();
        history.replaceState(null, '', '#chat');
      }));
      $$('[data-close-chat]').forEach(b => b.addEventListener('click', (e) => {
        e.preventDefault();
        UI.closeChat();
        history.replaceState(null, '', '#home');
      }));

      $('#theme-toggle').addEventListener('click', () => UI.cycleTheme());
      $('#theme-toggle-2').addEventListener('click', () => UI.cycleTheme());

      const burger = $('#nav-burger');
      const links = $('#nav-links');
      burger.addEventListener('click', () => {
        const open = links.classList.toggle('is-open');
        burger.setAttribute('aria-expanded', String(open));
      });
      links.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') { links.classList.remove('is-open'); burger.setAttribute('aria-expanded', 'false'); }
      });

      // Hairline under the nav only once the page has moved.
      const nav = $('#nav');
      addEventListener('scroll', () => nav.classList.toggle('is-stuck', scrollY > 8), { passive: true });

      // Follow the OS when the theme is set to auto.
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (State.settings.theme === 'auto') UI.applyTheme();
      });
    },

    /* ---- chat shell ---- */
    bindChat() {
      $('#new-chat').addEventListener('click', () => {
        const empty = State.current();
        // Reuse an untouched chat rather than piling up blanks.
        if (!empty || empty.messages.length) State.createChat();
        UI.renderChatList();
        UI.renderMessages();
        UI.closeSidebar();
        el.input.focus();
      });

      $('#sidebar-open').addEventListener('click', () => UI.openSidebar());
      $('#sidebar-close').addEventListener('click', () => UI.closeSidebar());
      el.scrim.addEventListener('click', () => UI.closeSidebar());
      $('#open-settings').addEventListener('click', () => { UI.syncSettingsForm(); el.settings.showModal(); });

      $('#search-chats').addEventListener('input', (e) => UI.renderChatList(e.target.value));

      el.chatList.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) {
          e.stopPropagation();
          const chat = State.chats.find(c => c.id === del.dataset.del);
          if (chat && chat.messages.length && !confirm(`Delete “${chat.title}”? This cannot be undone.`)) return;
          State.deleteChat(del.dataset.del);
          if (!State.chats.length) State.createChat();
          UI.renderChatList();
          UI.renderMessages();
          toast('Chat deleted.', 'ok');
          return;
        }
        const item = e.target.closest('.sb-item');
        if (item) {
          if (State.streaming) stopStreaming();
          State.currentId = item.dataset.id;
          UI.renderChatList();
          UI.renderMessages();
          UI.closeSidebar();
        }
      });

      el.chatList.addEventListener('keydown', (e) => {
        const item = e.target.closest('.sb-item');
        if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); item.click(); }
      });

      // Prompt cards + filters
      el.promptGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.prompt-card');
        if (card) sendMessage(card.dataset.text);
      });
      $$('.filter-chip').forEach(chip =>
        chip.addEventListener('click', () => UI.filterPrompts(chip.dataset.filter))
      );

      // Copy code, copy message, retry — one delegated listener for the whole stream.
      el.messages.addEventListener('click', async (e) => {
        const copyCode = e.target.closest('[data-copy]');
        if (copyCode) {
          const block = copyCode.closest('.code-block');
          const ok = await copyText(decodeURIComponent(block.dataset.code));
          const label = $('span', copyCode);
          copyCode.classList.toggle('is-done', ok);
          label.textContent = ok ? 'Copied' : 'Failed';
          setTimeout(() => { label.textContent = 'Copy'; copyCode.classList.remove('is-done'); }, 1600);
          return;
        }
        const copyMsg = e.target.closest('[data-copy-msg]');
        if (copyMsg) {
          const chat = State.current();
          const m = chat.messages.find(x => x.id === copyMsg.dataset.copyMsg);
          if (!m) return;
          const ok = await copyText(m.content);
          toast(ok ? 'Copied to clipboard.' : 'Could not copy.', ok ? 'ok' : 'err');
          return;
        }
        const retry = e.target.closest('[data-retry]');
        if (retry && !State.streaming) {
          const chat = State.current();
          const i = chat.messages.findIndex(x => x.id === retry.dataset.retry);
          if (i > -1) {
            chat.messages.splice(i);       // drop this answer, keep the question
            State.save();
            UI.renderMessages();
            runTurn();
          }
        }
      });

      el.messages.addEventListener('scroll', () => {
        el.scrollBtn.hidden = UI.nearBottom();
      }, { passive: true });
      el.scrollBtn.addEventListener('click', () => UI.scrollToEnd(true));

      // Export menu
      el.exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = el.exportMenu.hidden;
        el.exportMenu.hidden = !open;
        el.exportBtn.setAttribute('aria-expanded', String(open));
      });
      el.exportMenu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-export]');
        if (!b) return;
        el.exportMenu.hidden = true;
        el.exportBtn.setAttribute('aria-expanded', 'false');
        Export.run(b.dataset.export);
      });
      document.addEventListener('click', () => {
        if (!el.exportMenu.hidden) { el.exportMenu.hidden = true; el.exportBtn.setAttribute('aria-expanded', 'false'); }
      });
    },

    /* ---- composer ---- */
    bindComposer() {
      el.input.addEventListener('input', () => {
        autoGrow();
        if (!State.streaming) el.send.disabled = !el.input.value.trim();
        updateCmdPop();
      });

      el.input.addEventListener('keydown', (e) => {
        // Command palette takes the arrow keys while it is open.
        if (!el.cmdPop.hidden && cmdMatches.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = (cmdIndex + 1) % cmdMatches.length; renderCmdPop(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = (cmdIndex - 1 + cmdMatches.length) % cmdMatches.length; renderCmdPop(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickCmd(cmdMatches[cmdIndex].cmd); return; }
          if (e.key === 'Escape') { hideCmdPop(); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });

      el.cmdPop.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cmd]');
        if (b) pickCmd(b.dataset.cmd);
      });

      el.send.addEventListener('click', () => (State.streaming ? stopStreaming() : sendMessage()));
    },

    /* ---- settings ---- */
    bindSettings() {
      $$('input[name="theme"]').forEach(r => r.addEventListener('change', () => {
        State.settings.theme = r.value;
        State.saveSettings();
        UI.applyTheme();
      }));

      const font = $('#set-font');
      font.addEventListener('input', () => {
        State.settings.fontSize = +font.value;
        $('#set-font-out').textContent = font.value + 'px';
        State.saveSettings();
        UI.applyTheme();
      });

      const temp = $('#set-temp');
      temp.addEventListener('input', () => {
        State.settings.temperature = +temp.value;
        $('#set-temp-out').textContent = Number(temp.value).toFixed(1);
        State.saveSettings();
      });

      $('#set-length').addEventListener('change', (e) => {
        State.settings.length = e.target.value;
        State.saveSettings();
      });

      $('#set-endpoint').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        if (v && !/^https?:\/\//i.test(v)) { toast('Enter a full URL starting with https://', 'err'); return; }
        State.settings.endpoint = v;
        State.saveSettings();
        toast(v ? 'Endpoint saved.' : 'Using the built-in endpoint.', 'ok');
      });

      $('#clear-history').addEventListener('click', () => {
        if (!confirm('Delete every conversation in this browser? This cannot be undone.')) return;
        State.chats = [];
        State.currentId = null;
        Store.remove(CONFIG.STORAGE_KEY);
        State.createChat();
        UI.renderChatList();
        UI.renderMessages();
        toast('History cleared.', 'ok');
      });
    },

    /* ---- global keys ---- */
    bindGlobal() {
      document.addEventListener('keydown', (e) => {
        const inChat = !el.chatView.hidden;
        // Cmd/Ctrl+K: new chat. Esc: close the drawer, then the app.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && inChat) {
          e.preventDefault();
          $('#new-chat').click();
        }
        if (e.key === 'Escape' && inChat && !el.settings.open) {
          if (el.sidebar.classList.contains('is-open')) UI.closeSidebar();
          else if (State.streaming) stopStreaming();
        }
      });

      // Warn before a reload throws away an in-flight answer.
      addEventListener('beforeunload', (e) => {
        if (State.streaming) { e.preventDefault(); e.returnValue = ''; }
      });
    }
  };

  document.addEventListener('DOMContentLoaded', () => App.init());
})();
