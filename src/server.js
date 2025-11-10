const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { google } = require("googleapis");
const { DropboxAuth } = require("dropbox");
const logger = require("./logger");

const dropboxFetchFactory = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
      const status = await getStatus();
      res.json({
        status,
        running,
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
