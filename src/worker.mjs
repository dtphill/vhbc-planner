import html from '../public/index.html';
import javascript from '../public/app.js';
import css from '../public/style.css';
import {handleApi, HttpError, scheduledTasks} from './api.mjs';

const favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#34203e"/><path d="M9 13h46M9 51h46" stroke="#bb9146" stroke-width="2"/><text x="32" y="43" text-anchor="middle" font-family="Georgia,serif" font-size="32" fill="#f5f0e7">V</text></svg>';
const securityHeaders = {
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Robots-Tag':'noindex, nofollow',
};

export default {
  /** @param {Request} request @param {Env} env @param {ExecutionContext} ctx */
  async fetch(request, env, ctx) {
    let response;
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) response = await handleApi(request,env,ctx);
      else if (request.method !== 'GET' && request.method !== 'HEAD') response = new Response('Method not allowed',{status:405});
      else {
        const files = {'/':[html,'text/html; charset=utf-8'],'/app.js':[javascript,'text/javascript; charset=utf-8'],'/style.css':[css,'text/css; charset=utf-8'],'/favicon.svg':[favicon,'image/svg+xml'],'/robots.txt':['User-agent: *\nDisallow: /\n','text/plain']};
        const file = files[path];
        response = file ? new Response(request.method==='HEAD' ? null : file[0],{headers:{'Content-Type':file[1],'Cache-Control':path==='/'?'no-cache':'public, max-age=300'}}) : new Response('Not found',{status:404});
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(JSON.stringify({event:'request.failed',name:error?.name || 'Error'}));
      response = Response.json({error:status===500?'Something went wrong. Please refresh and try again.':error.message},{status,headers:{'Cache-Control':'no-store'}});
    }
    const secured = new Response(response.body,response);
    for (const [key,value] of Object.entries(securityHeaders)) secured.headers.set(key,value);
    return secured;
  },
  /** @param {ScheduledController} controller @param {Env} env @param {ExecutionContext} ctx */
  async scheduled(controller, env, ctx) { await scheduledTasks(env); },
};
