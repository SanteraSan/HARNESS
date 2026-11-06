import { z } from "zod";

/** Тело постановки M1. Неизвестные поля отбрасываются, message не длиннее 8000 символов. */
export const runPayloadSchema = z.object({
  message: z.string().max(8000),
});

export type RunPayload = z.infer<typeof runPayloadSchema>;
