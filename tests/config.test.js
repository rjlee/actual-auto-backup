const loadConfig = require("../src/config");

describe("config loader", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("parses booleans and numbers", () => {
    process.env.ACTUAL_SERVER_URL = "https://example.com";
    process.env.ACTUAL_PASSWORD = "secret";
    process.env.ACTUAL_SYNC_ID = "budget-123";
    process.env.ENABLE_LOCAL = "false";
    process.env.LOCAL_RETENTION_COUNT = "7";
    process.env.ENABLE_GDRIVE = "true";
    process.env.GDRIVE_SERVICE_ACCOUNT_JSON = __filename;

    const config = loadConfig();
    expect(config.local.enabled).toBe(false);
    expect(config.local.retentionCount).toBe(7);
    expect(config.googleDrive.enabled).toBe(true);
    expect(config.googleDrive.credentialsPath).toBe(__filename);
    expect(config.actual.syncTargets).toEqual([
      { syncId: "budget-123", budgetId: null },
    ]);
  });

  test("parses BACKUP_SYNC_ID with budget ids", () => {
    process.env.ACTUAL_SERVER_URL = "https://example.com";
    process.env.ACTUAL_PASSWORD = "secret";
    process.env.ACTUAL_SYNC_ID = "share-default";
    process.env.BACKUP_SYNC_ID = "budget-a:share-a,budget-b:share-b";

    const config = loadConfig();
    expect(config.actual.syncTargets).toEqual([
      { syncId: "share-a", budgetId: "budget-a" },
      { syncId: "share-b", budgetId: "budget-b" },
    ]);
    expect(config.actual.syncIds).toEqual(["share-a", "share-b"]);
    expect(config.actual.syncId).toBe("share-a");
  });

  test("parses BACKUP_SYNC_ID with plain sync ids", () => {
    process.env.ACTUAL_SERVER_URL = "https://example.com";
    process.env.ACTUAL_PASSWORD = "secret";
    process.env.BACKUP_SYNC_ID = "share-a,share-b";

    const config = loadConfig();
    expect(config.actual.syncTargets).toEqual([
      { syncId: "share-a", budgetId: null },
      { syncId: "share-b", budgetId: null },
    ]);
    expect(config.actual.syncIds).toEqual(["share-a", "share-b"]);
    expect(config.actual.syncId).toBe("share-a");
  });

  test("throws when required env missing", () => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_PASSWORD;
    delete process.env.ACTUAL_SYNC_ID;
    expect(() => loadConfig()).toThrow(/ACTUAL_SERVER_URL/);
  });
});
