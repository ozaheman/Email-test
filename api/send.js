/**
 * api/send.js — Vercel Serverless SMTP Email Function
 * Zero external dependencies — pure Node.js built-ins only
 */

'use strict';

import net from 'net';
import tls from 'tls';
import crypto from 'crypto';

// ─── CORS HEADERS ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── REPLY HELPER ────────────────────────────────────────────────────────────────
function reply(res, status, data) {
  try {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch(e) {
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
    this._waitingForResponse = false;
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
        sock.setTimeout(30000, () => {
          this._dead = true;
          sock.destroy(new Error('Socket timeout'));
          this._rejectAll(new Error('Socket timeout'));
        });
        sock.on('error', (e) => { 
          this._dead = true; 
          this._rejectAll(e); 
        });
        sock.on('close', ()  => { 
          this._dead = true; 
          this._rejectAll(new Error('Connection closed unexpectedly')); 
        });
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

    // Wait for greeting
    await this._expect([220], 'greeting');

    // Try EHLO first, fallback to HELO
    let caps = '';
    try {
      caps = await this._cmd('EHLO vercel-mailer', [250]);
    } catch (e) {
      await this._cmd('HELO vercel-mailer', [250]);
    }

    // Upgrade to TLS if available and not already using SSL
    if (!isSsl && caps.toLowerCase().includes('starttls')) {
      await this._cmd('STARTTLS', [220]);
      
      // Upgrade socket to TLS
      await new Promise((resolve, reject) => {
        const tlsSocket = tls.connect({
          socket: this.socket,
          host: server,
          rejectUnauthorized: false
        });
        
        tlsSocket.once('secureConnect', () => {
          tlsSocket.setEncoding('utf8');
          
          // Remove old listeners
          this.socket.removeAllListeners('data');
          this.socket.removeAllListeners('error');
          this.socket.removeAllListeners('close');
          
          // Replace with new TLS socket
          this.socket = tlsSocket;
          
          // Set up new listeners
          tlsSocket.on('data', (d) => this._onData(d));
          tlsSocket.on('error', (e) => { this._dead = true; this._rejectAll(e); });
          tlsSocket.on('close', () => { this._dead = true; this._rejectAll(new Error('TLS closed')); });
          
          resolve();
        });
        
        tlsSocket.once('error', reject);
      });
      
      // Send EHLO again after TLS upgrade
      caps = await this._cmd('EHLO vercel-mailer', [250]);
    }

    // AUTH LOGIN
    const authResp = await this._cmd('AUTH LOGIN', [334]);
    
    // Send username in base64
    const userB64 = Buffer.from(user).toString('base64');
    await this._cmd(userB64, [334]);
    
    // Send password in base64
    const passB64 = Buffer.from(pass).toString('base64');
    const authResult = await this._cmd(passB64, [235, 334, 535, 500, 501, 502, 503, 504]);
    
    const authCode = parseInt(authResult.slice(0, 3), 10);
    if (authCode !== 235) {
      let errorMsg = `Authentication failed (${authResult.trim()})`;
      if (authResult.toLowerCase().includes('username') || authResult.toLowerCase().includes('password')) {
        errorMsg = 'Invalid username or password. For Gmail, use an App Password (not your regular password).';
      }
      throw new Error(errorMsg);
    }
  }

  async send({ from, to, subject, html, attachments = [] }) {
    const fromAddr = from.match(/<([^>]+)>/)?.[1] || from;

    await this._cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await this._cmd(`RCPT TO:<${to}>`, [250, 251]);
    await this._cmd('DATA', [354]);

    const boundary = `----=_Part_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const msgId    = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@erpmail>`;
    const hasAtt   = attachments && attachments.length > 0;

    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${msgId}`,
      `MIME-Version: 1.0`,
    ];

    if (hasAtt) {
      lines.push(
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qpEncode(html || ''),
        ''
      );
      
      for (const att of attachments) {
        lines.push(
          `--${boundary}`,
          `Content-Type: ${att.mime || 'application/octet-stream'}; name="${att.filename}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${att.filename}"`,
          '',
          att.data,
          ''
        );
      }
      lines.push(`--${boundary}--`);
    } else {
      lines.push(
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qpEncode(html || ''),
        ''
      );
    }

    let body = lines.join('\r\n');
    // RFC 5321 dot-stuffing: lines starting with '.' must be escaped as '..'
    body = body.replace(/\r\n\./g, '\r\n..');
    if (body.startsWith('.')) body = '.' + body;
    body += '\r\n.\r\n';
    await this._sendRaw(body);
    await this._expect([250], 'DATA accepted');
  }

  async quit() {
    try {
      if (this.socket && !this._dead) {
        this.socket.write('QUIT\r\n');
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}
    try { this.socket && this.socket.destroy(); } catch {}
  }

  _onData(chunk) {
    this.buffer += chunk;
    
    // Process complete lines
    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd === -1) break;
      
      const line = this.buffer.slice(0, lineEnd + 1).replace(/\r?\n$/, '');
      this.buffer = this.buffer.slice(lineEnd + 1);
      
      // Check if this is a complete SMTP response
      // SMTP responses end with a line starting with 3 digits followed by space (not dash)
      if (/^\d{3} /.test(line)) {
        const cb = this._queue.shift();
        if (cb) {
          cb(null, line);
        }
      }
    }
  }

  _waitLine(ms = 30000) {
    return new Promise((resolve, reject) => {
      if (this._dead) return reject(new Error('Connection is dead'));
      
      const timeout = setTimeout(() => {
        const idx = this._queue.indexOf(cb);
        if (idx !== -1) this._queue.splice(idx, 1);
        reject(new Error('SMTP response timeout'));
      }, ms);
      
      const cb = (err, line) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(line);
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
    
    return new Promise((resolve, reject) => {
      this.socket.write(cmd + '\r\n', (err) => {
        if (err) return reject(err);
        
        this._waitLine().then(line => {
          const code = parseInt(line.slice(0, 3), 10);
          if (expect.includes(code)) {
            resolve(line);
          } else {
            reject(new Error(`SMTP error for "${cmd}": got "${line.trim()}"`));
          }
        }).catch(reject);
      });
    });
  }

  _sendRaw(data) {
    return new Promise((res, rej) => {
      if (this._dead) return rej(new Error('Connection is dead'));
      this.socket.write(data, (e) => e ? rej(e) : res());
    });
  }

  _rejectAll(err) {
    const cbs = this._queue.splice(0);
    for (const cb of cbs) {
      cb(err);
    }
  }
}

function qpEncode(str) {
  if (!str) return '';
  
  // Encode non-ASCII and special characters
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 61) { // '='
      result += '=3D';
    } else if (code === 9) { // tab
      result += '\t';
    } else if (code === 32) { // space
      result += ' ';
    } else if (code === 13) { // CR
      result += '=0D';
    } else if (code === 10) { // LF
      result += '=0A';
    } else if (code >= 32 && code <= 126 && code !== 61) {
      result += str[i];
    } else {
      // Encode as =XX
      const hex = code.toString(16).toUpperCase();
      result += '=' + (hex.length === 1 ? '0' + hex : hex);
    }
  }
  
  // Wrap lines at 76 characters
  const lines = [];
  for (let i = 0; i < result.length; i += 75) {
    lines.push(result.slice(i, i + 75));
  }
  
  return lines.join('=\r\n');
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
  const parts  = raw.toString('binary').split(sep);
  
  for (const part of parts) {
    if (part.startsWith('--') || !part.trim()) continue;
    
    const crlf = part.indexOf('\r\n\r\n');
    if (crlf === -1) continue;
    
    const headerBlock = part.slice(0, crlf);
    let content = part.slice(crlf + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    
    const headers = {};
    for (const h of headerBlock.split('\r\n')) {
      const ci = h.indexOf(':');
      if (ci !== -1) {
        headers[h.slice(0, ci).trim().toLowerCase()] = h.slice(ci + 1).trim();
      }
    }
    
    const cd = headers['content-disposition'] || '';
    const nameMatch = cd.match(/name="([^"]+)"/);
    const filenameMatch = cd.match(/filename="([^"]+)"/);
    
    if (!nameMatch) continue;
    
    if (filenameMatch) {
      // Handle file attachment
      let fileData = content;
      const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
      
      if (enc === 'base64') {
        // Remove whitespace and keep base64 string
        fileData = content.replace(/\s/g, '');
      } else if (enc === 'quoted-printable') {
        // Decode quoted-printable
        fileData = content.replace(/=[\r\n]/g, '').replace(/=([0-9A-F]{2})/gi, (m, hex) => 
          String.fromCharCode(parseInt(hex, 16))
        );
        fileData = Buffer.from(fileData, 'binary').toString('base64');
      } else {
        fileData = Buffer.from(content, 'binary').toString('base64');
      }
      
      files.push({
        fieldname: nameMatch[1],
        filename: filenameMatch[1],
        mime: headers['content-type'] || 'application/octet-stream',
        data: fileData,
      });
    } else {
      fields[nameMatch[1]] = content;
    }
  }
  
  return { fields, files };
}

async function parseBody(req) {
  const raw    = await readBody(req);
  const ctOrig = req.headers['content-type'] || '';
  const ct     = ctOrig.toLowerCase();

  if (ct.includes('application/json')) {
    try {
      return { fields: JSON.parse(raw.toString('utf8')), files: [] };
    } catch(e) {
      throw new Error('Invalid JSON body: ' + e.message);
    }
  }
  
  if (ct.includes('multipart/form-data')) {
    const bm = ctOrig.match(/boundary=([^\s;]+)/i);
    if (!bm) throw new Error('Multipart missing boundary');
    const boundary = bm[1].replace(/^"|"$/g, '');
    return parseMultipart(raw, boundary);
  }
  
  if (ct.includes('application/x-www-form-urlencoded')) {
    return { fields: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: [] };
  }
  
  // Fallback: try to parse as form data
  try {
    const str = raw.toString('utf8');
    if (str.includes('=')) {
      return { fields: Object.fromEntries(new URLSearchParams(str)), files: [] };
    }
  } catch {}
  
  return { fields: {}, files: [] };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
//module.exports = async function handler(req, res) {
async function handler(req, res) {
  // Handle OPTIONS for CORS preflight
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

  // Parse body
  let fields, files;
  try {
    ({ fields, files } = await parseBody(req));
  } catch (e) {
    return reply(res, 400, { success: false, message: 'Could not parse request: ' + e.message });
  }

  // Parse & validate SMTP config
  let smtp;
  try {
    const raw = fields.smtpConfig;
    if (!raw) {
      return reply(res, 400, { success: false, message: 'smtpConfig missing from request' });
    }
    smtp = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return reply(res, 400, { success: false, message: 'Invalid smtpConfig JSON: ' + e.message });
  }

  if (!smtp.server || !smtp.user || !smtp.pass) {
    return reply(res, 400, { 
      success: false, 
      message: 'smtpConfig must include server, user, and pass' 
    });
  }

  // Normalize port
  if (!smtp.port) {
    smtp.port = smtp.sec === 'SSL' ? '465' : '587';
  }

  // VALIDATE action - test SMTP connection
  if (action === 'validate') {
    const client = new SmtpClient(smtp);
    try {
      await client.connect();
      await client.quit();
      return reply(res, 200, { 
        success: true, 
        message: 'SMTP connection verified successfully ✅' 
      });
    } catch (e) {
      console.error('SMTP validation error:', e.message);
      return reply(res, 200, { 
        success: false, 
        message: e.message 
      });
    }
  }

  // SEND action
  const toRaw = fields.to || '';
  const recipients = toRaw.split(',').map(r => r.trim()).filter(Boolean);
  
  if (!recipients.length) {
    return reply(res, 400, { 
      success: false, 
      message: 'No recipients specified' 
    });
  }

  const subject = (fields.subject || '(No Subject)').trim();
  let messageBody = fields.message || '';
  
  // Add tracking pixel if enabled
  if (fields.enableTracking === 'true') {
    const trackingPixel = `<img src="https://erp-mail.example.com/track.png?email=${encodeURIComponent(recipients[0])}" width="1" height="1" style="display:none"/>`;
    messageBody += trackingPixel;
  }
  
  // Format HTML body
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; line-height: 1.6;">
${messageBody.replace(/\n/g, '<br/>')}
<hr style="margin-top: 30px; border: none; border-top: 1px solid #e5e7eb;"/>
<p style="color: #9ca3af; font-size: 12px;">Sent via ERP Mail</p>
</div>
</body>
</html>`;

  const results = [];
  
  for (const to of recipients) {
    const client = new SmtpClient(smtp);
    try {
      await client.connect();
      await client.send({
        from: `"ERP Mail" <${smtp.user}>`,
        to: to,
        subject: subject,
        html: html,
        attachments: files || [],
      });
      await client.quit();
      results.push({ to, success: true });
    } catch (e) {
      console.error(`Send error to ${to}:`, e.message);
      results.push({ to, success: false, error: e.message });
      try { await client.quit(); } catch {}
    }
  }

  const sentCount = results.filter(r => r.success).length;
  
  if (sentCount === 0) {
    return reply(res, 200, {
      success: false,
      message: results[0]?.error || 'All sends failed',
      results: results,
    });
  }

  return reply(res, 200, {
    success: true,
    message: `Sent to ${sentCount}/${results.length} recipient(s)`,
    results: results,
    timestamp: new Date().toISOString(),
  });
};
export default handler;