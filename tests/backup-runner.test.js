const fs = require("fs/promises");
const path = require("path");
const os = require("os");

jest.mock("@actual-app/api", () => {
  const send = jest
    .fn()
    .mockResolvedValue({ data: Buffer.from("backup-data") });
  return {
    init: jest.fn().mockResolvedValue(),
    downloadBudget: jest.fn().mockResolvedValue({}),
    loadBudget: jest.fn().mockResolvedValue({}),
    shutdown: jest.fn().mockResolvedValue(),
    internal: { send },
  };
});

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
    const config = {
      actual: {
        serverUrl: "https://example.com",
        password: "secret",
        syncId: "budget-123",
        budgetDir: path.join(tmpDir, "budget"),
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

    const files = await fs.readdir(config.local.outputDir);
    expect(files.some((file) => file.endsWith(".zip"))).toBe(true);
    const marker = await fs.readFile(
      path.join(tmpDir, ".last-success"),
      "utf8",
    );
    expect(Number(marker)).toBeGreaterThan(0);
  });
});
