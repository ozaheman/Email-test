/**
 * api/send.js — Vercel Serverless SMTP Email Function
 * Zero external dependencies — pure Node.js built-ins only
 */

'use strict';

const net    = require('net');
const tls    = require('tls');
const crypto = require('crypto');

// ─── CORS HEADERS ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── REPLY HELPER (always JSON, never crashes) ────────────────────────────────
function reply(res, status, data) {
  try {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch(e) {
    // last-ditch: if writeHead already called, just end
    try { res.end(JSON.stringify(data)); } catch {}
  }
}

// ─── SMTP CLIENT ─────────────────────────────────────────────────────────────
class SmtpClient {
  constructor(cfg) {
    this.cfg    = cfg;
    this.socket = null;
    this.buffer = '';
    this._queue = [];
    this._dead  = false;
  }

  async connect() {
    const { server, port: rawPort } = this.cfg;
    const port   = parseInt(rawPort, 10) || 587;
    const useSSL = port === 465;

    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(new Error('Connect failed: ' + e.message));

      const setup = (sock) => {
        this.socket = sock;
        sock.setEncoding('utf8');
        sock.setTimeout(15000, () => {
          this._dead = true;
          sock.destroy(new Error('Socket timeout'));
          this._rejectAll(new Error('Socket timeout'));
        });
        sock.on('error', (e) => { this._dead = true; this._rejectAll(e); });
        sock.on('close', ()  => { this._dead = true; this._rejectAll(new Error('Connection closed unexpectedly')); });
        sock.on('data',  (d) => this._onData(d));
        resolve();
      };

      if (useSSL) {
        const s = tls.connect({ host: server, port, rejectUnauthorized: false }, () => setup(s));
        s.on('error', onErr);
      } else {
        const s = net.connect({ host: server, port }, () => setup(s));
        s.on('error', onErr);
      }
    });

    await this._handshake(useSSL);
  }

  async _handshake(isSsl) {
    const { server, user, pass } = this.cfg;

    await this._expect([220], 'greeting');

    let caps = '';
    try {
      caps = await this._cmd('EHLO vercel-mailer', [250]);
    } catch {
      await this._cmd('HELO vercel-mailer', [250]);
    }

    if (!isSsl && /STARTTLS/i.test(caps)) {
      await this._cmd('STARTTLS', [220]);
      await new Promise((res, rej) => {
        const up = tls.connect(
          { socket: this.socket, host: server, rejectUnauthorized: false },
          () => {
            up.setEncoding('utf8');
            this.socket.removeAllListeners('data');
            this.socket.removeAllListeners('error');
            this.socket.removeAllListeners('close');
            this.socket = up;
            up.on('data',  (d) => this._onData(d));
            up.on('error', (e) => { this._dead = true; this._rejectAll(e); });
            up.on('close', ()  => { this._dead = true; this._rejectAll(new Error('TLS closed')); });
            res();
          }
        );
        up.on('error', rej);
      });
      await this._cmd('EHLO vercel-mailer', [250]);
    }

    // AUTH LOGIN
    await this._cmd('AUTH LOGIN', [334]);
    await this._cmd(Buffer.from(user).toString('base64'), [334]);
    const authResp = await this._cmd(Buffer.from(pass).toString('base64'), [235, 334, 535, 500, 501, 502, 503, 504]);
    const authCode = parseInt(authResp.slice(0, 3), 10);
    if (authCode !== 235) {
      throw new Error(`Authentication failed (${authResp.trim()}). Check username/password.`);
    }
  }

  async send({ from, to, subject, html, attachments = [] }) {
    const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];

    await this._cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await this._cmd(`RCPT TO:<${to}>`, [250, 251]);
    await this._cmd('DATA', [354]);

    const boundary = `BOUND${crypto.randomBytes(8).toString('hex')}`;
    const msgId    = `<${Date.now()}.${crypto.randomBytes(4).toString('hex')}@vercel>`;
    const hasAtt   = attachments.length > 0;

    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${msgId}`,
      `MIME-Version: 1.0`,
      `Content-Type: ${hasAtt
        ? `multipart/mixed; boundary="${boundary}"`
        : 'text/html; charset=UTF-8'}`,
      '',
    ];

    if (hasAtt) {
      lines.push(
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qpEncode(html),
      );
      for (const att of attachments) {
        lines.push(
          `--${boundary}`,
          `Content-Type: ${att.mime || 'application/octet-stream'}; name="${att.filename}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${att.filename}"`,
          '',
          att.data,
        );
      }
      lines.push(`--${boundary}--`);
    } else {
      lines.push(
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qpEncode(html),
      );
    }

    const body = lines.join('\r\n') + '\r\n.';
    await this._sendRaw(body);
    await this._expect([250], 'DATA accepted');
  }

  async quit() {
    try {
      if (this.socket && !this._dead) {
        this.socket.write('QUIT\r\n');
        await new Promise(r => setTimeout(r, 300));
      }
    } catch {}
    try { this.socket && this.socket.destroy(); } catch {}
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl + 1).replace(/\r?\n$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      // dispatch only on final line of multi-line response (code + space, not dash)
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const cb = this._queue.shift();
        if (cb) cb(null, line);
      }
    }
  }

  _waitLine(ms = 15000) {
    return new Promise((resolve, reject) => {
      if (this._dead) return reject(new Error('Connection is dead'));
      const t = setTimeout(() => {
        const i = this._queue.indexOf(cb);
        if (i !== -1) this._queue.splice(i, 1);
        reject(new Error('SMTP response timeout'));
      }, ms);
      const cb = (err, line) => {
        clearTimeout(t);
        if (err) reject(err); else resolve(line);
      };
      this._queue.push(cb);
    });
  }

  async _expect(codes, label) {
    const line = await this._waitLine();
    const code = parseInt(line.slice(0, 3), 10);
    if (!codes.includes(code)) {
      throw new Error(`SMTP error (${label}): got "${line.trim()}"`);
    }
    return line;
  }

  async _cmd(cmd, expect) {
    if (this._dead) throw new Error('Connection is dead');
    this.socket.write(cmd + '\r\n');
    return this._expect(expect, cmd.split(' ')[0]);
  }

  _sendRaw(data) {
    return new Promise((res, rej) => {
      if (this._dead) return rej(new Error('Connection is dead'));
      this.socket.write(data + '\r\n', (e) => e ? rej(e) : res());
    });
  }

  _rejectAll(err) {
    const cbs = this._queue.splice(0);
    for (const cb of cbs) cb(err);
  }
}

function qpEncode(str) {
  return (str || '').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, c =>
    Array.from(Buffer.from(c, 'utf8'))
      .map(b => '=' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join('')
  );
}

// ─── BODY PARSER ─────────────────────────────────────────────────────────────
async function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',  () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

function parseMultipart(raw, boundary) {
  const fields = {};
  const files  = [];
  const sep    = `--${boundary}`;
  const parts  = raw.toString('binary').split(sep).slice(1);

  for (const part of parts) {
    if (part.startsWith('--') || !part.trim()) continue;
    const crlf = part.indexOf('\r\n\r\n');
    if (crlf === -1) continue;

    const headerBlock = part.slice(0, crlf);
    let   content     = part.slice(crlf + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);

    const headers = {};
    for (const h of headerBlock.trim().split('\r\n')) {
      const ci = h.indexOf(':');
      if (ci !== -1) headers[h.slice(0, ci).trim().toLowerCase()] = h.slice(ci + 1).trim();
    }

    const cd    = headers['content-disposition'] || '';
    const nameM = cd.match(/name="([^"]+)"/);
    const fileM = cd.match(/filename="([^"]+)"/);
    if (!nameM) continue;

    if (fileM) {
      const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
      const b64 = enc === 'base64'
        ? content.replace(/\s/g, '')
        : Buffer.from(content, 'binary').toString('base64');
      files.push({
        fieldname: nameM[1],
        filename:  fileM[1],
        mime:      headers['content-type'] || 'application/octet-stream',
        data:      b64,
      });
    } else {
      fields[nameM[1]] = content;
    }
  }
  return { fields, files };
}

async function parseBody(req) {
  const raw = await readBody(req);
  const ct  = (req.headers['content-type'] || '').toLowerCase();

  if (ct.includes('application/json')) {
    try {
      return { fields: JSON.parse(raw.toString('utf8')), files: [] };
    } catch(e) {
      throw new Error('Invalid JSON body: ' + e.message);
    }
  }
  if (ct.includes('multipart/form-data')) {
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) throw new Error('Multipart missing boundary');
    return parseMultipart(raw, bm[1].replace(/^"|"$/g, ''));
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return { fields: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: [] };
  }
  // fallback: try JSON, then form
  try {
    return { fields: JSON.parse(raw.toString('utf8')), files: [] };
  } catch {
    return { fields: {}, files: [] };
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Always set CORS on every response
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Parse action from URL
  let action = '';
  try {
    const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    action = urlObj.searchParams.get('action') || '';
  } catch {}

  // Health check
  if (req.method === 'GET') {
    if (action === 'health') {
      return reply(res, 200, { status: 'OK', timestamp: new Date().toISOString() });
    }
    return reply(res, 405, { success: false, message: 'Method not allowed' });
  }

  if (req.method !== 'POST') {
    return reply(res, 405, { success: false, message: 'Method not allowed' });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let fields, files;
  try {
    ({ fields, files } = await parseBody(req));
  } catch (e) {
    return reply(res, 400, { success: false, message: 'Could not parse request: ' + e.message });
  }

  // ── Parse & validate SMTP config ───────────────────────────────────────────
  let smtp;
  try {
    const raw = fields.smtpConfig;
    if (!raw) return reply(res, 400, { success: false, message: 'smtpConfig missing from request' });
    smtp = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return reply(res, 400, { success: false, message: 'Invalid smtpConfig JSON: ' + e.message });
  }

  if (!smtp.server || !smtp.user || !smtp.pass) {
    return reply(res, 400, { success: false, message: 'smtpConfig must include server, user, and pass' });
  }

  // ── VALIDATE action ─────────────────────────────────────────────────────────
  if (action === 'validate') {
    const client = new SmtpClient(smtp);
    try {
      await client.connect();
      await client.quit();
      return reply(res, 200, { success: true, message: 'SMTP connection verified ✅' });
    } catch (e) {
      return reply(res, 200, { success: false, message: e.message });
    }
  }

  // ── SEND action ─────────────────────────────────────────────────────────────
  const toRaw = fields.to || '';
  const recipients = toRaw.split(',').map(r => r.trim()).filter(Boolean);
  if (!recipients.length) {
    return reply(res, 400, { success: false, message: 'No recipients specified' });
  }

  const subject = (fields.subject || '(No Subject)').trim();
  const body    = fields.message || '';
  const html    = `<div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;line-height:1.6">${body}<hr style="margin-top:30px;border:none;border-top:1px solid #eee"/><small style="color:#999">Sent via ERP Mail</small></div>`;

  const results = [];
  for (const to of recipients) {
    const client = new SmtpClient(smtp);
    try {
      await client.connect();
      await client.send({
        from: `"ERP Mail" <${smtp.user}>`,
        to,
        subject,
        html,
        attachments: files || [],
      });
      await client.quit();
      results.push({ to, success: true });
      console.log(`[SENT] → ${to}`);
    } catch (e) {
      console.error(`[ERR] → ${to}: ${e.message}`);
      results.push({ to, success: false, error: e.message });
      try { await client.quit(); } catch {}
    }
  }

  const sentCount = results.filter(r => r.success).length;
  if (sentCount === 0) {
    return reply(res, 200, {
      success: false,
      message: results[0]?.error || 'All sends failed',
      results,
    });
  }

  return reply(res, 200, {
    success: true,
    message: `Sent to ${sentCount}/${results.length} recipient(s)`,
    results,
    timestamp: new Date().toISOString(),
  });
};