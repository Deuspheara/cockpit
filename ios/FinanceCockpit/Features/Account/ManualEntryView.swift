import SwiftUI

enum ManualEntryMode: String, CaseIterable {
  case asset = "Asset"
  case transaction = "Transaction"
  case observation = "Observation"
  case recurring = "Recurring"
}

struct ManualEntryView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var mode: String
  @State private var name = ""
  @State private var symbol = ""
  @State private var assetClass = "etf"
  @State private var accountID = ""
  @State private var assetID = ""
  @State private var quantity = ""
  @State private var price = ""
  @State private var fee = ""
  @State private var notes = ""
  @State private var cashAmount = ""
  @State private var currency = "EUR"
  @State private var transactionType = "BUY"
  @State private var date = Date()
  @State private var accounts: [Account] = []
  @State private var assets: [Asset] = []
  @State private var error: String?
  @State private var working = false
  @State private var reviewID: UUID?
  init(initialMode: ManualEntryMode = .asset, account: Account? = nil) {
    _mode = State(initialValue: initialMode.rawValue)
    _accountID = State(initialValue: account?.id.uuidString ?? "")
    _currency = State(initialValue: account?.baseCurrency ?? "EUR")
  }
  var body: some View {
    Form {
      Picker("Add", selection: $mode) {
        ForEach(ManualEntryMode.allCases, id: \.self) {
          Text($0.rawValue).tag($0.rawValue)
        }
      }
      if mode == "Asset" {
        TextField("Symbol", text: $symbol)
        TextField("Asset name", text: $name)
        Picker("Type", selection: $assetClass) {
          ForEach(["etf", "equity", "crypto", "cash", "other"], id: \.self) { Text($0) }
        }
      } else {
        Picker("Account", selection: $accountID) {
          Text("Choose account").tag("")
          ForEach(accounts.filter { $0.sourceType == "manual" }) {
            Text($0.name).tag($0.id.uuidString)
          }
        }
        Picker("Asset", selection: $assetID) {
          Text("Choose asset").tag("")
          ForEach(assets) { Text("\($0.symbol) · \($0.name)").tag($0.id.uuidString) }
        }
        if mode == "Transaction" {
          Picker("Type", selection: $transactionType) {
            ForEach(
              [
                "BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "FEE",
                "INCOME",
              ], id: \.self
            ) { Text($0) }
          }
        }
        DatePicker(
          mode == "Observation" ? "Observed on" : "Date", selection: $date,
          displayedComponents: [.date])
        if mode == "Recurring" {
          TextField("Monthly cash amount", text: $cashAmount).keyboardType(.decimalPad)
          Text("Planned monthly investment. Actual purchased quantities require confirmation.")
            .font(.caption).foregroundStyle(.secondary)
        } else {
          TextField("Quantity", text: $quantity).keyboardType(.decimalPad)
          TextField("Unit price (optional)", text: $price).keyboardType(.decimalPad)
        }
      }
      if mode == "Transaction" {
        TextField("Fee (optional)", text: $fee).keyboardType(.decimalPad)
        TextField("Notes (optional)", text: $notes, axis: .vertical)
      }
      TextField("Currency", text: $currency).textInputAutocapitalization(.characters)
      if let error { Text(error).foregroundStyle(.red) }
      Button(
        working
          ? "Preparing…" : (mode == "Asset" ? "Create" : "Review changes")
      ) { Task { await submit() } }.disabled(working)
    }
    .navigationTitle("Add to portfolio")
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    .task { await loadOptions() }
    .onChange(of: mode) { _, new in
      if new == "Asset" { assetClass = "etf" }
    }
    .navigationDestination(item: $reviewID) { ChangeSetReview(changeSetID: $0) }
  }
  private func loadOptions() async {
    guard let api = environment.api else { return }
    do {
      accounts = try await api.send("accounts")
      assets = try await api.send("assets")
    } catch { self.error = error.localizedDescription }
  }
  private func decimal(_ text: String) throws -> JSONValue {
    let separator = Locale.current.decimalSeparator ?? "."
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(
      of: separator, with: ".")
    guard
      normalized.range(of: #"^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$"#, options: .regularExpression)
        != nil
    else { throw APIError(message: "Enter a decimal amount without grouping separators.") }
    return .string(normalized)
  }
  private func submit() async {
    guard let api = environment.api, !working else { return }
    working = true
    error = nil
    defer { working = false }
    do {
      if mode == "Asset" {
        let _: Asset = try await api.send(
          "assets", method: "POST",
          body: [
            "symbol": .string(symbol), "name": .string(name), "assetType": .string(assetClass),
            "quoteCurrency": .string(currency.uppercased()),
          ])
        await loadOptions()
        mode = "Observation"
        return
      }
      var body: [String: JSONValue] = [
        "accountId": .string(accountID), "assetId": .string(assetID),
        "currency": .string(currency.uppercased()),
      ]
      let path: String
      if mode == "Recurring" {
        path = "recurring-rules"
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        guard let year = components.year, let month = components.month, let day = components.day
        else { throw APIError(message: "Invalid date") }
        body.merge([
          "startOn": .string(String(format: "%04d-%02d-%02d", year, month, day)),
          "transactionType": .string("BUY"), "inputMode": .string("cash_amount"),
          "cashAmount": try decimal(cashAmount), "cadence": .string("monthly"),
        ]) { _, new in new }
      } else {
        path = mode == "Observation" ? "observations" : "transactions"
        body["quantity"] = try decimal(quantity)
        body[mode == "Observation" ? "observedAt" : "occurredAt"] = .string(date.ISO8601Format())
        if mode == "Transaction" {
          body["type"] = .string(transactionType)
          if !fee.isEmpty { body["feeAmount"] = try decimal(fee) }
          if !notes.isEmpty { body["notes"] = .string(notes) }
        }
        if !price.isEmpty { body["unitPrice"] = try decimal(price) }
      }
      let proposal: ChangeSet = try await api.send(path, method: "POST", body: body)
      reviewID = proposal.id
    } catch { self.error = error.localizedDescription }
  }
}
