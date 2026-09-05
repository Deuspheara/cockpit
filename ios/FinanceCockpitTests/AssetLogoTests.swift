import Foundation
import SwiftUI
import UIKit
import XCTest

@testable import FinanceCockpit

private final class OfflineLogoProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }
  override func stopLoading() {}
}

@MainActor
final class AssetLogoTests: XCTestCase {
  private let logoURL = URL(
    string: "https://static.coinpaprika.com/coin/hype-hyperliquid/logo.png")!

  private func cachedLoader() throws -> (AssetLogoLoader, Data) {
    // Use the existing official Hyperliquid artwork as an offline image fixture.
    let image = try XCTUnwrap(UIImage(named: "BrandHyperliquid"))
    let data = try XCTUnwrap(image.pngData())
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [OfflineLogoProtocol.self]
    let cache = URLCache(memoryCapacity: 1_048_576, diskCapacity: 0)
    config.urlCache = cache
    let response = try XCTUnwrap(
      HTTPURLResponse(
        url: logoURL, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "image/png", "Cache-Control": "max-age=86400"]))
    cache.storeCachedResponse(
      CachedURLResponse(response: response, data: data), for: URLRequest(url: logoURL))
    return (AssetLogoLoader(session: URLSession(configuration: config)), data)
  }

  func testPreviouslyCachedLogoWorksOffline() async throws {
    let (loader, expected) = try cachedLoader()
    let actual = try await loader.data(for: logoURL)
    XCTAssertEqual(actual, expected)
    XCTAssertNotNil(UIImage(data: actual))
    do {
      _ = try await loader.data(for: URL(string: "https://img.logo.dev/ticker/MISSING")!)
      XCTFail("An uncached offline logo must use the fallback")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
    }
  }

  func testAssetRowsInLightDarkAndLargeText() async throws {
    let (loader, _) = try cachedLoader()
    let account = UUID()
    let lines = [
      PortfolioAssetLine(
        accountId: account, accountName: "Trading", assetId: UUID(), symbol: "HYPE",
        name: "Hyperliquid", quantity: Amount(12), marketValue: Amount(540), currency: "USD",
        source: "hyperliquid", stale: false, logoUrl: logoURL.absoluteString),
      PortfolioAssetLine(
        accountId: account, accountName: "Long-term investment account", assetId: UUID(),
        symbol: "VWCE.DE", name: "Vanguard FTSE All-World", quantity: Amount(18.23),
        marketValue: Amount(2450), currency: "EUR", source: "manual", stale: true),
      PortfolioAssetLine(
        accountId: account, accountName: "Wallet", assetId: UUID(), symbol: "UNKNOWN",
        name: "Unmatched asset", quantity: Amount(0.1), marketValue: nil, currency: "EUR",
        source: "manual", stale: false),
    ]
    for (name, scheme, textSize) in [
      ("Asset rows · Light", ColorScheme.light, DynamicTypeSize.large),
      ("Asset rows · Dark", ColorScheme.dark, DynamicTypeSize.large),
      ("Asset rows · Accessibility", ColorScheme.light, DynamicTypeSize.accessibility3),
    ] {
      let content = VStack(alignment: .leading, spacing: 12) {
        Text("Assets").font(.title.bold())
        ForEach(lines) { line in
          PortfolioAssetRow(line: line, logoLoader: loader)
          Divider()
        }
        Spacer(minLength: 0)
      }
      .padding(20)
      .frame(width: 402, height: 850, alignment: .topLeading)
      .background(Color(uiColor: .systemBackground))
      .environment(\.colorScheme, scheme)
      .environment(\.dynamicTypeSize, textSize)
      let controller = UIHostingController(rootView: content)
      controller.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
      let scene = try XCTUnwrap(
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(x: 0, y: 0, width: 402, height: 850)
      window.rootViewController = controller
      window.makeKeyAndVisible()
      controller.view.frame = window.bounds
      controller.view.layoutIfNeeded()
      // Allow SwiftUI's asynchronous image task to consume the seeded HTTP cache.
      try await Task.sleep(for: .milliseconds(300))
      let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
      window.isHidden = true
    }
  }
}
