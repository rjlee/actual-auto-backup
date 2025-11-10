const fsp = require("fs/promises");
const path = require("path");
const { formatISO } = require("date-fns");

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeLocalBackup(buffer, options, logger) {
  const { outputDir, retentionCount, retentionWeeks, budgetId, timestamp } =
    options;
  await ensureDir(outputDir);
  const ts =
    timestamp || formatISO(new Date(), { format: "basic" }).replace(/[:]/g, "");
  const filename = `${budgetId || "budget"}-${ts}.zip`;
  const filePath = path.join(outputDir, filename);
  await fsp.writeFile(filePath, buffer);
  logger.info({ filePath }, "local backup saved");
  await fsp.writeFile(
    path.join(path.dirname(outputDir), ".last-success"),
    `${Math.floor(Date.now() / 1000)}`,
  );
  await pruneLocalBackups(outputDir, retentionCount, retentionWeeks, logger);
  return filePath;
}

async function pruneLocalBackups(dir, retentionCount, retentionWeeks, logger) {
  if (retentionCount <= 0 && retentionWeeks <= 0) {
    return;
  }
  let files = await fsp.readdir(dir);
  files = files.filter((file) => file.endsWith(".zip"));
  if (files.length === 0) return;
  const fileStats = await Promise.all(
    files.map(async (file) => {
      const stat = await fsp.stat(path.join(dir, file));
      return { file, mtime: stat.mtime };
    }),
  );
  fileStats.sort((a, b) => b.mtime - a.mtime);

  const keep = new Set();

  // Keep newest N
  fileStats.slice(0, Math.max(retentionCount, 0)).forEach((entry) => {
    keep.add(entry.file);
  });

  if (retentionWeeks > 0) {
    const byWeek = new Map();
    for (const entry of fileStats) {
      const weekKey = getWeekKey(entry.mtime);
      if (!byWeek.has(weekKey)) {
        byWeek.set(weekKey, entry);
      }
    }
    const uniqueWeeks = Array.from(byWeek.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, retentionWeeks);
    uniqueWeeks.forEach(([, entry]) => keep.add(entry.file));
  }

  const toDelete = fileStats
    .filter((entry) => !keep.has(entry.file))
    .map((entry) => entry.file);

  await Promise.all(
    toDelete.map(async (file) => {
      const target = path.join(dir, file);
      await fsp.unlink(target).catch((err) => {
        logger.warn({ err, target }, "failed to remove old backup");
      });
    }),
  );

  if (toDelete.length > 0) {
    logger.info({ removed: toDelete }, "pruned old backups");
  }
}

function getWeekKey(date) {
  const year = date.getUTCFullYear();
  const firstJan = new Date(Date.UTC(year, 0, 1));
  const diff =
    (date - firstJan + (firstJan.getUTCDay() + 6) * 86400000) / 86400000;
  const week = Math.floor(diff / 7) + 1;
  return `${year}-W${week.toString().padStart(2, "0")}`;
}

module.exports = {
  writeLocalBackup,
  pruneLocalBackups,
};
