const { Dropbox, DropboxAuth } = require("dropbox");

const fetchFactory = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

async function getDropboxClient(config, logger) {
  if (config.accessToken) {
    return new Dropbox({
      accessToken: config.accessToken,
      fetch: fetchFactory,
    });
  }
  const { oauth } = config;
  if (!oauth) {
    throw new Error(
      "Dropbox OAuth configuration missing. Provide access token or link via web UI.",
    );
  }
  const { appKey, appSecret, tokens, onTokenUpdate } = oauth;
  const auth = new DropboxAuth({
    clientId: appKey,
    clientSecret: appSecret,
    fetch: fetchFactory,
  });
  if (tokens.refresh_token) {
    auth.setRefreshToken(tokens.refresh_token);
  }
  if (tokens.access_token) {
    auth.setAccessToken(tokens.access_token);
  }
  if (tokens.expires_at) {
    auth.setAccessTokenExpiresAt(new Date(tokens.expires_at));
  }
  if (
    tokens.expires_at &&
    Date.now() >= new Date(tokens.expires_at).getTime() - 60 * 1000
  ) {
    const refreshResponse = await auth.refreshAccessToken();
    const result = refreshResponse?.result || refreshResponse;
    const updated = {
      access_token: result.access_token,
      refresh_token: auth.getRefreshToken() || tokens.refresh_token,
      expires_at: Date.now() + result.expires_in * 1000,
    };
    auth.setAccessToken(updated.access_token);
    auth.setAccessTokenExpiresAt(new Date(updated.expires_at));
    if (typeof onTokenUpdate === "function") {
      await onTokenUpdate(updated);
    }
    logger?.info("refreshed Dropbox access token");
  }
  return new Dropbox({ auth, fetch: fetchFactory });
}

async function uploadToDropbox(buffer, config, logger) {
  const { basePath = "/Actual-Backups", budgetId, timestamp } = config;
  const client = await getDropboxClient(config, logger);
  const filename = `${budgetId}-${timestamp || new Date().toISOString().replace(/[:]/g, "-")}.zip`;
  const path = `${basePath.replace(/\/$/, "")}/${filename}`;
  await client.filesUpload({
    path,
    contents: buffer,
    mode: { ".tag": "overwrite" },
    autorename: false,
    mute: true,
  });
  logger.info({ path }, "uploaded backup to Dropbox");
}

module.exports = { uploadToDropbox };
