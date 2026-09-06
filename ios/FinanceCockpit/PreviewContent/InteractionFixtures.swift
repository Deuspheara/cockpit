#if DEBUG
  import Foundation

  /// In-memory HTTP responses enabled only by the UI-test launch argument.
  final class InteractionFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
      request.url?.host == "fixtures.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var loadingTask: Task<Void, Never>?
    override func startLoading() {
      loadingTask = Task { @MainActor in
        if request.url?.path.contains("/agent/") == true
          || request.url?.path.hasSuffix("/session") == true
        {
          await AgentFixtureStore.shared.respond(to: request, transport: self)
          return
        }
        if request.url?.path.contains("dashboard") == true {
          try? await Task.sleep(for: .milliseconds(600))
        }
        do {
          let data = try InteractionFixtureStore.shared.response(request)
          let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
          client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
          client?.urlProtocol(self, didLoad: data)
          client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
      }
    }
    override func stopLoading() { loadingTask?.cancel() }
  }

  @MainActor private final class InteractionFixtureStore {
    static let shared = InteractionFixtureStore()
    let initial = Account(
      provider: ProcessInfo.processInfo.arguments.contains("--csv-account")
        ? "trade_republic" : nil,
      connectionType: ProcessInfo.processInfo.arguments.contains("--csv-account")
        ? "manual_csv" : nil,
      providerAccountKey: ProcessInfo.processInfo.arguments.contains("--csv-account")
        ? "DEFAULT" : nil,
      lastImportedAt: ProcessInfo.processInfo.arguments.contains("--csv-account") ? Date() : nil,
      id: UUID(),
      name: ProcessInfo.processInfo.arguments.contains("--dydx-layout")
        ? "dYdX"
        : ProcessInfo.processInfo.arguments.contains("--csv-account")
          ? "Trade Republic"
          : ProcessInfo.processInfo.arguments.contains("--wallet-layout")
            ? "Base Eth" : "Test investments",
      assetClass: ProcessInfo.processInfo.arguments.contains("--wallet-layout")
        ? "crypto" : "equities",
      sourceType: ProcessInfo.processInfo.arguments.contains("--dydx-layout")
        ? "dydx"
        : ProcessInfo.processInfo.arguments.contains("--wallet-layout")
          ? "evm_wallet" : "manual",
      baseCurrency: "EUR", externalAddress: nil)
    var transactionVoided = false
    var deletionProposed = false
    let transactionID = UUID()
    var archived = false
    var accounts: [Account] = []
    var assets = [
      Asset(id: UUID(), symbol: "AAPL", name: "Apple", assetType: "equity", quoteCurrency: "USD")
    ]
    var observation: [String: JSONValue] = [:]
    var changeID = UUID()
    var applied = false
    var historyRetried = false
    let importID = UUID()
    let marketSecurityID = UUID()
    let marketMappingID = UUID()
    let candidateID = UUID()
    let jobID = UUID()
    var importRevision = 0
    var imported = false
    var importPrepared = false
    var importUndone = false
    var importQuantity = "2"
    var importName = "Screenshot account"
    var jobReads = 0
    var importCancelled = false
    var importUnresolved = ProcessInfo.processInfo.arguments.contains("--unresolved-import")

    func encode<T: Encodable>(_ value: T) throws -> Data {
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .iso8601
      return try encoder.encode(value)
    }
    func body(_ request: URLRequest) throws -> [String: JSONValue] {
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&bytes, maxLength: bytes.count)
          if count <= 0 { break }
          data.append(contentsOf: bytes.prefix(count))
        }
      }
      return data.isEmpty ? [:] : try JSONDecoder().decode([String: JSONValue].self, from: data)
    }
    private struct AccountSyncResultFixture: Encodable { let status: String }
    private func marketDataFixture(detail: Bool) -> Data {
      let quota = ProcessInfo.processInfo.arguments.contains("--market-quota")
      let reason = quota ? "verification_quota_delayed" : "listing_selection_required"
      let message =
        quota
        ? "Verification delayed until EODHD quota resets" : "Listing selection required"
      let retry = quota ? #""2026-09-07T00:00:05Z""# : "null"
      let mappings = quota
        ? "[]"
        : """
          [{"id":"\(marketMappingID.uuidString)","provider":"eodhd",
            "providerSymbol":"EXH1.XETRA","providerExchange":"XETRA",
            "verificationStatus":"verified","ticker":"EXH1","mic":null,
            "name":"iShares STOXX Europe 600 Oil & Gas UCITS ETF (DE)",
            "quoteCurrency":"EUR","quoteUnit":"major","unitMultiplier":"1",
            "timezone":null,"active":true,"selected":false,"selectable":true}]
          """
      if detail {
        return Data(
          """
          {"id":"\(marketSecurityID.uuidString)","isin":"DE000A0H08M3",
           "name":"iShares STOXX Europe 600 Oil & Gas UCITS ETF (DE)","assetType":"etf",
           "identityStatus":"\(quota ? "identity_pending" : "identity_resolved")",
           "preferredMappingId":null,"selectionLocked":false,"revision":2,
           "resolutionReason":"\(reason)","nextRetryAt":\(retry),
           "states":[{"stage":"selection","status":"\(quota ? "verification_delayed" : "selection_required")",
             "errorClass":\(quota ? #""quota_exhausted""# : "null"),"message":"\(message)",
             "nextRetryAt":\(retry)}],"mappings":\(mappings),"latestPrice":null}
          """.utf8)
      }
      return Data(
        """
        [{"id":"\(marketSecurityID.uuidString)","isin":"DE000A0H08M3",
          "name":"iShares STOXX Europe 600 Oil & Gas UCITS ETF (DE)","assetType":"etf",
          "identityStatus":"\(quota ? "identity_pending" : "identity_resolved")",
          "selectionLocked":false,"revision":2,"selectionStatus":"\(quota ? "verification_delayed" : "selection_required")",
          "priceStatus":"price_pending","historyStatus":"history_pending","message":"\(message)",
          "resolutionReason":"\(reason)","nextRetryAt":\(retry),"marketDate":null,
          "close":null,"currency":null,"assetCount":1}]
        """.utf8)
    }
    func response(_ request: URLRequest) throws -> Data {
      let url = request.url!
      let path = url.path.replacingOccurrences(of: "/api/v1/", with: "")
      let input =
        request.value(forHTTPHeaderField: "Content-Type")?.contains("multipart") == true
        ? [:] : try body(request)
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let range =
        PortfolioRange(rawValue: query.first { $0.name == "range" }?.value ?? "1m") ?? .month
      let scope =
        PortfolioScope(rawValue: query.first { $0.name == "scope" }?.value ?? "global") ?? .global
      if path == "market-data/securities" { return marketDataFixture(detail: false) }
      if path == "market-data/securities/\(marketSecurityID.uuidString)" {
        return marketDataFixture(detail: true)
      }
      if path.hasPrefix("accounts/"), path.hasSuffix("/imports") {
        return try encode([
          CSVImportHistoryItem(
            id: CSVFixtures.id, filename: "trade-republic.csv", status: "completed",
            completedAt: Date(), importedRows: 3, duplicateRows: 0)
        ])
      }
      if path.hasPrefix("imports/csv/") {
        if ProcessInfo.processInfo.arguments.contains("--csv-error") {
          throw APIError(message: "CSV service unavailable")
        }
        if request.httpMethod == "DELETE" { return try encode(["cancelled": true]) }
        return try encode(
          CSVFixtures.preview(
            completed: path.hasSuffix("/confirm"),
            duplicates: ProcessInfo.processInfo.arguments.contains("--csv-duplicates")))
      }
      if path == "imports" { return try importResponse() }
      if path.hasPrefix("imports/") {
        if path.hasSuffix("/matches") {
          return try encode([
            "choices": JSONValue.array(
              ProcessInfo.processInfo.arguments.contains("--empty-matches")
                ? []
                : [
                  .object([
                    "symbol": .string("EUNL"), "name": .string("iShares Core MSCI World"),
                    "isin": .string("IE00B4L5Y983"), "exchange": .string("XETRA"),
                    "currency": .string("EUR"), "recommended": .bool(true),
                    "reason": .string("Matches the investment label."),
                  ])
                ]), "message": .string("Check the share class against your screenshot."),
          ])
        }
        if path.contains("/cancel") {
          importCancelled = true
          return try encode(importJob())
        }
        if path.hasSuffix("/jobs") {
          jobReads = 0
          return try encode(importJob())
        }
        if path.hasSuffix("/prepare-change-set") {
          importPrepared = true
          return try encode(importChange())
        }
        if request.httpMethod == "PATCH" {
          importRevision += 1
          if case .array(let rows) = input["positions"], case .object(let row) = rows.first,
            row["symbol"]?.display == "EUNL"
          {
            importUnresolved = false
          }
          if let name = input["likelyAccountName"] { importName = name.display }
          if case .array(let rows) = input["positions"], case .object(let row) = rows.first,
            let quantity = row["quantity"]
          {
            importQuantity = quantity.display
          }
        }
        jobReads += 1
        if jobReads > 2 { imported = true }
        return try importResponse()
      }
      if path.hasPrefix("change-sets/"), importPrepared {
        if path.hasSuffix("/apply") {
          applied = true
          if deletionProposed { transactionVoided = true }
        }
        if path.hasSuffix("/undo") { importUndone = true }
        let result = try encode(importChange())
        if path.hasSuffix("/reject") { importPrepared = false }
        return result
      }
      if path == "accounts", request.httpMethod == "POST" {
        let account = Account(
          id: UUID(), name: input["name"]!.display, assetClass: input["assetClass"]!.display,
          sourceType: input["sourceType"]!.display, baseCurrency: input["baseCurrency"]!.display,
          externalAddress: input["externalAddress"]?.display)
        accounts.append(account)
        return try encode(account)
      }
      if path == "accounts" { return try encode([initial] + accounts) }
      if path == "assets", request.httpMethod == "POST" {
        let asset = Asset(
          id: UUID(), symbol: input["symbol"]!.display, name: input["name"]!.display,
          assetType: input["assetType"]!.display, quoteCurrency: input["quoteCurrency"]!.display)
        assets.append(asset)
        return try encode(asset)
      }
      if path == "assets" { return try encode(assets) }
      if path.hasSuffix("/sync") || path.hasSuffix("/sync-runs") {
        if ProcessInfo.processInfo.arguments.contains("--wallet-layout") {
          return try encode([
            "status": JSONValue.string("partial"), "provider": .string("alchemy"),
            "warnings": .array([
              .string(
                "base-mainnet: Some token prices are unavailable; balances synchronized without valuation"
              )
            ]),
          ])
        }
        if ProcessInfo.processInfo.arguments.contains("--sync-failure") {
          throw APIError(message: "Fixture sync unavailable")
        }
        return try encode(AccountSyncResultFixture(status: "success"))
      }
      if path == "observations" {
        observation = input
        applied = false
        changeID = UUID()
        return try encode(change())
      }
      if path.hasPrefix("change-sets/") {
        if path.hasSuffix("/apply") {
          applied = true
          if deletionProposed { transactionVoided = true }
        }
        return try encode(change())
      }
      if path.hasSuffix("/history-jobs") {
        historyRetried = true
        return try encode(["status": "queued"])
      }
      if path.hasPrefix("accounts/"), request.httpMethod == "DELETE" {
        archived = true
        return try encode(["isArchived": true])
      }
      if path == "portfolio/dashboard" { return try encode(dashboard(range: range, scope: scope)) }
      if path.hasSuffix("/detail") {
        let id = path.split(separator: "/")[1]
        let account = accounts.first { $0.id.uuidString.lowercased() == id.lowercased() } ?? initial
        return try encode(
          AccountDetail(
            account: account, dashboard: dashboard(range: range, scope: scope),
            positions: ProcessInfo.processInfo.arguments.contains("--dydx-layout")
              ? [
                Position(
                  assetId: candidateID, symbol: "BTC-USD", name: "Bitcoin", assetType: "perp",
                  quantity: Amount(0.12), price: Amount(60000), marketValue: Amount(7200),
                  currency: "USD",
                  costBasis: nil, unrealizedPnl: Amount(200), source: "dydx", observedAt: Date(),
                  stale: false,
                  side: "long", entryPrice: Amount(58000), leverage: Amount(2),
                  liquidationPrice: Amount(40000))
              ]
              : ProcessInfo.processInfo.arguments.contains("--csv-account")
                ? [
                  Position(
                    assetId: candidateID, symbol: "AAPL", name: "Apple", assetType: "equity",
                    quantity: Amount(4), price: Amount(200), marketValue: Amount(800),
                    currency: "EUR",
                    costBasis: Amount(700), unrealizedPnl: Amount(100), source: "manual",
                    observedAt: Date(), stale: false, side: nil)
                ]
                : ProcessInfo.processInfo.arguments.contains("--wallet-layout")
                  ? [
                    Position(
                      assetId: candidateID, symbol: "ETH", name: "Ethereum", assetType: "crypto",
                      quantity: Amount(0.12), price: nil, marketValue: Amount(503.45),
                      currency: "USD",
                      costBasis: nil, unrealizedPnl: nil, source: "evm_wallet", observedAt: Date(),
                      stale: false, side: nil)
                  ] : [],
            activity: [],
            derivatives: ProcessInfo.processInfo.arguments.contains("--dydx-layout")
              ? DerivativesSummary(
                equity: Amount(3600), freeCollateral: Amount(2000), grossExposure: Amount(7200),
                effectiveLeverage: Amount(2), currency: "USD", asOf: Date()) : nil,
            historyJob: ProcessInfo.processInfo.arguments.contains("--partial-history")
              ? EVMHistoryJob(
                status: historyRetried ? "queued" : "partial", phase: "balances", daysDone: 30,
                totalDays: 90, requestsUsed: 125, dailyRequestLimit: 1000, nextAttemptAt: Date(),
                error: historyRetried ? nil : "Some historical token prices remain unavailable")
              : nil))
      }
      if path.hasPrefix("transactions/") {
        if request.httpMethod == "DELETE" {
          deletionProposed = true
          return try encode(change())
        }
        return try encode(
          Transaction(
            id: transactionID, accountId: initial.id, assetId: assets[0].id,
            type: "BUY", occurredAt: Date(), quantity: Amount(2), unitPrice: Amount(100),
            currency: "USD", source: "manual", isVoided: transactionVoided))
      }
      if path == "activity", ProcessInfo.processInfo.arguments.contains("--manual-activity"),
        !transactionVoided
      {
        return try encode([
          ActivityEvent(
            id: transactionID, accountId: initial.id, accountName: initial.name,
            assetClass: "equities", source: "manual", kind: "BUY", at: Date(), quantity: Amount(2),
            currency: "USD",
            symbol: "AAPL", isVoided: false, editable: true, transactionId: transactionID)
        ])
      }
      if path == "portfolio/assets" || path == "activity" { return Data("[]".utf8) }
      throw APIError(message: "No UI fixture for \(path)")
    }
    func importJob() -> [String: JSONValue] {
      [
        "id": .string(jobID.uuidString),
        "status": .string(importCancelled ? "cancelled" : imported ? "completed" : "running"),
        "phase": .string(imported ? "complete" : "extracting"), "failure": .null,
      ]
    }
    func importResponse() throws -> Data {
      var result: [String: JSONValue] = [
        "id": .string(importID.uuidString), "status": .string("ready_for_review"),
        "revision": .number(Decimal(importRevision)), "blockers": .array([]),
        "warnings": .array([.string("Quantity estimated from EODHD")]),
        "processing": .object(importJob()),
        "changeSetId": importPrepared ? .string(changeID.uuidString) : .null,
      ]
      result["candidateIssues"] = .object([
        candidateID.uuidString.lowercased(): .array(
          importUnresolved ? [.string("Choose the exact investment.")] : [])
      ])
      if imported {
        result["extraction"] = .object([
          "likelyAccountName": .string(importName), "capturedAt": .string("2026-09-01T00:00:00Z"),
          "capturedAtInferred": .bool(false), "currency": .string("EUR"),
          "positions": .array([
            .object([
              "candidateId": .string(candidateID.uuidString), "symbol": .string("AAPL"),
              "name": .string("Apple"), "quantity": .string(importQuantity),
              "marketValue": .string("400"), "currency": .string("EUR"), "confidence": .number(1),
              "matchStatus": .string("matched"), "quantitySource": .string("estimated"),
              "sourceLines": .number(1), "sourceCandidateIds": .array([]),
            ])
          ]), "derivatives": .array([]),
        ])
      }
      if importUnresolved, case .object(var extraction) = result["extraction"],
        case .array(var rows) = extraction["positions"], case .object(var row) = rows[0]
      {
        row["symbol"] = .null
        row["name"] = .string("Core MSCI World USD (Acc)")
        row["matchStatus"] = .string("ambiguous")
        row["matchCandidates"] = .array([])
        rows[0] = .object(row)
        extraction["positions"] = .array(rows)
        result["extraction"] = .object(extraction)
      }
      return try encode(result)
    }
    func importChange() -> ChangeSet {
      ChangeSet(
        id: changeID, title: "Import screenshots", summary: "One holding",
        status: importUndone ? "undone" : applied ? "applied" : "draft",
        operations: [.init(table: "accounts", id: initial.id, before: nil, after: [:])],
        labels: nil, effects: nil)
    }
    func change() -> ChangeSet {
      ChangeSet(
        id: changeID, title: "Add your first holding", summary: "Record the balance you reviewed.",
        status: applied ? "applied" : "draft",
        operations: [.init(table: "observations", id: UUID(), before: nil, after: observation)],
        labels: Dictionary(
          uniqueKeysWithValues: ([initial] + accounts).map {
            ($0.id.uuidString.lowercased(), $0.name)
          } + assets.map { ($0.id.uuidString.lowercased(), $0.symbol) }), effects: nil)
    }
    func dashboard(range: PortfolioRange, scope: PortfolioScope) -> PortfolioDashboard {
      let base = PortfolioDashboard.preview
      let wallet = ProcessInfo.processInfo.arguments.contains("--wallet-layout")
      let partial = ProcessInfo.processInfo.arguments.contains("--partial-history")
      let issue = ValuationIssue(
        code: "missing_price", accountId: initial.id, name: "Unpriced Base token",
        network: "base-mainnet", contractAddress: "0x" + String(repeating: "b", count: 40),
        message: "No usable price is available for this holding", retryable: true)
      let points =
        wallet ? [] : range == .day ? Array(base.chart.suffix(1)) : range == .week ? [] : base.chart
      return PortfolioDashboard(
        scope: scope, range: range, currency: "EUR", value: wallet ? Amount(433.19) : base.value,
        complete: !wallet, absoluteChange: wallet ? nil : base.absoluteChange,
        percentChange: wallet ? nil : base.percentChange,
        asOf: base.asOf,
        chart: partial
          ? [
            ValuationPoint(
              at: Date().addingTimeInterval(-86400 * 2), value: Amount(400), complete: false,
              segmentId: "1", coverage: ValuationCoverage(valued: ["ETH"], missing: [issue])),
            ValuationPoint(
              at: Date().addingTimeInterval(-86400), value: Amount(430), complete: false,
              segmentId: "1", coverage: ValuationCoverage(valued: ["ETH"], missing: [issue])),
            ValuationPoint(
              at: Date(), value: Amount(435), complete: true, segmentId: "2",
              coverage: ValuationCoverage(valued: ["ETH", "TOKEN"], missing: [])),
          ] : points, allocation: base.allocation,
        accounts: (archived ? [] : ([initial] + accounts)).map {
          AccountRow(
            provider: $0.provider, institution: $0.sourceType == "evm_wallet" ? "Base" : nil,
            id: $0.id, name: $0.name, assetClass: $0.assetClass, sourceType: $0.sourceType,
            value: base.value,
            complete: !partial, asOf: base.asOf, stale: false, unvaluedPositions: partial ? 1 : 0)
        }, valuationIssues: partial ? [issue] : nil, historyStatus: partial ? "partial" : nil)
    }
  }
#endif

#if DEBUG
  import SwiftUI

  struct InteractionFixtureAppearance: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    func body(content: Content) -> some View {
      let arguments = ProcessInfo.processInfo.arguments
      let enabled = arguments.contains("--ui-fixtures")
      content
        .environment(
          \.dynamicTypeSize,
          enabled && arguments.contains("--large-text") ? .accessibility3 : typeSize
        )
        .preferredColorScheme(enabled && arguments.contains("--dark") ? .dark : nil)
    }
  }
#endif
