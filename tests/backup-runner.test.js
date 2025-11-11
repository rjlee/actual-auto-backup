const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const sqlite3 = require("better-sqlite3");

jest.mock("@actual-app/api", () => ({
  init: jest.fn().mockResolvedValue(),
  downloadBudget: jest.fn().mockResolvedValue({
    id: { id: "lee-family" },
  }),
  loadBudget: jest.fn().mockResolvedValue({}),
  shutdown: jest.fn().mockResolvedValue(),
  getBudgets: jest.fn().mockResolvedValue([
    {
      id: "local-budget-id",
      cloudFileId: "budget-123",
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
    api.downloadBudget.mockResolvedValue({ id: { id: "lee-family" } });
    api.getBudgets.mockClear();
    api.getBudgets.mockResolvedValue([
      {
        id: "lee-family",
        cloudFileId: "budget-123",
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
        syncId: "budget-123",
        syncIds: ["budget-123"],
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
        dir: path.join(budgetDir, "Primary-Budget-123"),
        value: "test",
        name: "Primary Budget",
        cloudId: "budget-123",
      },
      {
        dir: path.join(budgetDir, "Secondary-Budget-456"),
        value: "test2",
        name: "Secondary Budget",
        cloudId: "budget-456",
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
      const match = budgetsMeta.find((meta) => meta.cloudId === syncId);
      return Promise.resolve({ id: { id: path.basename(match.dir) } });
    });

    api.getBudgets.mockResolvedValue(
      budgetsMeta.map((meta) => ({
        id: path.basename(meta.dir),
        cloudFileId: meta.cloudId,
        name: meta.name,
      })),
    );

    const config = {
      actual: {
        serverUrl: "https://example.com",
        password: "secret",
        syncId: "budget-123",
        syncIds: ["budget-123", "budget-456"],
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

    expect(api.downloadBudget).toHaveBeenCalledWith(
      "budget-123",
      expect.any(Object),
    );
    expect(api.downloadBudget).toHaveBeenCalledWith(
      "budget-456",
      expect.any(Object),
    );

    const files = await fs.readdir(config.local.outputDir);
    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Primary-Budget-.*\.zip$/),
        expect.stringMatching(/^Secondary-Budget-.*\.zip$/),
      ]),
    );

    // Restore default mock behaviour for subsequent tests
    api.downloadBudget.mockResolvedValue({ id: { id: "local-budget-id" } });
    api.getBudgets.mockResolvedValue([
      {
        id: "local-budget-id",
        cloudFileId: "budget-123",
        name: "Main Budget",
      },
    ]);
  });
});
