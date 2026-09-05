import Foundation
import Observation

@MainActor @Observable
final class PortfolioModel {
  var scope: PortfolioScope = .global
  var range: PortfolioRange = .month
  var dashboard: PortfolioDashboard?
  var isRefreshing = false
  var isCached = false
  var error: String?
  private var requestID = UUID()
  var key: String { "portfolio-\(scope.rawValue)-\(range.rawValue)" }
  func load(api: APIClient, cache: AppCache?) async {
    let identity = UUID()
    requestID = identity
    let key = self.key
    let scope = self.scope
    let range = self.range
    isRefreshing = true
    error = nil
    if dashboard?.scope != scope || dashboard?.range != range { dashboard = nil }
    if dashboard == nil, let cached = await cache?.read(key, as: PortfolioDashboard.self),
      requestID == identity
    {
      dashboard = cached
      isCached = true
    }
    do {
      let fresh: PortfolioDashboard = try await api.send(
        "portfolio/dashboard",
        query: [
          URLQueryItem(name: "scope", value: scope.rawValue),
          URLQueryItem(name: "range", value: range.rawValue),
        ])
      guard !Task.isCancelled, requestID == identity else { return }
      dashboard = fresh
      isCached = false
      isRefreshing = false
      await cache?.write(fresh, key: key)
    } catch {
      guard requestID == identity else { return }
      isRefreshing = false
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
}
