import Foundation
import Observation

@MainActor @Observable
final class PortfolioModel {
  var scope: PortfolioScope = .global
  var range: PortfolioRange = .month
  let snapshot = SnapshotLoader<PortfolioDashboard>()
  var dashboard: PortfolioDashboard? {
    get { snapshot.value }
    set { snapshot.value = newValue }
  }
  var isRefreshing: Bool { snapshot.isLoading }
  var isCached: Bool { snapshot.isCached }
  var error: String? { snapshot.error ?? previewError }
  var previewError: String?
  var key: String { "portfolio-\(scope.rawValue)-\(range.rawValue)" }
  func load(api: APIClient, cache: AppCache?) async {
    let key = self.key
    let scope = self.scope
    let range = self.range
    await snapshot.load(
      key: key,
      cached: { await cache?.read(key, as: PortfolioDashboard.self) },
      fetch: {
        try await api.send(
          "portfolio/dashboard",
          query: [
            URLQueryItem(name: "scope", value: scope.rawValue),
            URLQueryItem(name: "range", value: range.rawValue),
          ])
      },
      save: { await cache?.write($0, key: key) })
  }
}
