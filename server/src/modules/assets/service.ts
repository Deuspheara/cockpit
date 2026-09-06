import { z } from "zod";
import type { Database } from "../../db/index.js";
import { currency } from "../../shared/decimal.js";
import { linkSecurityAsset } from "../market-data/service.js";
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
  securityId?: string | null;
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
    return this.database.sql.begin(async (tx) => {
      const [asset] = await tx<
        Asset[]
      >`INSERT INTO assets(asset_type,symbol,name,quote_currency,chain,contract_address,external_ids)
       VALUES(${a.assetType},${a.symbol},${a.name},${a.quoteCurrency},${a.chain ?? null},${a.contractAddress ?? null},${tx.json(a.externalIds)}) RETURNING *`;
      if (a.externalIds.isin)
        await linkSecurityAsset(tx, {
          assetId: asset!.id,
          isin: a.externalIds.isin,
          name: a.name,
          assetType: a.assetType,
        });
      return asset!;
    });
  }
}
