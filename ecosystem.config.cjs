module.exports = {
  apps: [{
    name: 'tesla-charger',
    script: './dist/main.js',
    watch: false,
    node_args: '--env-file=.env',
    env: {
      NODE_ENV: 'production',
    },
    env_file: '.env',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 4000,
    exp_backoff_restart_delay: 0,
    max_memory_restart: '200M',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    time: true,
  }]
}; 
