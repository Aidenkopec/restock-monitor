/**
 * pm2 config. Keeps the monitor running across crashes and reboots.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # survive a reboot
 *   pm2 logs walmart-monitor
 */
module.exports = {
  apps: [
    {
      name: 'walmart-monitor',
      script: 'src/index.ts',
      interpreter: 'node',
      cwd: __dirname,
      autorestart: true,
      // Slow restarts down so a crash loop can't hammer Walmart.
      restart_delay: 30_000,
      exp_backoff_restart_delay: 5_000,
      max_restarts: 20,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: false, // logger already timestamps
    },
  ],
};
