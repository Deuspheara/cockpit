import Foundation
import Testing

@testable import FinanceCockpit

struct FinanceTests {
  @Test func decimalDTORequiresStrings() throws {
    let amount = try JSONDecoder().decode(Amount.self, from: Data("\"0.100000000000000001\"".utf8))
    #expect(amount.decimal == Decimal(string: "0.100000000000000001"))
    #expect(throws: (any Error).self) {
      try JSONDecoder().decode(Amount.self, from: Data("0.1".utf8))
    }
  }
  @Test func rangeValues() {
    #expect(PortfolioRange.allCases.map(\.rawValue) == ["1d", "1w", "3w", "1m", "3m", "1y", "all"])
  }
  @Test func requestConstruction() throws {
    let token = String(repeating: "a", count: 43)
    let config = try APIConfiguration(server: "https://finance.example.com", token: token)
    let request = try config.request(
      path: "portfolio/dashboard", query: [.init(name: "range", value: "1m")])
    #expect(
      request.url?.absoluteString
        == "https://finance.example.com/api/v1/portfolio/dashboard?range=1m")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
    #expect(throws: (any Error).self) {
      try APIConfiguration(server: "https://user:pass@example.com", token: token)
    }
  }
  @Test func formatUsesLocale() {
    let output = FinanceFormat.amount(
      Amount(1234.5), currency: "EUR", locale: Locale(identifier: "fr_FR"))
    #expect(output.contains("1"))
    #expect(output.contains(",50"))
    #expect(output.contains("€"))
  }

  @Test func assetLogoDTOIsBackwardCompatible() throws {
    let base = """
      {"accountId":"00000000-0000-0000-0000-000000000001",
       "assetId":"00000000-0000-0000-0000-000000000002",
       "accountName":"Broker", "symbol":"BTC", "name":"Bitcoin",
       "quantity":"1", "marketValue":"100", "currency":"USD", "source":"manual", "stale":false}
      """
    let decoder = JSONDecoder()
    #expect(try decoder.decode(PortfolioAssetLine.self, from: Data(base.utf8)).logoUrl == nil)
    let withLogo = base.replacingOccurrences(
      of: "\"stale\":false",
      with:
        "\"stale\":false,\"logoUrl\":\"https://static.coinpaprika.com/coin/btc-bitcoin/logo.png\"")
    #expect(try decoder.decode(PortfolioAssetLine.self, from: Data(withLogo.utf8)).logoUrl != nil)
  }

  @Test func assetLogoURLsRejectInvalidAndUntrustedSources() {
    #expect(AssetLogo.remoteURL(nil) == nil)
    #expect(AssetLogo.remoteURL("not a URL") == nil)
    #expect(AssetLogo.remoteURL("http://img.logo.dev/ticker/AAPL") == nil)
    #expect(AssetLogo.remoteURL("https://example.com/logo.png") == nil)
    #expect(AssetLogo.remoteURL("https://img.logo.dev/ticker/AAPL") != nil)
    #expect(AssetLogo.remoteURL("https://static.coinpaprika.com/coin/btc-bitcoin/logo.png") != nil)
  }

  @Test func providerLogosNeverGuessFromAccountNames() {
    #expect(ProviderBrand.resolve(sourceType: "hyperliquid") == .hyperliquid)
    #expect(ProviderBrand.resolve(sourceType: "dydx") == .dydx)
    #expect(ProviderBrand.resolve(sourceType: "manual") == .generic)
    #expect(ProviderBrand.resolve(sourceType: "My Hyperliquid copy") == .generic)
  }

  @Test func activityPresentationUsesReadableTitlesIconsAndSigns() {
    let purchase = ActivityPresentation.resolve(kind: "BUY")
    #expect(purchase.title == "Purchase")
    #expect(purchase.icon == .arrowDown)
    #expect(purchase.sign == "+")
    let sale = ActivityPresentation.resolve(kind: "SELL")
    #expect(sale.title == "Sale")
    #expect(sale.icon == .arrowUp)
    #expect(sale.sign == "−")
    #expect(
      ActivityPresentation.resolve(kind: "RECONCILIATION_PENDING").title == "Reconciliation needed")
  }

  @Test func activitySearchFiltersAndGroupsLocally() {
    let account = UUID()
    let calendar = Calendar(identifier: .gregorian)
    let start = Date(timeIntervalSince1970: 1_788_480_000)
    let events = [
      ActivityEvent(
        id: UUID(), accountId: account, accountName: "Trading", assetClass: "crypto",
        source: "hyperliquid", kind: "BUY", at: start.addingTimeInterval(3600),
        quantity: Amount(1), currency: "USD", symbol: "BTC", isVoided: false,
        editable: false, transactionId: nil),
      ActivityEvent(
        id: UUID(), accountId: UUID(), accountName: "Savings", assetClass: "cash",
        source: "manual", kind: "DEPOSIT", at: start.addingTimeInterval(90_000),
        quantity: Amount(100), currency: "EUR", symbol: "EUR", isVoided: false,
        editable: true, transactionId: UUID()),
    ]
    #expect(
      events[0].matches(
        searchText: "btc", accountID: account.uuidString, assetClass: "crypto",
        source: "hyperliquid"))
    #expect(!events[1].matches(searchText: "btc", accountID: "", assetClass: "", source: ""))
    let groups = ActivityDaySection.group(events, calendar: calendar)
    #expect(groups.count == 2)
    #expect(groups[0].events[0].accountName == "Savings")
  }
}

struct CacheTests {
  @Test func cacheIsIsolatedByServerAndDeviceAndCanBeCleared() async {
    let namespace = UUID().uuidString
    let first = AppCache(namespace: namespace + "-device-one")
    let second = AppCache(namespace: namespace + "-device-two")
    await first.write(["value": "0.100000000000000001"], key: "portfolio")
    let saved = await first.read("portfolio", as: [String: String].self)
    let other = await second.read("portfolio", as: [String: String].self)
    #expect(saved?["value"] == "0.100000000000000001")
    #expect(other == nil)
    await first.clear()
    let cleared = await first.read("portfolio", as: [String: String].self)
    #expect(cleared == nil)
  }
  @Test func APIAcceptsUTCWithAndWithoutFractionalSeconds() throws {
    struct Timestamp: Decodable { let at: Date }
    let a = try APIClient.decoder().decode(
      Timestamp.self, from: Data(#"{"at":"2026-09-05T00:00:00Z"}"#.utf8))
    let b = try APIClient.decoder().decode(
      Timestamp.self, from: Data(#"{"at":"2026-09-05T00:00:00.000Z"}"#.utf8))
    #expect(a.at == b.at)
  }
}
