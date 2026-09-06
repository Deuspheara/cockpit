import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL_PRIMARY: z.string().default(""),
  OPENROUTER_MODEL_VISION: z.string().default(""),
  EODHD_API_TOKEN: z.string().trim().default(""),
  EODHD_DAILY_LIMIT: z.coerce.number().int().min(1).max(100000).default(20),
  EODHD_PER_MINUTE_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
  OPENFIGI_API_KEY: z.string().trim().default(""),
  MARKET_DATA_MAX_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4),
  LOGO_DEV_PUBLISHABLE_KEY: z.string().trim().default(""),
  ALCHEMY_API_KEY: z.string().default(""),
  ALCHEMY_NETWORKS: z.string().default("eth-mainnet,base-mainnet,arb-mainnet"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(25).default(12),
  DASHBOARD_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(15),
  PROVIDER_SYNC_SECONDS: z.coerce.number().int().min(60).default(120),
  VALUATION_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
