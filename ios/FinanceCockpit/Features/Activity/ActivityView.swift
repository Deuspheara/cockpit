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
struct ActivityView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var activity: [ActivityEvent] = []
  @State private var accounts: [Account] = []
  @State private var source = ""
  @State private var accountID = ""
  @State private var assetClass = ""
  @State private var error: String?
  var body: some View {
    List {
      Section("Filters") {
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
          ForEach(
            [
              "manual", "screenshot", "recurring_rule", "hyperliquid", "dydx", "evm_wallet",
              "reconciliation", "agent", "system",
            ], id: \.self
          ) { Text($0).tag($0) }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if activity.isEmpty {
        ContentUnavailableView(
          "No activity yet", systemImage: "clock",
          description: Text(
            "Transactions, recurring occurrences, observations, and reconciliations appear here."))
      }
      ForEach(activity) { item in
        if item.editable, let id = item.transactionId {
          NavigationLink {
            TransactionEditView(transactionID: id)
          } label: {
            ActivityEventRow(event: item)
          }
        } else {
          ActivityEventRow(event: item)
        }
      }
    }.navigationTitle("Activity").task(
      id: "\(environment.dataRevision)-\(source)-\(accountID)-\(assetClass)"
    ) { await load() }.refreshable { await load() }
  }
  private func load() async {
    guard let api = environment.api else { return }
    do {
      if accounts.isEmpty { accounts = try await api.send("accounts") }
      let query = [("source", source), ("accountId", accountID), ("assetClass", assetClass)].filter
      { !$0.1.isEmpty }.map { URLQueryItem(name: $0.0, value: $0.1) }
      let result: [ActivityEvent] = try await api.send("activity", query: query)
      guard !Task.isCancelled else { return }
      activity = result
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}
struct ActivityEventRow: View {
  let event: ActivityEvent
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        Text(
          event.kind.replacingOccurrences(of: "_", with: " ").capitalized
            + (event.isVoided ? " · Voided" : "")
        ).font(.subheadline.weight(.medium))
        Text("\(event.accountName) · \(event.source)").font(.caption).foregroundStyle(.secondary)
        Text(event.at.formatted(date: .abbreviated, time: .omitted)).font(.caption).foregroundStyle(
          .secondary)
      }
      Spacer()
      if let quantity = event.quantity {
        Text("\(FinanceFormat.quantity(quantity)) \(event.symbol ?? "")").monospacedDigit()
      }
    }.padding(.vertical, 5)
  }
}
struct ActivityRow: View {
  let transaction: Transaction
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 4) {
        Text(transaction.type + (transaction.isVoided ? " · Voided" : "")).font(
          .subheadline.weight(.medium))
        Text(
          "\(transaction.occurredAt.formatted(date: .abbreviated, time: .omitted)) · \(transaction.source)"
        ).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Text(FinanceFormat.quantity(transaction.quantity)).monospacedDigit()
    }.padding(.vertical, 5)
  }
}
