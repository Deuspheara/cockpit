import Foundation
import SwiftUI
import Testing
import UIKit

@testable import FinanceCockpit

@MainActor
private final class Gate<T: Sendable> {
  private var continuation: CheckedContinuation<T, Never>?
  var waiting: Bool { continuation != nil }
  func wait() async -> T { await withCheckedContinuation { continuation = $0 } }
  func resume(_ value: T) {
    continuation?.resume(returning: value)
    continuation = nil
  }
}

@MainActor
struct SnapshotTests {
  @Test func latestRequestWinsAndRetainsVisibleData() async {
    let model = SnapshotLoader<String>()
    await model.load(key: "1m", fetch: { "month" })
    let slow = Gate<String>()
    let old = Task { await model.load(key: "1y", fetch: { await slow.wait() }) }
    while !slow.waiting { await Task.yield() }
    #expect(model.value == "month")
    #expect(model.displayedKey == "1m")
    #expect(model.requestedKey == "1y")
    #expect(model.isLoading)
    await model.load(key: "1d", fetch: { "day" })
    slow.resume("obsolete year")
    await old.value
    #expect(model.value == "day")
    #expect(model.displayedKey == "1d")
    #expect(!model.isLoading)
  }

  @Test func supersededCacheCannotReplaceLatestData() async {
    let model = SnapshotLoader<String>()
    let cache = Gate<String?>()
    let old = Task {
      await model.load(key: "1y", cached: { await cache.wait() }, fetch: { "year" })
    }
    while !cache.waiting { await Task.yield() }
    await model.load(key: "1w", fetch: { "week" })
    cache.resume("cached year")
    await old.value
    #expect(model.value == "week")
    #expect(!model.isCached)
  }

  @Test func cacheRemainsUsableAfterFailureAndRetryClearsError() async {
    let model = SnapshotLoader<String>()
    await model.load(
      key: "1m", cached: { "cached month" }, fetch: { throw APIError(message: "Offline") })
    #expect(model.value == "cached month")
    #expect(model.isCached)
    #expect(model.error == "Offline")
    #expect(!model.isLoading)
    await model.load(key: "1m", fetch: { "fresh month" })
    #expect(model.error == nil)
    #expect(!model.isCached)
    #expect(model.value == "fresh month")
  }

  @Test func cancellationDoesNotPublishOrShowAnError() async {
    let model = SnapshotLoader<String>()
    let gate = Gate<String>()
    let task = Task { await model.load(key: "1y", fetch: { await gate.wait() }) }
    while !gate.waiting { await Task.yield() }
    task.cancel()
    gate.resume("cancelled")
    await task.value
    #expect(model.value == nil)
    #expect(model.error == nil)
    #expect(!model.isLoading)
  }
}

@MainActor
struct AccountSetupTests {
  private func account(source: String = "manual", category: String = "cash") -> Account {
    Account(
      id: UUID(), name: "Savings", assetClass: category, sourceType: source,
      baseCurrency: "EUR", externalAddress: nil)
  }
  @Test func providerValidationAndManualDefaults() throws {
    var draft = AccountDraft()
    #expect(!draft.isValid)
    draft.address = " 0x" + String(repeating: "a", count: 40) + " "
    #expect(draft.isValid)
    draft.provider = .dydx
    #expect(!draft.isValid)
    draft.address = "dydx1" + String(repeating: "a", count: 38)
    draft.subaccount = "128000"
    #expect(draft.isValid)
    draft.subaccount = "128001"
    #expect(!draft.isValid)
    draft.tracking = .manual
    #expect(draft.isValid)
    let body = try draft.body()
    #expect(body["externalAddress"] == nil)
    #expect(body["externalSubaccount"] == nil)
    #expect(body["baseCurrency"]?.display == "EUR")
    #expect(body["name"]?.display == "Investments")
  }
  @Test func creationFailureCanRetryAndSuccessfulAccountIsNeverRecreated() async {
    let model = AccountSetupModel()
    model.draft.tracking = .manual
    await model.create { _ in throw APIError(message: "Offline") }
    #expect(model.account == nil)
    #expect(model.error == "Offline")
    let saved = account()
    var creates = 0
    await model.create { _ in
      creates += 1
      return saved
    }
    await model.create { _ in
      creates += 1
      return saved
    }
    #expect(creates == 1)
    #expect(model.account?.id == saved.id)
    #expect(model.path == [.holding])
  }
  @Test func duplicateTapWhileCreatingIsIgnored() async {
    let model = AccountSetupModel()
    model.draft.tracking = .manual
    let gate = Gate<Account>()
    let first = Task { await model.create { _ in await gate.wait() } }
    while !gate.waiting { await Task.yield() }
    var secondCalled = false
    await model.create { _ in
      secondCalled = true
      return account()
    }
    gate.resume(account())
    await first.value
    #expect(!secondCalled)
    #expect(model.account != nil)
  }
  @Test func syncFailureKeepsAccountAndRetriesOnlySync() async {
    let model = AccountSetupModel()
    model.draft.address = "0x" + String(repeating: "1", count: 40)
    let saved = account(source: "hyperliquid", category: "crypto")
    await model.create { _ in saved }
    await model.sync { _ in throw APIError(message: "Unavailable") }
    #expect(model.account?.id == saved.id)
    #expect(!model.synced)
    #expect(model.error != nil)
    await model.sync { id in
      #expect(id == saved.id)
      return AccountSyncResult(status: "success")
    }
    #expect(model.synced)
    #expect(model.error == nil)
  }
  @Test func cachedRunningOrFailedSyncIsNotReportedAsSuccess() async {
    let model = AccountSetupModel()
    model.draft.address = "0x" + String(repeating: "1", count: 40)
    await model.create { _ in account(source: "hyperliquid", category: "crypto") }
    for status in ["running", "failed"] {
      await model.sync { _ in AccountSyncResult(status: status) }
      #expect(!model.synced)
      #expect(model.error != nil)
    }
    await model.sync { _ in AccountSyncResult(status: "partial", warnings: ["History incomplete"]) }
    #expect(model.synced)
    #expect(model.syncMessage.contains("History incomplete"))
  }
  @Test func cashUsesOneUnitOfItsCurrencyAndHoldingsPreservePriceCurrency() throws {
    let cash = account()
    let eur = Asset(
      id: UUID(), symbol: "EUR", name: "Euro", assetType: "cash", quoteCurrency: "EUR")
    var draft = HoldingDraft(quantity: "2500", price: "", date: Date())
    let balance = try draft.body(account: cash, asset: eur)
    #expect(balance["quantity"]?.display == "2500")
    #expect(balance["unitPrice"]?.display == "1")
    let stock = Asset(
      id: UUID(), symbol: "AAPL", name: "Apple", assetType: "equity", quoteCurrency: "USD")
    draft.quantity = "2"
    let holding = try draft.body(account: account(category: "equities"), asset: stock)
    #expect(holding["unitPrice"] == nil)
    #expect(holding["currency"]?.display == "USD")
    #expect(try HoldingDraft.decimal("12,5", locale: Locale(identifier: "fr_FR")) == "12.5")
    #expect(throws: APIError.self) { try HoldingDraft.decimal("-1") }
    #expect(throws: APIError.self) {
      try HoldingDraft.decimal("1,000", locale: Locale(identifier: "en_US"))
    }
  }
}

@MainActor struct ChartLayoutTests {
  @Test func scrubbingDoesNotChangeIntrinsicHeight() {
    let dashboard = PortfolioDashboard.preview
    for size in [DynamicTypeSize.large, .accessibility3] {
      let idle = UIHostingController(
        rootView:
          PortfolioValueChart(dashboard: dashboard, range: .constant(.month))
          .environment(\.dynamicTypeSize, size))
      let selected = UIHostingController(
        rootView:
          PortfolioValueChart(
            dashboard: dashboard, range: .constant(.month),
            initialSelection: dashboard.chart.first!.at
          )
          .environment(\.dynamicTypeSize, size))
      let proposal = CGSize(width: 353, height: 1200)
      let idleSize = idle.sizeThatFits(in: proposal)
      let selectedSize = selected.sizeThatFits(in: proposal)
      #expect(abs(idleSize.height - selectedSize.height) < 1)
    }
  }
}
