import nodemailer from 'nodemailer';

const port = Number(process.env.SMTP_PORT || 587);

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465, // 587 uses STARTTLS
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
});

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
