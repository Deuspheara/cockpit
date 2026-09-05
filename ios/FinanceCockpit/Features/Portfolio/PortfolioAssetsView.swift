import SwiftUI

struct PortfolioAssetLine: Decodable, Identifiable, Sendable {
  var id: String { "\(accountId)-\(assetId)" }
  let accountId: UUID
  let accountName: String
  let assetId: UUID
  let symbol: String
  let name: String
  let quantity: Amount
  let marketValue: Amount?
  let currency: String
  let source: String
  let stale: Bool
  var logoUrl: String? = nil
}
struct PortfolioAssetsView: View {
  let scope: PortfolioScope
  @Environment(AppEnvironment.self) private var environment
  var snapshot: SnapshotLoader<[PortfolioAssetLine]>
  private var lines: [PortfolioAssetLine] { snapshot.value ?? [] }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(lines.sorted { $0.symbol < $1.symbol }) { line in
        NavigationLink {
          AccountDetailView(accountID: line.accountId)
        } label: {
          PortfolioAssetRow(line: line)
        }.buttonStyle(.plain)
        Divider()
      }
      if lines.contains(where: { AssetLogo.remoteURL($0.logoUrl)?.host == "static.coinpaprika.com" }
      ) {
        Link("Crypto logos by CoinPaprika", destination: URL(string: "https://coinpaprika.com")!)
          .font(.caption)
      }
      if lines.contains(where: { AssetLogo.remoteURL($0.logoUrl)?.host == "img.logo.dev" }) {
        Link("Logos provided by Logo.dev", destination: URL(string: "https://logo.dev")!)
          .font(.caption)
      }
      if snapshot.value == nil && snapshot.isLoading {
        ProgressView("Loading assets…").frame(maxWidth: .infinity, minHeight: 220)
      }
      if let error = snapshot.error { Text(error).foregroundStyle(.red) }
      if snapshot.error != nil { Button("Retry") { Task { await load() } } }
    }.task(id: "\(scope.rawValue)-\(environment.dataRevision)") {
      await load()
    }
  }
  private func load() async {
    guard let api = environment.api else { return }
    let requestedScope = scope
    await snapshot.load(
      key: requestedScope.rawValue,
      fetch: {
        try await api.send(
          "portfolio/assets", query: [URLQueryItem(name: "scope", value: requestedScope.rawValue)])
      })
  }
}

struct PortfolioAssetRow: View {
  let line: PortfolioAssetLine
  var logoLoader: AssetLogoLoader = .shared
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AssetLogo(symbol: line.symbol, urlString: line.logoUrl, loader: logoLoader)
      VStack(alignment: .leading, spacing: 4) {
        Text(line.symbol).font(.headline)
        Text("\(line.accountName) · \(FinanceFormat.quantity(line.quantity)) units")
          .font(.caption).foregroundStyle(.secondary)
        Text("\(line.source)\(line.stale ? " · Stale" : "")")
          .font(.caption).foregroundStyle(.secondary)
        if dynamicTypeSize.isAccessibilitySize { value }
      }
      if !dynamicTypeSize.isAccessibilitySize {
        Spacer(minLength: 8)
        value
      }
    }
    .padding(.vertical, 5)
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  private var value: some View {
    Text(
      line.marketValue.map { FinanceFormat.amount($0, currency: line.currency) } ?? "Unavailable"
    )
    .monospacedDigit()
    .fixedSize(horizontal: false, vertical: true)
  }
}
