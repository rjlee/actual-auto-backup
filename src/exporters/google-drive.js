const { google } = require("googleapis");
const fs = require("fs/promises");

async function loadCredentials(credentialsPath) {
  if (!credentialsPath) {
    throw new Error(
      "GDRIVE_SERVICE_ACCOUNT_JSON must point to a readable file",
    );
  }
  const raw = await fs.readFile(credentialsPath, "utf8");
  return JSON.parse(raw);
}

async function getDriveClient(credentialsPath) {
  const credentials = await loadCredentials(credentialsPath);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

async function getOAuthDriveClient(oauth, logger) {
  const { clientId, clientSecret, tokens, onTokenUpdate } = oauth;
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials(tokens);
  if (tokens.expiry_date && Date.now() >= tokens.expiry_date - 60 * 1000) {
    const refreshed = await oauth2Client.refreshAccessToken();
    const newTokens = refreshed.credentials;
    if (!newTokens.refresh_token) {
      newTokens.refresh_token = tokens.refresh_token;
    }
    if (typeof onTokenUpdate === "function") {
      await onTokenUpdate(newTokens);
    }
    oauth2Client.setCredentials(newTokens);
    logger?.info("refreshed Google Drive access token");
  }
  return google.drive({ version: "v3", auth: oauth2Client });
}

async function ensureFolder(drive, folderId, name) {
  if (folderId) return folderId;
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name = '${name.replace(/'/g, "\\'")}'`,
  ].join(" and ");
  const res = await drive.files.list({
    q: query,
    spaces: "drive",
    fields: "files(id, name)",
  });
  const existing = res.data.files?.[0];
  if (existing) return existing.id;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });
  return created.data.id;
}

async function uploadToDrive(
  buffer,
  { credentialsPath, folderId, budgetId, timestamp, oauth },
  logger,
) {
  let drive;
  if (oauth) {
    drive = await getOAuthDriveClient(oauth, logger);
  } else {
    drive = await getDriveClient(credentialsPath);
  }
  const targetFolder = await ensureFolder(
    drive,
    folderId,
    "Actual Budget Backups",
  );
  const filename = `${budgetId}-${timestamp || new Date().toISOString().replace(/[:]/g, "-")}.zip`;

  await drive.files.create({
    requestBody: {
      name: filename,
      parents: [targetFolder],
    },
    media: {
      mimeType: "application/zip",
      body: bufferToStream(buffer),
    },
  });

  logger.info(
    { filename, folder: targetFolder },
    "uploaded backup to Google Drive",
  );
}

function bufferToStream(buffer) {
  const { PassThrough } = require("stream");
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

module.exports = {
  uploadToDrive,
};
