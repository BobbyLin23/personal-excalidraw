import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';

export interface AuthEnv {
  DRAWINGS: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  AUTH_EMAIL: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    appName: 'Personal Excalidraw',
    database: env.DRAWINGS,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session' },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limit',
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 5 },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/email-otp/send-verification-otp' || ctx.path === '/sign-in/email-otp') {
          if (typeof ctx.body?.email !== 'string' || ctx.body.email.trim().toLowerCase() !== env.AUTH_EMAIL.trim().toLowerCase()) {
            throw new APIError('FORBIDDEN', { message: 'This email is not authorized to sign in.' });
          }
          ctx.body.email = env.AUTH_EMAIL.trim().toLowerCase();
          if (ctx.path === '/email-otp/send-verification-otp' && ctx.body.type !== 'sign-in') {
            throw new APIError('BAD_REQUEST', { message: 'Only sign-in codes are supported.' });
          }
        }
      }),
    },
    plugins: [emailOTP({
      storeOTP: 'hashed',
      expiresIn: 300,
      allowedAttempts: 3,
      async sendVerificationOTP({ email, otp }) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [email],
            subject: 'Your Personal Excalidraw sign-in code',
            text: `Your sign-in code is ${otp}. It expires in 5 minutes. If you did not request this code, ignore this email.`,
          }),
        });
        if (!response.ok) throw new APIError('BAD_GATEWAY', { message: 'Could not send your code. Please try again later.' });
      },
    })],
  });
}
