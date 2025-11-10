async function loadWebDavClient(url, options) {
  const mod = await import("webdav");
  const createClient = mod.createClient || mod.default?.createClient;
  if (typeof createClient !== "function") {
    throw new Error("webdav createClient export not found");
  }
  return createClient(url, options);
}

async function uploadToWebDAV(buffer, config, logger) {
  const {
    url,
    username,
    password,
    basePath = "/actual-backups",
    budgetId,
    timestamp,
  } = config;
  if (!url) {
    throw new Error("WEBDAV_URL must be provided when ENABLE_WEBDAV=true");
  }
  const client = await loadWebDavClient(url, {
    username,
    password,
  });
  const cleanBase = basePath.replace(/\/$/, "");
  const filename = `${budgetId}-${timestamp || new Date().toISOString().replace(/[:]/g, "-")}.zip`;
  const targetPath = `${cleanBase}/${filename}`;
  await client.putFileContents(targetPath, buffer, { overwrite: true });
  logger.info({ targetPath }, "uploaded backup to WebDAV");
}

module.exports = { uploadToWebDAV };
