import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { log } from "@/utils/log";

// Email sending for verification codes. Enabled only when all SMTP_* env vars
// are set; otherwise, when ALLOW_DEV_CODES=true, codes are logged and returned
// in API responses as `devCode` (local development only).

let transporter: Transporter | null = null;
let fromAddress = "";

export function initMailer(): void {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
    if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM) {
        transporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: parseInt(SMTP_PORT, 10),
            secure: parseInt(SMTP_PORT, 10) === 465,
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        });
        fromAddress = SMTP_FROM;
        log({ module: 'mailer' }, 'SMTP configured, email sending enabled');
    } else if (process.env.ALLOW_DEV_CODES === 'true') {
        log({ module: 'mailer', level: 'warn' }, 'SMTP not configured; ALLOW_DEV_CODES=true — verification codes go to logs and API responses');
    } else {
        log({ module: 'mailer', level: 'warn' }, 'SMTP not configured; email sending disabled');
    }
}

/** True when codes should be returned in API responses as `devCode`. */
export function isDevCodesEnabled(): boolean {
    return transporter === null && process.env.ALLOW_DEV_CODES === 'true';
}

/** Send a verification code email. No-op when SMTP is not configured. */
export async function sendCodeEmail(email: string, code: string, purpose: 'register' | 'reset'): Promise<void> {
    if (!transporter) {
        return;
    }
    const subject = purpose === 'register' ? 'Your CCH registration code' : 'Your CCH password reset code';
    await transporter.sendMail({
        from: fromAddress,
        to: email,
        subject,
        text: `Your verification code is: ${code}\n\nIt expires in 10 minutes.`
    });
}
