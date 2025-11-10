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
  });

  test("throws when required env missing", () => {
    delete process.env.ACTUAL_SERVER_URL;
    delete process.env.ACTUAL_PASSWORD;
    delete process.env.ACTUAL_SYNC_ID;
    expect(() => loadConfig()).toThrow(/ACTUAL_SERVER_URL/);
  });
});
