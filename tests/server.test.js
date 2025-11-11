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
        syncIds: ["primary-sync"],
        syncTargets: [
          { syncId: "primary-sync", budgetId: "cloud-primary" },
          { syncId: "primary-sync", budgetId: "cloud-secondary" },
        ],
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
    expect(res.body.meta.targets).toEqual([
      { syncId: "primary-sync", budgetId: "cloud-primary" },
      { syncId: "primary-sync", budgetId: "cloud-secondary" },
    ]);
    expect(res.body.meta.errors).toEqual([]);
    expect(res.body.errors).toEqual([]);
  });

  test("status endpoint reports configuration errors", async () => {
    const config = {
      googleDrive: { enabled: false, mode: "service-account" },
      dropbox: { enabled: false },
      s3: { enabled: false },
      webdav: { enabled: false },
      local: {
        enabled: false,
        outputDir: "/tmp/backups",
        retentionCount: 0,
        retentionWeeks: 0,
      },
      schedule: {
        cron: "",
      },
      actual: {
        budgetDir: "/tmp/budget",
        syncId: null,
        syncIds: [],
        syncTargets: [],
      },
      ui: { port: 4010, publicUrl: "http://localhost:4010" },
      runtime: {
        configError: {
          message: "ACTUAL_SYNC_ID is required",
        },
      },
    };
    const tokenStore = {
      has: jest.fn().mockResolvedValue(false),
    };
    const app = createRouter(config, tokenStore, jest.fn());
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ message: "ACTUAL_SYNC_ID is required" }),
    ]);
    expect(res.body.meta.errors).toEqual([
      expect.objectContaining({ message: "ACTUAL_SYNC_ID is required" }),
    ]);
  });

  test("backup endpoint rejects when configuration invalid", async () => {
    const config = {
      googleDrive: { enabled: false, mode: "service-account" },
      dropbox: { enabled: false },
      s3: { enabled: false },
      webdav: { enabled: false },
      local: { enabled: false },
      schedule: { cron: "" },
      actual: { syncTargets: [] },
      ui: { port: 4010, publicUrl: "http://localhost:4010" },
      runtime: {
        configError: {
          message: "Configuration invalid",
        },
      },
    };
    const app = createRouter(config, null, jest.fn());
    const res = await request(app).post("/api/backup");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/configuration/i);
  });
});
