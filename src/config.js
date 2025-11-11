require("dotenv").config();

const path = require("path");
const fs = require("fs");
const invariant = require("tiny-invariant");

function bool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalised = value.toString().trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalised);
}

function int(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function requireFileIfExists(maybePath) {
  if (!maybePath) return null;
  const resolved = path.isAbsolute(maybePath)
    ? maybePath
    : path.join(process.cwd(), maybePath);
  return fs.existsSync(resolved) ? resolved : null;
}

function loadConfig() {
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;
  const backupSyncIdsRaw = process.env.BACKUP_SYNC_ID;

  invariant(serverUrl, "ACTUAL_SERVER_URL is required");
  invariant(password, "ACTUAL_PASSWORD is required");
  const syncSources = backupSyncIdsRaw || syncId;

  invariant(syncSources, "BACKUP_SYNC_ID or ACTUAL_SYNC_ID is required");

  const syncTargets = [];
  if (backupSyncIdsRaw) {
    const entries = backupSyncIdsRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    invariant(
      entries.length > 0,
      "BACKUP_SYNC_ID must include at least one entry",
    );

    const seenTargets = new Set();

    for (const entry of entries) {
      const [first, second] = entry.split(":");
      if (typeof second === "undefined") {
        const syncIdValue = first.trim();
        invariant(
          syncIdValue.length > 0,
          "BACKUP_SYNC_ID entries must include a sync ID",
        );
        const key = `::${syncIdValue}`;
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        syncTargets.push({ budgetId: null, syncId: syncIdValue });
        continue;
      }

      const budgetId = first.trim();
      const syncIdValue = second.trim();
      invariant(
        budgetId.length > 0 && syncIdValue.length > 0,
        "BACKUP_SYNC_ID entries must include both budget and sync IDs when using the BudgetID:SyncID form",
      );
      const key = `${budgetId}::${syncIdValue}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      syncTargets.push({ budgetId, syncId: syncIdValue });
    }

    invariant(
      syncTargets.length > 0,
      "BACKUP_SYNC_ID must include at least one valid entry",
    );
  } else {
    invariant(syncId, "ACTUAL_SYNC_ID is required");
    syncTargets.push({ budgetId: null, syncId });
  }

  const primarySyncId = syncTargets[0].syncId;

  const budgetDir = process.env.BUDGET_DIR || "/app/data/budget";
  const backupOutput = process.env.BACKUP_OUTPUT || "/app/data/backups";
  const tokenStorePath = process.env.TOKEN_STORE_PATH || "/app/data/tokens";
  const httpPort = parseInt(process.env.HTTP_PORT || "4010", 10);
  const publicUrl =
    process.env.BACKUP_PUBLIC_URL || `http://localhost:${httpPort}`;

  return {
    actual: {
      serverUrl,
      password,
      syncId: primarySyncId,
      syncIds: Array.from(new Set(syncTargets.map((target) => target.syncId))),
      syncTargets,
      budgetDir: path.isAbsolute(budgetDir)
        ? budgetDir
        : path.join(process.cwd(), budgetDir),
      encryptionKey: process.env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD || null,
    },
    schedule: {
      cron: process.env.BACKUP_CRON || "0 0 * * 1",
      once: process.argv.includes("--once"),
    },
    tokens: {
      path: path.isAbsolute(tokenStorePath)
        ? tokenStorePath
        : path.join(process.cwd(), tokenStorePath),
    },
    local: {
      enabled: bool(process.env.ENABLE_LOCAL, true),
      outputDir: path.isAbsolute(backupOutput)
        ? backupOutput
        : path.join(process.cwd(), backupOutput),
      retentionCount: int(process.env.LOCAL_RETENTION_COUNT, 4),
      retentionWeeks: int(process.env.LOCAL_RETENTION_WEEKS, 0),
    },
    googleDrive: {
      enabled: bool(process.env.ENABLE_GDRIVE, false),
      credentialsPath: requireFileIfExists(
        process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
      ),
      folderId: process.env.GDRIVE_FOLDER_ID || null,
      mode:
        (process.env.GDRIVE_MODE || "service-account").toLowerCase() === "oauth"
          ? "oauth"
          : "service-account",
      oauth: {
        clientId: process.env.GDRIVE_OAUTH_CLIENT_ID || null,
        clientSecret: process.env.GDRIVE_OAUTH_CLIENT_SECRET || null,
      },
    },
    s3: {
      enabled: bool(process.env.ENABLE_S3, false),
      endpoint: process.env.S3_ENDPOINT || null,
      region: process.env.S3_REGION || null,
      bucket: process.env.S3_BUCKET || null,
      prefix: process.env.S3_PREFIX || "",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || null,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || null,
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, false),
    },
    dropbox: {
      enabled: bool(process.env.ENABLE_DROPBOX, false),
      accessToken: process.env.DROPBOX_ACCESS_TOKEN || null,
      basePath: process.env.DROPBOX_BASE_PATH || "/Actual-Backups",
      appKey: process.env.DROPBOX_APP_KEY || null,
      appSecret: process.env.DROPBOX_APP_SECRET || null,
    },
    webdav: {
      enabled: bool(process.env.ENABLE_WEBDAV, false),
      url: process.env.WEBDAV_URL || null,
      username: process.env.WEBDAV_USERNAME || null,
      password: process.env.WEBDAV_PASSWORD || null,
      basePath: process.env.WEBDAV_BASE_PATH || "/actual-backups",
    },
    ui: {
      port: httpPort,
      publicUrl,
    },
  };
}

module.exports = loadConfig;
