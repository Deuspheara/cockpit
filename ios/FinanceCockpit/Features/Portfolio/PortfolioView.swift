import SwiftUI

struct PortfolioView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.scenePhase) private var scenePhase
  @State private var model = PortfolioModel()
  @State private var showAssets = false
  @State private var assistantPresented = false
  @State private var sheet: PortfolioSheet?

  enum PortfolioSheet: String, Identifiable {
    case add, screenshots
    var id: String { rawValue }
  }

  init(dashboard: PortfolioDashboard? = nil, error: String? = nil) {
    let previewModel = PortfolioModel()
    previewModel.dashboard = dashboard
    previewModel.error = error
    _model = State(initialValue: previewModel)
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
              HStack(spacing: 6) {
                AppIcon(name: .clock, size: 15)
                Text(
                  "Saved data · \(dashboard.asOf.formatted(date: .abbreviated, time: .shortened))"
                )
              }
              .font(.caption)
              .foregroundStyle(.secondary)
            }
            allocation(dashboard)
            Picker("View", selection: $showAssets) {
              Text("Accounts").tag(false)
              Text("Assets").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("portfolio-content-picker")
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
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 24)
    }
    .navigationTitle("Portfolio")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        HStack(spacing: 0) {
          Button {
            assistantPresented = true
          } label: {
            AppIcon(name: .assistant, size: 21)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .accessibilityLabel("Assistant")
          .accessibilityHint("Opens the finance assistant")
          .accessibilityIdentifier("portfolio-assistant")
          Menu {
            Button("Import screenshot") { sheet = .screenshots }
            Button("Add manually or connect account") { sheet = .add }
          } label: {
            AppIcon(name: .add, size: 21)
              .frame(width: 44, height: 44)
              .contentShape(Rectangle())
          }
          .accessibilityLabel("Add")
          .accessibilityHint("Imports a screenshot or adds an account")
        }
        .buttonStyle(.plain)
        .fixedSize()
      }
      if model.isRefreshing && model.dashboard != nil {
        ToolbarItem(placement: .topBarLeading) {
          ProgressView().accessibilityLabel("Refreshing")
        }
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
    .fullScreenCover(isPresented: $assistantPresented) {
      NavigationStack { AgentView() }
    }
    .sheet(item: $sheet) { item in
      NavigationStack {
        switch item {
        case .add: ManualEntryView()
        case .screenshots: ImportView()
        }
      }
    }
  }

  private var emptyState: some View {
    VStack(spacing: 20) {
      AppEmptyState(
        title: "Your portfolio is empty",
        description: "Connect a read-only crypto account or add positions manually.",
        icon: .chart)
      Button("Add an account") { sheet = .add }
        .buttonStyle(.borderedProminent)
    }
  }

  private func allocation(_ dashboard: PortfolioDashboard) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Allocation").font(.headline)
      if !dashboard.allocation.isEmpty {
        GeometryReader { geometry in
          HStack(spacing: 2) {
            ForEach(Array(dashboard.allocation.enumerated()), id: \.element.id) { index, item in
              RoundedRectangle(cornerRadius: 3)
                .fill(allocationColor(item.key, index: index))
                .frame(
                  width: max(
                    3,
                    geometry.size.width
                      * CGFloat(NSDecimalNumber(decimal: item.percentage.decimal).doubleValue / 100)
                  )
                )
                .accessibilityHidden(true)
            }
          }
        }
        .frame(height: 10)
        .clipShape(Capsule())
      }
      ForEach(Array(dashboard.allocation.enumerated()), id: \.element.id) { index, item in
        HStack(spacing: 10) {
          Circle().fill(allocationColor(item.key, index: index)).frame(width: 8, height: 8)
          Text(item.label)
          Spacer(minLength: 8)
          Text(FinanceFormat.amount(item.value, currency: dashboard.currency))
            .monospacedDigit()
          Text(FinanceFormat.percent(item.percentage))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .frame(minWidth: 56, alignment: .trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
      }
    }
  }

  private func allocationColor(_ key: String, index: Int) -> Color {
    switch key.lowercased() {
    case "crypto": .mint
    case "equities": .blue
    case "cash": .green
    case "other": .orange
    default: [Color.indigo, .cyan, .pink, .purple][index % 4]
    }
  }

  private func accountList(_ dashboard: PortfolioDashboard) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Accounts").font(.headline).padding(.bottom, 4)
      ForEach(["crypto", "equities", "cash", "other"], id: \.self) { category in
        let rows = dashboard.accounts.filter { $0.assetClass == category }
        if !rows.isEmpty {
          Text(category == "equities" ? "ACTIONS" : category.uppercased())
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.top, 12)
          ForEach(rows) { account in
            NavigationLink {
              AccountDetailView(accountID: account.id)
            } label: {
              HStack(spacing: 12) {
                ProviderLogo(sourceType: account.sourceType)
                VStack(alignment: .leading, spacing: 3) {
                  Text(account.name).foregroundStyle(.primary)
                  Text(account.freshnessDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                  Text(FinanceFormat.amount(account.value, currency: dashboard.currency))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                  if !account.complete {
                    Text("Partial value").font(.caption).foregroundStyle(.orange)
                  }
                }
                AppIcon(name: .arrowRight, size: 15).foregroundStyle(.tertiary)
              }
              .padding(.vertical, 9)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("portfolio-account-\(account.id)")
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
