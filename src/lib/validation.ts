import type { z } from "zod";

export function validateRequest<T extends z.ZodType>(schema: T, data: unknown) {
  const result = schema.safeParse(data);
  if (!result.success) {
    return { success: false as const, error: result.error.flatten() };
  }
  return { success: true as const, data: result.data as z.infer<T> };
}
