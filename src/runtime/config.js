'use strict';

const { supabaseUrlAllowed } = require('../shared/supabase-url');

/**
 * Validate the settings the runtime needs. Takes the environment as an argument
 * (it never reads files or process.env itself), so it is easy to test.
 *
 * Problems name the setting, never its value, so they are safe to show and log.
 */
function loadConfig(env) {
  const problems = [];
  const url = (env.SUPABASE_URL || '').trim();
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url) problems.push('SUPABASE_URL is not set');
  else if (!supabaseUrlAllowed(url)) {
    problems.push('SUPABASE_URL must look like https://<project>.supabase.co (or http://localhost for local development)');
  }
  if (!serviceKey) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set');

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: Object.freeze({ supabase: Object.freeze({ url, serviceKey }) }) };
}

/** A printable summary of the config with every secret masked. */
function describeConfig(config) {
  return {
    supabase: {
      url: config.supabase.url,
      serviceKey: config.supabase.serviceKey ? `set (${config.supabase.serviceKey.length} characters, hidden)` : 'not set',
    },
  };
}

module.exports = { loadConfig, describeConfig };
