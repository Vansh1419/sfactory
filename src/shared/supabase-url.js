'use strict';

/**
 * The Supabase service key may only be sent to Supabase, or to a local dev server.
 * A mistyped URL must never receive it.
 */
function supabaseUrlAllowed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (u.protocol === 'https:' && host.endsWith('.supabase.co')) return true;
    return (host === 'localhost' || host === '127.0.0.1') && u.protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { supabaseUrlAllowed };
