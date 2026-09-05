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
}
struct PortfolioAssetsView: View {
  let scope: PortfolioScope
  @Environment(AppEnvironment.self) private var environment
  @State private var lines: [PortfolioAssetLine] = []
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(lines.sorted { $0.symbol < $1.symbol }) { line in
        NavigationLink {
          AccountDetailView(accountID: line.accountId)
        } label: {
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text(line.symbol).font(.headline)
              Text("\(line.accountName) · \(FinanceFormat.quantity(line.quantity)) units").font(
                .caption
              ).foregroundStyle(.secondary)
              Text("\(line.source)\(line.stale ? " · Stale" : "")").font(.caption).foregroundStyle(
                .secondary)
            }
            Spacer()
            Text(
              line.marketValue.map { FinanceFormat.amount($0, currency: line.currency) }
                ?? "Unavailable"
            ).monospacedDigit()
          }.padding(.vertical, 5).contentShape(Rectangle())
        }.buttonStyle(.plain)
        Divider()
      }
      if let error { Text(error).foregroundStyle(.red) }
    }.task(id: "\(scope.rawValue)-\(environment.dataRevision)") {
      do {
        let fresh: [PortfolioAssetLine] =
          try await environment.api?.send(
            "portfolio/assets", query: [URLQueryItem(name: "scope", value: scope.rawValue)]) ?? []
        guard !Task.isCancelled else { return }
        lines = fresh
        error = nil
      } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
  }
}
