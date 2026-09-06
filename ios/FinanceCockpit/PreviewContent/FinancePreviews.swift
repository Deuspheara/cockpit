import SwiftUI

extension PortfolioDashboard {
  static var preview: PortfolioDashboard {
    let at = Date(timeIntervalSince1970: 1_788_480_000)
    return PortfolioDashboard(
      scope: .global, range: .month, currency: "EUR", value: Amount(62871), complete: true,
      absoluteChange: Amount(1800), percentChange: Amount(3), asOf: at,
      chart: (0..<30).map { index in
        ValuationPoint(
          at: at.addingTimeInterval(Double(index - 29) * 86400),
          value: Amount(61000 + Decimal(index * 60)))
      },
      allocation: [
        Allocation(key: "crypto", label: "Crypto", value: Amount(31001), percentage: Amount(49)),
        Allocation(key: "equities", label: "Actions", value: Amount(31870), percentage: Amount(51)),
      ],
      accounts: [
        AccountRow(
          id: UUID(), name: "Hyperliquid", assetClass: "crypto", sourceType: "hyperliquid",
          value: Amount(18241), complete: true, asOf: at, stale: false, unvaluedPositions: 0),
        AccountRow(
          id: UUID(), name: "PEA", assetClass: "equities", sourceType: "manual",
          value: Amount(27840), complete: true, asOf: at, stale: true, unvaluedPositions: 0),
      ])
  }

  static var emptyPreview: PortfolioDashboard {
    PortfolioDashboard(
      scope: .global, range: .month, currency: "EUR", value: Amount(0), complete: true,
      absoluteChange: nil, percentChange: nil, asOf: Date(), chart: [], allocation: [], accounts: []
    )
  }
}
private struct ChartPreview: View {
  @State private var range: PortfolioRange = .month
  var body: some View {
    ScrollView { PortfolioValueChart(dashboard: .preview, range: $range).padding(20) }.environment(
      AppEnvironment())
  }
}
#Preview("Portfolio chart · Light") { ChartPreview() }
#Preview("Portfolio chart · Dark") { ChartPreview().preferredColorScheme(.dark) }
#Preview("Home · Loaded") {
  NavigationStack { PortfolioView(dashboard: .preview) }.environment(AppEnvironment())
}
#Preview("Home · Empty") {
  NavigationStack { PortfolioView(dashboard: .emptyPreview) }.environment(AppEnvironment())
}
#Preview("Home · Error") {
  NavigationStack { PortfolioView(dashboard: .preview, error: "The server is unavailable.") }
    .environment(AppEnvironment())
}
#Preview("Settings") { NavigationStack { SettingsView() }.environment(AppEnvironment()) }
#Preview("Manual entry") { NavigationStack { ManualEntryView() }.environment(AppEnvironment()) }
#Preview("Activity · Empty") { NavigationStack { ActivityView() }.environment(AppEnvironment()) }

private let previewAccountID = UUID()
private let previewActivity = [
  ActivityEvent(
    id: UUID(), accountId: previewAccountID, accountName: "Hyperliquid", assetClass: "crypto",
    source: "hyperliquid", kind: "BUY", at: Date(), quantity: Amount(0.04), currency: "USD",
    symbol: "BTC", isVoided: false, editable: false, transactionId: nil),
  ActivityEvent(
    id: UUID(), accountId: previewAccountID, accountName: "Hyperliquid", assetClass: "crypto",
    source: "hyperliquid", kind: "FEE", at: Date().addingTimeInterval(-3600),
    quantity: Amount(1.25), currency: "USD", symbol: "USDC", isVoided: true, editable: false,
    transactionId: nil),
]
#Preview("Activity · Loaded") {
  NavigationStack { ActivityView(activity: previewActivity) }.environment(AppEnvironment())
}

private struct AssistantPreviewHost: View {
  @State private var environment: AppEnvironment
  let messages: [AgentMessage]
  let working: Bool

  init(configured: Bool, messages: [AgentMessage] = [], working: Bool = false) {
    let environment = AppEnvironment()
    environment.sessionInfo = SessionInfo(
      apiVersion: "1",
      ai: SessionInfo.AI(
        configured: configured, keyConfigured: configured, chatConfigured: configured,
        visionConfigured: configured, primaryModel: configured ? "openai/gpt-4.1-mini" : "",
        visionModel: configured ? "openai/gpt-4.1-mini" : ""),
      walletConfigured: false)
    _environment = State(initialValue: environment)
    self.messages = messages
    self.working = working
  }

  var body: some View {
    NavigationStack { AgentView(messages: messages, working: working) }
      .environment(environment)
  }
}

#Preview("Assistant · Empty") { AssistantPreviewHost(configured: true) }
#Preview("Assistant · Missing configuration") { AssistantPreviewHost(configured: false) }
#Preview("Assistant · Response in progress") {
  AssistantPreviewHost(
    configured: true,
    messages: [
      AgentMessage(
        id: UUID(), role: "user", content: "Where is my exposure concentrated?", changeSetIds: []),
      AgentMessage(
        id: UUID(), role: "assistant",
        content: "Crypto currently represents the largest share of the portfolio.",
        changeSetIds: []),
    ], working: true)
}
