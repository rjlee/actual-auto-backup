const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");
const sqlite3 = require("better-sqlite3");
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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resetActualSession() {
  try {
    await api.closeBudget();
  } catch (err) {
    logger.debug(
      { err },
      "closeBudget before init failed (expected if unused)",
    );
  }
}

async function safeGetBudgets() {
  try {
    return await api.getBudgets();
  } catch (err) {
    logger.warn({ err }, "getBudgets failed after download");
    return null;
  }
}

function normalizeIdentifier(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getBudgetIdentifier(budget) {
  if (!budget) return null;
  return (
    normalizeIdentifier(budget.budgetId) ??
    normalizeIdentifier(budget.cloudFileId) ??
    null
  );
}

function logBudgetSummary(budgets, context = {}) {
  if (!Array.isArray(budgets)) {
    return;
  }
  logger.info(
    {
      ...context,
      budgets: budgets.map((b) => ({
        id: b?.id,
        budgetId: getBudgetIdentifier(b),
        name: b?.name,
      })),
    },
    "available budgets",
  );
}

function extractBudgetIdFromDownload(downloadResult) {
  if (typeof downloadResult?.id === "string" && downloadResult.id.length > 0) {
    return downloadResult.id.trim();
  }
  if (
    downloadResult?.id &&
    typeof downloadResult.id.id === "string" &&
    downloadResult.id.id.length > 0
  ) {
    return downloadResult.id.id.trim();
  }
  if (
    typeof downloadResult?.budgetId === "string" &&
    downloadResult.budgetId.length > 0
  ) {
    return downloadResult.budgetId.trim();
  }
  return null;
}

function collectCandidateBudgetIds(syncId, downloadResult, budgets) {
  const raw = [];
  const normalizedSyncId = normalizeIdentifier(syncId);
  const push = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    raw.push(trimmed);
  };

  push(extractBudgetIdFromDownload(downloadResult));

  if (Array.isArray(budgets) && budgets.length > 0) {
    const byBudgetId = budgets.find(
      (b) => getBudgetIdentifier(b) === normalizedSyncId,
    )?.id;
    push(byBudgetId);

    const byId = budgets.find(
      (b) => normalizeIdentifier(b?.id) === normalizedSyncId,
    )?.id;
    push(byId);

    budgets.forEach((b) => {
      push(b?.id);
      push(getBudgetIdentifier(b));
    });
  }

  push(syncId);

  const seen = new Set();
  return raw.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

async function resolveBudgetResources({
  syncId,
  downloadResult,
  budgets,
  budgetDir,
  targetBudgetId,
}) {
  const normalizedTargetBudgetId = normalizeIdentifier(targetBudgetId);
  const candidates = collectCandidateBudgetIds(syncId, downloadResult, budgets);

  if (normalizedTargetBudgetId && Array.isArray(budgets)) {
    const preferred = budgets
      .filter(
        (entry) => getBudgetIdentifier(entry) === normalizedTargetBudgetId,
      )
      .map((entry) => entry?.id)
      .filter(Boolean)
      .reverse();
    for (const id of preferred) {
      if (!candidates.includes(id)) {
        candidates.unshift(id);
      } else {
        const idx = candidates.indexOf(id);
        candidates.splice(idx, 1);
        candidates.unshift(id);
      }
    }
  }

  for (const candidate of candidates) {
    const dbFile = path.join(budgetDir, candidate, "db.sqlite");
    if (await pathExists(dbFile)) {
      return { budgetId: candidate, dbFile, dbExists: true };
    }
  }

  const localEntries = await fs.readdir(budgetDir).catch(() => []);
  for (const entry of localEntries) {
    const dbFile = path.join(budgetDir, entry, "db.sqlite");
    if (await pathExists(dbFile)) {
      return { budgetId: entry.trim(), dbFile, dbExists: true };
    }
  }

  const fallbackId = candidates[0] || syncId || "budget";
  return {
    budgetId: fallbackId,
    dbFile: path.join(budgetDir, fallbackId, "db.sqlite"),
    dbExists: false,
  };
}

async function createSanitizedDatabaseBuffer(dbFile) {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "actual-backup-"));
  const tmpDbPath = path.join(tmpBase, "db.sqlite");
  try {
    await fs.copyFile(dbFile, tmpDbPath);
    const db = sqlite3(tmpDbPath);
    db.exec(`
      DELETE FROM kvcache;
      DELETE FROM kvcache_key;
    `);
    db.close();
    return await fs.readFile(tmpDbPath);
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

async function readMetadataBuffer(budgetDir, budgetId, syncId) {
  const metadataPath = path.join(budgetDir, budgetId, "metadata.json");
  try {
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    metadata.resetClock = true;
    return {
      buffer: Buffer.from(JSON.stringify(metadata)),
      name:
        metadata.budgetName || metadata.name || metadata.displayName || null,
    };
  } catch (err) {
    const context = { err };
    if (typeof syncId !== "undefined") {
      context.syncId = syncId;
    }
    logger.warn(context, "failed to read metadata.json");
    return null;
  }
}

function buildZipBuffer(dbContent, metadataBuffer) {
  const zip = new AdmZip();
  zip.addFile("db.sqlite", dbContent);
  if (metadataBuffer) {
    zip.addFile("metadata.json", metadataBuffer);
  }
  return zip.toBuffer();
}

function withErrorHandling(
  promiseFactory,
  message,
  loggerInstance,
  context = {},
) {
  return promiseFactory().catch((err) => {
    const logContext = { err };
    for (const [key, value] of Object.entries(context)) {
      if (typeof value !== "undefined") {
        logContext[key] = value;
      }
    }
    loggerInstance.error(logContext, message);
    throw err;
  });
}

async function exportBudgetBuffer(config, target) {
  const { serverUrl, password, encryptionKey, budgetDir } = config.actual;
  const syncId = target?.syncId ?? target ?? config.actual.syncId;
  const targetBudgetId = target?.budgetId || null;
  await ensureDir(budgetDir);
  // Reset any previous budget state so we don't reuse local metadata
  await resetActualSession();
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

  logger.info(
    { downloadResult, syncId, targetBudgetId },
    "downloadBudget result",
  );

  const budgets = await safeGetBudgets();
  logBudgetSummary(budgets, {
    syncId,
    budgetId: targetBudgetId,
  });

  const matchedBudget = Array.isArray(budgets)
    ? budgets.find(
        (entry) =>
          (targetBudgetId &&
            getBudgetIdentifier(entry) ===
              normalizeIdentifier(targetBudgetId)) ||
          getBudgetIdentifier(entry) === normalizeIdentifier(syncId) ||
          normalizeIdentifier(entry?.id) === normalizeIdentifier(syncId),
      )
    : null;

  if (
    targetBudgetId &&
    (!matchedBudget ||
      getBudgetIdentifier(matchedBudget) !==
        normalizeIdentifier(targetBudgetId))
  ) {
    logger.warn(
      { syncId, targetBudgetId },
      "requested budget id not found for sync target; falling back",
    );
  }

  const { budgetId, dbFile, dbExists } = await resolveBudgetResources({
    syncId,
    downloadResult,
    budgets,
    budgetDir,
    targetBudgetId,
  });

  if (!dbExists) {
    logger.warn(
      { dbFile, syncId, targetBudgetId, resolvedBudgetId: budgetId },
      "budget directory missing after download, attempting load without local cache",
    );
  }

  logger.info(
    { budgetId, dbFile, syncId, targetBudgetId },
    "loading budget for export",
  );

  await api.loadBudget(budgetId);

  const dbContent = await createSanitizedDatabaseBuffer(dbFile);
  const metadataInfo = await readMetadataBuffer(budgetDir, budgetId, syncId);
  const buffer = buildZipBuffer(dbContent, metadataInfo?.buffer);

  return {
    buffer,
    budgetId,
    displayName:
      metadataInfo?.name?.toString()?.trim() ||
      matchedBudget?.name?.toString()?.trim() ||
      matchedBudget?.id?.toString()?.trim() ||
      budgetId,
    syncId,
    targetBudgetId,
  };
}

function sanitizeIdentifier(value) {
  if (!value) return "sync";
  return value.replace(/[^a-zA-Z0-9-_]/g, "-");
}

function makeUniqueBudgetId(baseId, syncId, usedIds) {
  const base = sanitizeIdentifier(baseId) || sanitizeIdentifier(syncId);
  let candidate = base || "budget";
  const syncSuffix = sanitizeIdentifier(syncId);

  if (usedIds.has(candidate)) {
    candidate = `${candidate}-${syncSuffix}`;
    let counter = 1;
    while (usedIds.has(candidate)) {
      candidate = `${base || "budget"}-${syncSuffix}-${counter}`;
      counter += 1;
    }
  }

  usedIds.add(candidate);
  return candidate;
}

async function markSuccess(outputDir) {
  const markerDir = path.resolve(outputDir, "..");
  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(
    path.join(markerDir, ".last-success"),
    `${Math.floor(Date.now() / 1000)}`,
  );
}

async function runBackupForSync(config, tokenStore, syncTarget, usedBudgetIds) {
  const { syncId: targetSyncId, budgetId: targetBudgetId } = syncTarget;
  logger.info(
    { syncId: targetSyncId, budgetId: targetBudgetId },
    "starting backup job",
  );
  let buffer;
  let resolvedBudgetId;
  let displayName;
  try {
    const result = await exportBudgetBuffer(config, syncTarget);
    buffer = result.buffer;
    resolvedBudgetId = result.budgetId;
    displayName = result.displayName;
  } catch (err) {
    logger.error(
      { err, syncId: targetSyncId, budgetId: targetBudgetId },
      "failed to export budget",
    );
    throw err;
  } finally {
    try {
      await api.shutdown();
    } catch (err) {
      logger.warn(
        { err, syncId: targetSyncId, budgetId: targetBudgetId },
        "failed to shutdown Actual API cleanly",
      );
    }
  }

  const budgetId = resolvedBudgetId || targetSyncId;
  const archiveBudgetId = makeUniqueBudgetId(
    displayName || budgetId,
    targetBudgetId || targetSyncId,
    usedBudgetIds,
  );
  const timestamp = new Date().toISOString().replace(/[:]/g, "-");

  const tasks = await createDestinationTasks({
    buffer,
    budgetId: archiveBudgetId,
    timestamp,
    config,
    tokenStore,
    logger,
    syncId: targetSyncId,
    budgetIdOverride: targetBudgetId,
  });

  if (tasks.length === 0) {
    logger.warn(
      { syncId: targetSyncId, budgetId: targetBudgetId },
      "no destinations enabled; skipping",
    );
  } else {
    await Promise.all(tasks);
  }

  if (!config.local.enabled) {
    const markerTarget = config.local.outputDir || config.actual.budgetDir;
    await ensureDir(markerTarget);
    await markSuccess(markerTarget);
  }

  logger.info(
    { syncId: targetSyncId, budgetId: targetBudgetId },
    "backup job complete",
  );
}

async function runBackup(config, tokenStore) {
  const targets = Array.isArray(config.actual.syncTargets)
    ? config.actual.syncTargets
    : [];
  const resolvedTargets =
    targets.length > 0
      ? targets
      : [{ syncId: config.actual.syncId, budgetId: null }];
  const usedBudgetIds = new Set();

  for (const target of resolvedTargets) {
    await runBackupForSync(config, tokenStore, target, usedBudgetIds);
  }
}

async function createDestinationTasks({
  buffer,
  budgetId,
  timestamp,
  config,
  tokenStore,
  logger: loggerInstance,
  syncId,
  budgetIdOverride,
}) {
  const tasks = [];

  if (config.local.enabled) {
    tasks.push(
      withErrorHandling(
        () =>
          writeLocalBackup(
            buffer,
            { ...config.local, budgetId, timestamp },
            loggerInstance,
          ),
        "local backup failed",
        loggerInstance,
        { syncId, budgetId: budgetIdOverride },
      ),
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
        loggerInstance.warn(
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
      withErrorHandling(
        () => uploadToDrive(buffer, driveOptions, loggerInstance),
        "google drive upload failed",
        loggerInstance,
        { syncId, budgetId: budgetIdOverride },
      ),
    );
  }

  if (config.s3.enabled) {
    if (!config.s3.bucket) {
      throw new Error("ENABLE_S3=true but S3_BUCKET is not set");
    }
    tasks.push(
      withErrorHandling(
        () =>
          uploadToS3(
            buffer,
            {
              ...config.s3,
              budgetId,
              timestamp,
            },
            loggerInstance,
          ),
        "s3 upload failed",
        loggerInstance,
        { syncId, budgetId: budgetIdOverride },
      ),
    );
  }

  if (config.dropbox.enabled) {
    const dropboxOptions = {
      ...config.dropbox,
      budgetId,
      timestamp,
    };

    if (!config.dropbox.accessToken) {
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
      withErrorHandling(
        () => uploadToDropbox(buffer, dropboxOptions, loggerInstance),
        "dropbox upload failed",
        loggerInstance,
        { syncId, budgetId: budgetIdOverride },
      ),
    );
  }

  if (config.webdav.enabled) {
    if (!config.webdav.url) {
      throw new Error("ENABLE_WEBDAV=true but WEBDAV_URL is not set");
    }
    tasks.push(
      withErrorHandling(
        () =>
          uploadToWebDAV(
            buffer,
            {
              ...config.webdav,
              budgetId,
              timestamp,
            },
            loggerInstance,
          ),
        "webdav upload failed",
        loggerInstance,
        { syncId, budgetId: budgetIdOverride },
      ),
    );
  }

  return tasks;
}

module.exports = {
  runBackup,
  exportBudgetBuffer,
};
