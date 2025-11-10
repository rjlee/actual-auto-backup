const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const {
  writeLocalBackup,
  pruneLocalBackups,
} = require("../src/exporters/local");

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
};

describe("local exporter", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-test-"));
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("writes file and retention marker", async () => {
    const buffer = Buffer.from("hello");
    const result = await writeLocalBackup(
      buffer,
      {
        outputDir: path.join(tmpDir, "backups"),
        retentionCount: 1,
        retentionWeeks: 0,
        budgetId: "test-budget",
      },
      logger,
    );

    const exists = await fs.stat(result);
    expect(exists.isFile()).toBe(true);
    const marker = await fs.readFile(
      path.join(tmpDir, ".last-success"),
      "utf8",
    );
    expect(Number(marker)).toBeGreaterThan(0);
  });

  test("prunes old files", async () => {
    const dir = path.join(tmpDir, "backups");
    await fs.mkdir(dir, { recursive: true });
    const filenames = ["a.zip", "b.zip", "c.zip"];
    for (const name of filenames) {
      await fs.writeFile(path.join(dir, name), "x");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await pruneLocalBackups(dir, 2, 0, logger);
    const remaining = await fs.readdir(dir);
    expect(remaining.length).toBe(2);
  });
});
