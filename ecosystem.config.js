module.exports = {
  apps: [
    {
      name: 'skillhive-backend',
      script: 'server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '/var/log/skillhive-backend/error.log',
      out_file: '/var/log/skillhive-backend/out.log',
      log_file: '/var/log/skillhive-backend/combined.log',
      time: true,
      max_memory_restart: '500M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      watch: false,
      kill_timeout: 10000,
      listen_timeout: 8000,
      autorestart: true,
      node_args: '--max-old-space-size=512',
    },
  ],
};