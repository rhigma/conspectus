import { createTransport } from 'nodemailer';
import { query, queryOne } from './db.js';

function getTransport(account) {
  return createTransport({
    host: account.host,
    port: account.smtp_port || 465,
    secure: true,
    auth: {
      user: account.username,
      pass: account.password,
    },
    tls: { rejectUnauthorized: false },
  });
}

export async function sendReply({ accountId, toEmail, toName, subject, body, inReplyTo, references }) {
  const account = await queryOne('SELECT * FROM email_accounts WHERE id = ?', [accountId]);
  if (!account) throw new Error('E-Mail-Konto nicht gefunden');

  const transport = getTransport(account);

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const info = await transport.sendMail({
    from: `${process.env.OWNER_NAME || "Schulleitung"} <${account.email}>`,
    to: toName ? `${toName} <${toEmail}>` : toEmail,
    subject: replySubject,
    text: body,
    headers: {
      ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}),
      ...(references ? { References: references } : {}),
    },
  });

  // Als Eintrag in Chronologie speichern wenn Vorgang vorhanden
  return { messageId: info.messageId, accepted: info.accepted };
}

export async function testSmtp(accountId) {
  const account = await queryOne('SELECT * FROM email_accounts WHERE id = ?', [accountId]);
  if (!account) throw new Error('Konto nicht gefunden');
  const transport = getTransport(account);
  await transport.verify();
  return { ok: true };
}
