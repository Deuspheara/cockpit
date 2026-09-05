import SwiftUI

struct Diagnostics: Decodable, Sendable {
  let dbReachable: Bool
  let redisReachable: Bool
  let workerHeartbeat: Date?
  let keyConfigured: Bool
  let chatConfigured: Bool
  let visionConfigured: Bool
  let walletConfigured: Bool
}
struct DiagnosticsView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var diagnostics: Diagnostics?
  @State private var accounts: [Account] = []
  @State private var error: String?
  var body: some View {
    List {
      if let diagnostics {
        Section("Services") {
          LabeledContent("Database", value: diagnostics.dbReachable ? "Reachable" : "Unavailable")
          LabeledContent("Cache", value: diagnostics.redisReachable ? "Reachable" : "Unavailable")
          LabeledContent(
            "Worker",
            value: diagnostics.workerHeartbeat.map {
              $0.formatted(date: .abbreviated, time: .standard)
            } ?? "No heartbeat")
          LabeledContent("OpenRouter key", value: diagnostics.keyConfigured ? "Ready" : "Missing")
          LabeledContent("Assistant", value: diagnostics.chatConfigured ? "Ready" : "Not ready")
          LabeledContent(
            "Screenshot import", value: diagnostics.visionConfigured ? "Ready" : "Not ready")
          LabeledContent(
            "Alchemy", value: diagnostics.walletConfigured ? "Configured" : "Not configured")
        }
      }
      Section("Read-only connections") {
        ForEach(accounts.filter { $0.sourceType != "manual" }) { account in
          NavigationLink {
            AccountDetailView(accountID: account.id)
          } label: {
            VStack(alignment: .leading) {
              Text(account.name)
              Text(account.sourceType).font(.caption).foregroundStyle(.secondary)
              if let address = account.externalAddress {
                Text(address).font(.caption.monospaced()).textSelection(.enabled)
              }
            }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Diagnostics").task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      guard let api = environment.api else { return }
      async let d: Diagnostics = api.send("diagnostics")
      async let a: [Account] = api.send("accounts")
      (diagnostics, accounts) = try await (d, a)
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
