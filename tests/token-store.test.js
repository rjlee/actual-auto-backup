const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const TokenStore = require("../src/token-store");

describe("TokenStore", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "token-store-"));
    store = new TokenStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("set and get tokens", async () => {
    const data = { access_token: "abc", expiry_date: Date.now() };
    await store.set("google", data);
    const fetched = await store.get("google");
    expect(fetched).toEqual(data);
    expect(await store.has("google")).toBe(true);
    await store.clear("google");
    expect(await store.get("google")).toBeNull();
  });
});
