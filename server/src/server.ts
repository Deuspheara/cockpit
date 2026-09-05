import { readConfig } from "./config.js";
import { createApp } from "./app.js";
const config = readConfig();
const app = await createApp(config);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close();
  });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
