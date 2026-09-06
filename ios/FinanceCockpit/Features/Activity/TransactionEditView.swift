import SwiftUI

struct TransactionEditView: View {
  let transactionID: UUID
  @Environment(AppEnvironment.self) private var environment
  @State private var transaction: Transaction?
  @State private var quantity = ""
  @State private var unitPrice = ""
  @State private var date = Date()
  @State private var error: String?
  @State private var reviewID: UUID?
  var body: some View {
    Form {
      if let transaction {
        LabeledContent("Type", value: ActivityPresentation.resolve(kind: transaction.type).title)
        if environment.advancedMode { LabeledContent("Source", value: transaction.source) }
        DatePicker("Occurred", selection: $date)
        TextField("Quantity", text: $quantity).keyboardType(.decimalPad)
        TextField("Unit price", text: $unitPrice).keyboardType(.decimalPad)
        Text("Enter decimal values with a dot. The correction affects this event only.").font(
          .caption
        ).foregroundStyle(.secondary)
        Button("Review correction") { Task { await propose(void: false) } }
        TransactionDeleteButton(transactionID: transactionID, dismissOnSuccess: true)
      } else {
        ProgressView()
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Correct transaction")
      .task {
        do {
          transaction = try await environment.api?.send("transactions/\(transactionID)")
          if let transaction {
            quantity = NSDecimalNumber(decimal: transaction.quantity.decimal).stringValue
            unitPrice =
              transaction.unitPrice.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? ""
            date = transaction.occurredAt
          }
        } catch { self.error = error.localizedDescription }
      }
      .navigationDestination(item: $reviewID) { ChangeSetReview(changeSetID: $0) }
  }
  private func propose(void: Bool) async {
    guard let transaction, let api = environment.api else { return }
    do {
      let body: [String: JSONValue] = [
        "accountId": .string(transaction.accountId.uuidString),
        "assetId": .string(transaction.assetId.uuidString), "type": .string(transaction.type),
        "occurredAt": .string(date.ISO8601Format()), "quantity": .string(quantity),
        "unitPrice": unitPrice.isEmpty ? .null : .string(unitPrice),
        "currency": .string(transaction.currency),
      ]
      let proposal: ChangeSet = try await api.send(
        "transactions/\(transactionID)", method: void ? "DELETE" : "PATCH", body: void ? nil : body)
      reviewID = proposal.id
    } catch { self.error = error.localizedDescription }
  }
}

struct TransactionDeleteButton: View {
  let transactionID: UUID
  var dismissOnSuccess = false
  var body: some View {
    Color.clear.frame(height: 0).modifier(
      TransactionRemovalActions(
        transactionID: transactionID, dismissOnSuccess: dismissOnSuccess, showButton: true))
  }
}

struct TransactionRemovalActions: ViewModifier {
  let transactionID: UUID
  var dismissOnSuccess = false
  var showButton = false
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var confirming = false
  @State private var working = false
  @State private var error: String?
  @State private var pendingChangeID: UUID?
  func body(content: Content) -> some View {
    Group {
      if showButton {
        deleteButton
      } else {
        content
          .swipeActions(allowsFullSwipe: false) { deleteButton }
          .contextMenu { deleteButton }
          .accessibilityAction(named: "Delete transaction") { confirming = true }
      }
    }
    .confirmationDialog(
      "Delete this transaction?", isPresented: $confirming, titleVisibility: .visible
    ) {
      Button("Delete transaction", role: .destructive) { Task { await remove() } }
    } message: {
      Text("Your holdings and chart will be recalculated. A record of this change will be kept.")
    }
    .alert(
      "Couldn’t delete transaction",
      isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
    ) {
      Button("Retry") { Task { await remove() } }
      Button("Cancel", role: .cancel) { error = nil }
    } message: {
      Text(error ?? "Try again.")
    }
  }
  private var deleteButton: some View {
    Button("Delete transaction", role: .destructive) { confirming = true }.disabled(working)
  }
  private func remove() async {
    guard let api = environment.api else { return }
    working = true
    defer { working = false }
    do {
      if pendingChangeID == nil {
        let proposal: ChangeSet = try await api.send(
          "transactions/\(transactionID)", method: "DELETE")
        pendingChangeID = proposal.id
      }
      guard let id = pendingChangeID else { return }
      let _: ChangeSet = try await api.send("change-sets/\(id)/apply", method: "POST")
      await environment.cache?.clear()
      environment.dataRevision += 1
      if dismissOnSuccess { dismiss() }
    } catch { self.error = error.localizedDescription }
  }
}
