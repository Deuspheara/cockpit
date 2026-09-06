import Foundation

struct Amount: Codable, Hashable, Sendable {
  let decimal: Decimal
  init(_ decimal: Decimal) { self.decimal = decimal }
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let string = try container.decode(String.self)
    guard
      string.range(of: #"^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$"#, options: .regularExpression)
        != nil,
      let value = Decimal(string: string, locale: Locale(identifier: "en_US_POSIX")), !value.isNaN
    else {
      throw DecodingError.dataCorruptedError(
        in: container, debugDescription: "Invalid decimal string")
    }
    decimal = value
  }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(NSDecimalNumber(decimal: decimal).stringValue)
  }
}

enum PortfolioScope: String, CaseIterable, Codable, Sendable {
  case global, crypto, equities, other
  var title: String {
    switch self {
    case .global: "Global"
    case .crypto: "Crypto"
    case .equities: "Actions"
    case .other: "Other"
    }
  }
}
enum PortfolioRange: String, CaseIterable, Codable, Sendable {
  case day = "1d"
  case week = "1w"
  case threeWeeks = "3w"
  case month = "1m"
  case quarter = "3m"
  case year = "1y"
  case all
  var title: String { rawValue.uppercased() }
}
struct PortfolioDashboard: Codable, Sendable {
  let scope: PortfolioScope
  let range: PortfolioRange
  let currency: String
  let value: Amount
  let complete: Bool
  let absoluteChange: Amount?
  let percentChange: Amount?
  let asOf: Date
  let chart: [ValuationPoint]
  let allocation: [Allocation]
  let accounts: [AccountRow]
  var valuationIssues: [ValuationIssue]? = nil
  var historyStatus: String? = nil
}
struct ValuationPoint: Codable, Identifiable, Sendable {
  var id: Date { at }
  let at: Date
  var sourceAt: Date? = nil
  let value: Amount
  var complete: Bool? = nil
  var segmentId: String? = nil
  var coverage: ValuationCoverage? = nil
}
struct Allocation: Codable, Identifiable, Sendable {
  var id: String { key }
  let key: String
  let label: String
  let value: Amount
  let percentage: Amount
}
struct AccountRow: Codable, Identifiable, Sendable {
  let id: UUID
  let name: String
  let assetClass: String
  let sourceType: String
  let value: Amount
  let complete: Bool
  let asOf: Date?
  let stale: Bool
  var isDemo: Bool? = nil
  var syncStatus: String? = nil
  let unvaluedPositions: Int
  var freshnessDescription: String {
    if isDemo == true { return "Demo · " + sourceType }
    if sourceType != "manual", syncStatus == nil, asOf == nil { return "Waiting for first sync" }
    if syncStatus == "running" { return "Syncing · " + sourceType }
    return stale ? "Stale data · " + sourceType : sourceType
  }
}
struct Account: Codable, Identifiable, Sendable {
  var provider: String? = nil
  var connectionType: String? = nil
  var providerAccountKey: String? = nil
  var lastImportedAt: Date? = nil
  let id: UUID
  let name: String
  let assetClass: String
  let sourceType: String
  let baseCurrency: String
  let externalAddress: String?
}
struct Asset: Codable, Identifiable, Sendable {
  let id: UUID
  let symbol: String
  let name: String
  let assetType: String
  let quoteCurrency: String
}
struct Position: Codable, Identifiable, Sendable {
  var id: UUID { assetId }
  let assetId: UUID
  let symbol: String
  let name: String
  let assetType: String
  let quantity: Amount?
  let price: Amount?
  let marketValue: Amount?
  let currency: String
  let costBasis: Amount?
  let unrealizedPnl: Amount?
  let source: String
  let observedAt: Date?
  let stale: Bool
  let side: String?
  var entryPrice: Amount? = nil
  var leverage: Amount? = nil
  var liquidationPrice: Amount? = nil
  var realizedPnl: Amount? = nil
}
struct Transaction: Codable, Identifiable, Sendable {
  let id: UUID
  let accountId: UUID
  let assetId: UUID
  let type: String
  let occurredAt: Date
  let quantity: Amount
  let unitPrice: Amount?
  let currency: String
  let source: String
  let isVoided: Bool
}
struct AccountDetail: Codable, Sendable {
  let account: Account
  let dashboard: PortfolioDashboard
  let positions: [Position]
  let activity: [Transaction]
  var derivatives: DerivativesSummary? = nil
  var performance: TradingPerformance? = nil
  var historyStatus: String? = nil
  var historyError: String? = nil
  var historyJob: EVMHistoryJob? = nil
}
struct DerivativesSummary: Codable, Sendable {
  let equity: Amount
  let freeCollateral: Amount?
  let grossExposure: Amount
  let effectiveLeverage: Amount?
  let currency: String
  let asOf: Date
}
struct TradingPerformance: Codable, Sendable {
  let currency: String
  let source: String
  let asOf: Date
  let equity: Amount
  let totalPnl: Amount
  let netTransfers: Amount
  let chart: [ValuationPoint]
}
struct SessionInfo: Codable, Sendable {
  struct AI: Codable, Sendable {
    let configured: Bool
    let keyConfigured: Bool
    let chatConfigured: Bool
    let visionConfigured: Bool
    let primaryModel: String
    let visionModel: String
  }
  let apiVersion: String
  let ai: AI
  let walletConfigured: Bool
}
struct ChangeSet: Codable, Identifiable, Sendable {
  struct Operation: Codable, Identifiable, Sendable {
    let table: String
    let id: UUID
    let before: [String: JSONValue]?
    let after: [String: JSONValue]?
  }
  let id: UUID
  let title: String
  let summary: String
  let status: String
  let operations: [Operation]
  let labels: [String: String]?
  let effects: Effects?
  struct Effects: Codable, Sendable {
    let historicalTransactions: Int
    let ledgerQuantityChanges: [QuantityChange]
  }
  struct QuantityChange: Codable, Sendable {
    let accountId: UUID
    let assetId: UUID
    let deltaQuantity: Amount
  }
}
indirect enum JSONValue: Codable, Sendable, Equatable {
  case string(String)
  case number(Decimal)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode(Decimal.self) {
      self = .number(v)
    } else if let v = try? c.decode([String: JSONValue].self) {
      self = .object(v)
    } else {
      self = .array(try c.decode([JSONValue].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  var display: String {
    switch self {
    case .string(let v): v
    case .number(let v): NSDecimalNumber(decimal: v).stringValue
    case .bool(let v): v ? "Yes" : "No"
    case .null: "Unknown"
    case .array, .object: "Structured data"
    }
  }
}

struct ValuationIssue: Codable, Sendable {
  let code: String
  var accountId: UUID? = nil
  var assetId: UUID? = nil
  let name: String
  var network: String? = nil
  var contractAddress: String? = nil
  var quotedAt: Date? = nil
  let message: String
  let retryable: Bool
  var retryAction: String? = nil
}
struct ValuationCoverage: Codable, Sendable {
  let valued: [String]
  let missing: [ValuationIssue]
}
struct EVMHistoryJob: Codable, Sendable {
  let status: String
  let phase: String
  let daysDone: Int
  let totalDays: Int
  let requestsUsed: Int
  let dailyRequestLimit: Int
  let nextAttemptAt: Date
  let error: String?
}
