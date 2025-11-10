const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const { google } = require("googleapis");
const { DropboxAuth } = require("dropbox");
const logger = require("./logger");

const dropboxFetchFactory = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const DAY_NAME_LOOKUP = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  tues: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  thur: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

function normalizeDayToken(token) {
  if (!token) return null;
  const lower = token.toString().toLowerCase();
  if (DAY_NAME_LOOKUP[lower]) {
    return DAY_NAME_LOOKUP[lower];
  }
  if (/^\d+$/.test(token)) {
    const normalised = String(Number(token) % 7);
    return DAY_NAME_LOOKUP[normalised] || null;
  }
  return null;
}

function pad(value) {
  return value.toString().padStart(2, "0");
}

function isNumeric(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

function describeCron(cronExpression) {
  const cron = (cronExpression || "").trim();
  if (!cron) {
    return "Schedule not configured.";
  }
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) {
    return `Cron schedule: ${cron}`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const minuteValue = isNumeric(minute) ? Number(minute) : null;
  const hourValue = isNumeric(hour) ? Number(hour) : null;
  const timeLabel =
    minuteValue !== null && hourValue !== null
      ? `${pad(hourValue)}:${pad(minuteValue)}`
      : null;

  const isEveryMonth = month === "*";
  const isEveryDom = dayOfMonth === "*";
  const isEveryDow = dayOfWeek === "*";

  if (timeLabel && isEveryDom && isEveryMonth && isEveryDow) {
    return `Every day at ${timeLabel}`;
  }

  if (
    timeLabel &&
    isEveryDom &&
    isEveryMonth &&
    dayOfWeek !== "*" &&
    !/[/-]/.test(dayOfWeek)
  ) {
    const tokens = dayOfWeek.split(",");
    const dayNames = tokens
      .map((token) => normalizeDayToken(token))
      .filter(Boolean);
    if (dayNames.length === tokens.length && dayNames.length > 0) {
      const joined =
        dayNames.length === 1
          ? dayNames[0]
          : `${dayNames.slice(0, -1).join(", ")} and ${dayNames.slice(-1)}`;
      return `Every ${joined} at ${timeLabel}`;
    }
  }

  if (
    timeLabel &&
    dayOfMonth !== "*" &&
    !/[,-]/.test(dayOfMonth) &&
    !dayOfMonth.includes("/") &&
    isEveryMonth &&
    isEveryDow
  ) {
    return `On day ${dayOfMonth} of every month at ${timeLabel}`;
  }

  if (
    minute.startsWith("*/") &&
    hour === "*" &&
    isEveryDom &&
    isEveryMonth &&
    isEveryDow
  ) {
    const interval = parseInt(minute.slice(2), 10);
    if (!Number.isNaN(interval) && interval > 0) {
      return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
    }
  }

  if (
    minute === "0" &&
    hour.startsWith("*/") &&
    isEveryDom &&
    isEveryMonth &&
    isEveryDow
  ) {
    const interval = parseInt(hour.slice(2), 10);
    if (!Number.isNaN(interval) && interval > 0) {
      return interval === 1
        ? "Every hour on the hour"
        : `Every ${interval} hours`;
    }
  }

  if (
    timeLabel &&
    isEveryDom &&
    month !== "*" &&
    !/[/-]/.test(month) &&
    isEveryDow
  ) {
    return `On day ${dayOfMonth} of month ${month} at ${timeLabel}`;
  }

  return `Cron schedule: ${cron}`;
}

function describeRetention(localConfig) {
  if (!localConfig || !localConfig.enabled) {
    return "Local backups disabled.";
  }
  const { retentionCount = 0, retentionWeeks = 0 } = localConfig;
  const fragments = [];
  if (retentionCount > 0) {
    fragments.push(
      retentionCount === 1
        ? "keeps the most recent backup"
        : `keeps the ${retentionCount} most recent backups`,
    );
  }
  if (retentionWeeks > 0) {
    fragments.push(
      retentionWeeks === 1
        ? "retains up to one weekly snapshot"
        : `retains up to ${retentionWeeks} weekly snapshots`,
    );
  }
  if (fragments.length === 0) {
    return "No automatic pruning; all local backups are kept.";
  }
  return `Local retention ${fragments.join(" and ")}.`;
}

async function readLastBackupTimestamp(config) {
  const candidates = new Set();
  const addCandidate = (dir) => {
    if (typeof dir === "string" && dir.length > 0) {
      const parent = path.dirname(dir);
      if (parent && parent !== ".") {
        candidates.add(path.join(parent, ".last-success"));
      }
    }
  };

  addCandidate(config?.local?.outputDir);
  addCandidate(config?.actual?.budgetDir);

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const seconds = parseInt(content.trim(), 10);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    } catch (err) {
      if (!(err && err.code === "ENOENT")) {
        logger.warn({ err, filePath }, "failed to read last-success marker");
      }
    }
  }

  return null;
}

async function buildMeta(config) {
  const cron = config?.schedule?.cron || null;
  const lastBackupTs = await readLastBackupTimestamp(config);

  return {
    schedule: {
      cron,
      description: describeCron(cron),
    },
    retention: {
      enabled: Boolean(config?.local?.enabled),
      count: config?.local?.retentionCount ?? null,
      weeks: config?.local?.retentionWeeks ?? null,
      description: describeRetention(config?.local),
    },
    lastBackup: lastBackupTs
      ? {
          timestamp: lastBackupTs,
          iso: new Date(lastBackupTs * 1000).toISOString(),
        }
      : null,
  };
}

function buildRedirectUrl(baseUrl, pathname) {
  const url = new URL(
    pathname,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  return url.toString();
}

function createRouter(config, tokenStore, runBackupFn) {
  const app = express();
  app.use(express.json());

  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  let running = false;

  async function getStatus() {
    const googleLinked = tokenStore ? await tokenStore.has("google") : false;
    const dropboxLinked = tokenStore ? await tokenStore.has("dropbox") : false;
    return {
      google: {
        enabled: config.googleDrive.enabled,
        mode: config.googleDrive.mode,
        linked: googleLinked,
      },
      dropbox: {
        enabled: config.dropbox.enabled,
        linked: dropboxLinked || Boolean(config.dropbox.accessToken),
      },
      s3: {
        enabled: config.s3.enabled,
      },
      webdav: {
        enabled: config.webdav.enabled,
      },
      local: {
        enabled: config.local.enabled,
      },
    };
  }

  app.get("/api/status", async (req, res) => {
    try {
      const [status, meta] = await Promise.all([
        getStatus(),
        buildMeta(config),
      ]);
      res.json({
        status,
        running,
        meta,
      });
    } catch (err) {
      logger.error({ err }, "failed to retrieve status");
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.post("/api/backup", async (req, res) => {
    if (running) {
      return res.status(409).json({ error: "Backup already in progress" });
    }
    running = true;
    try {
      await runBackupFn(config, tokenStore);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "manual backup failed");
      res.status(500).json({ error: err.message || "Backup failed" });
    } finally {
      running = false;
    }
  });

  app.post("/api/google/unlink", async (req, res) => {
    if (!tokenStore) {
      return res.status(400).json({ error: "Token store unavailable" });
    }
    await tokenStore.clear("google");
    res.json({ ok: true });
  });

  app.post("/api/dropbox/unlink", async (req, res) => {
    if (!tokenStore) {
      return res.status(400).json({ error: "Token store unavailable" });
    }
    await tokenStore.clear("dropbox");
    res.json({ ok: true });
  });

  const pendingStates = new Map();
  const randomState = () => crypto.randomBytes(16).toString("hex");

  function ensurePublicUrl() {
    return config.ui.publicUrl || `http://localhost:${config.ui.port}`;
  }

  app.get("/auth/google", (req, res) => {
    if (config.googleDrive.mode !== "oauth") {
      return res
        .status(400)
        .json({ error: "Google Drive OAuth is not enabled" });
    }
    if (
      !config.googleDrive.oauth?.clientId ||
      !config.googleDrive.oauth?.clientSecret
    ) {
      return res.status(400).json({
        error:
          "Missing Google OAuth client credentials. Set GDRIVE_OAUTH_CLIENT_ID/SECRET.",
      });
    }
    const redirectUri = buildRedirectUrl(
      ensurePublicUrl(),
      "/oauth/google/callback",
    );
    const oauth2Client = new google.auth.OAuth2(
      config.googleDrive.oauth.clientId,
      config.googleDrive.oauth.clientSecret,
      redirectUri,
    );
    const state = randomState();
    pendingStates.set(state, { provider: "google" });
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/drive.file"],
      state,
    });
    res.redirect(authUrl);
  });

  app.get("/oauth/google/callback", async (req, res) => {
    const { state, code, error } = req.query;
    if (error) {
      logger.error({ error }, "google oauth returned error");
      return res.redirect("/?error=google");
    }
    if (!state || !pendingStates.has(state)) {
      return res.status(400).send("Invalid state");
    }
    pendingStates.delete(state);
    const redirectUri = buildRedirectUrl(
      ensurePublicUrl(),
      "/oauth/google/callback",
    );
    const oauth2Client = new google.auth.OAuth2(
      config.googleDrive.oauth.clientId,
      config.googleDrive.oauth.clientSecret,
      redirectUri,
    );
    try {
      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        // Ensure refresh token is retained for future
        tokens.refresh_token =
          oauth2Client.credentials.refresh_token || tokens.refresh_token;
      }
      await tokenStore.set("google", tokens);
      res.redirect("/?linked=google");
    } catch (err) {
      logger.error({ err }, "failed to exchange google oauth code");
      res.redirect("/?error=google");
    }
  });

  app.get("/auth/dropbox", async (req, res) => {
    if (!config.dropbox.enabled) {
      return res.status(400).json({ error: "Dropbox integration disabled" });
    }
    if (config.dropbox.accessToken) {
      return res.status(400).json({
        error:
          "Static Dropbox access token already configured; OAuth linking is unnecessary.",
      });
    }
    if (!config.dropbox.appKey || !config.dropbox.appSecret) {
      return res.status(400).json({
        error:
          "Missing Dropbox app credentials. Set DROPBOX_APP_KEY and DROPBOX_APP_SECRET.",
      });
    }
    const redirectUri = buildRedirectUrl(
      ensurePublicUrl(),
      "/oauth/dropbox/callback",
    );
    const dropboxAuth = new DropboxAuth({
      clientId: config.dropbox.appKey,
      clientSecret: config.dropbox.appSecret,
      fetch: dropboxFetchFactory,
    });
    const state = randomState();
    pendingStates.set(state, { provider: "dropbox" });
    const authUrl = await dropboxAuth.getAuthenticationUrl(
      redirectUri,
      state,
      "code",
      "offline",
      null,
      null,
      false,
    );
    res.redirect(authUrl);
  });

  app.get("/oauth/dropbox/callback", async (req, res) => {
    const { state, code, error } = req.query;
    if (error) {
      logger.error({ error }, "dropbox oauth returned error");
      return res.redirect("/?error=dropbox");
    }
    if (!state || !pendingStates.has(state)) {
      return res.status(400).send("Invalid state");
    }
    pendingStates.delete(state);
    const redirectUri = buildRedirectUrl(
      ensurePublicUrl(),
      "/oauth/dropbox/callback",
    );
    const dropboxAuth = new DropboxAuth({
      clientId: config.dropbox.appKey,
      clientSecret: config.dropbox.appSecret,
      fetch: dropboxFetchFactory,
    });
    try {
      const response = await dropboxAuth.getAccessTokenFromCode(
        redirectUri,
        code,
      );
      const result = response?.result || response;
      const tokens = {
        access_token: result.access_token,
        refresh_token: result.refresh_token || dropboxAuth.getRefreshToken(),
        expires_at: Date.now() + (result.expires_in || 14400) * 1000,
      };
      await tokenStore.set("dropbox", tokens);
      res.redirect("/?linked=dropbox");
    } catch (err) {
      logger.error({ err }, "failed to exchange dropbox oauth code");
      res.redirect("/?error=dropbox");
    }
  });

  app.use((req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}

function startServer(config, tokenStore, runBackupFn) {
  const app = createRouter(config, tokenStore, runBackupFn);
  const server = app.listen(config.ui.port, () => {
    logger.info(
      { port: config.ui.port },
      "actual-auto-backup web UI listening",
    );
  });
  return server;
}

module.exports = {
  startServer,
  createRouter,
};
