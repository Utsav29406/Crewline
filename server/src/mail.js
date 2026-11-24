import nodemailer from 'nodemailer';

/**
 * Outgoing email (daily logs, notifications, sign-in codes). Only when SMTP is set up:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM (e.g. "Crewline <attendance@example.com>")
 */
let transport;
export function mailer() {
  if (!process.env.SMTP_HOST) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Sending happens inside requests (15 s limit on Vercel): give up quickly rather than hang them.
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 8000,
  });
  return transport;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Wraps email content in a table layout that renders the same in Gmail, Outlook (desktop, web, phone), Apple Mail
 * and Yahoo. Outlook for Windows draws email with Word, which ignores max-width, div backgrounds and rounded
 * corners, so the width and colours sit on tables (with bgcolor) instead.
 */
export function emailLayout(inner, footer = 'Sent by Crewline') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>Crewline</title></head>
<body style="margin:0;padding:0;background:#f1f3f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f3f8" style="background:#f1f3f8">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px">
  <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:16px;padding:24px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#262b3d">
${inner}
  </td></tr>
  <tr><td align="center" style="padding:14px 0 0;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#8a90a6">${esc(footer)}</td></tr>
  </table>
</td></tr></table></body></html>`;
}

/** A plain card-style email: heading, paragraphs, optional big code or button. */
export function simpleEmail({ company, heading, lines = [], code, button }) {
  const html = emailLayout(`
  ${company ? `<div style="font-size:13px;color:#747c94;font-weight:600">${esc(company)}</div>` : ''}
  <h1 style="margin:4px 0 12px;font-size:20px;color:#262b3d">${esc(heading)}</h1>
  ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#535b74">${esc(l)}</p>`).join('')}
  ${code ? `<div style="margin:16px 0;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;color:#262b3d">${esc(code)}</div>` : ''}
  ${button ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0"><tr><td bgcolor="#6366f1" style="border-radius:10px">
    <a href="${esc(button.url)}" style="display:inline-block;padding:10px 18px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${esc(button.label)}</a></td></tr></table>` : ''}`);
  const text = [company, heading, '', ...lines, ...(code ? ['', code] : []), ...(button ? ['', `${button.label}: ${button.url}`] : [])]
    .filter((l) => l !== undefined && l !== null).join('\n');
  return { html, text };
}

/** Same check the sign-up form uses: something@domain.tld, no spaces. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();

/** Sends one email; throws if SMTP isn't set up or sending fails. */
export async function sendMail({ to, subject, text, html }) {
  const smtp = mailer();
  if (!smtp) throw Object.assign(new Error('Email is not set up on the server'), { noSmtp: true });
  await deliver(smtp, { to, subject, text, html });
}

/**
 * Sends through the shared transport with a Reply-To and logs the result, so a mailbox that refuses mail
 * (an address that doesn't exist, or a company server that blocks outside senders) shows up in the server logs.
 */
export async function deliver(smtp, { to, subject, text, html, attachments }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const info = await smtp.sendMail({ from, replyTo: process.env.MAIL_REPLY_TO || from, to, subject, text, html, attachments });
  if (info.rejected?.length) throw new Error(`Mail server refused ${info.rejected.join(', ')}`);
  console.log('email sent', to, subject, info.response || '');
  return info;
}
