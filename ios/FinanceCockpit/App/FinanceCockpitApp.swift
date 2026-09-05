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
  private enum AppTab: Hashable { case home, activity, settings }
  @State private var selection: AppTab = .home

  var body: some View {
    TabView(selection: $selection) {
      Tab(value: .home) {
        NavigationStack { PortfolioView() }
      } label: {
        AppIcon(name: .home, size: 25, decorative: false)
          .accessibilityLabel("Home")
          .accessibilityHint("Shows your portfolio")
      }
      Tab(value: .activity) {
        NavigationStack { ActivityView() }
      } label: {
        AppIcon(name: .activity, size: 25, decorative: false)
          .accessibilityLabel("Activity")
          .accessibilityHint("Shows account activity")
      }
      Tab(value: .settings) {
        NavigationStack { SettingsView() }
      } label: {
        AppIcon(name: .settings, size: 25, decorative: false)
          .accessibilityLabel("Settings")
          .accessibilityHint("Opens app settings")
      }
    }
  }
}
