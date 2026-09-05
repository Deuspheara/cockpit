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
