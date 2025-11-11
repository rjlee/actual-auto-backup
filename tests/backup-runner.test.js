const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const sqlite3 = require("better-sqlite3");

jest.mock("@actual-app/api", () => ({
  init: jest.fn().mockResolvedValue(),
  downloadBudget: jest.fn().mockResolvedValue({
    id: { id: "primary-budget" },
  }),
  loadBudget: jest.fn().mockResolvedValue({}),
  shutdown: jest.fn().mockResolvedValue(),
  getBudgets: jest.fn().mockResolvedValue([
    {
      id: "primary-budget",
      budgetId: "budget-primary",
      name: "Main Budget",
    },
  ]),
}));

const api = require("@actual-app/api");
const { runBackup } = require("../src/backup-runner");

describe("runBackup", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-runner-"));
    api.downloadBudget.mockClear();
    api.downloadBudget.mockResolvedValue({ id: { id: "primary-budget" } });
    api.getBudgets.mockClear();
    api.getBudgets.mockResolvedValue([
      {
        id: "primary-budget",
        budgetId: "budget-primary",
        name: "Main Budget",
      },
    ]);
  });

  afterEach(async () => {
    jest.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("executes local backup", async () => {
    const budgetDir = path.join(tmpDir, "budget");
    const budgetPath = path.join(budgetDir, "lee-family");
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
      JSON.stringify({ budgetName: "Main Budget" }),
    );

    const config = {
      actual: {
        serverUrl: "https://example.com",
        password: "secret",
        syncId: "sync-primary",
        syncIds: ["sync-primary"],
        syncTargets: [
          {
            syncId: "sync-primary",
            budgetId: "budget-primary",
          },
        ],
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
    expect(files).toEqual([expect.stringMatching(/^Main-Budget-.*\.zip$/)]);
    const marker = await fs.readFile(
      path.join(tmpDir, ".last-success"),
      "utf8",
    );
    expect(Number(marker)).toBeGreaterThan(0);
  });

  test("backs up multiple sync ids sequentially", async () => {
    const budgetDir = path.join(tmpDir, "budget-multi");
    const budgetsMeta = [
      {
        dir: path.join(budgetDir, "primary-budget"),
        value: "test",
        name: "Primary Budget",
        syncId: "sync-primary",
        budgetId: "budget-primary",
      },
      {
        dir: path.join(budgetDir, "secondary-budget"),
        value: "test2",
        name: "Secondary Budget",
        syncId: "sync-secondary",
        budgetId: "budget-secondary",
      },
    ];

    for (const meta of budgetsMeta) {
      await fs.mkdir(meta.dir, { recursive: true });
      const dbPath = path.join(meta.dir, "db.sqlite");
      const db = sqlite3(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS kvcache (key TEXT);
        CREATE TABLE IF NOT EXISTS kvcache_key (key TEXT);
        INSERT INTO kvcache(key) VALUES ('${meta.value}');
      `);
      db.close();

      await fs.writeFile(
        path.join(meta.dir, "metadata.json"),
        JSON.stringify({ budgetName: meta.name }),
      );
    }

    api.downloadBudget.mockImplementation((syncId) => {
      const match = budgetsMeta.find((meta) => meta.syncId === syncId);
      expect(match).toBeDefined();
      return Promise.resolve({ id: { id: path.basename(match.dir) } });
    });

    api.getBudgets.mockResolvedValue(
      budgetsMeta.map((meta) => ({
        id: path.basename(meta.dir),
        budgetId: meta.budgetId,
        name: meta.name,
      })),
    );

    const config = {
      actual: {
        serverUrl: "https://example.com",
        password: "secret",
        syncId: "sync-primary",
        syncIds: budgetsMeta.map((meta) => meta.syncId),
        syncTargets: budgetsMeta.map((meta) => ({
          syncId: meta.syncId,
          budgetId: meta.budgetId,
        })),
        budgetDir,
        encryptionKey: null,
      },
      local: {
        enabled: true,
        outputDir: path.join(tmpDir, "backups"),
        retentionCount: 5,
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

    expect(api.downloadBudget).toHaveBeenCalledTimes(2);
    const syncIds = api.downloadBudget.mock.calls
      .map(([syncId]) => syncId)
      .sort();
    expect(syncIds).toEqual(["sync-primary", "sync-secondary"].sort());

    const files = await fs.readdir(config.local.outputDir);
    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Primary-Budget-.*\.zip$/),
        expect.stringMatching(/^Secondary-Budget-.*\.zip$/),
      ]),
    );

    // Restore default mock behaviour for subsequent tests
    api.downloadBudget.mockResolvedValue({ id: { id: "primary-budget" } });
    api.getBudgets.mockResolvedValue([
      {
        id: "primary-budget",
        budgetId: "budget-primary",
        name: "Main Budget",
      },
    ]);
  });
});
