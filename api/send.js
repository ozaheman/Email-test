/**
 * api/send.js — Vercel Serverless SMTP Email Function
 * Zero external dependencies — pure Node.js built-ins only
 * Supports: TLS / STARTTLS / plain, attachments (base64), bulk send
 */

'use strict';

const net    = require('net');
const tls    = require('tls');
const crypto = require('crypto');
const os     = require('os');

// ─── SMTP CLIENT ─────────────────────────────────────────────────────────────
class SmtpClient {
    constructor(cfg) {
        this.cfg    = cfg;
        this.socket = null;
        this.buffer = '';
        this._queue = [];
    }

    async connect() {
        const { server, port: rawPort } = this.cfg;
        const port   = parseInt(rawPort) || 587;
        const useSSL = port === 465;

        await new Promise((resolve, reject) => {
            const onError = (e) => reject(new Error('Connect failed: ' + e.message));
            const afterConnect = (sock) => {
                this.socket = sock;
                sock.setEncoding('utf8');
                sock.setTimeout(20000, () => sock.destroy(new Error('Socket timeout')));
                sock.on('error', (e) => { this._rejectAll(e); });
                sock.on('close', ()  => { this._rejectAll(new Error('Connection closed')); });
                sock.on('data',  (d) => this._onData(d));
                resolve();
            };

            if (useSSL) {
                const s = tls.connect({ host: server, port, rejectUnauthorized: false }, () => afterConnect(s));
                s.on('error', onError);
            } else {
                const s = net.connect({ host: server, port }, () => afterConnect(s));
                s.on('error', onError);
            }
        });

        await this._handshake(useSSL);
    }

    async _handshake(isSsl) {
        const { server, user, pass } = this.cfg;
        await this._expect(220, 'greeting');

        const hostname = (() => { try { return os.hostname(); } catch { return 'mail.client'; } })();
        let caps = '';
        try { caps = await this._cmd(`EHLO ${hostname}`, 250); }
        catch { await this._cmd(`HELO ${hostname}`, 250); }

        if (!isSsl && /STARTTLS/i.test(caps)) {
            await this._cmd('STARTTLS', 220);
            await new Promise((res, rej) => {
                const upgraded = tls.connect({ socket: this.socket, host: server, rejectUnauthorized: false }, () => {
                    upgraded.setEncoding('utf8');
                    this.socket.removeAllListeners('data');
                    this.socket = upgraded;
                    upgraded.on('data',  (d) => this._onData(d));
                    upgraded.on('error', (e) => this._rejectAll(e));
                    upgraded.on('close', ()  => this._rejectAll(new Error('TLS closed')));
                    res();
                });
                upgraded.on('error', rej);
            });
            await this._cmd(`EHLO ${hostname}`, 250);
        }

        await this._cmd('AUTH LOGIN', 334);
        await this._cmd(Buffer.from(user).toString('base64'), 334);
        await this._cmd(Buffer.from(pass).toString('base64'), 235);
    }

    async send({ from, to, subject, html, attachments = [] }) {
        const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1];

        await this._cmd(`MAIL FROM:<${fromAddr}>`, 250);
        await this._cmd(`RCPT TO:<${to}>`, [250, 251]);
        await this._cmd('DATA', 354);

        const boundary = `_BOUND_${crypto.randomBytes(10).toString('hex')}_`;
        const msgId    = `<${Date.now()}.${crypto.randomBytes(5).toString('hex')}@vercel>`;
        const hasAtt   = attachments.length > 0;

        const lines = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: ${msgId}`,
            `MIME-Version: 1.0`,
            `Content-Type: ${hasAtt ? `multipart/mixed; boundary="${boundary}"` : 'text/html; charset=UTF-8'}`,
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
                    att.data,   // already base64 string
                );
            }
            lines.push(`--${boundary}--`);
        } else {
            lines.push('Content-Transfer-Encoding: quoted-printable', '', qpEncode(html));
        }

        await this._sendRaw(lines.join('\r\n') + '\r\n.');
        await this._expect(250, 'DATA accepted');
    }

    async quit() {
        try {
            this.socket.write('QUIT\r\n');
            await new Promise(r => setTimeout(r, 200));
            this.socket.destroy();
        } catch {}
    }

    _onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, nl + 1).replace(/\r?\n$/, '');
            this.buffer = this.buffer.slice(nl + 1);
            if (/^\d{3}[ -]/.test(line) || /^\d{3}$/.test(line)) {
                // Only dispatch on final line of multi-line response
                if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
                    const r = this._queue.shift();
                    if (r) r(line);
                }
            }
        }
    }

    _waitLine(ms = 20000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                const i = this._queue.indexOf(r);
                if (i !== -1) this._queue.splice(i, 1);
                reject(new Error('SMTP timeout'));
            }, ms);
            const r = (line) => { clearTimeout(t); resolve(line); };
            this._queue.push(r);
        });
    }

    async _expect(codes, label) {
        const allowed = [].concat(codes).map(String);
        const line    = await this._waitLine();
        const code    = line.slice(0, 3);
        if (!allowed.includes(code))
            throw new Error(`SMTP ${label}: expected ${allowed.join('/')} got "${line}"`);
        return line;
    }

    async _cmd(cmd, expect) {
        this.socket.write(cmd + '\r\n');
        return this._expect(expect, cmd.split(' ')[0]);
    }

    async _sendRaw(data) {
        return new Promise((res, rej) => this.socket.write(data + '\r\n', e => e ? rej(e) : res()));
    }

    _rejectAll(err) {
        this._queue.splice(0).forEach(r => r(`500 ${err.message}`));
    }
}

function qpEncode(str) {
    return str.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, c => {
        return Array.from(Buffer.from(c, 'utf8')).map(b => '=' + b.toString(16).toUpperCase().padStart(2,'0')).join('');
    });
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
    const parts  = raw.toString('binary').split(`--${boundary}`).slice(1);

    for (const part of parts) {
        if (part.trim() === '--' || !part.trim()) continue;
        const sep = part.indexOf('\r\n\r\n');
        if (sep === -1) continue;
        const headerBlock = part.slice(0, sep);
        let   content     = part.slice(sep + 4);
        if (content.endsWith('\r\n')) content = content.slice(0, -2);

        const headers = {};
        for (const h of headerBlock.trim().split('\r\n')) {
            const c = h.indexOf(':');
            if (c !== -1) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
        }

        const cd      = headers['content-disposition'] || '';
        const nameM   = cd.match(/name="([^"]+)"/);
        const fileM   = cd.match(/filename="([^"]+)"/);
        const ctype   = headers['content-type'] || 'application/octet-stream';
        const enc     = (headers['content-transfer-encoding'] || '').toLowerCase();

        if (!nameM) continue;

        if (fileM) {
            let b64;
            if (enc === 'base64') {
                b64 = content.replace(/\s/g, '');
            } else {
                b64 = Buffer.from(content, 'binary').toString('base64');
            }
            files.push({ fieldname: nameM[1], filename: fileM[1], mime: ctype, data: b64 });
        } else {
            fields[nameM[1]] = content;
        }
    }
    return { fields, files };
}

async function parseBody(req) {
    const raw = await readBody(req);
    const ct  = req.headers['content-type'] || '';

    if (ct.includes('application/json')) {
        return { fields: JSON.parse(raw.toString()), files: [] };
    }
    if (ct.includes('multipart/form-data')) {
        const bm = ct.match(/boundary=([^\s;]+)/);
        if (!bm) throw new Error('No boundary');
        return parseMultipart(raw, bm[1].replace(/^"|"$/g, ''));
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
        return { fields: Object.fromEntries(new URLSearchParams(raw.toString())), files: [] };
    }
    return { fields: {}, files: [] };
}

// ─── CORS HEADERS ─────────────────────────────────────────────────────────────
const CORS = {
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
    }

    const reply = (status, data) => {
        res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    // ── Parse query string manually (req.query undefined in Vercel raw handlers) ──
    const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const action = urlObj.searchParams.get('action') || '';

    if (req.method === 'GET' && action === 'health') {
        return reply(200, { status: 'OK', timestamp: new Date().toISOString() });
    }

    if (req.method !== 'POST') return reply(405, { success: false, message: 'Method not allowed' });

    try {
        const { fields, files } = await parseBody(req);

        // ── Validate SMTP ───────────────────────────────────────────────────
        if (action === 'validate') {
            let smtp;
            try { smtp = typeof fields.smtpConfig === 'string' ? JSON.parse(fields.smtpConfig) : fields; }
            catch { return reply(400, { success: false, message: 'Invalid SMTP config JSON' }); }

            if (!smtp.server || !smtp.user || !smtp.pass)
                return reply(400, { success: false, message: 'server, user and pass are required' });

            const client = new SmtpClient(smtp);
            await client.connect();
            await client.quit();
            return reply(200, { success: true, message: 'SMTP connection verified ✅' });
        }

        // ── Send Email ──────────────────────────────────────────────────────
        if (!fields.smtpConfig) return reply(400, { success: false, message: 'smtpConfig missing' });

        let smtp;
        try { smtp = JSON.parse(fields.smtpConfig); }
        catch { return reply(400, { success: false, message: 'Invalid smtpConfig JSON' }); }

        if (!smtp.server || !smtp.user || !smtp.pass)
            return reply(400, { success: false, message: 'smtpConfig needs server, user, pass' });

        const recipients = (fields.to || '').split(',').map(r => r.trim()).filter(Boolean);
        if (!recipients.length) return reply(400, { success: false, message: 'No recipients' });

        const subject = fields.subject || '(No Subject)';
        const html    = `<div style="font-family:Arial,sans-serif;padding:20px;max-width:600px">
                            ${fields.message || ''}
                            <hr style="margin-top:30px;border:none;border-top:1px solid #eee"/>
                            <small style="color:#999">Sent via ERP Email System</small>
                         </div>`;

        const results = [];
        for (const to of recipients) {
            const client = new SmtpClient(smtp);
            try {
                await client.connect();
                await client.send({
                    from: `"Mail System" <${smtp.user}>`,
                    to,
                    subject,
                    html,
                    attachments: files,
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

        const allFailed = results.every(r => !r.success);
        if (allFailed) return reply(500, { success: false, message: results[0].error, results });

        return reply(200, {
            success: true,
            message: `Sent to ${results.filter(r => r.success).length}/${results.length} recipient(s)`,
            results,
            timestamp: new Date().toISOString(),
        });

    } catch (err) {
        console.error('[HANDLER ERROR]', err.message);
        return reply(500, { success: false, message: err.message });
    }
};
