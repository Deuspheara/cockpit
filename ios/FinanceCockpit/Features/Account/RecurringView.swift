import SwiftUI

struct RecurringRule: Codable, Identifiable, Sendable {
  let id: UUID
  let seriesId: UUID
  let accountId: UUID
  let assetId: UUID
  let transactionType: String
  let inputMode: String
  let quantity: Amount?
  let cashAmount: Amount?
  let currency: String
  let cadence: String
  let interval: Int
  let weekday: Int?
  let dayOfMonth: Int?
  let startOn: String
  let endOn: String?
  let autoPost: Bool
  let enabled: Bool
  func replacement(start: String, value: String) -> [String: JSONValue] {
    var body: [String: JSONValue] = [
      "accountId": .string(accountId.uuidString), "assetId": .string(assetId.uuidString),
      "transactionType": .string(transactionType), "inputMode": .string(inputMode),
      "currency": .string(currency), "cadence": .string(cadence),
      "interval": .number(Decimal(interval)), "startOn": .string(start),
      "autoPost": .bool(autoPost),
      inputMode == "quantity" ? "quantity" : "cashAmount": .string(value),
    ]
    if let weekday { body["weekday"] = .number(Decimal(weekday)) }
    if let dayOfMonth { body["dayOfMonth"] = .number(Decimal(dayOfMonth)) }
    return body
  }
}
struct RecurringOccurrence: Codable, Identifiable, Sendable {
  let id: UUID
  let dueAt: Date
  let status: String
  let transactionId: UUID?
}
struct RecurringView: View {
  var accountID: UUID? = nil
  @Environment(AppEnvironment.self) private var environment
  @State private var rules: [RecurringRule] = []
  @State private var assets: [Asset] = []
  @State private var accounts: [Account] = []
  @State private var error: String?
  var body: some View {
    List {
      ForEach(rules.filter { accountID == nil || $0.accountId == accountID }) { rule in
        NavigationLink {
          RecurringRuleView(rule: rule)
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(
              "\(assets.first { $0.id == rule.assetId }?.symbol ?? "Investment") · \(rule.cadence)"
            ).font(.headline)
            Text(accounts.first { $0.id == rule.accountId }?.name ?? "Account").foregroundStyle(
              .secondary)
            Text(
              "From \(rule.startOn)\(rule.endOn.map { " through " + $0 } ?? "") · \(rule.enabled ? "Active version" : "Replaced")"
            ).font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      if rules.isEmpty && error == nil {
        AppEmptyState(
          title: "No recurring rules",
          description: "Create a recurring investment from Add manually in Portfolio.",
          icon: .recurring)
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Recurring investments")
      .task(id: environment.dataRevision) {
        do {
          guard let api = environment.api else { return }
          async let r: [RecurringRule] = api.send("recurring-rules")
          async let a: [Asset] = api.send("assets")
          async let c: [Account] = api.send("accounts")
          (rules, assets, accounts) = try await (r, a, c)
          error = nil
        } catch { self.error = error.localizedDescription }
      }
  }
}
struct RecurringRuleView: View {
  let rule: RecurringRule
  @Environment(AppEnvironment.self) private var environment
  @State private var occurrences: [RecurringOccurrence] = []
  @State private var effective = Date()
  @State private var amount = ""
  @State private var reviewID: UUID?
  @State private var error: String?
  @State private var working = false
  var body: some View {
    Form {
      Section("Rule version") {
        LabeledContent("Start", value: rule.startOn)
        LabeledContent("End", value: rule.endOn ?? "Open ended")
        LabeledContent(
          "Mode",
          value: rule.autoPost ? "Exact quantity · auto-post" : "Planned · confirmation required")
        Text(
          "Changes are previewed before application. Posted transactions affected by a retrospective edit are listed for review."
        ).font(.caption).foregroundStyle(.secondary)
      }
      Section("Correct this series") {
        DatePicker("Effective date", selection: $effective, displayedComponents: .date)
        TextField(
          rule.inputMode == "quantity" ? "New quantity" : "New amount in \(rule.currency)",
          text: $amount
        ).keyboardType(.decimalPad)
        Button("Preview change from date") {
          Task {
            await propose(
              "change-from-date",
              body: [
                "effectiveOn": .string(day(effective)),
                "replacement": .object(
                  rule.replacement(
                    start: day(effective), value: amount.replacingOccurrences(of: ",", with: "."))),
              ])
          }
        }.disabled(working || amount.isEmpty)
        Button("Preview stop from date", role: .destructive) {
          Task { await propose("stop", body: ["effectiveOn": .string(day(effective))]) }
        }.disabled(working)
        Button("Preview entire-series replacement") {
          Task {
            await propose(
              "edit-series",
              body: rule.replacement(
                start: rule.startOn, value: amount.replacingOccurrences(of: ",", with: ".")))
          }
        }.disabled(working || amount.isEmpty)
      }
      Section("Occurrences") {
        ForEach(occurrences) { occurrence in
          NavigationLink {
            RecurringOccurrenceView(rule: rule, occurrence: occurrence)
          } label: {
            LabeledContent(
              occurrence.dueAt.formatted(date: .abbreviated, time: .omitted),
              value: occurrence.status.capitalized)
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Recurring rule").navigationBarTitleDisplayMode(.inline)
      .task(id: environment.dataRevision) {
        do {
          occurrences =
            try await environment.api?.send("recurring-rules/\(rule.id)/occurrences") ?? []
        } catch { self.error = error.localizedDescription }
      }
      .navigationDestination(item: $reviewID) { ChangeSetReview(changeSetID: $0) }
  }
  private func day(_ date: Date) -> String {
    date.formatted(.iso8601.year().month().day().dateSeparator(.dash))
  }
  private func propose(_ route: String, body: [String: JSONValue]) async {
    working = true
    defer { working = false }
    do {
      let change: ChangeSet? = try await environment.api?.send(
        "recurring-rules/\(rule.id)/\(route)", method: "POST", body: body)
      reviewID = change?.id
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
struct RecurringOccurrenceView: View {
  let rule: RecurringRule
  let occurrence: RecurringOccurrence
  @Environment(AppEnvironment.self) private var environment
  @State private var quantity = ""
  @State private var price = ""
  @State private var reviewID: UUID?
  @State private var error: String?
  @State private var working = false
  var body: some View {
    Form {
      Section {
        LabeledContent(
          "Scheduled", value: occurrence.dueAt.formatted(date: .abbreviated, time: .omitted))
        LabeledContent("Status", value: occurrence.status.capitalized)
      }
      if occurrence.status == "planned" {
        Section("Confirm actual transaction") {
          TextField("Actual quantity", text: $quantity).keyboardType(.decimalPad)
          TextField("Unit price (optional)", text: $price).keyboardType(.decimalPad)
          Button("Preview confirmation") { Task { await propose("confirm") } }.disabled(
            quantity.isEmpty || working)
          Text(
            "A cash budget never implies a purchase quantity. Enter the executed quantity from your statement."
          ).font(.caption).foregroundStyle(.secondary)
        }
      }
      if let transactionID = occurrence.transactionId {
        NavigationLink("Edit posted transaction") {
          TransactionEditView(transactionID: transactionID)
        }
      }
      Section {
        Button("Preview skip occurrence", role: .destructive) { Task { await propose("skip") } }
          .disabled(working || occurrence.status == "skipped")
        Button("Preview detach from series") { Task { await propose("detach") } }.disabled(
          working || occurrence.status == "detached")
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Occurrence").navigationBarTitleDisplayMode(.inline)
      .navigationDestination(item: $reviewID) { ChangeSetReview(changeSetID: $0) }
  }
  private func propose(_ action: String) async {
    working = true
    defer { working = false }
    do {
      var body: [String: JSONValue] = [:]
      if action == "confirm" {
        body = [
          "accountId": .string(rule.accountId.uuidString),
          "assetId": .string(rule.assetId.uuidString), "type": .string(rule.transactionType),
          "occurredAt": .string(occurrence.dueAt.ISO8601Format()),
          "quantity": .string(quantity.replacingOccurrences(of: ",", with: ".")),
          "currency": .string(rule.currency),
        ]
        if !price.isEmpty {
          body["unitPrice"] = .string(price.replacingOccurrences(of: ",", with: "."))
        }
      }
      let change: ChangeSet? = try await environment.api?.send(
        "recurring-occurrences/\(occurrence.id)/\(action)", method: "POST", body: body)
      reviewID = change?.id
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
