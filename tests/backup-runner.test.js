const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const sqlite3 = require("better-sqlite3");

jest.mock("@actual-app/api", () => ({
  init: jest.fn().mockResolvedValue(),
  downloadBudget: jest.fn().mockResolvedValue({
    id: { id: "local-budget-id" },
  }),
  loadBudget: jest.fn().mockResolvedValue({}),
  shutdown: jest.fn().mockResolvedValue(),
  getBudgets: jest
    .fn()
    .mockResolvedValue([{ id: "local-budget-id", cloudFileId: "budget-123" }]),
}));

const api = require("@actual-app/api");
const { runBackup } = require("../src/backup-runner");

describe("runBackup", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-runner-"));
  });

  afterEach(async () => {
    jest.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("executes local backup", async () => {
    const budgetDir = path.join(tmpDir, "budget");
    const budgetPath = path.join(budgetDir, "local-budget-id");
    await fs.mkdir(budgetPath, { recursive: true });

    const dbPath = path.join(budgetPath, "db.sqlite");
    const db = sqlite3(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS kvcache (key TEXT);
      CREATE TABLE IF NOT EXISTS kvcache_key (key TEXT);
      INSERT INTO kvcache(key) VALUES ('test');
    `);
    db.close();

    await fs.writeFile(
      path.join(budgetPath, "metadata.json"),
      JSON.stringify({ budgetName: "Demo Budget" }),
    );

    const config = {
      actual: {
        serverUrl: "https://example.com",
        password: "secret",
        syncId: "budget-123",
        budgetDir,
        encryptionKey: null,
      },
      local: {
        enabled: true,
        outputDir: path.join(tmpDir, "backups"),
        retentionCount: 2,
        retentionWeeks: 0,
      },
      googleDrive: { enabled: false },
      s3: { enabled: false },
      dropbox: { enabled: false },
      webdav: { enabled: false },
    };

    const tokenStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      clear: jest.fn(),
      has: jest.fn().mockResolvedValue(false),
    };

    await runBackup(config, tokenStore);

    expect(api.downloadBudget).toHaveBeenCalled();
    const files = await fs.readdir(config.local.outputDir);
    expect(files).toEqual([expect.stringMatching(/^local-budget-id-.*\.zip$/)]);
    const marker = await fs.readFile(
      path.join(tmpDir, ".last-success"),
      "utf8",
    );
    expect(Number(marker)).toBeGreaterThan(0);
  });
});
