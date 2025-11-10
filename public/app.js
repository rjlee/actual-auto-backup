const destinationList = document.getElementById("destinationList");
const alertBox = document.getElementById("alert");
const backupBtn = document.getElementById("backupBtn");

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

async function loadStatus() {
  try {
    const res = await fetch(`${basePath()}/api/status`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "status request failed");
    }
    const { status, running } = await res.json();
    renderDestinations(status);
    backupBtn.disabled = running;
    hideAlert();
  } catch (err) {
    showAlert(`Failed to load status: ${err.message}`, "danger");
  }
}

function badgeClass(variant = "secondary") {
  switch (variant) {
    case "success":
    case "secondary":
    case "primary":
    case "danger":
    case "info":
      return `badge bg-${variant}`;
    case "warning":
      return "badge bg-warning text-dark";
    default:
      return "badge bg-secondary";
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
  badges = [],
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
  badges
    .map((badge) =>
      typeof badge === "string"
        ? { label: badge, variant: "secondary" }
        : badge,
    )
    .filter((badge) => badge && badge.label)
    .forEach(({ label: badgeLabel, variant = "secondary" }) => {
      const span = document.createElement("span");
      span.className = `${badgeClass(variant)} ms-1`;
      span.textContent = badgeLabel;
      actions.appendChild(span);
    });
  item.appendChild(actions);
  return item;
}

function buildBadges({ enabled, linked, mode, extras }) {
  const badges = [];
  badges.push({
    label: enabled ? "Enabled" : "Disabled",
    variant: enabled ? "success" : "secondary",
  });

  if (typeof linked === "boolean") {
    badges.push({
      label: linked ? "Linked" : "Not linked",
      variant: linked ? "primary" : "warning",
    });
  }

  if (enabled && mode) {
    const modeLabel =
      mode === "oauth"
        ? "OAuth"
        : mode === "service-account"
          ? "Service account"
          : mode;
    badges.push({
      label: modeLabel,
      variant: "info",
    });
  }

  const extraList = Array.isArray(extras)
    ? extras.filter(Boolean)
    : extras
      ? [extras]
      : [];
  extraList.forEach((extraBadge) => {
    if (typeof extraBadge === "string") {
      badges.push({ label: extraBadge, variant: "secondary" });
    } else if (extraBadge && extraBadge.label) {
      badges.push(extraBadge);
    }
  });
  return badges;
}

function renderDestinations(status) {
  destinationList.innerHTML = "";
  const entries = [
    {
      id: "local",
      label: "Local storage",
      enabled: status.local.enabled,
      linked: status.local.enabled,
      statusText: status.local.enabled ? "Linked" : "Disabled",
      badges: buildBadges({
        enabled: status.local.enabled,
        linked: status.local.enabled,
      }),
    },
    {
      id: "google",
      label: "Google Drive",
      enabled: status.google.enabled,
      linked: status.google.linked,
      linkUrl:
        status.google.enabled && status.google.mode === "oauth"
          ? `${basePath()}/auth/google`
          : null,
      unlinkAction: unlinkProvider,
      statusText: status.google.enabled
        ? status.google.linked
          ? "Linked"
          : "Not linked"
        : "Disabled",
      badges: buildBadges({
        enabled: status.google.enabled,
        linked: status.google.linked,
        mode: status.google.mode,
      }),
    },
    {
      id: "dropbox",
      label: "Dropbox",
      enabled: status.dropbox.enabled,
      linked: status.dropbox.linked,
      linkUrl: status.dropbox.enabled ? `${basePath()}/auth/dropbox` : null,
      unlinkAction: unlinkProvider,
      statusText: status.dropbox.enabled
        ? status.dropbox.linked
          ? "Linked"
          : "Not linked"
        : "Disabled",
      badges: buildBadges({
        enabled: status.dropbox.enabled,
        linked: status.dropbox.linked,
      }),
    },
    {
      id: "s3",
      label: "S3 / compatible",
      enabled: status.s3.enabled,
      linked: status.s3.enabled,
      statusText: status.s3.enabled ? "Configured" : "Disabled",
      badges: buildBadges({
        enabled: status.s3.enabled,
        linked: status.s3.enabled,
        extras: status.s3.enabled ? "Configured" : null,
      }),
    },
    {
      id: "webdav",
      label: "WebDAV / Nextcloud",
      enabled: status.webdav.enabled,
      linked: status.webdav.enabled,
      statusText: status.webdav.enabled ? "Configured" : "Disabled",
      badges: buildBadges({
        enabled: status.webdav.enabled,
        linked: status.webdav.enabled,
        extras: status.webdav.enabled ? "Configured" : null,
      }),
    },
  ];
  entries.forEach((entry) => {
    destinationList.appendChild(createDestinationItem(entry));
  });
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
