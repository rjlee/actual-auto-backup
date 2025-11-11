const cron = require("node-cron");
const path = require("path");
const loadConfig = require("./config");
const logger = require("./logger");
const { runBackup } = require("./backup-runner");
const TokenStore = require("./token-store");
const { startServer } = require("./server");

function buildFallbackConfig(error) {
  const message =
    error && typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "Configuration failed; check environment variables.";
  return {
    runtime: {
      configError: {
        message,
        details:
          error && typeof error.stack === "string" ? error.stack : undefined,
      },
    },
    actual: {
      serverUrl: "",
      password: "",
      syncId: null,
      syncIds: [],
      syncTargets: [],
      budgetDir: path.join(process.cwd(), "data", "budget"),
      encryptionKey: null,
    },
    schedule: {
      cron: "",
      once: false,
    },
    tokens: {
      path: path.join(process.cwd(), "data", "tokens"),
    },
    local: {
      enabled: false,
      outputDir: path.join(process.cwd(), "data", "backups"),
      retentionCount: 0,
      retentionWeeks: 0,
    },
    googleDrive: {
      enabled: false,
      credentialsPath: null,
      folderId: null,
      mode: "service-account",
      oauth: {
        clientId: null,
        clientSecret: null,
      },
    },
    s3: {
      enabled: false,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: "",
      accessKeyId: null,
      secretAccessKey: null,
      forcePathStyle: false,
    },
    dropbox: {
      enabled: false,
      accessToken: null,
      basePath: "/Actual-Backups",
      appKey: null,
      appSecret: null,
    },
    webdav: {
      enabled: false,
      url: null,
      username: null,
      password: null,
      basePath: "/actual-backups",
    },
    ui: {
      port: 4010,
      publicUrl: "http://localhost:4010",
    },
  };
}

function hasConfigError(config) {
  return Boolean(config?.runtime?.configError);
}

function createDisabledTokenStore() {
  return {
    async init() {},
    async has() {
      return false;
    },
    async get() {
      return null;
    },
    async set() {
      throw new Error("Token store unavailable due to configuration error");
    },
    async clear() {},
  };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error({ err }, "configuration error");
    config = buildFallbackConfig(err);
  }

  const tokenStore = hasConfigError(config)
    ? createDisabledTokenStore()
    : new TokenStore(config.tokens.path);

  if (!hasConfigError(config)) {
    await tokenStore.init();
  }

  if (hasConfigError(config)) {
    logger.error(
      { message: config.runtime.configError.message },
      "service running in degraded mode due to configuration error",
    );
  }

  if (config.schedule.once) {
    if (hasConfigError(config)) {
      logger.fatal(
        { message: config.runtime.configError.message },
        "cannot perform one-off backup due to configuration error",
      );
      process.exit(1);
    }
    try {
      await runBackup(config, tokenStore);
      process.exit(0);
    } catch (err) {
      logger.fatal({ err }, "backup failed");
      process.exit(1);
    }
    return;
  }

  if (!hasConfigError(config) && config.schedule.cron) {
    const targetsLog = (config.actual.syncTargets || []).map((target) => ({
      syncId: target.syncId,
      budgetId: target.budgetId,
    }));
    logger.info(
      {
        cron: config.schedule.cron,
        targets: targetsLog,
      },
      "scheduling backups",
    );
    cron.schedule(config.schedule.cron, async () => {
      try {
        await runBackup(config, tokenStore);
      } catch (err) {
        logger.error({ err }, "scheduled backup failed");
      }
    });
  } else if (hasConfigError(config)) {
    logger.warn(
      { message: config.runtime.configError.message },
      "skipping scheduler due to configuration error",
    );
  }

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
