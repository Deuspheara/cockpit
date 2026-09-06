import SwiftUI

struct AccountDetailView: View {
  let accountID: UUID
  @Environment(AppEnvironment.self) private var environment
  @State private var snapshot = SnapshotLoader<AccountDetail>()
  private var detail: AccountDetail? { snapshot.value }
  @State private var firstHoldingPresented = false
  @State private var range: PortfolioRange = .month
  @State private var error: String?
  @State private var csvPresented = false
  @State private var syncing = false
  @State private var chartMetric = "Equity"
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let detail {
          Text(accountSourceTitle(detail.account.sourceType)).font(.subheadline).foregroundStyle(
            .secondary)
          if detail.performance != nil {
            Picker("Chart", selection: $chartMetric) {
              Text("Account equity").tag("Equity")
              Text("Trading PnL").tag("PnL")
            }.pickerStyle(.segmented)
          }
          Group {
            if chartMetric == "PnL", let performance = detail.performance {
              TradingPerformanceView(
                performance: performance, range: $range, displayedRange: detail.dashboard.range)
            } else {
              PortfolioValueChart(
                dashboard: detail.dashboard, range: $range, compactEmptyHistory: true)
            }
          }.modifier(DatasetTransition(key: chartMetric))
          if detail.account.sourceType != "manual" {
            AccountSyncStatusView(accountID: accountID)
          }
          if detail.account.sourceType == "evm_wallet" {
            EVMHistoryStatusView(accountID: accountID, job: detail.historyJob)
          }
          if let summary = detail.derivatives { DerivativesSummaryView(summary: summary) }
          if let historyError = detail.historyError {
            Text(historyError).font(.caption).foregroundStyle(.secondary)
          }
          if detail.account.provider == "trade_republic", detail.account.sourceType == "manual" {
            VStack(alignment: .leading, spacing: 10) {
              Text("Trade Republic · Manual").font(.subheadline).foregroundStyle(.secondary)
              if let imported = detail.account.lastImportedAt {
                Text("Last import " + imported.formatted(date: .abbreviated, time: .omitted)).font(
                  .caption)
              }
              Button("Import CSV") { csvPresented = true }
              NavigationLink("Import history") { CSVImportHistoryView(accountID: accountID) }
            }
          }
          Text("Positions").font(.headline)
          if detail.account.sourceType == "manual", detail.positions.isEmpty {
            Button(
              detail.account.assetClass == "cash" ? "Add your balance" : "Add your first holding"
            ) {
              firstHoldingPresented = true
            }.buttonStyle(.borderedProminent)
          }
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
                position.quantity.map {
                  "\(position.side.map { $0.capitalized + " " } ?? "")\(FinanceFormat.quantity($0)) · \(accountSourceTitle(position.source))"
                } ?? "Quantity unknown · \(accountSourceTitle(position.source))"
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
              if position.costBasis == nil && position.unrealizedPnl == nil
                && detail.account.sourceType != "evm_wallet"
              {
                Text("Return unavailable · incomplete cost basis").font(.caption).foregroundStyle(
                  .secondary)
              }
              if let at = position.observedAt {
                Text(
                  "\(position.stale ? "Stale · " : "")\(at.formatted(date: .abbreviated, time: .shortened))"
                ).font(.caption).foregroundStyle(.secondary)
              }
            }.padding(14)
              .background(Color.primary.opacity(0.045), in: .rect(cornerRadius: 16))
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
          if !detail.activity.isEmpty {
            Text("Recent activity").font(.headline)
            ForEach(detail.activity.prefix(20)) { item in ActivityRow(transaction: item) }
          }
        } else if error == nil {
          ProgressView("Loading account").frame(maxWidth: .infinity, minHeight: 220)
        }
        if let error = error ?? snapshot.error {
          Text(error).foregroundStyle(.red)
          Button("Retry") { Task { await load() } }
        }
      }.padding(20)
    }.navigationTitle(detail?.account.name ?? "Account")
      .fullScreenCover(isPresented: $csvPresented) {
        NavigationStack { CSVImportView(accountID: accountID) }
      }
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if detail?.account.sourceType != "manual" {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              Task { await sync() }
            } label: {
              AppIcon(name: .sync, size: 20).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Sync account")
            .disabled(syncing)
          }
        }
      }
      .sheet(isPresented: $firstHoldingPresented) {
        if let account = detail?.account {
          NavigationStack {
            FirstHoldingView(account: account) { firstHoldingPresented = false }
          }
        }
      }
      .task(id: "\(range)-\(scenePhase)-\(environment.dataRevision)") {
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
        "accounts/\(accountID)/sync-runs", method: "POST")
      await load()
      environment.dataRevision += 1
    } catch { self.error = error.localizedDescription }
  }
  private func load() async {
    guard let api = environment.api else { return }
    let requestedRange = range
    let key = "account-\(accountID)-\(requestedRange.rawValue)"
    let id = accountID
    await snapshot.load(
      key: key,
      cached: { await environment.cache?.read(key, as: AccountDetail.self) },
      fetch: {
        try await api.send(
          "accounts/\(id)/detail",
          query: [URLQueryItem(name: "range", value: requestedRange.rawValue)])
      }, save: { await environment.cache?.write($0, key: key) })
  }
}

struct AccountSyncStatusView: View {
  let accountID: UUID
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.scenePhase) private var scenePhase
  @State private var run: AccountSyncResult?
  @State private var error: String?
  @State private var retrying = false
  @State private var pollGeneration = 0
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let run {
        if run.status == "queued" || run.status == "running" {
          ProgressView("Updating balances…").font(.subheadline)
        } else if run.status == "partial" || run.status == "failed" {
          DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
              if let failure = run.failure { Text(failure.message) }
              ForEach(run.warnings ?? [], id: \.self) { Text($0) }
              Button("Retry sync") { Task { await retry() } }.disabled(retrying)
                .buttonStyle(.bordered)
            }.font(.caption).foregroundStyle(.secondary).padding(.top, 8)
          } label: {
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: run.status == "failed" ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(run.status == "failed" ? Color.orange : Color.secondary)
              VStack(alignment: .leading, spacing: 3) {
                Text(run.status == "failed" ? "Sync needs another try" : "Balances updated")
                  .font(.subheadline.weight(.medium))
                Text(
                  run.status == "failed"
                    ? "Your saved holdings are still available."
                    : "Some values or networks are incomplete."
                )
                .font(.caption).foregroundStyle(.secondary)
              }
            }
          }.tint(.secondary).accessibilityIdentifier("account-sync-details")
        } else if run.status == "success" {
          Label("Up to date", systemImage: "checkmark.circle")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      if let error {
        Text(error).font(.caption).foregroundStyle(.secondary)
        Button("Retry") { Task { await retry() } }.disabled(retrying)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(Color.primary.opacity(0.045), in: .rect(cornerRadius: 16))
    .task(id: "\(scenePhase)-\(pollGeneration)") {
      guard scenePhase == .active else { return }
      while !Task.isCancelled {
        do {
          let previous = run?.status
          if let api = environment.api {
            let latest: AccountSyncResult? = try await api.send("accounts/\(accountID)/sync-runs")
            run = latest
            error = nil
          }
          if previous != run?.status && (run?.status == "success" || run?.status == "partial") {
            environment.dataRevision += 1
          }
          try await Task.sleep(for: .seconds(3))
        } catch {
          if !Task.isCancelled { self.error = error.localizedDescription }
          return
        }
      }
    }
  }
  private func retry() async {
    retrying = true
    defer { retrying = false }
    do {
      run = try await environment.api?.send("accounts/\(accountID)/sync-runs", method: "POST")
      error = nil
      pollGeneration += 1
    } catch { self.error = error.localizedDescription }
  }
}

private func accountSourceTitle(_ source: String) -> String {
  switch source {
  case "evm_wallet": "EVM wallet"
  case "manual": "Manual account"
  case "dydx": "dYdX"
  case "hyperliquid": "Hyperliquid"
  default: source.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private struct EVMHistoryStatusView: View {
  let accountID: UUID
  let job: EVMHistoryJob?
  @Environment(AppEnvironment.self) private var environment
  @State private var requesting = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Base history").font(.headline)
      if let job {
        Text("\(job.daysDone) of \(job.totalDays) daily values processed").font(.subheadline)
        if ["queued", "running"].contains(job.status) {
          ProgressView(
            job.phase == "discovery"
              ? "Discovering past holdings" : "Recovering balances and prices")
        }
        if let message = job.error { Text(message).font(.caption).foregroundStyle(.secondary) }
        if job.status == "paused" {
          Text("Resumes \(job.nextAttemptAt.formatted())").font(.caption)
        }
        Text("\(job.requestsUsed) / \(job.dailyRequestLimit) requests today").font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(
        "Daily values for the last 90 days. Other networks and unavailable token data remain explicit gaps."
      )
      .font(.caption).foregroundStyle(.secondary)
      if job == nil || ["failed", "partial"].contains(job?.status ?? "") {
        Button(job == nil ? "Recover history" : "Retry missing history") {
          Task {
            requesting = true
            defer { requesting = false }
            do {
              let _: JSONValue? = try await environment.api?.send(
                "accounts/\(accountID)/history-jobs", method: "POST")
              environment.dataRevision += 1
            } catch { self.error = error.localizedDescription }
          }
        }.disabled(requesting).accessibilityIdentifier("recover-base-history")
      }
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
    }
  }
}
