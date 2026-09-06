import SwiftUI
import UniformTypeIdentifiers

struct CSVImportView: View {
  var accountID: UUID? = nil
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var model = CSVImportModel()
  @State private var choosing = false
  @State private var destinationEditor: CSVDestinationEditor?
  var body: some View {
    Form {
      if let preview = model.preview {
        Section {
          Text(preview.filename).font(.headline)
          Text("Trade Republic").foregroundStyle(.secondary)
        }
        if let result = preview.result {
          Section(
            result.skipped + result.conflicts > 0
              ? "Import completed with warnings"
              : result.imported == 0 ? "Already up to date" : "Import complete"
          ) {
            LabeledContent("Transactions added", value: "\(result.imported)")
            LabeledContent("Duplicates ignored", value: "\(result.duplicates)")
            LabeledContent("Rows skipped", value: "\(result.skipped)")
            LabeledContent("Conflicts", value: "\(result.conflicts)")
            LabeledContent("Positions updated", value: "\(result.positionsUpdated)")
            if let queued = result.marketDataQueued, queued > 0 {
              LabeledContent("Securities queued for pricing", value: "\(queued)")
            }
            if let unresolved = result.unresolvedSecurities, unresolved > 0 {
              Text("\(unresolved) securities are resolving in the background. Import is complete.")
                .font(.caption).foregroundStyle(.secondary)
            }
            LabeledContent(
              "Last imported",
              value: result.completedAt.formatted(date: .abbreviated, time: .shortened))
          }.accessibilityIdentifier("csv-result")
        } else {
          Section("Preview") {
            LabeledContent("Rows", value: "\(preview.summary.rows)")
            LabeledContent("New transactions", value: "\(preview.summary.new)")
            LabeledContent("Already imported", value: "\(preview.summary.duplicates)")
            LabeledContent("Warnings", value: "\(preview.summary.warnings)")
            if preview.summary.conflicts > 0 {
              LabeledContent("Conflicts", value: "\(preview.summary.conflicts)")
            }
            if preview.summary.skipped > 0 {
              LabeledContent("Rows skipped", value: "\(preview.summary.skipped)")
            }
          }.accessibilityIdentifier("csv-preview")
          Section("Accounts") {
            ForEach(preview.destinations) { destination in
              Button {
                destinationEditor = CSVDestinationEditor(
                  destinations: preview.destinations, candidates: preview.candidates)
              } label: {
                VStack(alignment: .leading) {
                  Text(destination.name).foregroundStyle(.primary)
                  Text(
                    destination.included
                      ? "\(destination.accountId == nil ? "Create account" : "Update account") · \(destination.summary.new) new"
                      : "Not included"
                  )
                  .font(.caption).foregroundStyle(.secondary)
                }
              }.disabled(model.working)
            }
          }
          if !preview.categories.isEmpty {
            Section("New transactions detected") {
              LabeledContent("Assets", value: "\(preview.assets)")
              ForEach(preview.categories.keys.sorted(), id: \.self) { key in
                LabeledContent(eventTitle(key), value: "\(preview.categories[key] ?? 0)")
              }
            }
          }
          if preview.status == "expired" || preview.status == "cancelled"
            || preview.expiresAt <= Date()
          {
            Text("This preview is no longer available. Choose the CSV again.")
          }
          if !model.needsRecovery {
            Button("Choose another CSV") {
              Task {
                if let api = environment.api { await model.cancel(api: api) }
                model.preview = nil
                choosing = true
              }
            }.disabled(model.working)
          }
        }
        if !preview.issues.isEmpty {
          Section {
            NavigationLink("View issues (\(preview.issues.count))") {
              List(Array(preview.issues.enumerated()), id: \.offset) { _, issue in
                VStack(alignment: .leading, spacing: 4) {
                  Text("Row \(issue.row)").font(.headline)
                  Text(issue.message)
                }
              }.navigationTitle("Import issues")
            }
          }
        }
      } else {
        Section("Provider") {
          Picker("Provider", selection: $model.provider) {
            Text("Auto detect").tag("auto")
            Text("Trade Republic").tag("trade_republic")
          }
        }
        Section("File") {
          Button("Choose CSV file") { choosing = true }.disabled(model.working)
            .accessibilityIdentifier("csv-choose-file")
          Text("Select an export from Files or iCloud Drive. Maximum 10 MB.").font(.caption)
            .foregroundStyle(.secondary)
        }
        Section("Supported") { Text("Trade Republic") }
      }
      if model.working { ProgressView(model.phase) }
      if let error = model.error {
        Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("csv-error") }
      }

    }
    .task {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixtures"),
          ProcessInfo.processInfo.arguments.contains("--csv-preview"), model.preview == nil
        {
          model.preview = CSVFixtures.preview(
            duplicates: ProcessInfo.processInfo.arguments.contains("--csv-duplicates"))
        }
      #endif
    }
    .safeAreaInset(edge: .bottom) {
      if let preview = model.preview {
        VStack(spacing: 8) {
          if model.needsRecovery {
            Button("Check import result") {
              if let api = environment.api { Task { await model.recover(api: api) } }
            }.disabled(model.working)
          }
          if preview.result != nil {
            Button("Done") {
              environment.dataRevision += 1
              dismiss()
            }
            .accessibilityIdentifier("csv-done")
          } else {
            Button(
              preview.summary.new == 0
                ? "Finish import" : "Import \(preview.summary.new) new transactions"
            ) {
              if let api = environment.api {
                Task {
                  await model.confirm(api: api)
                  if model.preview?.result != nil { environment.dataRevision += 1 }
                }
              }
            }.disabled(!model.canConfirm).accessibilityIdentifier("csv-confirm")
          }
        }
        .buttonStyle(.borderedProminent).controlSize(.large)
        .frame(maxWidth: .infinity).padding().background(.bar)
      }
    }
    .navigationTitle("Import financial data")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Close") {
          Task {
            if let api = environment.api { await model.cancel(api: api) }
            dismiss()
          }
        }.disabled(model.working || model.needsRecovery)
      }
    }
    .interactiveDismissDisabled(model.working || model.needsRecovery)
    .fileImporter(isPresented: $choosing, allowedContentTypes: [.commaSeparatedText]) { result in
      switch result {
      case .success(let url):
        if let api = environment.api {
          Task { await model.select(url, api: api, accountID: accountID) }
        }
      case .failure(let error): model.error = error.localizedDescription
      }
    }
    .sheet(item: $destinationEditor) { editor in
      CSVDestinationsView(destinations: editor.destinations, candidates: editor.candidates) {
        selected in
        destinationEditor = nil
        if let api = environment.api { Task { await model.saveDestinations(selected, api: api) } }
      }
    }
  }

  private func eventTitle(_ event: String) -> String {
    [
      "BUY": "Purchases", "SELL": "Sales", "DIVIDEND": "Dividends",
      "INTEREST_PAYMENT": "Interest payments",
      "TRANSFER_INBOUND": "Deposits", "TRANSFER_IN": "Transfers in",
      "TRANSFER_OUT": "Transfers out",
      "CARD_TRANSACTION": "Card payments", "PEA_MARKETING": "Promotional credits",
    ][event] ?? "Other"
  }
}
private struct CSVDestinationEditor: Identifiable {
  let id = UUID()
  let destinations: [CSVDestination]
  let candidates: [CSVAccountCandidate]
}
private struct CSVDestinationsView: View {
  @State var destinations: [CSVDestination]
  let candidates: [CSVAccountCandidate]
  let save: ([CSVDestination]) -> Void
  var body: some View {
    NavigationStack {
      Form {
        ForEach($destinations) { $destination in
          Section(destination.name) {
            Toggle("Include account", isOn: $destination.included)
            Picker("Destination", selection: $destination.accountId) {
              Text("Create new account").tag(UUID?.none)
              ForEach(candidates.filter { $0.group == nil || $0.group == destination.group }) {
                candidate in
                Text(candidate.name).tag(Optional(candidate.id))
              }
            }
            if destination.accountId == nil { TextField("Account name", text: $destination.name) }
          }
        }
      }.navigationTitle("Import accounts")
        .toolbar { Button("Save") { save(destinations) } }
    }
  }
}
struct CSVImportHistoryView: View {
  let accountID: UUID
  @Environment(AppEnvironment.self) private var environment
  @State private var entries: [CSVImportHistoryItem] = []
  @State private var error: String?
  @State private var more = true
  @State private var loading = false
  var body: some View {
    List {
      ForEach(entries) { item in
        VStack(alignment: .leading, spacing: 4) {
          Text(item.completedAt.formatted(date: .abbreviated, time: .shortened)).font(.headline)
          Text("\(item.importedRows) imported · \(item.duplicateRows) duplicates")
          Text(item.filename).font(.caption).foregroundStyle(.secondary)
        }
      }
      if entries.isEmpty && !more { Text("No imports yet.") }
      if let error { Text(error).foregroundStyle(.red) }
      if more { Button("Load more") { Task { await load() } }.disabled(loading) }
    }.navigationTitle("Import history").task { if entries.isEmpty { await load() } }
  }
  private func load() async {
    guard let api = environment.api, !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let page: [CSVImportHistoryItem] = try await api.send(
        "accounts/\(accountID)/imports", query: [.init(name: "offset", value: "\(entries.count)")])
      entries.append(contentsOf: page)
      more = page.count == 20
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
