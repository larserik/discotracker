import nodemailer from 'nodemailer';

const port = Number(process.env.SMTP_PORT || 587);

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465, // 587 uses STARTTLS
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sendPlaylistInvite(email, { from, name, url, isPublic }) {
  if (!process.env.SMTP_HOST) {
    console.log(`[mail] SMTP not configured – playlist invite for ${email}: ${url}`);
    return;
  }
  const how = isPublic
    ? 'Open the link to listen.'
    : `Open the link and sign in with this email address (${email}) to listen.`;
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    replyTo: from,
    subject: `${from} shared the playlist "${name}" with you on DiscoTracker`,
    text: `${from} shared the DiscoTracker playlist "${name}" with you.\n\n${url}\n\n${how}\n`,
    html:
      `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#222">` +
      `<p>${esc(from)} shared the DiscoTracker playlist <strong>${esc(name)}</strong> with you.</p>` +
      `<p><a href="${esc(url)}" style="display:inline-block;background:#d42b7d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Listen to the playlist</a></p>` +
      `<p style="color:#666">${esc(how)}<br><a href="${esc(url)}" style="color:#666">${esc(url)}</a></p>` +
      `</div>`,
  });
}

export async function sendLoginCode(email, code) {
  if (!process.env.SMTP_HOST) {
    // Development fallback: no SMTP configured, print the code to the log.
    console.log(`[mail] SMTP not configured – login code for ${email}: ${code}`);
    return;
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: `${code} is your DiscoTracker sign-in code`,
    text:
      `Your DiscoTracker sign-in code is: ${code}\n\n` +
      `The code is valid for 10 minutes. If you did not try to sign in, you can ignore this email.\n`,
    html:
      `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#222">` +
      `<p>Your DiscoTracker sign-in code is:</p>` +
      `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:monospace">${code}</p>` +
      `<p style="color:#666">The code is valid for 10 minutes. If you did not try to sign in, you can ignore this email.</p>` +
      `</div>`,
  });
}
