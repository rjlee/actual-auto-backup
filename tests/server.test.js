const path = require("path");
const os = require("os");
const request = require("supertest");
const { createRouter } = require("../src/server");

describe("server", () => {
  test("status endpoint returns destination info", async () => {
    const tmpDir = path.join(os.tmpdir(), "actual-auto-backup-test");
    const config = {
      googleDrive: { enabled: false, mode: "service-account" },
      dropbox: { enabled: false },
      s3: { enabled: false },
      webdav: { enabled: false },
      local: {
        enabled: true,
        outputDir: path.join(tmpDir, "backups"),
        retentionCount: 4,
        retentionWeeks: 0,
      },
      schedule: {
        cron: "0 0 * * 1",
      },
      actual: {
        budgetDir: path.join(tmpDir, "budget"),
        syncId: "primary-sync",
        syncIds: ["primary-sync", "secondary-sync"],
      },
      ui: { port: 4010, publicUrl: "http://localhost:4010" },
    };
    const tokenStore = {
      has: jest.fn().mockResolvedValue(false),
    };
    const app = createRouter(config, tokenStore, jest.fn());
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toHaveProperty("google");
    expect(res.body.status.google.enabled).toBe(false);
    expect(res.body.meta.schedule.cron).toBe("0 0 * * 1");
    expect(res.body.meta.retention.description).toBeDefined();
    expect(res.body.meta.targets).toEqual(["primary-sync", "secondary-sync"]);
  });
});
