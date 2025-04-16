module.exports = {
    apps : [{
      name   : "BOT_TELEGRAM",
      cwd:"./",
      script : "./dist/app.js",
      watch:false,
      env_production: {
         NODE_ENV: "production"
      },
      env_development: {
         NODE_ENV: "development"
      },
      instances:1, 
      exec_mode:"cluster"
    }]
  }