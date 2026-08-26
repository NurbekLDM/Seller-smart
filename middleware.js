/* Vercel Edge Middleware: server-side login gate for the app page.
   The session cookie is validated against Supabase Auth on every page load,
   so the application HTML is never served to unauthenticated visitors.
   Requires SUPABASE_URL and SUPABASE_ANON_KEY environment variables in the
   Vercel project settings. */

export const config = {
  matcher: ['/', '/index.html', '/admin', '/admin.html']
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

  return Response.redirect(new URL('/login.html', request.url), 302);
}
