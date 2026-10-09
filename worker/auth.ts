import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

export interface AuthEnv {
  DRAWINGS: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  AUTH_EMAIL: string;
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    appName: 'Personal Excalidraw',
    database: env.DRAWINGS,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session', expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limit',
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/email') {
          if (typeof ctx.body?.email !== 'string' || ctx.body.email.trim().toLowerCase() !== env.AUTH_EMAIL.trim().toLowerCase()) {
            throw new APIError('FORBIDDEN', { message: 'This email is not authorized to sign in.' });
          }
          ctx.body.email = env.AUTH_EMAIL.trim().toLowerCase();
          ctx.body.rememberMe = true;
        }
      }),
    },
  });
}
