import { createClient } from "redis";
export function connectCache(url: string) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 1500,
      reconnectStrategy: (retries) => Math.min(1000 * (retries + 1), 15000),
    },
    disableOfflineQueue: true,
  });
  client.on("error", () => {
    /* Optional cache; never log connection URLs containing credentials. */
  });
  void client.connect().catch(() => {});
  return client;
}
export type Cache = ReturnType<typeof connectCache>;
