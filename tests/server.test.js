const request = require("supertest");
const { createRouter } = require("../src/server");

describe("server", () => {
  test("status endpoint returns destination info", async () => {
    const config = {
      googleDrive: { enabled: false, mode: "service-account" },
      dropbox: { enabled: false },
      s3: { enabled: false },
      webdav: { enabled: false },
      local: { enabled: true },
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
  });
});
