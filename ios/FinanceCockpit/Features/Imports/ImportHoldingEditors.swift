import SwiftUI

struct ImportPositionEditor: View {
  @State var session: ImportSessionDTO
  @State var position: ImportSessionDTO.Extraction.Candidate
  let onSaved: (ImportSessionDTO) -> Void
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var selectedMatch: ImportSessionDTO.Extraction.Candidate.Match?
  @State private var name: String
  @State private var symbol: String
  @State private var quantity: String
  @State private var value: String
  @State private var currency: String
  @State private var working = false
  @State private var error: String?

  init(
    session: ImportSessionDTO, position: ImportSessionDTO.Extraction.Candidate,
    onSaved: @escaping (ImportSessionDTO) -> Void
  ) {
    _session = State(initialValue: session)
    _position = State(initialValue: position)
    self.onSaved = onSaved
    _name = State(initialValue: position.name ?? "")
    _symbol = State(initialValue: position.symbol ?? "")
    _quantity = State(initialValue: position.quantity.map(Self.decimal) ?? "")
    _value = State(initialValue: position.marketValue.map(Self.decimal) ?? "")
    _currency = State(initialValue: position.currency ?? session.extraction?.currency ?? "EUR")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Group {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 5) {
            Text(position.name ?? position.symbol ?? "Unknown instrument").font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
              ImportBadge(text: "From screenshot", color: .secondary)
              if position.quantitySource == "estimated" { ImportBadge(text: "Estimated", color: .blue) }
              if position.symbol == nil || position.matchStatus == "ambiguous" {
                ImportBadge(text: "Confirm investment", color: .secondary)
              } else if position.matchStatus == "matched" {
                ImportBadge(text: "Matched", color: .green)
              } else {
                ImportBadge(text: "From its label", color: .secondary)
              }
              if position.sourceLines > 1 { ImportBadge(text: "\(position.sourceLines) lines combined", color: .secondary) }
            }

          }
          Spacer()
          VStack(alignment: .trailing, spacing: 4) {
            Text(position.marketValue.map { FinanceFormat.amount($0, currency: currency) } ?? "Value unknown")
              .monospacedDigit()
            Text(position.quantity.map { "\(FinanceFormat.quantity($0)) units" } ?? "Quantity unknown")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
        .contentShape(Rectangle())
      }
      Group {
        if position.symbol == nil || position.matchStatus == "ambiguous" {
          TextField("Investment name", text: $name).textFieldStyle(.roundedBorder)
          Text("We’ll look up the investment from its name. You don’t need to know its ticker.")
            .font(.callout).foregroundStyle(.secondary)
        }
        if let matches = position.matchCandidates, !matches.isEmpty {
          Text("Choose the investment shown in your screenshot").font(.callout)
          ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
            Button {
              selectedMatch = match
              name = match.name
              symbol = match.symbol
            } label: {
              VStack(alignment: .leading) {
                Text(match.name)
                Text([match.symbol, match.exchange, match.isin, match.currency].compactMap { $0 }.joined(separator: " · "))
                  .font(.caption).foregroundStyle(.secondary)
                if selectedMatch?.symbol == match.symbol && selectedMatch?.isin == match.isin { Text("Selected").font(.caption) }
              }
            }.buttonStyle(.bordered)
          }
        }
        LabeledContent("Position value") {
          TextField("Value", text: $value).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
        }
        LabeledContent("Currency") {
          TextField("Currency", text: $currency).textInputAutocapitalization(.characters).multilineTextAlignment(.trailing)
        }
        Text("Quantity is estimated from the position value and an available share price. If there’s no suitable price, you can still save the value.")
          .font(.callout).foregroundStyle(.secondary)
        DisclosureGroup("Edit quantity or ticker") {
          TextField("Quantity (optional)", text: $quantity).keyboardType(.decimalPad).accessibilityIdentifier("import-quantity")
          TextField("Ticker (optional)", text: $symbol).textInputAutocapitalization(.characters)
        }
        if let at = position.quoteAt, let price = position.quotePrice {
          Text("Estimate uses \(FinanceFormat.amount(price, currency: position.quoteCurrency ?? currency)) · \(at.formatted(date: .abbreviated, time: .omitted))")
            .font(.caption).foregroundStyle(.secondary)
        }
        Button(working ? "Saving…" : "Save") { Task { await save() } }
          .disabled(working)
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
      }
    }
    .padding(12)
    .background(Color.primary.opacity(0.04), in: .rect(cornerRadius: 14))
  }

  private func save() async {
    guard let api = environment.api, position.candidateId != nil else { return }
    working = true
    defer { working = false }
    do {
      var correction = position.correction(name: name, symbol: symbol, quantity: quantity, value: value, currency: currency)
      if let selectedMatch, selectedMatch.name == name, selectedMatch.symbol == symbol {
        correction["isin"] = selectedMatch.isin.map(JSONValue.string) ?? .null
        correction["symbol"] = .string(selectedMatch.symbol)
        correction["name"] = .string(selectedMatch.name)
      }
      let body: [String: JSONValue] = [
        "revision": .number(Decimal(session.revision)),
        "positions": .array([.object(correction)]),
      ]
      let updated: ImportSessionDTO = try await api.send(
        "imports/\(session.id)", method: "PATCH", body: body)
      session = updated
      onSaved(updated)
      if let latest = updated.extraction?.positions.first(where: { $0.candidateId == position.candidateId }) {
        position = latest
        name = latest.name ?? ""
        symbol = latest.symbol ?? ""
        quantity = latest.quantity.map(Self.decimal) ?? ""
        value = latest.marketValue.map(Self.decimal) ?? ""
        currency = latest.currency ?? updated.extraction?.currency ?? currency
        let issues = updated.remainingIssues(for: latest)
        if !issues.isEmpty {
          error = "Changes saved. " + issues.joined(separator: " ")
          return
        }
      }
      dismiss()
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private static func decimal(_ value: Amount) -> String {
    NSDecimalNumber(decimal: value.decimal).stringValue
  }
}

struct ImportDerivativeEditor: View {
  @State var session: ImportSessionDTO
  @State var derivative: ImportSessionDTO.Extraction.Derivative
  let onSaved: (ImportSessionDTO) -> Void
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var underlying: String
  @State private var optionType: String
  @State private var strike: String
  @State private var expiration: String
  @State private var quantity: String
  @State private var value: String
  @State private var currency: String
  @State private var working = false
  @State private var error: String?

  init(
    session: ImportSessionDTO, derivative: ImportSessionDTO.Extraction.Derivative,
    onSaved: @escaping (ImportSessionDTO) -> Void
  ) {
    _session = State(initialValue: session)
    _derivative = State(initialValue: derivative)
    self.onSaved = onSaved
    _underlying = State(initialValue: derivative.underlyingSymbol ?? "")
    _optionType = State(initialValue: derivative.optionType ?? "")
    _strike = State(initialValue: derivative.strike.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _expiration = State(initialValue: derivative.expiration ?? "")
    _quantity = State(initialValue: derivative.quantity.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _value = State(initialValue: derivative.marketValue.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _currency = State(initialValue: derivative.currency ?? "USD")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Group {
        HStack {
          VStack(alignment: .leading, spacing: 5) {
            Text(derivative.name ?? "\((derivative.optionType ?? "Option").capitalized) \(underlying)")
              .font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
              ImportBadge(text: "From screenshot", color: .secondary)
              ImportBadge(text: "Derivative", color: .purple)
              if derivative.quantity == nil { ImportBadge(text: "Value recorded", color: .secondary) }
              if derivative.sourceLines > 1 {
                ImportBadge(text: "\(derivative.sourceLines) lines combined", color: .secondary)
              }
            }
            Text("\(Int((derivative.confidence * 100).rounded()))% extraction confidence")
              .font(.caption2).foregroundStyle(.secondary)
          }
          Spacer()
          Text(derivative.marketValue.map { FinanceFormat.amount($0, currency: derivative.currency ?? currency) } ?? "Value unknown")
            .monospacedDigit()
        }
      }
      Group {
        TextField("Underlying symbol", text: $underlying).textFieldStyle(.roundedBorder)
        Picker("Option type", selection: $optionType) {
          Text("Choose type").tag("")
          Text("Call").tag("call")
          Text("Put").tag("put")
        }
        .pickerStyle(.segmented)
        VStack(alignment: .leading, spacing: 12) {
          TextField("Strike", text: $strike).keyboardType(.decimalPad)
          TextField("Expiration YYYY-MM-DD", text: $expiration)
        }.textFieldStyle(.roundedBorder)
        VStack(alignment: .leading, spacing: 12) {
          TextField("Contracts (optional)", text: $quantity).keyboardType(.decimalPad)
          TextField("Market value", text: $value).keyboardType(.decimalPad)
          TextField("Currency", text: $currency).frame(maxWidth: 82)
        }.textFieldStyle(.roundedBorder)
        Button(working ? "Saving…" : "Save") { Task { await save() } }.disabled(working)
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
      }
    }
    .padding(12)
    .background(Color.primary.opacity(0.04), in: .rect(cornerRadius: 14))
  }
  private func save() async {
    guard let api = environment.api, let id = derivative.candidateId else { return }
    working = true
    defer { working = false }
    do {
      let body: [String: JSONValue] = [
        "revision": .number(Decimal(session.revision)),
        "derivatives": .array([.object([
          "candidateId": .string(id.uuidString.lowercased()), "underlyingSymbol": .string(underlying),
          "optionType": optionType.isEmpty ? .null : .string(optionType),
          "strike": strike.isEmpty ? .null : .string(strike.replacingOccurrences(of: ",", with: ".")),
          "expiration": expiration.isEmpty ? .null : .string(expiration),
          "quantity": quantity.isEmpty ? .null : .string(quantity.replacingOccurrences(of: ",", with: ".")),
          "marketValue": value.isEmpty ? .null : .string(value.replacingOccurrences(of: ",", with: ".")),
          "currency": .string(currency.uppercased()),
        ])]),
      ]
      let updated: ImportSessionDTO = try await api.send(
        "imports/\(session.id)", method: "PATCH", body: body)
      session = updated
      onSaved(updated)
      if let latest = updated.extraction?.derivatives.first(where: { $0.candidateId == derivative.candidateId }) {
        derivative = latest
        let issues = updated.remainingIssues(for: latest)
        if !issues.isEmpty {
          error = "Changes saved. " + issues.joined(separator: " ")
          return
        }
      }
      dismiss()
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct ImportBadge: View {
  let text: String
  let color: Color
  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .foregroundStyle(color)
      .padding(.horizontal, 7).padding(.vertical, 4)
      .background(color.opacity(0.1), in: Capsule())
  }
}


extension ImportSessionDTO.Extraction.Candidate {
  func correction(name: String, symbol: String, quantity: String, value: String, currency: String) -> [String: JSONValue] {
    func clean(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    func amount(_ text: String) -> String { clean(text).replacingOccurrences(of: ",", with: ".") }
    func decimal(_ value: Amount?) -> String { value.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "" }
    func optional(_ text: String) -> JSONValue { text.isEmpty ? .null : .string(text) }
    guard let candidateId else { return [:] }
    var edit: [String: JSONValue] = ["candidateId": .string(candidateId.uuidString.lowercased())]
    if clean(name) != (self.name ?? "") {
      edit["name"] = optional(clean(name))
      edit["isin"] = .null
      edit["symbol"] = .null
    }
    if clean(symbol) != (self.symbol ?? "") { edit["symbol"] = optional(clean(symbol)) }
    if amount(quantity) != decimal(self.quantity) { edit["quantity"] = optional(amount(quantity)) }
    if amount(value) != decimal(marketValue) { edit["marketValue"] = optional(amount(value)) }
    if clean(currency).uppercased() != self.currency { edit["currency"] = optional(clean(currency).uppercased()) }
    return edit
  }
}


extension ImportSessionDTO {
  func remainingIssues(for p: Extraction.Candidate) -> [String] {
    if let issues = candidateIssues?[p.candidateId?.uuidString.lowercased() ?? ""] { return issues }
    var issues: [String] = []
    if (p.symbol ?? "").isEmpty || p.matchStatus == "ambiguous" {
      issues.append("We couldn’t identify a unique investment. Refine its name or enter its exact ticker under Edit quantity or ticker.")
    }
    if p.quantity == nil && p.marketValue == nil { issues.append("Enter the position value or quantity.") }
    if (p.currency ?? extraction?.currency) == nil { issues.append("Enter the currency.") }
    if (p.quantity?.decimal ?? 0) < 0 || (p.marketValue?.decimal ?? 0) < 0 { issues.append("Check the negative quantity or value.") }
    return issues
  }
  func remainingIssues(for d: Extraction.Derivative) -> [String] {
    if let issues = candidateIssues?[d.candidateId?.uuidString.lowercased() ?? ""] { return issues }
    var issues: [String] = []
    if d.underlyingSymbol == nil || d.optionType == nil || d.expiration == nil || (d.strike?.decimal ?? 0) <= 0 {
      issues.append("Enter the underlying, option type, positive strike and expiration.")
    }
    if d.quantity == nil && d.marketValue == nil { issues.append("Enter the market value or contract quantity.") }
    if d.currency == nil { issues.append("Enter the currency.") }
    if (d.quantity?.decimal ?? 0) < 0 || (d.marketValue?.decimal ?? 0) < 0 { issues.append("Check the negative quantity or value.") }
    return issues
  }
}
