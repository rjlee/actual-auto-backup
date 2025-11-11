const destinationList = document.getElementById("destinationList");
const alertBox = document.getElementById("alert");
const backupBtn = document.getElementById("backupBtn");
const scheduleInfo = document.getElementById("scheduleInfo");
const syncTargetsInfo = document.getElementById("syncTargetsInfo");
const retentionInfo = document.getElementById("retentionInfo");
const lastBackupInfo = document.getElementById("lastBackupInfo");

function showAlert(message, type = "info") {
  alertBox.textContent = message;
  alertBox.className = `alert alert-${type}`;
  alertBox.classList.remove("d-none");
}

function hideAlert() {
  alertBox.classList.add("d-none");
}

function basePath() {
  const path = window.location.pathname.replace(/\/$/, "");
  return path === "" || path === "/" ? "" : path;
}

function formatSchedule(scheduleMeta) {
  if (!scheduleMeta) return "Not configured";
  const { description, cron } = scheduleMeta;
  if (description && cron) {
    return description.includes(cron)
      ? description
      : `${description} (cron: ${cron})`;
  }
  if (description) return description;
  if (cron) return `Cron: ${cron}`;
  return "Not configured";
}

function formatRetention(retentionMeta) {
  if (!retentionMeta) return "Not configured";
  return retentionMeta.description || "Not configured";
}

function formatTargetLabel(target) {
  if (!target) return null;
  if (typeof target === "string") {
    const trimmed = target.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const parts = [];
  if (target.budgetId) {
    parts.push(target.budgetId);
  }
  if (target.syncId) {
    parts.push(parts.length ? `→ ${target.syncId}` : target.syncId);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function formatRelativeTime(date) {
  if (typeof Intl === "undefined" || !Intl.RelativeTimeFormat) {
    return "";
  }
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const units = [
    { unit: "day", ms: 24 * 60 * 60 * 1000 },
    { unit: "hour", ms: 60 * 60 * 1000 },
    { unit: "minute", ms: 60 * 1000 },
    { unit: "second", ms: 1000 },
  ];
  for (const { unit, ms } of units) {
    if (Math.abs(diffMs) >= ms || unit === "second") {
      const formatter = new Intl.RelativeTimeFormat(undefined, {
        numeric: "auto",
      });
      const value = Math.round(diffMs / ms);
      return formatter.format(value, unit);
    }
  }
  return "";
}

function formatLastBackup(lastMeta) {
  if (!lastMeta) return "No successful backups yet.";
  const date = lastMeta.iso
    ? new Date(lastMeta.iso)
    : lastMeta.timestamp
      ? new Date(lastMeta.timestamp * 1000)
      : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "No successful backups yet.";
  }
  const localeString = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const relative = formatRelativeTime(date);
  return relative ? `${localeString} (${relative})` : localeString;
}

function updateOverview(meta = {}) {
  if (scheduleInfo) {
    scheduleInfo.textContent = formatSchedule(meta.schedule);
  }
  if (syncTargetsInfo) {
    renderSyncTargets(meta.targets);
  }
  if (retentionInfo) {
    retentionInfo.textContent = formatRetention(meta.retention);
  }
  if (lastBackupInfo) {
    lastBackupInfo.textContent = formatLastBackup(meta.lastBackup);
  }
}

async function loadStatus() {
  try {
    const res = await fetch(`${basePath()}/api/status`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "status request failed");
    }
    const { status, running, meta, errors } = await res.json();
    renderDestinations(status || {});
    updateOverview(meta);
    const metaErrors = Array.isArray(meta?.errors) ? meta.errors : [];
    const responseErrors = Array.isArray(errors) ? errors : [];
    const combinedErrors = [...metaErrors, ...responseErrors].filter(Boolean);
    if (backupBtn) {
      backupBtn.disabled = running || combinedErrors.length > 0;
    }
    if (combinedErrors.length > 0) {
      const message = combinedErrors
        .map((entry) => {
          if (!entry) return null;
          if (typeof entry === "string") return entry;
          if (entry.message) return entry.message;
          return JSON.stringify(entry);
        })
        .filter(Boolean)
        .join("\n");
      showAlert(message || "Configuration error detected.", "danger");
    } else {
      hideAlert();
    }
  } catch (err) {
    updateOverview();
    showAlert(`Failed to load status: ${err.message}`, "danger");
  }
}

function createDestinationItem({
  id,
  label,
  linked,
  enabled,
  linkUrl,
  unlinkAction,
  statusText,
}) {
  const item = document.createElement("div");
  item.className =
    "list-group-item d-flex justify-content-between align-items-center flex-wrap";
  const text = document.createElement("div");
  text.innerHTML = `<strong>${label}</strong><br />
    <small class="text-muted">${statusText}</small>`;
  item.appendChild(text);
  const actions = document.createElement("div");
  if (enabled && linkUrl && !linked) {
    const linkBtn = document.createElement("a");
    linkBtn.className = "btn btn-sm btn-success me-2";
    linkBtn.href = linkUrl;
    linkBtn.textContent = "Link";
    actions.appendChild(linkBtn);
  }
  if (enabled && linked && unlinkAction) {
    const unlinkBtn = document.createElement("button");
    unlinkBtn.className = "btn btn-sm btn-outline-danger me-2";
    unlinkBtn.textContent = "Unlink";
    unlinkBtn.onclick = () => unlinkAction(id);
    actions.appendChild(unlinkBtn);
  }
  item.appendChild(actions);
  return item;
}

function renderDestinations(status) {
  const safeStatus = {
    local: { enabled: false, ...(status?.local || {}) },
    google: {
      enabled: false,
      linked: false,
      mode: "service-account",
      ...(status?.google || {}),
    },
    dropbox: { enabled: false, linked: false, ...(status?.dropbox || {}) },
    s3: { enabled: false, ...(status?.s3 || {}) },
    webdav: { enabled: false, ...(status?.webdav || {}) },
  };
  destinationList.innerHTML = "";
  const entries = [
    {
      id: "local",
      label: "Local storage",
      enabled: safeStatus.local.enabled,
      linked: safeStatus.local.enabled,
      statusText: safeStatus.local.enabled
        ? "Enabled (writes inside the container volume)"
        : "Disabled",
    },
    {
      id: "google",
      label: "Google Drive",
      enabled: safeStatus.google.enabled,
      linked: safeStatus.google.linked,
      linkUrl:
        safeStatus.google.enabled && safeStatus.google.mode === "oauth"
          ? `${basePath()}/auth/google`
          : null,
      unlinkAction: unlinkProvider,
      statusText: safeStatus.google.enabled
        ? safeStatus.google.linked
          ? `Linked (${safeStatus.google.mode === "oauth" ? "OAuth" : "Service account"})`
          : `Not linked (${safeStatus.google.mode === "oauth" ? "OAuth" : "Service account"})`
        : "Disabled",
    },
    {
      id: "dropbox",
      label: "Dropbox",
      enabled: safeStatus.dropbox.enabled,
      linked: safeStatus.dropbox.linked,
      linkUrl: safeStatus.dropbox.enabled ? `${basePath()}/auth/dropbox` : null,
      unlinkAction: unlinkProvider,
      statusText: safeStatus.dropbox.enabled
        ? safeStatus.dropbox.linked
          ? "Linked"
          : "Not linked"
        : "Disabled",
    },
    {
      id: "s3",
      label: "S3 / compatible",
      enabled: safeStatus.s3.enabled,
      linked: safeStatus.s3.enabled,
      statusText: safeStatus.s3.enabled ? "Configured" : "Disabled",
    },
    {
      id: "webdav",
      label: "WebDAV / Nextcloud",
      enabled: safeStatus.webdav.enabled,
      linked: safeStatus.webdav.enabled,
      statusText: safeStatus.webdav.enabled ? "Configured" : "Disabled",
    },
  ];
  entries.forEach((entry) => {
    destinationList.appendChild(createDestinationItem(entry));
  });
}

function renderSyncTargets(targetsMeta) {
  if (!syncTargetsInfo) return;
  syncTargetsInfo.innerHTML = "";
  const labels = Array.isArray(targetsMeta)
    ? targetsMeta.map((target) => formatTargetLabel(target)).filter(Boolean)
    : [];

  if (labels.length === 0) {
    syncTargetsInfo.textContent = "Not configured";
    return;
  }

  if (labels.length === 1) {
    syncTargetsInfo.textContent = labels[0];
    return;
  }

  const list = document.createElement("ul");
  list.className = "mb-0 ps-3";
  labels.forEach((label) => {
    const item = document.createElement("li");
    item.textContent = label;
    list.appendChild(item);
  });
  syncTargetsInfo.appendChild(list);
}

async function unlinkProvider(provider) {
  try {
    const res = await fetch(`${basePath()}/api/${provider}/unlink`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("unlink failed");
    await loadStatus();
    showAlert(`${provider} unlinked`, "success");
  } catch (err) {
    showAlert(`Failed to unlink ${provider}: ${err.message}`, "danger");
  }
}

backupBtn.addEventListener("click", async () => {
  backupBtn.disabled = true;
  showAlert("Running backup...", "info");
  try {
    const res = await fetch(`${basePath()}/api/backup`, { method: "POST" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || "backup failed");
    }
    showAlert("Backup completed successfully", "success");
  } catch (err) {
    showAlert(`Backup failed: ${err.message}`, "danger");
  } finally {
    backupBtn.disabled = false;
  }
});

loadStatus();
