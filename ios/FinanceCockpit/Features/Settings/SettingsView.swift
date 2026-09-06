import SwiftUI

struct SettingsView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var error: String?

  var body: some View {
    @Bindable var environment = environment
    Form {
      Section("Display") {
        Picker("Interface", selection: $environment.advancedMode) {
          Text("Simple").tag(false)
          Text("Advanced").tag(true)
        }.pickerStyle(.segmented).accessibilityIdentifier("interface-mode")
      }
      Section("Tools") {
        if environment.advancedMode {
          NavigationLink {
            BotsView()
          } label: {
            SettingsDestinationLabel(title: "Bots", detail: "Paper strategies", icon: .bot)
          }
          .accessibilityLabel("Bots")
          .accessibilityHint("Opens paper strategies")
        }
        NavigationLink {
          RecurringView()
        } label: {
          SettingsDestinationLabel(
            title: "Recurring investments", detail: "Schedules and occurrences", icon: .recurring)
        }
        .accessibilityLabel("Recurring investments")
        if environment.advancedMode {
          NavigationLink {
            DiagnosticsView()
          } label: {
            SettingsDestinationLabel(
              title: "Integration diagnostics", detail: "Services and read-only connections",
              icon: .connected)
          }
          .accessibilityLabel("Integration diagnostics")
        }
        NavigationLink {
          MarketDataReviewView()
        } label: {
          SettingsDestinationLabel(
            title: "Market data", detail: "Resolve securities and valuation prices", icon: .chart)
        }
        .accessibilityLabel("Market data")
      }
      if environment.advancedMode {
        Section("Server") {
          LabeledContent("URL", value: environment.serverURL)
          Button("Test connection") { Task { await environment.testConnection() } }
          if let issue = environment.connectionError {
            Text(issue).foregroundStyle(.red)
          } else if environment.sessionInfo != nil {
            HStack(spacing: 8) {
              AppIcon(name: .connected, size: 18)
              Text("Connected")
            }
            .foregroundStyle(.green)
            .accessibilityElement(children: .combine)
          }
          if let at = environment.lastSuccessfulRefresh {
            LabeledContent(
              "Last refresh", value: at.formatted(date: .abbreviated, time: .shortened))
          }
        }

        Section("AI · server configuration") {
          LabeledContent(
            "OpenRouter key", value: environment.aiAvailability.keyConfigured ? "Ready" : "Missing")
          LabeledContent(
            "Assistant", value: environment.aiAvailability.chatConfigured ? "Ready" : "Not ready")
          LabeledContent(
            "Screenshot import",
            value: environment.aiAvailability.visionConfigured ? "Ready" : "Not ready")
          if let ai = environment.sessionInfo?.ai {
            LabeledContent(
              "Primary model", value: ai.primaryModel.isEmpty ? "Not set" : ai.primaryModel)
            LabeledContent(
              "Vision model", value: ai.visionModel.isEmpty ? "Not set" : ai.visionModel)
          }
        }
      }

      Section("Data") {
        Button("Refresh portfolio") { environment.dataRevision += 1 }
        if environment.advancedMode {
          LabeledContent(
            "Public wallet indexer",
            value: environment.sessionInfo?.walletConfigured == true
              ? "Configured" : "Not configured"
          )
        }
        LabeledContent("App version", value: "0.1.0")
        Button("Disconnect this device", role: .destructive) {
          Task {
            do { try await environment.logout() } catch { self.error = error.localizedDescription }
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Settings")
    .task { await environment.testConnection() }
  }
}

private struct SettingsDestinationLabel: View {
  let title: String
  let detail: String
  let icon: AppIconName

  var body: some View {
    HStack(spacing: 12) {
      AppIcon(name: icon, size: 20)
        .foregroundStyle(.tint)
        .frame(width: 34, height: 34)
        .background(Color.accentColor.opacity(0.1), in: .rect(cornerRadius: 9))
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}
