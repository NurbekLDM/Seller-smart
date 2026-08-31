/* Vercel Edge Middleware: server-side login gate for the app page.
   The session cookie is validated against Supabase Auth on every page load,
   so the application HTML is never served to unauthenticated visitors.
   Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables in the
   Vercel project settings. */

export const config = {
  matcher: ['/', '/index.html', '/admin', '/admin.html', '/erp', '/erp.html']
};

export default async function middleware(request) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  // Not configured yet (first deploy before env vars are set): let the
  // client-side guard handle it. No data is reachable without Supabase anyway.
  if (!supabaseUrl || !supabaseAnonKey) return;

  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)sr-access-token=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : '';

  if (token) {
    try {
      const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { apikey: supabaseAnonKey, authorization: `Bearer ${token}` }
      });
      if (response.ok) return; // valid session — serve the app
    } catch (_) {
      // Supabase unreachable: fall through to the login page, which will
      // show its own connection error.
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
