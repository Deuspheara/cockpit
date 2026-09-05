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
}
private struct ChartPreview: View {
  @State private var range: PortfolioRange = .month
  var body: some View {
    ScrollView { PortfolioValueChart(dashboard: .preview, range: $range).padding(20) }
  }
}
#Preview("Portfolio chart · Light") { ChartPreview() }
#Preview("Portfolio chart · Dark") { ChartPreview().preferredColorScheme(.dark) }
#Preview("Settings") { NavigationStack { SettingsView() }.environment(AppEnvironment()) }
#Preview("Manual entry") { NavigationStack { ManualEntryView() }.environment(AppEnvironment()) }
#Preview("Activity · Empty") { NavigationStack { ActivityView() }.environment(AppEnvironment()) }
