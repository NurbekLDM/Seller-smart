/* Audit log writer (public.audit_events, supabase/2026-11-28-erp119-team.sql).
   Server-side only: the table is reachable with the service-role key and
   nothing else. A failed audit write never fails the action it records
   (the action already happened); it is logged instead. */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function clientIp(req) {
  const forwarded = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return (forwarded || (req && req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

export async function recordAudit(event, req) {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  const row = {
    actor_id: event.actor_id || null,
    actor_email: event.actor_email ? String(event.actor_email).slice(0, 200) : null,
    action: String(event.action || 'unknown').slice(0, 80),
    target_id: event.target_id || null,
    target_email: event.target_email ? String(event.target_email).slice(0, 200) : null,
    service: event.service ? String(event.service).slice(0, 40) : null,
    details: event.details && typeof event.details === 'object' ? event.details : {},
    ip: req ? clientIp(req) : (event.ip || null)
  };
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/audit_events`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
        'content-type': 'application/json',
        prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!response.ok) console.warn('sr-audit: not written', response.status, row.action);
  } catch (error) {
    console.warn('sr-audit: not written', String(error && error.message || error), row.action);
  }
}
