import SwiftUI

struct PortfolioView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.scenePhase) private var scenePhase
  @State private var model = PortfolioModel()
  @State private var showAssets = false
  @State private var sheet: PortfolioSheet?
  enum PortfolioSheet: String, Identifiable {
    case add, agent, screenshots
    var id: String { rawValue }
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        PortfolioScopePicker(selection: $model.scope)
        if let dashboard = model.dashboard {
          if dashboard.accounts.isEmpty {
            emptyState
          } else {
            PortfolioValueChart(dashboard: dashboard, range: $model.range)
            if model.isCached || model.error != nil {
              Label(
                "Saved data · \(dashboard.asOf.formatted(date: .abbreviated, time: .shortened))",
                systemImage: "clock"
              ).font(.caption).foregroundStyle(.secondary)
            }
            allocation(dashboard)
            Picker("View", selection: $showAssets) {
              Text("Accounts").tag(false)
              Text("Assets").tag(true)
            }.pickerStyle(.segmented)
            if showAssets {
              PortfolioAssetsView(scope: model.scope)
            } else {
              accountList(dashboard)
            }
          }
        } else if model.isRefreshing {
          ProgressView("Loading portfolio").frame(maxWidth: .infinity, minHeight: 220)
        }
        if let error = model.error {
          Text(error).font(.callout).foregroundStyle(.red)
          Button("Try again") { Task { await load() } }
        }
      }.padding(.horizontal, 20).padding(.bottom, 24)
    }
    .navigationTitle("Portfolio")
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Menu("Add", systemImage: "plus") {
          Button("Import screenshot", systemImage: "photo") { sheet = .screenshots }
          Button("Add manually or connect account", systemImage: "plus") { sheet = .add }
        }
        Button("Finance assistant", systemImage: "sparkles") { sheet = .agent }
      }
      if model.isRefreshing && model.dashboard != nil {
        ToolbarItem(placement: .topBarLeading) { ProgressView().accessibilityLabel("Refreshing") }
      }
    }
    .task(id: "\(model.key)-\(environment.dataRevision)-\(scenePhase)") {
      guard scenePhase == .active else { return }
      await load()
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        guard !Task.isCancelled else { return }
        await load()
      }
    }
    .refreshable { await load() }
    .sheet(item: $sheet) { item in
      NavigationStack {
        switch item {
        case .add: ManualEntryView()
        case .agent: AgentView()
        case .screenshots: ImportView()
        }
      }
    }
  }
  private var emptyState: some View {
    VStack(spacing: 20) {
      ContentUnavailableView(
        "Your portfolio is empty", systemImage: "chart.pie",
        description: Text("Connect a read-only crypto account or add positions manually."))
      Button("Add an account") { sheet = .add }.buttonStyle(.borderedProminent)
    }
  }
  private func allocation(_ dashboard: PortfolioDashboard) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Allocation").font(.headline)
      ForEach(dashboard.allocation) { allocation in
        HStack {
          Text(allocation.label)
          Spacer()
          Text(FinanceFormat.percent(allocation.percentage)).foregroundStyle(.secondary)
            .monospacedDigit()
        }
      }
    }
  }
  private func accountList(_ dashboard: PortfolioDashboard) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Accounts").font(.headline).padding(.bottom, 4)
      ForEach(["crypto", "equities", "cash", "other"], id: \.self) { category in
        let rows = dashboard.accounts.filter { $0.assetClass == category }
        if !rows.isEmpty {
          Text(category == "equities" ? "ACTIONS" : category.uppercased()).font(
            .caption.weight(.medium)
          ).foregroundStyle(.secondary).padding(.top, 12)
          ForEach(rows) { account in
            NavigationLink {
              AccountDetailView(accountID: account.id)
            } label: {
              HStack(spacing: 12) {
                Image(
                  systemName: account.assetClass == "crypto"
                    ? "bitcoinsign.circle" : "building.columns"
                ).font(.title2).frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                  Text(account.name).foregroundStyle(.primary)
                  Text(account.freshnessDescription)
                    .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing) {
                  Text(FinanceFormat.amount(account.value, currency: dashboard.currency))
                    .monospacedDigit().foregroundStyle(.primary)
                  if !account.complete {
                    Text("Partial value").font(.caption).foregroundStyle(.orange)
                  }
                }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
              }.padding(.vertical, 9).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("portfolio-account-\(account.id)")
            Divider()
          }
        }
      }
    }
  }
  private func load() async {
    guard let api = environment.api else { return }
    await model.load(api: api, cache: environment.cache)
    if model.error == nil { environment.lastSuccessfulRefresh = Date() }
  }
}
