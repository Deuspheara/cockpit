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
      id: UUID(), name: ProcessInfo.processInfo.arguments.contains("--wallet-layout") ? "Base Eth" : "Test investments",
      assetClass: ProcessInfo.processInfo.arguments.contains("--wallet-layout") ? "crypto" : "equities",
      sourceType: ProcessInfo.processInfo.arguments.contains("--wallet-layout") ? "evm_wallet" : "manual",
      baseCurrency: "EUR", externalAddress: nil)
    var accounts: [Account] = []
    var assets = [
      Asset(id: UUID(), symbol: "AAPL", name: "Apple", assetType: "equity", quoteCurrency: "USD")
    ]
    var observation: [String: JSONValue] = [:]
    var changeID = UUID()
    var applied = false
    let importID = UUID()
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
    func response(_ request: URLRequest) throws -> Data {
      let url = request.url!
      let path = url.path.replacingOccurrences(of: "/api/v1/", with: "")
      let input = request.value(forHTTPHeaderField: "Content-Type")?.contains("multipart") == true ? [:] : try body(request)
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let range =
        PortfolioRange(rawValue: query.first { $0.name == "range" }?.value ?? "1m") ?? .month
      let scope =
        PortfolioScope(rawValue: query.first { $0.name == "scope" }?.value ?? "global") ?? .global
      if path == "imports" { return try importResponse() }
      if path.hasPrefix("imports/") {
        if path.contains("/cancel") { importCancelled = true; return try encode(importJob()) }
        if path.hasSuffix("/jobs") { jobReads = 0; return try encode(importJob()) }
        if path.hasSuffix("/prepare-change-set") { importPrepared = true; return try encode(importChange()) }
        if request.httpMethod == "PATCH" {
          importRevision += 1
          if case .array(let rows) = input["positions"], case .object(let row) = rows.first, row["symbol"]?.display == "EUNL" { importUnresolved = false }
          if let name = input["likelyAccountName"] { importName = name.display }
          if case .array(let rows) = input["positions"], case .object(let row) = rows.first, let quantity = row["quantity"] { importQuantity = quantity.display }
        }
        jobReads += 1
        if jobReads > 2 { imported = true }
        return try importResponse()
      }
      if path.hasPrefix("change-sets/"), importPrepared {
        if path.hasSuffix("/apply") { applied = true }
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
          return try encode(["status": JSONValue.string("partial"), "provider": .string("alchemy"), "warnings": .array([.string("base-mainnet: Some token prices are unavailable; balances synchronized without valuation")])])
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
        if path.hasSuffix("/apply") { applied = true }
        return try encode(change())
      }
      if path == "portfolio/dashboard" { return try encode(dashboard(range: range, scope: scope)) }
      if path.hasSuffix("/detail") {
        let id = path.split(separator: "/")[1]
        let account = accounts.first { $0.id.uuidString.lowercased() == id.lowercased() } ?? initial
        return try encode(
          AccountDetail(
            account: account, dashboard: dashboard(range: range, scope: scope), positions: ProcessInfo.processInfo.arguments.contains("--wallet-layout") ? [
              Position(assetId: candidateID, symbol: "ETH", name: "Ethereum", assetType: "crypto", quantity: Amount(0.12), price: nil, marketValue: Amount(503.45), currency: "USD", costBasis: nil, unrealizedPnl: nil, source: "evm_wallet", observedAt: Date(), stale: false, side: nil)
            ] : [],
            activity: []))
      }
      if path == "portfolio/assets" || path == "activity" { return Data("[]".utf8) }
      throw APIError(message: "No UI fixture for \(path)")
    }
    func importJob() -> [String: JSONValue] {
      ["id": .string(jobID.uuidString), "status": .string(importCancelled ? "cancelled" : imported ? "completed" : "running"), "phase": .string(imported ? "complete" : "extracting"), "failure": .null]
    }
    func importResponse() throws -> Data {
      var result: [String: JSONValue] = ["id": .string(importID.uuidString), "status": .string("ready_for_review"), "revision": .number(Decimal(importRevision)), "blockers": .array([]), "warnings": .array([.string("Quantity estimated from EODHD")]), "processing": .object(importJob()), "changeSetId": importPrepared ? .string(changeID.uuidString) : .null]
      result["candidateIssues"] = .object([candidateID.uuidString.lowercased(): .array(importUnresolved ? [.string("Choose the exact investment.")] : [])])
      if imported {
        result["extraction"] = .object(["likelyAccountName": .string(importName), "capturedAt": .string("2026-09-01T00:00:00Z"), "capturedAtInferred": .bool(false), "currency": .string("EUR"), "positions": .array([.object(["candidateId": .string(candidateID.uuidString), "symbol": .string("AAPL"), "name": .string("Apple"), "quantity": .string(importQuantity), "marketValue": .string("400"), "currency": .string("EUR"), "confidence": .number(1), "matchStatus": .string("matched"), "quantitySource": .string("estimated"), "sourceLines": .number(1), "sourceCandidateIds": .array([])])]), "derivatives": .array([])])
      }
      if importUnresolved, case .object(var extraction) = result["extraction"], case .array(var rows) = extraction["positions"], case .object(var row) = rows[0] {
        row["symbol"] = .null
        row["name"] = .string("Core MSCI World USD (Acc)")
        row["matchStatus"] = .string("ambiguous")
        row["matchCandidates"] = .array([.object(["symbol": .string("EUNL"), "name": .string("iShares Core MSCI World"), "isin": .string("IE00B4L5Y983"), "exchange": .string("XETRA"), "currency": .string("EUR")])])
        rows[0] = .object(row)
        extraction["positions"] = .array(rows)
        result["extraction"] = .object(extraction)
      }
      return try encode(result)
    }
    func importChange() -> ChangeSet {
      ChangeSet(id: changeID, title: "Import screenshots", summary: "One holding", status: importUndone ? "undone" : applied ? "applied" : "draft", operations: [.init(table: "accounts", id: initial.id, before: nil, after: [:])], labels: nil, effects: nil)
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
      let points = wallet ? [] : range == .day ? Array(base.chart.suffix(1)) : range == .week ? [] : base.chart
      return PortfolioDashboard(
        scope: scope, range: range, currency: "EUR", value: wallet ? Amount(433.19) : base.value,
        complete: !wallet, absoluteChange: wallet ? nil : base.absoluteChange, percentChange: wallet ? nil : base.percentChange,
        asOf: base.asOf, chart: points, allocation: base.allocation,
        accounts: ([initial] + accounts).map {
          AccountRow(
            id: $0.id, name: $0.name, assetClass: $0.assetClass, sourceType: $0.sourceType,
            value: base.value,
            complete: true, asOf: base.asOf, stale: false, unvaluedPositions: 0)
        })
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
