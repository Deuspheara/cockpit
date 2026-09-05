import SwiftUI

struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var error: String?
  var body: some View {
    Form {
      Section("Server") {
        LabeledContent("URL", value: environment.serverURL)
        Button("Test connection") { Task { await environment.testConnection() } }
        if let issue = environment.connectionError {
          Text(issue).foregroundStyle(.red)
        } else if environment.sessionInfo != nil {
          Label("Connected", systemImage: "checkmark.circle").foregroundStyle(.green)
        }
        if let at = environment.lastSuccessfulRefresh {
          LabeledContent("Last refresh", value: at.formatted(date: .abbreviated, time: .shortened))
        }
      }
      Section("AI · server configuration") {
        LabeledContent(
          "OpenRouter",
          value: environment.sessionInfo?.ai.configured == true ? "Configured" : "Not configured")
        if let ai = environment.sessionInfo?.ai {
          LabeledContent(
            "Primary model", value: ai.primaryModel.isEmpty ? "Not set" : ai.primaryModel)
          LabeledContent("Vision model", value: ai.visionModel.isEmpty ? "Not set" : ai.visionModel)
        }
      }
      Section("Data") {
        NavigationLink("Recurring investments") { RecurringView() }
        NavigationLink("Integration diagnostics") { DiagnosticsView() }
        Button("Refresh portfolio") { environment.dataRevision += 1 }
        LabeledContent(
          "Public wallet indexer",
          value: environment.sessionInfo?.walletConfigured == true ? "Configured" : "Not configured"
        )
        LabeledContent("App version", value: "0.1.0")
        Button("Remove device credentials", role: .destructive) {
          Task {
            do { try await environment.logout() } catch { self.error = error.localizedDescription }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.navigationTitle("Settings").task { await environment.testConnection() }
  }
}
