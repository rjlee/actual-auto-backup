const pino = require("pino");

const level = process.env.LOG_LEVEL || "info";
const isProduction = process.env.NODE_ENV === "production";
const isCi = process.env.CI === "true";
const usePretty = !isProduction && !isCi && process.env.PINO_PRETTY !== "false";

let transport;
if (usePretty) {
  try {
    require.resolve("pino-pretty");
    transport = {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard" },
    };
  } catch {
    // Fallback gracefully if pino-pretty is not installed (e.g., unit tests)
    transport = undefined;
  }
}

const logger = pino(
  transport
    ? {
        level,
        transport,
      }
    : { level },
);

module.exports = logger;
