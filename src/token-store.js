const fs = require("fs/promises");
const path = require("path");

class TokenStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  filePath(provider) {
    return path.join(this.baseDir, `${provider}.json`);
  }

  async get(provider) {
    try {
      const raw = await fs.readFile(this.filePath(provider), "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async set(provider, data) {
    await this.init();
    await fs.writeFile(this.filePath(provider), JSON.stringify(data, null, 2));
  }

  async clear(provider) {
    await fs.rm(this.filePath(provider), { force: true });
  }

  async has(provider) {
    return (await this.get(provider)) !== null;
  }
}

module.exports = TokenStore;
