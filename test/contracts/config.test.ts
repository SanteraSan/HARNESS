import { hostname } from "node:os";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://devai:test-secret-value@127.0.0.1:5442/harness",
    HARNESS_TEST_DATABASE_URL: "postgres://devai:test-secret-value@127.0.0.1:5442/harness_test",
    LITELLM_API_KEY: "",
    HARNESS_API_TOKEN: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_ALLOWED_USER_IDS: "1234567890123456789, 42",
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("должен подставить значения M1 и сохранить длинный id строкой", () => {
    const config = loadConfig(baseEnv());
    expect(config.litellmBaseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(config.agentSlug).toBe("clerk");
    expect(config.fileRoot).toBe("./workspace");
    expect(config.leaseSeconds).toBe(120);
    expect(config.heartbeatSeconds).toBe(15);
    expect(config.workerId).toBe(hostname());
    expect(config.harnessLiveModel).toBeNull();
    expect(config.telegramAllowedUserIds).toEqual(["1234567890123456789", "42"]);
    expect(config.telegramBotToken).toBe("");
  });

  it("должен отказать без DATABASE_URL и не включить секрет в текст ошибки", () => {
    const env = baseEnv({ LEASE_SECONDS: "0" });
    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig({ ...baseEnv(), DATABASE_URL: undefined });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) {
        expect(error.code).toBe("config_invalid");
        expect(error.message).not.toContain("test-secret-value");
        expect(error.message).toContain("DATABASE_URL");
      }
    }
  });
});
