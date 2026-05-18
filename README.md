# ERP Email Client — Vercel Deployment

Zero external dependencies. Pure Node.js built-ins only.

## Folder Structure

```
email-vercel/
├── api/
│   └── send.js          ← Serverless SMTP function
├── public/
│   └── index.html       ← Frontend email client
├── vercel.json          ← Routing config
├── package.json
└── README.md
```

## Deploy to Vercel (3 steps)

### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel
cd email-vercel
vercel
```
Follow the prompts. Your site will be live at `https://your-project.vercel.app`.

### Option B — GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to vercel.com → "Add New Project"
3. Import your repo → click **Deploy**
4. Done — Vercel auto-detects the config

## Usage

1. Open your deployed URL
2. Click **⚙ SMTP Config** tab
3. Pick a preset (Gmail, Outlook, etc.) and enter credentials
4. Click **Test Connection** to verify
5. Switch to **✉ Compose** and send!

## Gmail Setup (required for Gmail)

Gmail blocks regular passwords for SMTP. You need an App Password:

1. Enable 2-Step Verification: myaccount.google.com → Security
2. Go to Security → App Passwords
3. Select "Mail" and generate a 16-character password
4. Use that as your password in SMTP Config
5. Server: smtp.gmail.com | Port: 587

## SMTP Settings Reference

| Provider   | Server                          | Port |
|------------|---------------------------------|------|
| Gmail      | smtp.gmail.com                  | 587  |
| Outlook    | smtp-mail.outlook.com           | 587  |
| Yahoo      | smtp.mail.yahoo.com             | 587  |
| Zoho       | smtp.zoho.com                   | 587  |
| Office 365 | smtp.office365.com              | 587  |
| SendGrid   | smtp.sendgrid.net               | 587  |
| AWS SES    | email-smtp.us-east-1.amazonaws.com | 587 |

## Features

- ✅ Bulk send (multiple recipients as pills)
- ✅ File attachments (drag & drop, up to 5MB)
- ✅ STARTTLS + SSL/TLS support
- ✅ Scheduled send
- ✅ Open tracking pixel
- ✅ HTML / plain text editor toggle
- ✅ Send history log
- ✅ SMTP presets for major providers
- ✅ Zero npm dependencies
