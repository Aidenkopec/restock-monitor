/**
 * Loads .env before anything else reads process.env.
 *
 * Import this FIRST, ahead of every other import, in every entry point.
 * Module evaluation order is the whole point: log.ts used to read LOG_LEVEL at
 * import time, but .env was not loaded until loadConfig() ran inside main(), so
 * the LOG_LEVEL knob documented in .env.example silently did nothing.
 *
 * process.loadEnvFile does not overwrite variables that are already set, so a
 * real environment variable -- pm2's env: block, or `LOG_LEVEL=debug npm start`
 * -- still beats the file. That is the precedence we want.
 */

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env -- every setting has a default, so this is not an error */
}
