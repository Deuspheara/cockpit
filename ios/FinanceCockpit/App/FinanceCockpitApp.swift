import SwiftUI

@main
struct FinanceCockpitApp: App {
  @State private var environment = AppEnvironment()
  var body: some Scene {
    WindowGroup {
      Group {
        if environment.api == nil { ConnectionView() } else { AppTabs() }
      }.environment(environment)
        #if DEBUG
          .task {
            let launch = ProcessInfo.processInfo.environment
            if let server = launch["FINANCE_DEVELOPMENT_SERVER"],
              let token = launch["FINANCE_DEVELOPMENT_TOKEN"]
            {
              do { try await environment.connect(server: server, token: token) } catch {
                environment.connectionError = error.localizedDescription
              }
            }
          }
        #endif
    }
  }
}
struct AppTabs: View {
  var body: some View {
    TabView {
      Tab("Portfolio", systemImage: "chart.xyaxis.line") { NavigationStack { PortfolioView() } }
      Tab("Activity", systemImage: "clock.arrow.circlepath") { NavigationStack { ActivityView() } }
      Tab("Bots", systemImage: "cpu") { NavigationStack { BotsView() } }
      Tab("Settings", systemImage: "gearshape") { NavigationStack { SettingsView() } }
    }
  }
}
