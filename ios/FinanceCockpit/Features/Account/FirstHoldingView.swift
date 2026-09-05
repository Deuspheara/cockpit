import SwiftUI

struct HoldingDraft {
  var quantity = ""
  var price = ""
  var date = Date()
  static func decimal(_ text: String, locale: Locale = .current) throws -> String {
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: locale.decimalSeparator ?? ".", with: ".")
    guard
      normalized.range(of: #"^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$"#, options: .regularExpression)
        != nil
    else {
      throw APIError(message: "Enter a positive amount or zero, without grouping separators.")
    }
    return normalized
  }
  func body(account: Account, asset: Asset) throws -> [String: JSONValue] {
    var result: [String: JSONValue] = [
      "accountId": .string(account.id.uuidString), "assetId": .string(asset.id.uuidString),
      "quantity": .string(try Self.decimal(quantity)), "observedAt": .string(date.ISO8601Format()),
      "currency": .string(asset.quoteCurrency),
    ]
    if account.assetClass == "cash" {
      result["unitPrice"] = .string("1")
    } else if !price.isEmpty {
      result["unitPrice"] = .string(try Self.decimal(price))
    }
    return result
  }
}

struct FirstHoldingView: View {
  let account: Account
  var showsClose = true
  var onFinish: () -> Void
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var assets: [Asset] = []
  @State private var selectedID: UUID?
  @State private var newAsset = false
  @State private var symbol = ""
  @State private var assetName = ""
  @State private var assetType = "equity"
  @State private var currency: String
  @State private var holding = HoldingDraft()
  @State private var amountPresented = false
  @State private var reviewID: UUID?
  @State private var working = false
  @State private var loaded = false
  @State private var error: String?
  private var isCash: Bool { account.assetClass == "cash" }
  private var selected: Asset? { assets.first { $0.id == selectedID } }

  init(account: Account, showsClose: Bool = true, onFinish: @escaping () -> Void) {
    self.account = account
    self.showsClose = showsClose
    self.onFinish = onFinish
    _currency = State(initialValue: account.baseCurrency)
    _assetType = State(
      initialValue: account.assetClass == "equities"
        ? "equity" : account.assetClass == "crypto" ? "crypto" : "other")
  }
  var body: some View {
    Group {
      if isCash { amountForm } else { assetForm }
    }
    .navigationTitle(isCash ? "First balance" : "First holding")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if showsClose {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }.disabled(working)
        }
      }
    }
    .interactiveDismissDisabled(working)
    .task { await loadAssets() }
    .navigationDestination(isPresented: $amountPresented) {
      amountForm.navigationTitle("Holding details").navigationBarTitleDisplayMode(.inline)
    }
    .navigationDestination(item: $reviewID) { id in
      ChangeSetReview(changeSetID: id, onApplied: onFinish, holdingSummary: reviewSummary)
    }
  }
  private var reviewSummary: String {
    let amount = (try? HoldingDraft.decimal(holding.quantity)) ?? holding.quantity
    let unit = isCash ? account.baseCurrency : selected?.symbol ?? "units"
    var summary =
      "\(account.name)\n\(amount) \(unit)\nAs of \(holding.date.formatted(date: .abbreviated, time: .omitted))"
    if !isCash, !holding.price.isEmpty {
      summary += "\nUnit price: \(holding.price) \(selected?.quoteCurrency ?? currency)"
    }
    return summary
  }
  private var assetForm: some View {
    Form {
      Section {
        Text("Add a holding to \(account.name)").font(.headline)
        Text("Choose what you own. We’ll ask for the quantity next.").foregroundStyle(.secondary)
      }
      Section("Choose an asset") {
        if !loaded { ProgressView("Loading assets…") }
        Picker("Asset", selection: $selectedID) {
          Text("Choose asset").tag(nil as UUID?)
          ForEach(assets) { Text("\($0.symbol) · \($0.name)").tag(Optional($0.id)) }
        }.disabled(newAsset || working)
        Toggle("Add a new asset", isOn: $newAsset).disabled(working)
        if newAsset {
          TextField("Symbol, e.g. AAPL", text: $symbol).textInputAutocapitalization(.characters)
          TextField("Asset name", text: $assetName)
          Picker("Type", selection: $assetType) {
            Text("Stock").tag("equity")
            Text("ETF").tag("etf")
            Text("Crypto").tag("crypto")
            Text("Other").tag("other")
          }
          TextField("Price currency", text: $currency).textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
        }
      }
      Section {
        if let error { Text(error).foregroundStyle(.red) }
        if !loaded { Button("Retry loading assets") { Task { await loadAssets() } } }
        Button(working ? "Preparing…" : "Continue") { Task { await chooseAsset() } }
          .disabled(working || !loaded || !assetValid)
        Button("Skip for now", action: onFinish).disabled(working)
      }
    }
  }
  private var assetValid: Bool {
    if !newAsset { return selected != nil }
    return (1...32).contains(symbol.trimmingCharacters(in: .whitespacesAndNewlines).count)
      && (1...150).contains(assetName.trimmingCharacters(in: .whitespacesAndNewlines).count)
      && currency.uppercased().range(of: "^[A-Z]{3}$", options: .regularExpression) != nil
  }
  private var amountValid: Bool {
    (try? HoldingDraft.decimal(holding.quantity)) != nil
      && (isCash || holding.price.isEmpty || (try? HoldingDraft.decimal(holding.price)) != nil)
  }
  private var amountForm: some View {
    Form {
      Section {
        Text(
          isCash
            ? "What is your current balance?" : "How much \(selected?.symbol ?? "") do you own?"
        ).font(.headline)
        LabeledContent("Account", value: account.name)
        LabeledContent(
          "Currency", value: isCash ? account.baseCurrency : selected?.quoteCurrency ?? currency)
      }
      Section(isCash ? "Balance" : "Holding") {
        TextField(isCash ? "Balance" : "Quantity", text: $holding.quantity).keyboardType(
          .decimalPad
        )
        .accessibilityIdentifier("holding-quantity")
        if !holding.quantity.isEmpty, (try? HoldingDraft.decimal(holding.quantity)) == nil {
          Text("Enter an amount without grouping separators.").font(.caption).foregroundStyle(.red)
        }
        DatePicker("As of", selection: $holding.date, displayedComponents: .date)
        if !isCash {
          TextField("Unit price (optional)", text: $holding.price).keyboardType(.decimalPad)
          if !holding.price.isEmpty, (try? HoldingDraft.decimal(holding.price)) == nil {
            Text("Enter a price without grouping separators.").font(.caption).foregroundStyle(.red)
          }
          Text(
            "Leave the price blank if you don’t know it. This records what you own today, not a purchase."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
      }.disabled(working)
      Section {
        if let error { Text(error).foregroundStyle(.red) }
        if !loaded { Button("Retry loading assets") { Task { await loadAssets() } } }
        Button(working ? "Preparing…" : "Review holding") { Task { await prepare() } }
          .disabled(working || !loaded || !amountValid)
        Button("Skip for now", action: onFinish).disabled(working)
      }
    }.navigationBarBackButtonHidden(working)
  }
  private func loadAssets() async {
    guard let api = environment.api else { return }
    do {
      let result: [Asset] = try await api.send("assets")
      guard !Task.isCancelled else { return }
      assets = result
      loaded = true
      error = nil
      if isCash {
        selectedID =
          assets.first {
            $0.assetType == "cash" && $0.symbol == account.baseCurrency
              && $0.quoteCurrency == account.baseCurrency
          }?.id
      }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func chooseAsset() async {
    guard !working, let api = environment.api else { return }
    working = true
    error = nil
    defer { working = false }
    do {
      if newAsset {
        let asset: Asset = try await api.send(
          "assets", method: "POST",
          body: [
            "symbol": .string(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()),
            "name": .string(assetName.trimmingCharacters(in: .whitespacesAndNewlines)),
            "assetType": .string(assetType), "quoteCurrency": .string(currency.uppercased()),
          ])
        assets.append(asset)
        selectedID = asset.id
        newAsset = false
      }
      amountPresented = true
    } catch { self.error = error.localizedDescription }
  }
  private func prepare() async {
    guard !working, let api = environment.api else { return }
    working = true
    error = nil
    defer { working = false }
    do {
      if isCash, selected == nil {
        let asset: Asset = try await api.send(
          "assets", method: "POST",
          body: [
            "symbol": .string(account.baseCurrency),
            "name": .string(account.baseCurrency + " cash"),
            "assetType": .string("cash"), "quoteCurrency": .string(account.baseCurrency),
          ])
        assets.append(asset)
        selectedID = asset.id
      }
      guard let selected else { throw APIError(message: "Choose an asset first.") }
      let change: ChangeSet = try await api.send(
        "observations", method: "POST", body: holding.body(account: account, asset: selected))
      reviewID = change.id
    } catch { self.error = error.localizedDescription }
  }
}
