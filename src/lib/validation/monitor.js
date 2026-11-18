import { z } from "zod";

const INTERVALS = [60, 300, 600, 1800, 3600];

export function supportedMonitorIntervals() {
  const minimum = Number(process.env.MIN_MONITOR_INTERVAL_SECONDS || 60);
  return minimum > 3600
    ? [minimum]
    : INTERVALS.filter((interval) => interval >= minimum);
}

export const monitorSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.string().url().max(2048),
    method: z
      .enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
      .default("GET"),
    intervalSeconds: z
      .number()
      .int()
      .refine((interval) => supportedMonitorIntervals().includes(interval)),
    timeoutMs: z.number().int().min(1000).max(15000).default(10000),
    expectedStatusCodes: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .max(20)
      .default([200]),
    expectedContent: z.string().max(500).optional(),
    customHeaders: z.record(z.string().max(2000)).optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
