import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MarketDataService } from "./service.js";

const securityId = (params: unknown) =>
  z.object({ id: z.uuid().toLowerCase() }).parse(params).id;

export function registerMarketDataRoutes(
  app: FastifyInstance,
  marketData: MarketDataService,
) {
  app.get("/api/v1/market-data/securities", (request) => {
    const query = z
      .object({ needsReview: z.stringbool().default(false) })
      .parse(request.query);
    return marketData.list(query.needsReview);
  });
  app.get("/api/v1/market-data/securities/:id", (request) =>
    marketData.detail(securityId(request.params)),
  );
  app.put("/api/v1/market-data/securities/:id/selection", (request) => {
    const body = z
      .object({
        mappingId: z.uuid().toLowerCase().nullable(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    return marketData.select(
      securityId(request.params),
      body.mappingId,
      body.expectedRevision,
    );
  });
  app.post("/api/v1/market-data/securities/:id/refresh", (request) =>
    marketData.refresh(securityId(request.params)),
  );
  app.post("/api/v1/market-data/securities/:id/re-resolve", (request) => {
    const body = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(request.body);
    return marketData.reResolve(
      securityId(request.params),
      body.expectedRevision,
    );
  });
}
