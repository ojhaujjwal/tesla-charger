module.exports = {
  apps: [
    {
      name: "tesla-charger",
      script: "./dist/main.js",
      watch: false,
      node_args: "--env-file=.env",
      // args: '--weather-aware',
      env: {
        NODE_ENV: "production"
      },
      env_file: ".env",
      autorestart: true,
      // Exit code 0 means the app ended deliberately (car fully charged,
      // max runtime reached, SHUTDOWN_AT reached). Do not restart in that
      // case — start the next session manually with `npm run start`.
      // Crashes and defects exit non-zero and are auto-restarted as usual.
      stop_exit_codes: [0],
      max_restarts: 20,
      restart_delay: 4000,
      exp_backoff_restart_delay: 0,
      max_memory_restart: "400M",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      time: true
    }
  ]
};
