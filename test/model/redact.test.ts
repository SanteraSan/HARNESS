import { describe, expect, it } from "vitest";

import { REDACTED, collectSecrets, redact } from "../../src/model/redact.js";

const listedSecret = "test-secret-value";

describe("redact", () => {
  it("должен заменить каждое вхождение секрета из списка", () => {
    const text = `до ${listedSecret} после ${listedSecret}`;
    expect(redact(text, [listedSecret])).toBe(`до ${REDACTED} после ${REDACTED}`);
  });

  it("должен заменить секрет буквально, даже если в нём символы регулярного выражения", () => {
    const secret = "test-secret-value+.*";
    expect(redact(`x ${secret} y`, [secret])).toBe(`x ${REDACTED} y`);
  });

  it("должен маскировать Bearer, ключ sk- и токен Telegram без списка", () => {
    const prefix = "a".repeat(5_000);
    const text = `${prefix} Bearer test-token sk-testsecretvalue 123456789:AAHtestsecretvalue123456789012345 end`;
    expect(redact(text, [])).toBe(`${prefix} ${REDACTED} ${REDACTED} ${REDACTED} end`);
  });

  it("должен оставить текст без секретов и коротких похожих фрагментов", () => {
    const text = "просто ответ 1234:abc sk-";
    expect(redact(text, [])).toBe(text);
  });

  it("должен маскировать короткое значение из списка целиком", () => {
    expect(redact("код short и ещё short", ["short"])).toBe(`код ${REDACTED} и ещё ${REDACTED}`);
    expect(redact("a xa", ["a"])).toBe(`${REDACTED} x${REDACTED}`);
  });

  it("должен не маскировать пустую строку и сам маркер", () => {
    const text = `видно ${REDACTED} и буквы`;
    expect(redact(text, ["", REDACTED])).toBe(text);
  });

  it("должен вырезать длинный секрет целиком, а не только окно регулярного выражения", () => {
    const secret = `test-secret-${"v".repeat(3_000)}`;
    expect(redact(`before ${secret} after`, [secret])).toBe(`before ${REDACTED} after`);
  });

  it("должен собрать секреты окружения и убрать их из текста", () => {
    const databaseUrl = "postgres://devai:test-secret-value@127.0.0.1:5442/harness";
    const secrets = collectSecrets({
      databaseUrl,
      harnessTestDatabaseUrl: "",
      litellmApiKey: "test-api-key",
      harnessApiToken: "",
      telegramBotToken: "short",
    });

    expect(secrets).toContain(databaseUrl);
    expect(secrets).toContain("test-api-key");
    expect(secrets).toContain("short");
    expect(secrets).not.toContain("");
    expect(secrets).not.toContain(REDACTED);

    const masked = redact(`url ${databaseUrl} key test-api-key tok short`, secrets);
    expect(masked).not.toContain(databaseUrl);
    expect(masked).not.toContain("test-secret-value");
    expect(masked).not.toContain("test-api-key");
    expect(masked).not.toContain("short");
    expect(masked).toContain(REDACTED);
  });
});
