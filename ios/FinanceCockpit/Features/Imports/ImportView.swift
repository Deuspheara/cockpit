import PhotosUI
import SwiftUI
import UIKit

struct ImportSessionDTO: Decodable, Sendable {
  struct Extraction: Decodable, Sendable {
    struct Candidate: Decodable, Sendable {
      struct Match: Decodable, Sendable {
        let symbol: String
        let name: String
        let isin: String?
        let exchange: String
        let currency: String?
      }
      let matchCandidates: [Match]?
      let candidateId: UUID?
      let symbol: String?
      let name: String?
      let isin: String?
      let quantity: Amount?
      let currency: String?
      let marketValue: Amount?
      let confidence: Double
      let providerKey: String?
      let providerExchange: String?
      let matchStatus: String
      let quantitySource: String
      let quotePrice: Amount?
      let quoteCurrency: String?
      let quoteAt: Date?
      let fxRate: Amount?
      let sourceLines: Int
      let sourceCandidateIds: [UUID]
    }
    struct Derivative: Decodable, Sendable {
      let candidateId: UUID?
      let underlyingSymbol: String?
      let name: String?
      let optionType: String?
      let strike: Amount?
      let expiration: String?
      let contractSymbol: String?
      let quantity: Amount?
      let marketValue: Amount?
      let currency: String?
      let confidence: Double
      let quantitySource: String
      let sourceLines: Int
      let sourceCandidateIds: [UUID]
    }
    let likelyAccountName: String?
    let likelyInstitution: String?
    let capturedAt: Date?
    let capturedAtInferred: Bool
    let currency: String?
    let positions: [Candidate]
    let derivatives: [Derivative]
  }
  let id: UUID
  let status: String
  let revision: Int
  let summary: String?
  let extraction: Extraction?
  let questions: [String]?
  let blockers: [String]?
  let candidateIssues: [String: [String]]?
  let warnings: [String]?
  let changeSetId: UUID?
  var accountId: UUID? = nil
  var processing: ImportJobDTO? = nil
}
struct ImportJobDTO: Decodable, Sendable {
  struct Failure: Decodable, Sendable { let code: String; let message: String; let retryable: Bool }
  let id: UUID
  let status: String
  let phase: String
  let failure: Failure?
  struct Phase: Decodable, Sendable, Identifiable { let id: String; let status: String }
  var progress: [Phase]? = nil
  var isActive: Bool { status == "queued" || status == "running" }
}
enum ImportStage: Int, CaseIterable {
  case upload, destination, holdings, confirm, complete
  var title: String {
    switch self {
    case .upload: "Upload & Analysis"
    case .destination: "Account & Date"
    case .holdings: "Holdings"
    case .confirm: "Confirm"
    case .complete: "Complete"
    }
  }
}
private enum ImportEditor: Identifiable {
  case position(ImportSessionDTO.Extraction.Candidate)
  case derivative(ImportSessionDTO.Extraction.Derivative)
  var id: UUID? {
    switch self { case .position(let p): p.candidateId; case .derivative(let d): d.candidateId }
  }
}
struct ImportView: View {
  var accountID: UUID?
  var sessionID: UUID?
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var selected: [PhotosPickerItem] = []
  @State private var previews: [UIImage] = []
  @State private var session: ImportSessionDTO?
  @State private var job: ImportJobDTO?
  @State private var stage: ImportStage = .upload
  @State private var editor: ImportEditor?
  @State private var accounts: [Account] = []
  @State private var destinationID: UUID?
  @State private var accountName = ""
  @State private var observedAt = Date()
  @State private var error: String?
  @State private var working = false
  @State private var change: ChangeSet?
  @State private var openedAccount: UUID?
  private var restoreKey: String { "screenshot-import-\(environment.serverURL)-\(accountID?.uuidString ?? "portfolio")" }
  private var blockers: [String] { session?.blockers ?? [] }
  private var actionTitle: String { stage == .confirm ? "Apply" : stage == .complete ? "Done" : "Continue" }
  var body: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 12) {
          Text("Step \(stage.rawValue + 1) of 5").font(.caption).foregroundStyle(.secondary)
          ProgressView(value: Double(stage.rawValue + 1), total: 5).accessibilityLabel("Import progress")
          Text(stage.title).font(.title2.bold())
        }.padding(.vertical, 6)
      }
      stageContent
      if let warnings = session?.warnings, !warnings.isEmpty {
        Section("Import notes") {
          ForEach(warnings, id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
        }
      }
      if let error { Section { Text(error).foregroundStyle(.red) } }
    }
    .navigationTitle("Screenshot import")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      if stage == .destination || stage == .holdings || stage == .confirm {
        ToolbarItem(placement: .topBarLeading) {
          Button("Back") { Task { await back() } }.disabled(working)
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      Button { Task { await advance() } } label: {
        HStack { Spacer(); if working { ProgressView() }; Text(actionTitle).bold(); Spacer() }.padding(8)
      }
      .buttonStyle(.borderedProminent)
      .disabled(working || job?.isActive == true || (stage == .upload && session?.extraction == nil))
      .padding().background(.bar)
    }
    .sheet(item: $editor) { item in
      NavigationStack {
        if let session {
          ScrollView {
            switch item {
            case .position(let position): ImportPositionEditor(session: session, position: position) { self.session = $0 }
            case .derivative(let derivative): ImportDerivativeEditor(session: session, derivative: derivative) { self.session = $0 }
            }
          }.padding().navigationTitle("Edit holding")
        }
      }
    }
    .navigationDestination(item: $openedAccount) { AccountDetailView(accountID: $0) }
    .task { await restore() }
    .onDisappear { previews = [] }
    .task(id: "\(session?.id.uuidString ?? "")-\(job?.id.uuidString ?? "")-\(scenePhase)") {
      guard scenePhase == .active else { return }
      await poll()
    }
    .onChange(of: selected) { _, items in if !items.isEmpty { Task { await upload(items) } } }
  }
  @ViewBuilder private var stageContent: some View {
    switch stage {
    case .upload:
      Section {
        Text("Choose up to five screenshots for one review. Only structured results are retained by your server.").foregroundStyle(.secondary)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixtures") {
          Button("Use sample screenshots") { Task { await uploadSample() } }
        }
        #endif
        PhotosPicker(selection: $selected, maxSelectionCount: 5, matching: .images) {
          Label(job?.failure == nil ? "Choose screenshots" : "Re-upload screenshots", systemImage: "photo.on.rectangle")
        }.disabled(working || job?.isActive == true || session?.changeSetId != nil || !environment.aiAvailability.visionConfigured)
        ForEach(previews.indices, id: \.self) { index in
          Image(uiImage: previews[index]).resizable().scaledToFit().frame(maxHeight: 240).accessibilityLabel("Selected screenshot \(index + 1)")
        }
        if let job {
          if job.isActive {
            ForEach(job.progress ?? [.init(id: job.phase, status: job.status)]) { phase in
              HStack {
                if phase.status == "running" { ProgressView().controlSize(.small) }
                Text(phase.id.capitalized).foregroundStyle(phase.status == "running" ? .primary : .secondary)
              }
            }
            Text("You can close this screen. Processing continues on the server.").font(.caption)
            Button("Cancel processing", role: .destructive) { Task { await cancel() } }
          } else if let failure = job.failure { Text(failure.message).foregroundStyle(.orange) }
          else { Text(job.status.capitalized) }
        }
      }
    case .destination:
      Section("Destination") {
        Picker("Account", selection: $destinationID) {
          Text("New manual account").tag(nil as UUID?)
          ForEach(accounts.filter { $0.sourceType == "manual" }) { Text($0.name).tag(Optional($0.id)) }
        }
        if destinationID == nil { TextField("New account name", text: $accountName) }
        DatePicker("Observed", selection: $observedAt, displayedComponents: .date)
        if session?.extraction?.capturedAtInferred == true { Text("The upload date was inferred. Confirm the observation date.").font(.caption) }
      }
    case .holdings:
      holdingSections
      if !blockers.isEmpty {
        Section {
          Text("A few details will help finish this import. Continue opens the next item to check.")
            .font(.callout).foregroundStyle(.secondary)
        }
      }
    case .confirm:
      Section("Account") { Text(accounts.first(where: { $0.id == destinationID })?.name ?? accountName); Text(observedAt, style: .date) }
      holdingSections
      Section { Text("Apply records the reviewed evidence. You can undo this import afterward.") }
    case .complete:
      Section {
        Label(change?.status == "undone" ? "Import undone" : "Import applied", systemImage: "checkmark.circle.fill").font(.title2)
        if let id = resultAccountID, change?.status == "applied" {
          Button("Open Account") { openedAccount = id }
        }
        if change?.status == "applied" { Button("Undo", role: .destructive) { Task { await mutate("undo") } }.disabled(working) }
      }
    }
  }
  @ViewBuilder private var holdingSections: some View {
    if let extraction = session?.extraction {
      if extraction.positions.contains(where: needsAttention) || extraction.derivatives.contains(where: derivativeNeedsAttention) {
      Section("A quick check") {
        ForEach(extraction.positions.filter(needsAttention), id: \.candidateId) { positionRow($0) }
        ForEach(extraction.derivatives.filter(derivativeNeedsAttention), id: \.candidateId) { derivativeRow($0) }
      }
      }
      Section("Holdings") { ForEach(extraction.positions.filter { !needsAttention($0) }, id: \.candidateId) { positionRow($0) } }
      Section("Derivatives") { ForEach(extraction.derivatives.filter { !derivativeNeedsAttention($0) }, id: \.candidateId) { derivativeRow($0) } }
    }
  }
  private func needsAttention(_ p: ImportSessionDTO.Extraction.Candidate) -> Bool {
    !(session?.remainingIssues(for: p).isEmpty ?? true)
  }
  private func derivativeNeedsAttention(_ d: ImportSessionDTO.Extraction.Derivative) -> Bool {
    !(session?.remainingIssues(for: d).isEmpty ?? true)
  }
  private func positionRow(_ p: ImportSessionDTO.Extraction.Candidate) -> some View {
    Button { editor = .position(p) } label: {
      VStack(alignment: .leading, spacing: 5) {
        Text(p.name ?? p.symbol ?? "Unknown instrument").font(.headline)
        Text(p.marketValue.map { FinanceFormat.amount($0, currency: p.currency ?? "EUR") } ?? "Value unknown")
        Text(needsAttention(p) ? "Confirm investment details" : p.quantitySource == "estimated" ? "Quantity estimated automatically" : p.quantity == nil ? "Position value saved · quantity optional" : "Tap to view details").font(.caption).foregroundStyle(.secondary)
      }.padding(.vertical, 4)
    }.buttonStyle(.plain).disabled(change != nil)
  }
  private func derivativeRow(_ d: ImportSessionDTO.Extraction.Derivative) -> some View {
    Button { editor = .derivative(d) } label: {
      VStack(alignment: .leading) { Text(d.name ?? d.underlyingSymbol ?? "Option").font(.headline); Text(d.marketValue.map { FinanceFormat.amount($0, currency: d.currency ?? "USD") } ?? "Value unknown") }
    }.buttonStyle(.plain).disabled(change != nil)
  }
  private var resultAccountID: UUID? {
    if let id = session?.accountId { return id }
    return change?.operations.first(where: { $0.table == "accounts" })?.id
  }
  private func restore() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("--fresh-import") { UserDefaults.standard.removeObject(forKey: restoreKey) }
    #endif
    await environment.testConnection()
    guard let api = environment.api else { return }
    do {
      accounts = try await api.send("accounts")
      let id = sessionID ?? UserDefaults.standard.string(forKey: restoreKey).flatMap(UUID.init(uuidString:))
      if let id { session = try await api.send("imports/\(id)"); adoptSession() }
      destinationID = session?.accountId ?? accountID
      if let id = session?.changeSetId {
        change = try await api.send("change-sets/\(id)")
        stage = change?.status == "draft" ? .confirm : .complete
      }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func adoptSession() {
    job = session?.processing
    accountName = session?.extraction?.likelyAccountName ?? accountName
    observedAt = session?.extraction?.capturedAt ?? observedAt
    if session?.extraction != nil && job?.isActive != true && stage == .upload { stage = .destination }
  }
  private func poll() async {
    guard let api = environment.api, let id = session?.id else { return }
    while !Task.isCancelled && job?.isActive == true {
      do {
        try await Task.sleep(for: .seconds(1))
        session = try await api.send("imports/\(id)")
        adoptSession()
      } catch { if !Task.isCancelled { self.error = error.localizedDescription; try? await Task.sleep(for: .seconds(3)) } }
    }
  }
  #if DEBUG
  private func uploadSample() async {
    guard let api = environment.api else { return }
    do {
      session = try await api.send("imports", method: "POST", body: [:])
      guard let session else { return }
      UserDefaults.standard.set(session.id.uuidString, forKey: restoreKey)
      job = try await api.uploadImportJob(id: session.id, revision: session.revision, requestID: UUID(), images: [(Data(), "image/png")])
    } catch { self.error = error.localizedDescription }
  }
  #endif
  private func upload(_ items: [PhotosPickerItem]) async {
    guard let api = environment.api, !working else { return }
    working = true; error = nil
    defer { working = false; selected = [] }
    do {
      if session == nil {
        let body: [String: JSONValue] = accountID.map { ["accountId": .string($0.uuidString)] } ?? [:]
        session = try await api.send("imports", method: "POST", body: body)
      }
      guard let session else { return }
      UserDefaults.standard.set(session.id.uuidString, forKey: restoreKey)
      var images: [(Data, String)] = []
      previews = []
      for item in items {
        guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data), let bytes = image.jpegData(compressionQuality: 0.9), bytes.count <= 12 * 1024 * 1024 else { throw APIError(message: "Choose a smaller readable screenshot.") }
        images.append((bytes, "image/jpeg")); previews.append(image)
      }
      job = try await api.uploadImportJob(id: session.id, revision: session.revision, requestID: UUID(), images: images)
    } catch { self.error = error.localizedDescription }
  }
  private func cancel() async {
    guard let api = environment.api, let session, let job else { return }
    do { self.job = try await api.send("imports/\(session.id)/jobs/\(job.id)/cancel", method: "POST") }
    catch { self.error = error.localizedDescription }
  }
  private func back() async {
    if stage == .confirm, let change, let api = environment.api {
      working = true
      defer { working = false }
      do {
        let _: ChangeSet = try await api.send("change-sets/\(change.id)/reject", method: "POST")
        if let id = session?.id { session = try await api.send("imports/\(id)") }
        self.change = nil; stage = .holdings
      } catch { self.error = error.localizedDescription }
    } else { stage = ImportStage(rawValue: stage.rawValue - 1) ?? .upload }
  }
  private func advance() async {
    guard let api = environment.api else { return }
    working = true; error = nil
    defer { working = false }
    do {
      switch stage {
      case .upload: stage = .destination
      case .destination:
        guard let session else { return }
        guard destinationID != nil || !accountName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError(message: "Choose a destination account or enter a new name.") }
        self.session = try await api.send("imports/\(session.id)", method: "PATCH", body: ["revision": .number(Decimal(session.revision)), "accountId": destinationID.map { .string($0.uuidString) } ?? .null, "likelyAccountName": .string(accountName), "capturedAt": .string(observedAt.ISO8601Format())])
        stage = .holdings
      case .holdings:
        if let p = session?.extraction?.positions.first(where: needsAttention) { editor = .position(p); return }
        if let d = session?.extraction?.derivatives.first(where: derivativeNeedsAttention) { editor = .derivative(d); return }
        guard blockers.isEmpty, let session else { throw APIError(message: blockers.first ?? "Review missing information.") }
        change = try await api.send("imports/\(session.id)/prepare-change-set", method: "POST")
        stage = .confirm
      case .confirm: await mutate("apply")
      case .complete: UserDefaults.standard.removeObject(forKey: restoreKey); dismiss()
      }
    } catch { self.error = error.localizedDescription }
  }
  private func mutate(_ action: String) async {
    guard let api = environment.api, let change else { return }
    working = true
    defer { working = false }
    do {
      self.change = try await api.send("change-sets/\(change.id)/\(action)", method: "POST")
      environment.dataRevision += 1; stage = .complete
    } catch { self.error = error.localizedDescription }
  }
}
#Preview { NavigationStack { ImportView() }.environment(AppEnvironment()) }
