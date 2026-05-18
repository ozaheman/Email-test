#!/usr/bin/env node
/**
 * test.js — Local smoke-tests for api/send.js
 *
 * Usage:
 *   node test.js                   # run all tests (no real SMTP needed)
 *   node test.js --smtp-live       # also run live SMTP test (needs env vars)
 *
 * Live SMTP env vars (only for --smtp-live):
 *   SMTP_SERVER   e.g. smtp.gmail.com
 *   SMTP_PORT     e.g. 587
 *   SMTP_USER     your email
 *   SMTP_PASS     your app-password
 *   SMTP_TO       recipient address
 */

'use strict';

const http    = require('http');
const { once } = require('events');

// ── Minimal mock req/res ──────────────────────────────────────────────────────
function mockReq(method, url, headers, bodyStr) {
  const { Readable } = require('stream');
  const r = Readable.from([bodyStr ?? '']);
  r.method  = method;
  r.url     = url;
  r.headers = { host: 'localhost', ...headers };
  return r;
}

function mockRes() {
  const res = {
    _status: null, _headers: {}, _body: '',
    writeHead(status, headers) { this._status = status; Object.assign(this._headers, headers ?? {}); },
    end(body) { this._body = body ?? ''; },
    json() { return JSON.parse(this._body); },
  };
  return res;
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function run(label, fn) {
  console.log(`\n▶  ${label}`);
  try { await fn(); }
  catch (e) { console.error('  💥  Threw:', e.message); failed++; }
}

// ── Load handler ─────────────────────────────────────────────────────────────
const handler = require('./api/send.js');

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══════════════════════════════════════');
  console.log(' ERP Email Client — api/send.js Tests  ');
  console.log('═══════════════════════════════════════');

  // ── 1. Health endpoint ─────────────────────────────────────────────────────
  await run('GET /api/send?action=health', async () => {
    const req = mockReq('GET', '/api/send?action=health', {});
    const res = mockRes();
    await handler(req, res);
    assert('returns 200', res._status === 200);
    const body = res.json();
    assert('status is OK',        body.status === 'OK');
    assert('has timestamp',        typeof body.timestamp === 'string');
  });

  // ── 2. CORS preflight ──────────────────────────────────────────────────────
  await run('OPTIONS preflight', async () => {
    const req = mockReq('OPTIONS', '/api/send', {});
    const res = mockRes();
    await handler(req, res);
    assert('returns 204',          res._status === 204);
    assert('CORS origin header',   res._headers['Access-Control-Allow-Origin'] === '*');
  });

  // ── 3. Method not allowed ─────────────────────────────────────────────────
  await run('PUT /api/send → 405', async () => {
    const req = mockReq('PUT', '/api/send', {});
    const res = mockRes();
    await handler(req, res);
    assert('returns 405',          res._status === 405);
    assert('success is false',     res.json().success === false);
  });

  // ── 4. Missing smtpConfig ─────────────────────────────────────────────────
  await run('POST send without smtpConfig', async () => {
    const body = 'to=test%40example.com&subject=Hi&message=Hello';
    const req  = mockReq('POST', '/api/send', {
      'content-type': 'application/x-www-form-urlencoded',
    }, body);
    const res  = mockRes();
    await handler(req, res);
    assert('returns 400',          res._status === 400);
    assert('success is false',     res.json().success === false);
    assert('mentions smtpConfig',  res.json().message.includes('smtpConfig'));
  });

  // ── 5. Malformed smtpConfig JSON ──────────────────────────────────────────
  await run('POST send with invalid smtpConfig JSON', async () => {
    const body = 'smtpConfig=%7Bnot-json%7D&to=a%40b.com&subject=X&message=Y';
    const req  = mockReq('POST', '/api/send', {
      'content-type': 'application/x-www-form-urlencoded',
    }, body);
    const res  = mockRes();
    await handler(req, res);
    assert('returns 400',          res._status === 400);
    assert('success is false',     res.json().success === false);
  });

  // ── 6. smtpConfig missing required fields ─────────────────────────────────
  await run('POST send with incomplete smtpConfig', async () => {
    const cfg  = JSON.stringify({ server: 'smtp.gmail.com' }); // no user/pass
    const body = `smtpConfig=${encodeURIComponent(cfg)}&to=a%40b.com&subject=X&message=Y`;
    const req  = mockReq('POST', '/api/send', {
      'content-type': 'application/x-www-form-urlencoded',
    }, body);
    const res  = mockRes();
    await handler(req, res);
    assert('returns 400',          res._status === 400);
    assert('success is false',     res.json().success === false);
  });

  // ── 7. No recipients ──────────────────────────────────────────────────────
  await run('POST send with no recipients', async () => {
    const cfg  = JSON.stringify({ server: 'smtp.example.com', user: 'u', pass: 'p' });
    const body = `smtpConfig=${encodeURIComponent(cfg)}&to=&subject=X&message=Y`;
    const req  = mockReq('POST', '/api/send', {
      'content-type': 'application/x-www-form-urlencoded',
    }, body);
    const res  = mockRes();
    await handler(req, res);
    assert('returns 400',          res._status === 400);
    assert('mentions recipient',   res.json().message.toLowerCase().includes('recipient'));
  });

  // ── 8. Validate action — missing fields ───────────────────────────────────
  await run('POST validate with missing fields', async () => {
    const body = 'smtpConfig=%7B%22server%22%3A%22smtp.gmail.com%22%7D';
    const req  = mockReq('POST', '/api/send?action=validate', {
      'content-type': 'application/x-www-form-urlencoded',
    }, body);
    const res  = mockRes();
    await handler(req, res);
    assert('returns 400',          res._status === 400);
    assert('success is false',     res.json().success === false);
  });

  // ── 9. JSON body parsing ──────────────────────────────────────────────────
  await run('POST with application/json body', async () => {
    const payload = JSON.stringify({
      smtpConfig: JSON.stringify({ server: 'x', user: 'u', pass: 'p' }),
      to: '',
      subject: 'Test',
      message: 'Hello',
    });
    const req = mockReq('POST', '/api/send', {
      'content-type': 'application/json',
    }, payload);
    const res = mockRes();
    await handler(req, res);
    // no recipients → 400 is the correct behaviour
    assert('JSON body parsed (400 no recipients)', res._status === 400);
  });

  // ── 10. Live SMTP (opt-in) ────────────────────────────────────────────────
  if (process.argv.includes('--smtp-live')) {
    await run('LIVE SMTP — validate connection', async () => {
      const { SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
      if (!SMTP_SERVER || !SMTP_USER || !SMTP_PASS) {
        console.log('  ⚠️   Skipped — set SMTP_SERVER / SMTP_USER / SMTP_PASS env vars');
        return;
      }
      const cfg  = JSON.stringify({ server: SMTP_SERVER, port: SMTP_PORT || '587', user: SMTP_USER, pass: SMTP_PASS });
      const body = `smtpConfig=${encodeURIComponent(cfg)}`;
      const req  = mockReq('POST', '/api/send?action=validate', {
        'content-type': 'application/x-www-form-urlencoded',
      }, body);
      const res  = mockRes();
      await handler(req, res);
      const json = res.json();
      assert('SMTP connection succeeded', json.success === true, json.message);
    });

    await run('LIVE SMTP — send email', async () => {
      const { SMTP_SERVER, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_TO } = process.env;
      if (!SMTP_SERVER || !SMTP_USER || !SMTP_PASS || !SMTP_TO) {
        console.log('  ⚠️   Skipped — also set SMTP_TO env var');
        return;
      }
      const cfg  = JSON.stringify({ server: SMTP_SERVER, port: SMTP_PORT || '587', user: SMTP_USER, pass: SMTP_PASS });
      const body = `smtpConfig=${encodeURIComponent(cfg)}&to=${encodeURIComponent(SMTP_TO)}&subject=ERP+Test&message=Hello+from+test.js`;
      const req  = mockReq('POST', '/api/send', {
        'content-type': 'application/x-www-form-urlencoded',
      }, body);
      const res  = mockRes();
      await handler(req, res);
      const json = res.json();
      assert('email sent successfully', json.success === true, json.message);
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════\n');
  if (failed > 0) process.exit(1);
})();
