const nodemailer = require('nodemailer');
const dns = require('dns');

// Force Node.js to prioritize IPv4 over IPv6 if supported
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

class EmailService {
    constructor() {
        const port = parseInt(process.env.SMTP_PORT) || 587;
        const host = process.env.SMTP_HOST || 'smtp.gmail.com';

        console.log(`📧 Initializing Email Service with host: ${host}, port: ${port}`);

        this.transporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465, 
            family: 4, 
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false
            },
            connectionTimeout: 15000,
            greetingTimeout: 15000,
            socketTimeout: 30000
        });

        this.transporter.verify((error, success) => {
            if (error) {
                console.log("❌ SMTP Connection Error:", error);
            } else {
                console.log("✅ SMTP Server is ready for KodiPay emails");
            }
        });
    }

    async sendEmail(to, subject, html, text = '') {
        try {
            const mailOptions = {
                from: process.env.SMTP_FROM || `"KodiPay" <${process.env.SMTP_USER}>`,
                to,
                subject,
                text: text || html.replace(/<[^>]*>?/gm, ''),
                html
            };

            console.log(`📤 Sending Email | From: ${mailOptions.from} | Subject: ${mailOptions.subject}`);

            const info = await this.transporter.sendMail(mailOptions);
            console.log(`✅ Email sent to ${to}: ${info.messageId}`);
            return info;
        } catch (error) {
            console.error(`❌ Failed to send email to ${to}:`, error.message);
            throw error;
        }
    }

    async sendOtpEmail(to, otp) {
        const subject = `${otp} is your KodiPay verification code`;
        const html = `
            <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border: 1px solid #f0f0f0; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.02);">
                <div style="text-align: center; margin-bottom: 32px;">
                    <div style="display: inline-block; width: 56px; height: 56px; background-color: #4f46e5; border-radius: 16px; line-height: 56px; color: white; font-size: 24px; font-weight: bold;">K</div>
                </div>
                <h2 style="color: #111827; text-align: center; font-size: 24px; font-weight: 800; margin-bottom: 8px;">Verify your account</h2>
                <p style="color: #6b7280; text-align: center; font-size: 16px; line-height: 1.6;">Welcome to KodiPay! Use the following code to complete your registration. This code is valid for 10 minutes.</p>
                
                <div style="background: #f8fafc; padding: 32px; text-align: center; border-radius: 20px; margin: 32px 0; border: 1px dashed #e2e8f0;">
                    <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #4f46e5;">${otp}</span>
                </div>
                
                <p style="color: #9ca3af; font-size: 14px; text-align: center;">If you did not request this, you can safely ignore this email.</p>
                <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #f3f4f6; text-align: center;">
                    <p style="font-size: 12px; color: #d1d5db;">&copy; 2026 KodiPay Inc. All rights reserved.</p>
                </div>
            </div>
        `;
        return this.sendEmail(to, subject, html);
    }
}

module.exports = new EmailService();
