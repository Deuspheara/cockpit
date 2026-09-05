import SwiftUI

struct AccountDetailView: View {
  let accountID: UUID
  @Environment(AppEnvironment.self) private var environment
  @State private var detail: AccountDetail?
  @State private var range: PortfolioRange = .month
  @State private var error: String?
  @State private var syncing = false
  @State private var chartMetric = "Equity"
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let detail {
          Text(detail.account.sourceType).font(.subheadline).foregroundStyle(.secondary)
          if detail.performance != nil {
            Picker("Chart", selection: $chartMetric) {
              Text("Account equity").tag("Equity")
              Text("Trading PnL").tag("PnL")
            }.pickerStyle(.segmented)
          }
          if chartMetric == "PnL", let performance = detail.performance {
            TradingPerformanceView(performance: performance, range: $range)
          } else {
            PortfolioValueChart(dashboard: detail.dashboard, range: $range)
          }
          if let summary = detail.derivatives { DerivativesSummaryView(summary: summary) }
          if let historyError = detail.historyError {
            Text(historyError).font(.caption).foregroundStyle(.secondary)
          }
          Text("Positions").font(.headline)
          ForEach(detail.positions.filter { $0.assetType != "cash" || detail.derivatives == nil }) {
            position in
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(position.symbol).font(.headline)
                Spacer()
                if let value = position.marketValue {
                  Text(FinanceFormat.amount(value, currency: position.currency)).monospacedDigit()
                } else {
                  Text("Price unavailable").foregroundStyle(.secondary)
                }
              }
              Text(
                "\(position.side.map { $0.capitalized + " " } ?? "")\(FinanceFormat.quantity(position.quantity)) · \(position.source)"
              ).font(.subheadline).foregroundStyle(.secondary)
              if position.assetType == "perp" {
                if detail.account.sourceType == "dydx" {
                  NavigationLink(
                    "Price history",
                    destination: MarketPriceView(assetID: position.assetId, symbol: position.symbol)
                  ).accessibilityIdentifier("market-price-history")
                }
                Text("Position exposure").font(.caption).foregroundStyle(.secondary)
                LabeledContent(
                  "Entry price",
                  value: position.entryPrice.map {
                    FinanceFormat.amount($0, currency: position.currency)
                  } ?? "Unavailable")
                LabeledContent(
                  "Valuation price",
                  value: position.price.map {
                    FinanceFormat.amount($0, currency: position.currency)
                  } ?? "Unavailable")
                if let leverage = position.leverage {
                  LabeledContent(
                    "Exposure / equity",
                    value: NSDecimalNumber(decimal: leverage.decimal).doubleValue.formatted(
                      .number.precision(.fractionLength(2))) + "×")
                }
                if let liquidation = position.liquidationPrice {
                  LabeledContent(
                    "Liquidation price",
                    value: FinanceFormat.amount(liquidation, currency: position.currency))
                }
              }
              if let pnl = position.unrealizedPnl {
                Text("Unrealized PnL: \(FinanceFormat.amount(pnl, currency: position.currency))")
                  .font(.caption).foregroundStyle(pnl.decimal >= 0 ? Color.green : Color.red)
              }
              if position.costBasis == nil && position.unrealizedPnl == nil {
                Text("Return unavailable · incomplete cost basis").font(.caption).foregroundStyle(
                  .secondary)
              }
              if let at = position.observedAt {
                Text(
                  "\(position.stale ? "Stale · " : "")\(at.formatted(date: .abbreviated, time: .shortened))"
                ).font(.caption).foregroundStyle(.secondary)
              }
            }.padding(.vertical, 4)
            Divider()
          }
          if detail.derivatives != nil {
            DisclosureGroup("Collateral ledger") {
              ForEach(detail.positions.filter { $0.assetType == "cash" }) { position in
                LabeledContent(
                  position.symbol,
                  value: position.marketValue.map {
                    FinanceFormat.amount($0, currency: position.currency)
                  } ?? "Unavailable")
              }
              Text(
                "Signed quote balance plus signed position exposure equals account equity. This ledger balance is not an additional holding to add to equity."
              ).font(.caption).foregroundStyle(.secondary)
            }
          }
          if detail.account.sourceType == "manual" {
            NavigationLink("Recurring investments") { RecurringView(accountID: accountID) }
          }
          Text("Recent activity").font(.headline)
          ForEach(detail.activity.prefix(20)) { item in ActivityRow(transaction: item) }
        } else if error == nil {
          ProgressView("Loading account").frame(maxWidth: .infinity, minHeight: 220)
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.padding(20)
    }.navigationTitle(detail?.account.name ?? "Account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if detail?.account.sourceType != "manual" {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Sync account", systemImage: "arrow.clockwise") { Task { await sync() } }
              .disabled(syncing)
          }
        }
      }
      .task(id: "\(range)-\(scenePhase)") {
        guard scenePhase == .active else { return }
        await load()
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(30)) } catch { return }
          await load()
        }
      }
      .refreshable { await load() }
  }
  private func sync() async {
    syncing = true
    defer { syncing = false }
    do {
      let _: JSONValue? = try await environment.api?.send(
        "accounts/\(accountID)/sync", method: "POST")
      await load()
      environment.dataRevision += 1
    } catch { self.error = error.localizedDescription }
  }
  private func load() async {
    guard let api = environment.api else { return }
    let key = "account-\(accountID)-\(range.rawValue)"
    if detail == nil, let cached = await environment.cache?.read(key, as: AccountDetail.self) {
      detail = cached
    }
    do {
      let fresh: AccountDetail = try await api.send(
        "accounts/\(accountID)/detail", query: [URLQueryItem(name: "range", value: range.rawValue)])
      guard !Task.isCancelled else { return }
      detail = fresh
      error = nil
      await environment.cache?.write(fresh, key: key)
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
