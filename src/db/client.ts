import postgres from "postgres";

/**
 * int8 (chat_id) остаётся строкой.
 * Number() для идентификатора Telegram не помещается в точное целое.
 */
const chatId: postgres.PostgresType<string> = {
  to: 20,
  from: [20],
  serialize: (value: string) => value,
  parse: (value: string) => value,
};

export type Sql = postgres.Sql<{ chat_id: string }>;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    types: {
      chat_id: chatId,
    },
    connection: {
      application_name: "harness",
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 10_000,
    },
    // У драйвера notice по умолчанию идёт в console.log. В журнал процесса его не пишем.
    onnotice() {
      return undefined;
    },
  });
}
