import SwiftUI

struct ActivityEvent: Codable, Identifiable, Sendable {
  let id: UUID
  let accountId: UUID
  let accountName: String
  let assetClass: String
  let source: String
  let kind: String
  let at: Date
  let quantity: Amount?
  let currency: String
  let symbol: String?
  let isVoided: Bool
  let editable: Bool
  let transactionId: UUID?
}

struct ActivityPresentation {
  let title: String
  let icon: AppIconName
  let sign: String
  let tint: Color

  static func resolve(kind: String) -> ActivityPresentation {
    switch kind.uppercased() {
    case "BUY": .init(title: "Purchase", icon: .arrowDown, sign: "+", tint: .green)
    case "SELL": .init(title: "Sale", icon: .arrowUp, sign: "−", tint: .orange)
    case "DEPOSIT", "TRANSFER_IN":
      .init(
        title: kind.uppercased() == "DEPOSIT" ? "Deposit" : "Transfer in", icon: .arrowDown,
        sign: "+", tint: .green)
    case "WITHDRAWAL", "TRANSFER_OUT":
      .init(
        title: kind.uppercased() == "WITHDRAWAL" ? "Withdrawal" : "Transfer out", icon: .arrowUp,
        sign: "−", tint: .orange)
    case "FEE": .init(title: "Fee", icon: .money, sign: "−", tint: .orange)
    case "INCOME": .init(title: "Income", icon: .money, sign: "+", tint: .green)
    case "FUNDING": .init(title: "Funding", icon: .money, sign: "+", tint: .blue)
    case "ADJUSTMENT": .init(title: "Adjustment", icon: .edit, sign: "", tint: .indigo)
    case "OBSERVATION": .init(title: "Position observed", icon: .search, sign: "", tint: .blue)
    case "RECURRING_PENDING":
      .init(title: "Recurring investment pending", icon: .recurring, sign: "", tint: .secondary)
    case "RECURRING_SKIPPED":
      .init(title: "Recurring investment skipped", icon: .recurring, sign: "", tint: .secondary)
    case "RECURRING_FAILED":
      .init(title: "Recurring investment failed", icon: .warning, sign: "", tint: .red)
    case "RECONCILIATION_PENDING":
      .init(title: "Reconciliation needed", icon: .review, sign: "", tint: .orange)
    case "RECONCILIATION_RESOLVED":
      .init(title: "Reconciliation resolved", icon: .connected, sign: "", tint: .green)
    default:
      .init(
        title: kind.replacingOccurrences(of: "_", with: " ").lowercased().capitalized,
        icon: .transaction, sign: "", tint: .secondary)
    }
  }
}

struct ActivityDaySection: Identifiable {
  let day: Date
  let events: [ActivityEvent]
  var id: Date { day }

  var title: String {
    let calendar = Calendar.current
    if calendar.isDateInToday(day) { return "Today" }
    if calendar.isDateInYesterday(day) { return "Yesterday" }
    return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
  }

  static func group(_ events: [ActivityEvent], calendar: Calendar = .current) -> [Self] {
    Dictionary(grouping: events) { calendar.startOfDay(for: $0.at) }
      .map { Self(day: $0.key, events: $0.value.sorted { $0.at > $1.at }) }
      .sorted { $0.day > $1.day }
  }
}

extension ActivityEvent {
  func matches(
    searchText: String, accountID: String, assetClass selectedAssetClass: String,
    source selectedSource: String
  ) -> Bool {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    return (accountID.isEmpty || self.accountId.uuidString == accountID)
      && (selectedAssetClass.isEmpty || assetClass == selectedAssetClass)
      && (selectedSource.isEmpty || source == selectedSource)
      && (query.isEmpty
        || [accountName, source, kind, symbol ?? ""]
          .contains { $0.localizedCaseInsensitiveContains(query) })
  }
}

struct ActivityView: View {
  @MotionPreference private var reduceMotion
  @Environment(AppEnvironment.self) private var environment
  @State private var activity: [ActivityEvent]
  @State private var accounts: [Account]
  @State private var source = ""
  @State private var accountID = ""
  @State private var assetClass = ""
  @State private var searchText = ""
  @State private var filterPresented = false
  @State private var error: String?

  init(activity: [ActivityEvent] = [], accounts: [Account] = []) {
    _activity = State(initialValue: activity)
    _accounts = State(initialValue: accounts)
  }

  var body: some View {
    List {
      if hasActiveFilters {
        Section {
          ScrollView(.horizontal) {
            HStack(spacing: 8) {
              if !accountID.isEmpty {
                ActivityFilterChip(
                  title: accounts.first { $0.id.uuidString == accountID }?.name ?? "Account"
                ) { accountID = "" }
              }
              if !assetClass.isEmpty {
                ActivityFilterChip(title: assetClass.capitalized) { assetClass = "" }
              }
              if !source.isEmpty {
                ActivityFilterChip(title: sourceDisplayName(source)) { source = "" }
              }
            }
          }
          .scrollIndicators(.hidden)
          .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
        }
      }

      if let error {
        Section { Text(error).foregroundStyle(.red) }
      }

      if filteredActivity.isEmpty {
        Section {
          AppEmptyState(
            title: hasQuery ? "No matching activity" : "No activity yet",
            description: hasQuery
              ? "Try another search or reset the active filters."
              : "Transactions, observations, and reconciliations will appear here.",
            icon: hasQuery ? .search : .activity)
          if hasActiveFilters {
            Button("Reset filters") { resetFilters() }
              .frame(maxWidth: .infinity)
          }
        }
        .listRowBackground(Color.clear)
      } else {
        ForEach(daySections) { section in
          Section(section.title) {
            ForEach(section.events) { item in
              if item.editable, let id = item.transactionId {
                VStack(alignment: .leading, spacing: 8) {
                  NavigationLink {
                    TransactionEditView(transactionID: id)
                  } label: {
                    ActivityEventRow(event: item)
                  }
                  TransactionDeleteButton(transactionID: id).font(.caption).buttonStyle(.borderless)
                }
              } else {
                ActivityEventRow(event: item)
              }
            }
          }
        }
      }
    }
    .animation(AppMotion.selection(reduceMotion), value: "\(accountID)-\(assetClass)-\(source)")
    .listStyle(.insetGrouped)
    .navigationTitle("Activity")
    .searchable(text: $searchText, prompt: "Search activity")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          filterPresented = true
        } label: {
          ZStack(alignment: .topTrailing) {
            AppIcon(name: .filter, size: 20).frame(width: 44, height: 44)
            if hasActiveFilters {
              Circle().fill(.tint).frame(width: 8, height: 8).offset(x: -7, y: 7)
            }
          }
        }
        .accessibilityLabel("Filter activity")
        .accessibilityValue(hasActiveFilters ? "Filters active" : "No filters active")
      }
    }
    .sheet(isPresented: $filterPresented) {
      NavigationStack {
        ActivityFilterView(
          accounts: accounts,
          sources: activitySources,
          accountID: $accountID,
          assetClass: $assetClass,
          source: $source)
      }
      .presentationDetents([.medium, .large])
    }
    .task(id: environment.dataRevision) { await load() }
    .refreshable { await load() }
  }

  private var hasActiveFilters: Bool {
    !source.isEmpty || !accountID.isEmpty || !assetClass.isEmpty
  }

  private var hasQuery: Bool {
    hasActiveFilters || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var filteredActivity: [ActivityEvent] {
    activity.filter {
      !$0.isVoided
        && $0.matches(
          searchText: searchText, accountID: accountID, assetClass: assetClass, source: source)
    }
  }

  private var activitySources: [String] {
    let known = [
      "manual", "screenshot", "recurring_rule", "hyperliquid", "dydx", "evm_wallet",
      "reconciliation", "agent", "system",
    ]
    return Array(Set(known + activity.map(\.source))).sorted()
  }

  private var daySections: [ActivityDaySection] {
    ActivityDaySection.group(filteredActivity)
  }

  private func resetFilters() {
    accountID = ""
    assetClass = ""
    source = ""
  }

  private func load() async {
    guard let api = environment.api else { return }
    do {
      async let accountResult: [Account] = api.send("accounts")
      async let activityResult: [ActivityEvent] = api.send("activity")
      let result = try await (accountResult, activityResult)
      guard !Task.isCancelled else { return }
      accounts = result.0
      activity = result.1
      error = nil
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
}

private struct ActivityFilterChip: View {
  let title: String
  let remove: () -> Void

  var body: some View {
    Button(action: remove) {
      HStack(spacing: 5) {
        Text(title)
        AppIcon(name: .close, size: 13)
      }
      .font(.caption.weight(.medium))
      .padding(.horizontal, 11)
      .frame(minHeight: 32)
      .background(Color.accentColor.opacity(0.12), in: Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Remove \(title) filter")
  }
}

private struct ActivityFilterView: View {
  @Environment(\.dismiss) private var dismiss
  let accounts: [Account]
  let sources: [String]
  @Binding var accountID: String
  @Binding var assetClass: String
  @Binding var source: String

  var body: some View {
    Form {
      Section {
        Picker("Account", selection: $accountID) {
          Text("All accounts").tag("")
          ForEach(accounts) { Text($0.name).tag($0.id.uuidString) }
        }
        Picker("Category", selection: $assetClass) {
          Text("All categories").tag("")
          ForEach(["crypto", "equities", "cash", "other"], id: \.self) {
            Text($0.capitalized).tag($0)
          }
        }
        Picker("Source", selection: $source) {
          Text("All sources").tag("")
          ForEach(sources, id: \.self) { Text(sourceDisplayName($0)).tag($0) }
        }
      }
      Section {
        Button {
          accountID = ""
          assetClass = ""
          source = ""
        } label: {
          HStack {
            AppIcon(name: .reset, size: 18)
            Text("Reset")
          }
        }
      }
    }
    .navigationTitle("Filters")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
    }
  }
}

struct ActivityEventRow: View {
  let event: ActivityEvent
  @Environment(AppEnvironment.self) private var environment

  var body: some View {
    let presentation = ActivityPresentation.resolve(kind: event.kind)
    HStack(spacing: 12) {
      AppIcon(name: presentation.icon, size: 20)
        .foregroundStyle(presentation.tint)
        .frame(width: 38, height: 38)
        .background(presentation.tint.opacity(0.1), in: .rect(cornerRadius: 10))
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 7) {
          Text(presentation.title).font(.subheadline.weight(.semibold))
          if event.isVoided {
            Text("Voided")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(Color.secondary.opacity(0.12), in: Capsule())
          }
        }
        Text(
          environment.advancedMode
            ? "\(event.accountName) · \(sourceDisplayName(event.source))" : event.accountName
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        Text(event.at.formatted(date: .omitted, time: .shortened))
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 8)
      if let quantity = event.quantity {
        Text("\(presentation.sign)\(FinanceFormat.quantity(quantity)) \(event.symbol ?? "")")
          .font(.subheadline.weight(.medium))
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
    }
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
  }
}

struct ActivityRow: View {
  let transaction: Transaction
  @Environment(AppEnvironment.self) private var environment
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        Text(ActivityPresentation.resolve(kind: transaction.type).title)
          .font(.subheadline.weight(.medium))
        Text(
          transaction.occurredAt.formatted(date: .abbreviated, time: .omitted)
            + (environment.advancedMode ? " · " + sourceDisplayName(transaction.source) : "")
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer()
      Text(FinanceFormat.quantity(transaction.quantity)).monospacedDigit()
    }
    .padding(.vertical, 5)
  }
}

private func sourceDisplayName(_ source: String) -> String {
  switch source.lowercased() {
  case "dydx": "dYdX"
  case "hyperliquid": "Hyperliquid"
  case "evm_wallet": "Wallet"
  case "recurring_rule": "Recurring rule"
  default: source.replacingOccurrences(of: "_", with: " ").capitalized
  }
}
