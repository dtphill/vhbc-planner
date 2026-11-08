import {createAuth} from './auth.mjs';

/** Read the existing signed session without HTTP rate limits or session refresh. */
export function privateSession(request, env) {
  return createAuth(env, null).api.getSession({
    headers: request.headers,
    query: {disableRefresh: true, disableCookieCache: true},
  });
}
