import { z } from "zod";

const events = z.array(z.enum(["incident.opened", "incident.resolved"])).min(1);

export const channelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    name: z.string().trim().min(1).max(80),
    email: z.email(),
    events,
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("webhook"),
    name: z.string().trim().min(1).max(80),
    url: z.url().max(2048),
    secret: z.string().min(32).max(256),
    events,
    enabled: z.boolean().default(true),
  }),
]);
