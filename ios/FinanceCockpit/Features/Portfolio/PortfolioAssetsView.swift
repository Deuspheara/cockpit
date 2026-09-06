import SwiftUI

struct PortfolioAssetLine: Decodable, Identifiable, Sendable {
  var id: String { "\(accountId)-\(assetId)" }
  let accountId: UUID
  let accountName: String
  let assetId: UUID
  let symbol: String
  let name: String
  let quantity: Amount?
  let marketValue: Amount?
  let currency: String
  let source: String
  let stale: Bool
  var logoUrl: String? = nil
  var assetType: String? = nil
  var side: String? = nil
  var unpricedReason: String? = nil
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
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HoldingSummaryRow(
        name: line.name, symbol: line.symbol, logoUrl: line.logoUrl,
        quantity: line.quantity, value: line.marketValue, currency: line.currency,
        side: line.side, exposure: line.assetType == "perp", loader: logoLoader,
        unavailableReason: line.unpricedReason)
      if environment.advancedMode {
        Text("\(line.accountName) · \(line.source)").font(.caption).foregroundStyle(.secondary)
      } else if line.stale {
        Text("Update needed").font(.caption).foregroundStyle(.secondary)
      }
    }.padding(.vertical, 6)
  }
}

enum HoldingPresentation {
  static func name(_ name: String, symbol: String) -> String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? symbol : trimmed
  }
}

struct HoldingSummaryRow: View {
  let name: String
  let symbol: String
  let logoUrl: String?
  let quantity: Amount?
  let value: Amount?
  let currency: String
  var side: String? = nil
  var exposure = false
  var loader: AssetLogoLoader = .shared
  var unavailableReason: String? = nil
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AssetLogo(symbol: symbol, urlString: logoUrl, loader: loader)
      VStack(alignment: .leading, spacing: 4) {
        Text(HoldingPresentation.name(name, symbol: symbol)).font(.headline)
        Text(
          [symbol, side?.capitalized, quantity.map { FinanceFormat.quantity($0) }]
            .compactMap { $0 }.joined(separator: " · ")
        )
        .font(.caption).foregroundStyle(.secondary)
        if typeSize.isAccessibilitySize { amount }
      }
      if !typeSize.isAccessibilitySize {
        Spacer(minLength: 8)
        amount
      }
    }.frame(minHeight: 44).contentShape(Rectangle())
      .accessibilityElement(children: .combine)
  }
  private var amount: some View {
    VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 4) {
      Text(value.map { FinanceFormat.amount($0, currency: currency) } ?? unavailableReason ?? "Unavailable")
        .monospacedDigit().fixedSize(horizontal: false, vertical: true)
      if exposure { Text("Exposure").font(.caption).foregroundStyle(.secondary) }
    }
  }
}
