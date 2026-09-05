import SwiftUI

struct ChangeSetReview: View {
  let changeSetID: UUID
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var change: ChangeSet?
  @State private var error: String?
  @State private var working = false
  var body: some View {
    List {
      if let change {
        Section {
          Text(change.title).font(.headline)
          Text(change.summary).foregroundStyle(.secondary)
        }
        if let effects = change.effects {
          Section("Portfolio impact") {
            Text("\(effects.historicalTransactions) historical transaction(s) affected")
            ForEach(Array(effects.ledgerQuantityChanges.enumerated()), id: \.offset) { _, effect in
              VStack(alignment: .leading) {
                Text(change.labels?[effect.assetId.uuidString.lowercased()] ?? "Asset")
                Text(
                  "\(change.labels?[effect.accountId.uuidString.lowercased()] ?? "Account"): \(FinanceFormat.quantity(effect.deltaQuantity)) units"
                ).foregroundStyle(.secondary)
              }
            }
            Text(
              "Valuation and returns will be recalculated from the corrected records. Unknown prices and cost basis remain unavailable."
            ).font(.caption).foregroundStyle(.secondary)
          }
        }
        ForEach(change.operations) { operation in
          Section(operation.table.replacingOccurrences(of: "_", with: " ").capitalized) {
            ForEach(
              Array(Set((operation.before ?? [:]).keys).union((operation.after ?? [:]).keys))
                .sorted(), id: \.self
            ) { key in
              let before = operation.before?[key]
              let after = operation.after?[key]
              if before != after {
                VStack(alignment: .leading, spacing: 4) {
                  Text(key).font(.caption).foregroundStyle(.secondary)
                  if let before { Text("Before: \(label(before, change: change))") }
                  if let after { Text("After: \(label(after, change: change))") }
                }.textSelection(.enabled)
              }
            }
          }
        }
        Section {
          if change.status == "draft" {
            Button("Apply reviewed changes") { Task { await action("apply") } }.disabled(working)
            Button("Reject", role: .destructive) { Task { await action("reject") } }.disabled(
              working)
          } else if change.status == "applied" {
            HStack(spacing: 8) {
              AppIcon(name: .connected, size: 18)
              Text("Applied")
            }
            .accessibilityElement(children: .combine)
            Button("Undo changes") { Task { await action("undo") } }.disabled(working)
          } else {
            Text(change.status.capitalized)
          }
        }
      } else if error == nil {
        ProgressView()
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Review changes").navigationBarTitleDisplayMode(.inline)
      .task {
        do { change = try await environment.api?.send("change-sets/\(changeSetID)") } catch {
          self.error = error.localizedDescription
        }
      }
  }
  private func label(_ value: JSONValue, change: ChangeSet) -> String {
    if case .string(let id) = value, let name = change.labels?[id.lowercased()] { return name }
    return value.display
  }
  private func action(_ action: String) async {
    working = true
    defer { working = false }
    do {
      change = try await environment.api?.send(
        "change-sets/\(changeSetID)/\(action)", method: "POST")
      environment.dataRevision += 1
    } catch { self.error = error.localizedDescription }
  }
}
