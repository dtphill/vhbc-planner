import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';

export function mailEnabled(env) {
  return Boolean(env.MAIL_FROM && (env.EMAIL || env.RESEND_API_KEY));
}

export async function sendMail(env, {to, subject, text}) {
  if (!mailEnabled(env)) throw new Error('Email delivery has not been configured.');
  const message = {from: env.MAIL_FROM, to, subject, text};
  if (env.EMAIL) return env.EMAIL.send(message);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: {'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(message), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
}

// Invitations confer membership; an unverified email address confers no authority.
// No password or token is written to logs. Better Auth handles hashes and sessions.
export function authOptions(env, ctx, registration = null, resetReceiver = null) {
  const canMail = mailEnabled(env);
  return {
    appName: 'Victorian Historical Boardgaming Collective',
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    trustedOrigins: [env.APP_URL],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 1800,
      ...(canMail || resetReceiver ? {sendResetPassword: async ({user, token}) => {
        const url = `${env.APP_URL}/#reset=${encodeURIComponent(token)}`;
        if (resetReceiver) { resetReceiver(url); return; }
        if (!user.emailVerified || !await env.DB.prepare('SELECT user_id FROM members WHERE user_id=? AND disabled=0').bind(user.id).first()) return;
        await sendMail(env, {to: user.email, subject: 'Reset your Collective password', text: `Use this private link within 30 minutes to reset your password:\n\n${url}\n\nIf you did not request a reset, ignore this email.`});
      }} : {}),
    },
    emailVerification: {
      sendOnSignUp: canMail,
      autoSignInAfterVerification: false,
      ...(canMail ? {sendVerificationEmail: async ({user, url}) => {
        await sendMail(env, {to: user.email, subject: 'Confirm your Collective email address', text: `Confirm your email address to receive meeting notifications:\n\n${url}`});
      }} : {}),
    },
    session: {expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24, cookieCache: {enabled: false}},
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 60,
      customRules: {'/sign-in/email': {window: 60, max: 5}, '/sign-up/email': {window: 60, max: 3}, '/reset-password': {window: 60, max: 5}, '/request-password-reset': {window: 60, max: 3}},
    },
    advanced: {
      cookiePrefix: 'vhbc',
      useSecureCookies: env.APP_URL.startsWith('https://'),
      ipAddress: {ipAddressHeaders: ['cf-connecting-ip']},
      defaultCookieAttributes: {sameSite: 'lax', httpOnly: true, path: '/'},
      backgroundTasks: ctx ? {handler: promise => ctx.waitUntil(promise)} : undefined,
    },
    databaseHooks: {user: {create: {before: async user => {
      if (!registration || registration.email !== user.email.toLowerCase()) {
        throw new APIError('FORBIDDEN', {message: 'A valid private invitation is required.'});
      }
      return {data: user};
    }}}},
  };
}

export function createAuth(env, ctx, registration, resetReceiver) {
  return betterAuth(authOptions(env, ctx, registration, resetReceiver));
}

export async function tokenHash(token) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(result), x => x.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
}
