const fs = require("fs/promises");
const path = require("path");
const api = require("@actual-app/api");

const logger = require("./logger");
const { writeLocalBackup } = require("./exporters/local");
const { uploadToDrive } = require("./exporters/google-drive");
const { uploadToS3 } = require("./exporters/s3");
const { uploadToDropbox } = require("./exporters/dropbox");
const { uploadToWebDAV } = require("./exporters/webdav");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exportBudgetBuffer(config) {
  const { serverUrl, password, syncId, encryptionKey, budgetDir } =
    config.actual;
  await ensureDir(budgetDir);
  // Reset any previous budget state so we don't reuse local metadata
  try {
    await api.closeBudget();
  } catch (err) {
    logger.debug(
      { err },
      "closeBudget before init failed (expected if unused)",
    );
  }
  await api.init({
    dataDir: budgetDir,
    serverURL: serverUrl,
    password,
  });

  const downloadOptions = {};
  if (encryptionKey) {
    downloadOptions.password = encryptionKey;
  }

  const downloadResult = await api.downloadBudget(syncId, downloadOptions);
  if (downloadResult?.error) {
    throw new Error(
      `downloadBudget failed: ${JSON.stringify(downloadResult.error)}`,
    );
  }

  logger.info({ downloadResult }, "downloadBudget result");

  let budgetId = syncId;
  if (downloadResult) {
    if (typeof downloadResult.id === "string" && downloadResult.id.length > 0) {
      budgetId = downloadResult.id.trim();
    } else if (
      downloadResult.id &&
      typeof downloadResult.id.id === "string" &&
      downloadResult.id.id.length > 0
    ) {
      budgetId = downloadResult.id.id.trim();
    } else if (
      typeof downloadResult.budgetId === "string" &&
      downloadResult.budgetId.length > 0
    ) {
      budgetId = downloadResult.budgetId.trim();
    }
  }

  let resolvedBudgetId =
    typeof budgetId === "string" && budgetId.length > 0 ? budgetId : syncId;

  const budgets = await api.getBudgets().catch((err) => {
    logger.warn({ err }, "getBudgets failed after download");
    return null;
  });

  if (Array.isArray(budgets)) {
    logger.info(
      {
        budgets: budgets.map((b) => ({
          id: b?.id,
          cloudFileId: b?.cloudFileId,
          name: b?.name,
        })),
      },
      "available budgets",
    );
  }

  if (Array.isArray(budgets)) {
    const byCloud = budgets.find((b) => b?.cloudFileId === syncId);
    if (byCloud?.id) {
      resolvedBudgetId = byCloud.id.trim();
    } else {
      const byId = budgets.find((b) => b?.id === syncId);
      if (byId?.id) {
        resolvedBudgetId = byId.id.trim();
      } else if (budgets.length === 1 && budgets[0]?.id) {
        resolvedBudgetId = budgets[0].id.trim();
      }
    }
  }

  const fileExists = async (filePath) =>
    fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);

  let dbFile = path.join(budgetDir, resolvedBudgetId, "db.sqlite");
  let exists = await fileExists(dbFile);

  if (!exists && Array.isArray(budgets)) {
    for (const entry of budgets) {
      if (!entry?.id) continue;
      const candidate = path.join(budgetDir, entry.id, "db.sqlite");
      if (await fileExists(candidate)) {
        resolvedBudgetId = entry.id.trim();
        dbFile = candidate;
        exists = true;
        break;
      }
    }
  }

  if (!exists) {
    const dirs = await fs.readdir(budgetDir).catch(() => []);
    for (const entry of dirs) {
      const candidate = path.join(budgetDir, entry, "db.sqlite");
      if (await fileExists(candidate)) {
        resolvedBudgetId = entry.trim();
        dbFile = candidate;
        exists = true;
        break;
      }
    }
  }

  if (!exists) {
    logger.warn(
      { dbFile, syncId, resolvedBudgetId },
      "budget directory missing after download, attempting load without local cache",
    );
  }

  logger.info(
    { budgetId: resolvedBudgetId, dbFile },
    "loading budget for export",
  );

  await api.loadBudget(resolvedBudgetId);

  const backupDir = path.join(budgetDir, resolvedBudgetId, "backups");
  await fs.mkdir(backupDir, { recursive: true });

  let exportResult = await api.internal.send("export-budget");
  if (exportResult?.error) {
    logger.warn(
      { error: exportResult.error },
      "initial export failed, attempting loadBackup and retry",
    );
    const backups = await api.getBackups(resolvedBudgetId);
    const latestBackup =
      backups?.find((b) => b?.id && b?.isLatest) || backups?.[0] || null;
    if (latestBackup?.id) {
      logger.info(
        { backupId: latestBackup.id },
        "restoring latest backup prior to retry",
      );
      await api.loadBackup({
        id: resolvedBudgetId,
        backupId: latestBackup.id,
      });
    } else {
      logger.warn(
        { resolvedBudgetId },
        "no backup available to restore before retry",
      );
    }
    await fs.mkdir(backupDir, { recursive: true });
    exportResult = await api.internal.send("export-budget");
    if (exportResult?.error) {
      throw new Error(
        `export-budget failed after retry: ${JSON.stringify(
          exportResult.error,
        )}`,
      );
    }
  }

  let buffer = exportResult?.data || exportResult?.buffer;
  if (!buffer) {
    throw new Error("export-budget returned no data");
  }
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  return buffer;
}

async function markSuccess(outputDir) {
  const markerDir = path.resolve(outputDir, "..");
  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(
    path.join(markerDir, ".last-success"),
    `${Math.floor(Date.now() / 1000)}`,
  );
}

async function runBackup(config, tokenStore) {
  logger.info("starting backup job");
  let buffer;
  try {
    buffer = await exportBudgetBuffer(config);
  } catch (err) {
    logger.error({ err }, "failed to export budget");
    throw err;
  } finally {
    try {
      await api.shutdown();
    } catch (err) {
      logger.warn({ err }, "failed to shutdown Actual API cleanly");
    }
  }

  const tasks = [];
  const budgetId = config.actual.syncId;

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");

  if (config.local.enabled) {
    tasks.push(
      writeLocalBackup(
        buffer,
        { ...config.local, budgetId, timestamp },
        logger,
      ).catch((err) => {
        logger.error({ err }, "local backup failed");
        throw err;
      }),
    );
  }

  if (config.googleDrive.enabled) {
    const driveOptions = {
      ...config.googleDrive,
      budgetId,
      timestamp,
    };
    if (config.googleDrive.mode === "service-account") {
      if (!config.googleDrive.credentialsPath) {
        throw new Error(
          "ENABLE_GDRIVE=true but GDRIVE_SERVICE_ACCOUNT_JSON is missing",
        );
      }
      if (!config.googleDrive.folderId) {
        logger.warn(
          "GDRIVE_FOLDER_ID not set; using /Actual Budget Backups root",
        );
      }
    } else {
      if (
        !config.googleDrive.oauth?.clientId ||
        !config.googleDrive.oauth?.clientSecret
      ) {
        throw new Error(
          "GDRIVE_MODE=oauth requires GDRIVE_OAUTH_CLIENT_ID and GDRIVE_OAUTH_CLIENT_SECRET",
        );
      }
      if (!tokenStore) {
        throw new Error("Token store not available for Google Drive OAuth");
      }
      const tokens = await tokenStore.get("google");
      if (!tokens) {
        throw new Error(
          "Google Drive is not linked. Visit the web UI to connect.",
        );
      }
      driveOptions.oauth = {
        clientId: config.googleDrive.oauth.clientId,
        clientSecret: config.googleDrive.oauth.clientSecret,
        tokens,
        onTokenUpdate: async (updated) => {
          await tokenStore.set("google", updated);
        },
      };
    }
    tasks.push(
      uploadToDrive(buffer, driveOptions, logger).catch((err) => {
        logger.error({ err }, "google drive upload failed");
        throw err;
      }),
    );
  }

  if (config.s3.enabled) {
    if (!config.s3.bucket) {
      throw new Error("ENABLE_S3=true but S3_BUCKET is not set");
    }
    tasks.push(
      uploadToS3(
        buffer,
        {
          ...config.s3,
          budgetId,
          timestamp,
        },
        logger,
      ).catch((err) => {
        logger.error({ err }, "s3 upload failed");
        throw err;
      }),
    );
  }

  if (config.dropbox.enabled) {
    const dropboxOptions = {
      ...config.dropbox,
      budgetId,
      timestamp,
    };
    if (config.dropbox.accessToken) {
      // static token provided via env
    } else {
      if (!config.dropbox.appKey || !config.dropbox.appSecret) {
        throw new Error(
          "Dropbox OAuth requires DROPBOX_APP_KEY and DROPBOX_APP_SECRET",
        );
      }
      if (!tokenStore) {
        throw new Error("Token store not available for Dropbox OAuth");
      }
      const tokens = await tokenStore.get("dropbox");
      if (!tokens) {
        throw new Error("Dropbox is not linked. Visit the web UI to connect.");
      }
      dropboxOptions.oauth = {
        appKey: config.dropbox.appKey,
        appSecret: config.dropbox.appSecret,
        tokens,
        onTokenUpdate: async (updated) => {
          await tokenStore.set("dropbox", updated);
        },
      };
    }
    tasks.push(
      uploadToDropbox(buffer, dropboxOptions, logger).catch((err) => {
        logger.error({ err }, "dropbox upload failed");
        throw err;
      }),
    );
  }

  if (config.webdav.enabled) {
    if (!config.webdav.url) {
      throw new Error("ENABLE_WEBDAV=true but WEBDAV_URL is not set");
    }
    tasks.push(
      uploadToWebDAV(
        buffer,
        {
          ...config.webdav,
          budgetId,
          timestamp,
        },
        logger,
      ).catch((err) => {
        logger.error({ err }, "webdav upload failed");
        throw err;
      }),
    );
  }

  if (tasks.length === 0) {
    logger.warn("no destinations enabled; skipping");
  } else {
    await Promise.all(tasks);
  }

  if (!config.local.enabled) {
    await ensureDir(config.local.outputDir);
    await markSuccess(config.local.outputDir || config.actual.budgetDir);
  }

  logger.info("backup job complete");
}

module.exports = {
  runBackup,
  exportBudgetBuffer,
};
