const cron = require("node-cron");
const loadConfig = require("./config");
const logger = require("./logger");
const { runBackup } = require("./backup-runner");
const TokenStore = require("./token-store");
const { startServer } = require("./server");

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.fatal({ err }, "configuration error");
    process.exit(1);
  }

  const tokenStore = new TokenStore(config.tokens.path);
  await tokenStore.init();

  if (config.schedule.once) {
    try {
      await runBackup(config, tokenStore);
      process.exit(0);
    } catch (err) {
      logger.fatal({ err }, "backup failed");
      process.exit(1);
    }
    return;
  }

  logger.info({ cron: config.schedule.cron }, "scheduling backups");
  cron.schedule(config.schedule.cron, async () => {
    try {
      await runBackup(config, tokenStore);
    } catch (err) {
      logger.error({ err }, "scheduled backup failed");
    }
  });

  startServer(config, tokenStore, runBackup);

  process.on("SIGINT", () => {
    logger.info("received SIGINT, shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    logger.info("received SIGTERM, shutting down");
    process.exit(0);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error starting service");
  process.exit(1);
});
