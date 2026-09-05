import { readConfig } from "../../config.js";
import { connectDatabase } from "../../db/index.js";
import { AuthService } from "./service.js";
const database = connectDatabase(readConfig().DATABASE_URL);
try {
  const service = new AuthService(database);
  if (process.argv[2] === "create") {
    const index = process.argv.indexOf("--name");
    const name = index >= 0 ? process.argv[index + 1] : undefined;
    if (!name?.trim())
      throw new Error('Usage: npm run token:create -- --name "iPhone"');
    const result = await service.create(name);
    console.log(`Device ID: ${result.id}\nToken (shown once): ${result.token}`);
  } else if (process.argv[2] === "revoke" && process.argv[3]) {
    console.log(await service.revoke(process.argv[3]));
  } else throw new Error("Usage: npm run token:revoke -- <device UUID>");
} finally {
  await database.close();
}
