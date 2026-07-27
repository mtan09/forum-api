// Outbound email. Uses Resend's REST API when RESEND_API_KEY is set;
// otherwise logs the message to the server console so the flows stay fully
// testable in development (the code/link appears in the API logs).
//
// Setup (production): create a free Resend account, verify your sending
// domain, then set RESEND_API_KEY and EMAIL_FROM in the environment.

type EmailInput = { to: string; subject: string; html: string }

export async function sendEmail({ to, subject, html }: EmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      // Never print reset codes or verification links into production logs.
      throw new Error('Email delivery is not configured')
    }
    console.log(
      `[email:dev] to=${to} subject="${subject}"\n${html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()}`
    )
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? 'forum <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Email send failed (${res.status}): ${detail.slice(0, 300)}`)
  }
}

const wrap = (body: string) => `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="color:#B647FF;margin-bottom:4px">forum</h2>
    ${body}
    <p style="color:#8D8D8D;font-size:12px;margin-top:24px">If you didn't request this, you can ignore this email.</p>
  </div>`

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const verificationEmail = (link: string) => ({
  subject: 'Verify your forum email',
  html: wrap(`
    <p>Tap the button below to verify your email address.</p>
    <p><a href="${link}" style="display:inline-block;background:#B647FF;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700">Verify email</a></p>
    <p style="color:#5A5A5A;font-size:13px">Or open this link: ${link}</p>`),
})

export const resetEmail = (code: string) => ({
  subject: `${code} is your forum password reset code`,
  html: wrap(`
    <p>Enter this code in the app to reset your password. It expires in 1 hour.</p>
    <p style="font-size:32px;font-weight:800;letter-spacing:6px;color:#B647FF">${code}</p>`),
})

export const notificationEmail = (
  subject: string,
  body: string,
  link?: string
) => ({
  subject,
  html: wrap(`
    <p>${escapeHtml(body)}</p>
    ${
      link
        ? `<p><a href="${link}" style="display:inline-block;background:#B647FF;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-weight:700">Open forum</a></p>`
        : ''
    }
    <p style="color:#5A5A5A;font-size:13px">You can change email notifications in Settings.</p>`),
})
