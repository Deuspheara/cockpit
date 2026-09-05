import SwiftUI

struct ImportConversationCard: View {
  let session: ImportSessionDTO
  let onSessionChange: (ImportSessionDTO) -> Void
  let onAddScreenshots: () -> Void

  @Environment(AppEnvironment.self) private var environment
  @State private var accountName: String
  @State private var observedAt: Date
  @State private var change: ChangeSet?
  @State private var working = false
  @State private var error: String?

  init(
    session: ImportSessionDTO,
    onSessionChange: @escaping (ImportSessionDTO) -> Void,
    onAddScreenshots: @escaping () -> Void
  ) {
    self.session = session
    self.onSessionChange = onSessionChange
    self.onAddScreenshots = onAddScreenshots
    _accountName = State(initialValue: session.extraction?.likelyAccountName ?? "")
    _observedAt = State(initialValue: session.extraction?.capturedAt ?? Date())
  }

  private var blockers: [String] { session.blockers ?? session.questions ?? [] }
  private var warnings: [String] { session.warnings ?? [] }
  private var itemCount: Int {
    (session.extraction?.positions.count ?? 0) + (session.extraction?.derivatives.count ?? 0)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 10) {
        AppIcon(name: .review, size: 20)
          .frame(width: 34, height: 34)
          .background(Color.accentColor.opacity(0.12), in: Circle())
        VStack(alignment: .leading, spacing: 3) {
          Text("Review screenshot import").font(.headline)
          Text("\(itemCount) item\(itemCount == 1 ? "" : "s") found")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        ImportBadge(
          text: blockers.isEmpty ? "Ready" : "\(blockers.count) need attention",
          color: blockers.isEmpty ? .green : .orange)
      }

      if let extraction = session.extraction {
        VStack(alignment: .leading, spacing: 10) {
          TextField("Account name", text: $accountName)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel("Imported account name")
          DatePicker("Observed", selection: $observedAt, displayedComponents: .date)
          if extraction.capturedAtInferred {
            Label("Upload date used — tap the date to correct it", systemImage: "wand.and.stars")
              .font(.caption).foregroundStyle(.secondary)
          }
          Button("Save account details") { Task { await saveDetails() } }
            .font(.callout.weight(.semibold))
            .disabled(working || accountName.trimmingCharacters(in: .whitespaces).isEmpty)
        }

        VStack(spacing: 10) {
          ForEach(extraction.positions, id: \.candidateId) { position in
            ImportPositionEditor(session: session, position: position) { updated in
              onSessionChange(updated)
            }
          }
          ForEach(extraction.derivatives, id: \.candidateId) { derivative in
            ImportDerivativeEditor(session: session, derivative: derivative) { updated in
              onSessionChange(updated)
            }
          }
        }
      }

      if !blockers.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Label("Needs attention", systemImage: "exclamationmark.triangle")
            .font(.subheadline.weight(.semibold))
          ForEach(blockers, id: \.self) { Text("• \($0)").font(.caption) }
        }
        .foregroundStyle(.orange)
      }
      if !warnings.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Text("Check these estimates").font(.subheadline.weight(.semibold))
          ForEach(warnings, id: \.self) { Text("• \($0)").font(.caption) }
        }
        .foregroundStyle(.secondary)
      }

      if let change {
        ImportChangeSetCard(change: change) { action in await changeAction(action) }
      } else if session.extraction != nil && blockers.isEmpty && session.status != "applied" {
        Button {
          Task { await prepare() }
        } label: {
          HStack {
            Text("Review \(itemCount) imported position\(itemCount == 1 ? "" : "s")")
            Spacer()
            if working { ProgressView().tint(.white) } else { AppIcon(name: .arrowRight, size: 16) }
          }
          .frame(minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .disabled(working)
      }

      Button("Add another screenshot", action: onAddScreenshots)
        .disabled(working || session.changeSetId != nil)
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    .padding(16)
    .background(Color.primary.opacity(0.045), in: .rect(cornerRadius: 18))
    .task(id: session.changeSetId) {
      guard let id = session.changeSetId, change == nil else { return }
      do { change = try await environment.api?.send("change-sets/\(id)") } catch {
        self.error = error.localizedDescription
      }
    }
  }

  private func patch(_ body: [String: JSONValue]) async throws -> ImportSessionDTO {
    guard let api = environment.api else { throw APIError(message: "Server unavailable") }
    var values = body
    values["revision"] = .number(Decimal(session.revision))
    return try await api.send("imports/\(session.id)", method: "PATCH", body: values)
  }
  private func saveDetails() async {
    working = true
    defer { working = false }
    do {
      let updated = try await patch([
        "likelyAccountName": .string(accountName.trimmingCharacters(in: .whitespacesAndNewlines)),
        "capturedAt": .string(ISO8601DateFormatter().string(from: observedAt)),
      ])
      onSessionChange(updated)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func prepare() async {
    working = true
    defer { working = false }
    do {
      var current = session
      let name = accountName.trimmingCharacters(in: .whitespacesAndNewlines)
      if name != session.extraction?.likelyAccountName || observedAt != session.extraction?.capturedAt {
        current = try await patch([
          "likelyAccountName": .string(name),
          "capturedAt": .string(ISO8601DateFormatter().string(from: observedAt)),
        ])
        onSessionChange(current)
      }
      guard (current.blockers ?? current.questions ?? []).isEmpty else { return }
      let body: [String: JSONValue] = name.isEmpty ? [:] : ["accountName": .string(name)]
      change = try await environment.api?.send(
        "imports/\(session.id)/prepare-change-set", method: "POST", body: body)
      let refreshed: ImportSessionDTO? = try await environment.api?.send("imports/\(session.id)")
      if let refreshed { onSessionChange(refreshed) }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func changeAction(_ action: String) async {
    guard let currentChange = change else { return }
    working = true
    defer { working = false }
    do {
      let result: ChangeSet? = try await environment.api?.send(
        "change-sets/\(currentChange.id)/\(action)", method: "POST")
      change = action == "undo" ? nil : result
      environment.dataRevision += 1
      let refreshed: ImportSessionDTO? = try await environment.api?.send("imports/\(session.id)")
      if let refreshed { onSessionChange(refreshed) }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

private struct ImportPositionEditor: View {
  let session: ImportSessionDTO
  let position: ImportSessionDTO.Extraction.Candidate
  let onSaved: (ImportSessionDTO) -> Void
  @Environment(AppEnvironment.self) private var environment
  @State private var expanded = false
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
    self.session = session
    self.position = position
    self.onSaved = onSaved
    _symbol = State(initialValue: position.symbol ?? "")
    _quantity = State(initialValue: position.quantity.map(Self.decimal) ?? "")
    _value = State(initialValue: position.marketValue.map(Self.decimal) ?? "")
    _currency = State(initialValue: position.currency ?? session.extraction?.currency ?? "EUR")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button { expanded.toggle() } label: {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 5) {
            Text(position.name ?? position.symbol ?? "Unknown instrument").font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
              ImportBadge(text: "From screenshot", color: .secondary)
              if position.quantitySource == "estimated" { ImportBadge(text: "Estimated", color: .blue) }
              if position.symbol == nil || position.matchStatus == "ambiguous" {
                ImportBadge(text: "Needs attention", color: .orange)
              } else if position.matchStatus == "matched" {
                ImportBadge(text: "Matched", color: .green)
              } else {
                ImportBadge(text: "Verify match", color: .orange)
              }
              if position.sourceLines > 1 { ImportBadge(text: "\(position.sourceLines) lines combined", color: .secondary) }
            }
            Text("\(Int((position.confidence * 100).rounded()))% extraction confidence")
              .font(.caption2).foregroundStyle(.secondary)
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
      .buttonStyle(.plain)
      if expanded {
        TextField("Symbol", text: $symbol).textFieldStyle(.roundedBorder)
        HStack {
          TextField("Quantity (optional)", text: $quantity).keyboardType(.decimalPad)
          TextField("Market value", text: $value).keyboardType(.decimalPad)
          TextField("Currency", text: $currency).textInputAutocapitalization(.characters)
            .frame(maxWidth: 82)
        }
        .textFieldStyle(.roundedBorder)
        if let at = position.quoteAt, let price = position.quotePrice {
          Text("Estimate uses \(FinanceFormat.amount(price, currency: position.quoteCurrency ?? currency)) · \(at.formatted(date: .abbreviated, time: .omitted))")
            .font(.caption).foregroundStyle(.secondary)
        }
        Button(working ? "Saving…" : "Save correction") { Task { await save() } }
          .disabled(working)
        if let error { Text(error).font(.caption).foregroundStyle(.red) }
      }
    }
    .padding(12)
    .background(Color.primary.opacity(0.04), in: .rect(cornerRadius: 14))
  }

  private func save() async {
    guard let api = environment.api, let id = position.candidateId else { return }
    working = true
    defer { working = false }
    do {
      let body: [String: JSONValue] = [
        "revision": .number(Decimal(session.revision)),
        "positions": .array([.object([
          "candidateId": .string(id.uuidString), "symbol": .string(symbol),
          "quantity": quantity.isEmpty ? .null : .string(quantity.replacingOccurrences(of: ",", with: ".")),
          "marketValue": value.isEmpty ? .null : .string(value.replacingOccurrences(of: ",", with: ".")),
          "currency": .string(currency.uppercased()),
        ])]),
      ]
      let updated: ImportSessionDTO = try await api.send(
        "imports/\(session.id)", method: "PATCH", body: body)
      onSaved(updated)
      expanded = false
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private static func decimal(_ value: Amount) -> String {
    NSDecimalNumber(decimal: value.decimal).stringValue
  }
}

private struct ImportDerivativeEditor: View {
  let session: ImportSessionDTO
  let derivative: ImportSessionDTO.Extraction.Derivative
  let onSaved: (ImportSessionDTO) -> Void
  @Environment(AppEnvironment.self) private var environment
  @State private var expanded = false
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
    self.session = session
    self.derivative = derivative
    self.onSaved = onSaved
    _underlying = State(initialValue: derivative.underlyingSymbol ?? "")
    _optionType = State(initialValue: derivative.optionType ?? "call")
    _strike = State(initialValue: derivative.strike.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _expiration = State(initialValue: derivative.expiration ?? "")
    _quantity = State(initialValue: derivative.quantity.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _value = State(initialValue: derivative.marketValue.map { NSDecimalNumber(decimal: $0.decimal).stringValue } ?? "")
    _currency = State(initialValue: derivative.currency ?? "USD")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button { expanded.toggle() } label: {
        HStack {
          VStack(alignment: .leading, spacing: 5) {
            Text(derivative.name ?? "\((derivative.optionType ?? "Option").capitalized) \(underlying)")
              .font(.subheadline.weight(.semibold))
            HStack(spacing: 6) {
              ImportBadge(text: "From screenshot", color: .secondary)
              ImportBadge(text: "Derivative", color: .purple)
              if derivative.quantity == nil { ImportBadge(text: "Quantity unknown", color: .orange) }
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
      }.buttonStyle(.plain)
      if expanded {
        TextField("Underlying symbol", text: $underlying).textFieldStyle(.roundedBorder)
        Picker("Option type", selection: $optionType) {
          Text("Call").tag("call")
          Text("Put").tag("put")
        }
        .pickerStyle(.segmented)
        HStack {
          TextField("Strike", text: $strike).keyboardType(.decimalPad)
          TextField("Expiration YYYY-MM-DD", text: $expiration)
        }.textFieldStyle(.roundedBorder)
        HStack {
          TextField("Contracts (optional)", text: $quantity).keyboardType(.decimalPad)
          TextField("Market value", text: $value).keyboardType(.decimalPad)
          TextField("Currency", text: $currency).frame(maxWidth: 82)
        }.textFieldStyle(.roundedBorder)
        Button(working ? "Saving…" : "Save correction") { Task { await save() } }.disabled(working)
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
          "candidateId": .string(id.uuidString), "underlyingSymbol": .string(underlying),
          "optionType": .string(optionType),
          "strike": strike.isEmpty ? .null : .string(strike.replacingOccurrences(of: ",", with: ".")),
          "expiration": expiration.isEmpty ? .null : .string(expiration),
          "quantity": quantity.isEmpty ? .null : .string(quantity.replacingOccurrences(of: ",", with: ".")),
          "marketValue": value.isEmpty ? .null : .string(value.replacingOccurrences(of: ",", with: ".")),
          "currency": .string(currency.uppercased()),
        ])]),
      ]
      let updated: ImportSessionDTO = try await api.send(
        "imports/\(session.id)", method: "PATCH", body: body)
      onSaved(updated)
      expanded = false
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

private struct ImportChangeSetCard: View {
  let change: ChangeSet
  let action: (String) async -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(change.status == "applied" ? "Import applied" : "Ready to apply", systemImage: change.status == "applied" ? "checkmark.circle.fill" : "checkmark.shield")
        .font(.headline)
      Text(change.summary).font(.callout).foregroundStyle(.secondary)
      Text("\(change.operations.count) record\(change.operations.count == 1 ? "" : "s") will be created")
        .font(.caption).foregroundStyle(.secondary)
      if change.status == "draft" {
        Button("Apply imported positions") { Task { await action("apply") } }
          .buttonStyle(.borderedProminent)
      } else if change.status == "applied" {
        Button("Undo import") { Task { await action("undo") } }
      }
    }
    .padding(14)
    .background(Color.accentColor.opacity(0.09), in: .rect(cornerRadius: 14))
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
