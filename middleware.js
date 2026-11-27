/* Vercel Edge Middleware: server-side login gate for the app page.
   The session cookie is validated against Supabase Auth on every page load,
   so the application HTML is never served to unauthenticated visitors.
   Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables in the
   Vercel project settings. */

export const config = {
  matcher: ['/', '/index.html', '/admin', '/admin.html', '/erp', '/erp.html', '/app', '/app.html']
};

export default async function middleware(request) {
  /* Trimmed: a value pasted into the Vercel dashboard with a stray space or
     newline is invisible there, but an untrimmed URL makes fetch() throw and
     an untrimmed key makes every validation 401 — both land the user on the
     login page with a perfectly good session, which is indistinguishable
     from a wrong project. */
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  // Not configured yet (first deploy before env vars are set): let the
  // client-side guard handle it. No data is reachable without Supabase anyway.
  if (!supabaseUrl || !supabaseAnonKey) return;

  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)sr-access-token=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : '';

  if (token) {
    const endpoint = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
    try {
      const response = await fetch(endpoint, {
        headers: { apikey: supabaseAnonKey, authorization: `Bearer ${token}` }
      });
      if (response.ok) return; // valid session — serve the app
      /* Surfaces in Vercel → Deployment → Runtime Logs. Never log the token
         or the key: the endpoint and the status are enough to tell a wrong
         project (401) from a wrong URL (404) from an outage (5xx). */
      console.warn('sr-auth: token refused', JSON.stringify({
        endpoint, status: response.status
      }));
    } catch (error) {
      console.warn('sr-auth: validation failed', JSON.stringify({
        endpoint, error: String(error && error.message || error)
      }));
    }
  }

  return bounce(request, token ? 'rejected' : 'required');
}

/* A rejected token must be CLEARED on the way out, and the login page has to
   know the server refused it.

   Without both, a middleware that disagrees with the browser about which
   Supabase project is authoritative — mismatched SUPABASE_URL/ANON_KEY, a
   half-applied project switch, a rotated key — produces an infinite loop:
   the browser holds a session it considers valid, login.html bounces to "/",
   middleware rejects the cookie and bounces back. Both sides use
   location.replace, so no history is written and the tab cannot be escaped.
   Clearing the cookie and flagging the reason turns that into a single hop
   to a login form with an error on it. */
function bounce(request, reason) {
  const target = new URL('/login.html', request.url);
  target.searchParams.set('session', reason);
  // "Mening servislarim" comes back to itself after login (a service it
  // was opening is in its query).
  const from = new URL(request.url);
  if (from.pathname === '/app' || from.pathname === '/app.html') target.searchParams.set('next', '/app.html' + from.search);
  const cookie = [
    'sr-access-token=',
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax'
  ];
  if (target.protocol === 'https:') cookie.push('Secure');
  // Response.redirect() returns an immutable response, so its headers cannot
  // be amended — build the redirect directly to attach the clearing cookie.
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), 'set-cookie': cookie.join('; ') }
  });
}
