import SwiftUI

struct AccountDetailView: View {
  let accountID: UUID
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var removing = false
  @State private var confirmRemoval = false
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
          if environment.advancedMode {
            Text(accountSourceTitle(detail.account.sourceType)).font(.subheadline).foregroundStyle(
              .secondary)
          }
          if environment.advancedMode, detail.performance != nil {
            Picker("Chart", selection: $chartMetric) {
              Text("Account equity").tag("Equity")
              Text("Trading PnL").tag("PnL")
            }.pickerStyle(.segmented)
          }
          Group {
            if environment.advancedMode, chartMetric == "PnL", let performance = detail.performance
            {
              TradingPerformanceView(
                performance: performance, range: $range, displayedRange: detail.dashboard.range)
            } else {
              PortfolioValueChart(
                dashboard: detail.dashboard, range: $range, compactEmptyHistory: true)
            }
          }.modifier(DatasetTransition(key: chartMetric))
          if environment.advancedMode, detail.account.sourceType != "manual" {
            AccountSyncStatusView(accountID: accountID)
          }
          if environment.advancedMode, detail.account.sourceType == "evm_wallet" {
            EVMHistoryStatusView(accountID: accountID, job: detail.historyJob)
          }
          if environment.advancedMode, let summary = detail.derivatives {
            DerivativesSummaryView(summary: summary)
          }
          if environment.advancedMode, let historyError = detail.historyError {
            Text(historyError).font(.caption).foregroundStyle(.secondary)
          }
          if environment.advancedMode, detail.account.provider == "trade_republic",
            detail.account.sourceType == "manual"
          {
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
          VStack(alignment: .leading, spacing: 12) {
            Text("Holdings").font(.headline)
            if detail.account.sourceType == "manual", detail.positions.isEmpty {
              Button(
                detail.account.assetClass == "cash" ? "Add your balance" : "Add your first holding"
              ) {
                firstHoldingPresented = true
              }.buttonStyle(.borderedProminent)
            }
            ForEach(detail.positions.filter { $0.assetType != "cash" || detail.derivatives == nil })
            {
              position in
              VStack(alignment: .leading, spacing: 5) {
                HoldingSummaryRow(
                  name: position.name, symbol: position.symbol,
                  logoUrl: position.logoUrl, quantity: position.quantity,
                  value: position.marketValue,
                  currency: position.currency, side: position.side,
                  exposure: position.assetType == "perp")
                if environment.advancedMode, position.assetType == "perp" {
                  if detail.account.sourceType == "dydx" {
                    NavigationLink(
                      "Price history",
                      destination: MarketPriceView(
                        assetID: position.assetId, symbol: position.symbol)
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
                  Text(
                    "\(pnl.decimal >= 0 ? "Gain" : "Loss"): \(FinanceFormat.amount(pnl, currency: position.currency))"
                  )
                  .font(.caption).foregroundStyle(pnl.decimal >= 0 ? Color.green : Color.red)
                }
                if environment.advancedMode,
                  position.costBasis == nil && position.unrealizedPnl == nil
                    && detail.account.sourceType != "evm_wallet"
                {
                  Text("Return unavailable · incomplete cost basis").font(.caption).foregroundStyle(
                    .secondary)
                }
                if environment.advancedMode, let at = position.observedAt {
                  Text(
                    "\(position.stale ? "Stale · " : "")\(at.formatted(date: .abbreviated, time: .shortened))"
                  ).font(.caption).foregroundStyle(.secondary)
                }
              }.padding(.vertical, 6)
              Divider()
            }
          }
          if environment.advancedMode, detail.derivatives != nil {
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
            ForEach(detail.activity.filter { !$0.isVoided }.prefix(20)) { item in
              if detail.account.sourceType == "manual", item.allowsManualCorrection {
                NavigationLink {
                  TransactionEditView(transactionID: item.id)
                } label: {
                  ActivityRow(transaction: item)
                }.buttonStyle(.plain).modifier(TransactionRemovalActions(transactionID: item.id))
              } else {
                ActivityRow(transaction: item)
              }
            }
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
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            if let detail, detail.account.sourceType != "manual" {
              Button("Refresh account") { Task { await sync() } }.disabled(syncing)
            }
            if detail?.account.sourceType == "manual", detail?.account.provider == "trade_republic"
            {
              Button("Import CSV") { csvPresented = true }
              NavigationLink("Import history") { CSVImportHistoryView(accountID: accountID) }
            }
            Button("Remove account", role: .destructive) { confirmRemoval = true }
              .disabled(detail == nil || removing)
          } label: {
            Image(systemName: "ellipsis").frame(width: 44, height: 44)
          }
          .accessibilityLabel("Account actions")
        }
      }
      .confirmationDialog(
        "Remove this account?", isPresented: $confirmRemoval, titleVisibility: .visible
      ) {
        Button("Remove account", role: .destructive) { Task { await removeAccount() } }
      } message: {
        Text("This account will leave your portfolio and stop updating. Its records will be kept.")
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
  private func removeAccount() async {
    guard let api = environment.api else { return }
    removing = true
    defer { removing = false }
    do {
      let _: JSONValue = try await api.send("accounts/\(accountID)", method: "DELETE")
      await environment.cache?.clear()
      environment.dataRevision += 1
      dismiss()
    } catch {
      self.error = "Couldn’t remove this account. Try again. " + error.localizedDescription
    }
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
    let cacheGeneration = await environment.cache?.generation
    await snapshot.load(
      key: key,
      cached: { await environment.cache?.read(key, as: AccountDetail.self) },
      fetch: {
        try await api.send(
          "accounts/\(id)/detail",
          query: [URLQueryItem(name: "range", value: requestedRange.rawValue)])
      }, save: { await environment.cache?.write($0, key: key, generation: cacheGeneration) })
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
          if !environment.advancedMode {
            HStack {
              Text(
                run.status == "failed"
                  ? "Couldn’t update this account." : "Some balances are unavailable.")
              Spacer()
              Button("Retry") { Task { await retry() } }.disabled(retrying)
            }.font(.caption).foregroundStyle(.secondary)
          } else {
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
          }
        } else if run.status == "success", environment.advancedMode {
          Label("Up to date", systemImage: "checkmark.circle")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      if let error {
        Text(environment.advancedMode ? error : "Couldn’t check for updates.").font(.caption)
          .foregroundStyle(.secondary)
        Button("Retry") { Task { await retry() } }.disabled(retrying)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, environment.advancedMode ? 8 : 0)
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
