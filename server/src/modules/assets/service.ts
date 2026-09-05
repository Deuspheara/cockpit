import { z } from "zod";
import type { Database } from "../../db/index.js";
import { currency } from "../../shared/decimal.js";
export const assetInput = z
  .object({
    assetType: z.enum([
      "crypto",
      "equity",
      "etf",
      "cash",
      "perp",
      "option",
      "other",
    ]),
    symbol: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(150),
    quoteCurrency: currency,
    chain: z.string().max(80).nullable().optional(),
    contractAddress: z.string().max(100).nullable().optional(),
    externalIds: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export interface Asset {
  id: string;
  assetType: string;
  symbol: string;
  name: string;
  quoteCurrency: string;
  chain: string | null;
  contractAddress: string | null;
  externalIds: Record<string, string>;
}
export class AssetService {
  constructor(private database: Database) {}
  async list() {
    return this.database.sql<
      Asset[]
    >`SELECT * FROM assets ORDER BY symbol,id LIMIT 1000`;
  }
  async create(input: unknown) {
    const a = assetInput.parse(input);
    const [asset] = await this.database.sql<
      Asset[]
    >`INSERT INTO assets(asset_type,symbol,name,quote_currency,chain,contract_address,external_ids)
   VALUES(${a.assetType},${a.symbol},${a.name},${a.quoteCurrency},${a.chain ?? null},${a.contractAddress ?? null},${this.database.sql.json(a.externalIds)}) RETURNING *`;
    return asset!;
  }
}
