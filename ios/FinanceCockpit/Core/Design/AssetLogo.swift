import Foundation
import SwiftUI
import UIKit

/// Logos are decorative; the adjacent asset symbol remains the accessible label.
struct AssetLogo: View {
  let symbol: String
  let urlString: String?
  var size: CGFloat = 36
  var loader: AssetLogoLoader = .shared
  @State private var image: UIImage?
  @State private var loadedURL: URL?

  nonisolated static func remoteURL(_ value: String?) -> URL? {
    guard let value, let url = URL(string: value), url.scheme == "https",
      let host = url.host,
      ["static.coinpaprika.com", "img.logo.dev"].contains(host),
      url.user == nil, url.password == nil
    else { return nil }
    return url
  }

  private var url: URL? { Self.remoteURL(urlString) }

  var body: some View {
    Group {
      if let image, loadedURL == url {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .padding(4)
          .frame(width: size, height: size)
          .background(.white, in: .rect(cornerRadius: 10))
      } else {
        Text(String(symbol.prefix(3)).uppercased())
          .font(.system(size: 11, weight: .semibold))
          .minimumScaleFactor(0.7)
          .lineLimit(1)
          .padding(3)
          .frame(width: size, height: size)
          .foregroundStyle(.secondary)
          .background(Color.secondary.opacity(0.1), in: .rect(cornerRadius: 10))
      }
    }
    .clipShape(.rect(cornerRadius: 10))
    .accessibilityHidden(true)
    .task(id: url) {
      image = nil
      loadedURL = nil
      guard let url else { return }
      do {
        let data = try await loader.data(for: url)
        guard !Task.isCancelled else { return }
        image = UIImage(data: data)
        loadedURL = url
      } catch {
        // Missing, offline, or invalid logos keep the neutral symbol badge.
      }
    }
  }
}

actor AssetLogoLoader {
  static let shared = AssetLogoLoader()
  private let session: URLSession
  private var pending: [URL: Task<Data, Error>] = [:]

  init(session: URLSession? = nil) {
    if let session {
      self.session = session
      return
    }
    let configuration = URLSessionConfiguration.default
    configuration.urlCache = URLCache(
      memoryCapacity: 8 * 1024 * 1024,
      diskCapacity: 50 * 1024 * 1024,
      diskPath: "AssetLogos")
    configuration.requestCachePolicy = .useProtocolCachePolicy
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 8
    configuration.httpMaximumConnectionsPerHost = 4
    self.session = URLSession(configuration: configuration)
  }

  func data(for url: URL) async throws -> Data {
    if let task = pending[url] { return try await task.value }
    let task = Task<Data, Error> { [session] in
      let request = URLRequest(url: url)
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
          response.mimeType?.hasPrefix("image/") == true, data.count <= 1_048_576
        else { throw URLError(.badServerResponse) }
        return data
      } catch {
        // Previously cached logos remain usable without connectivity.
        if let saved = session.configuration.urlCache?.cachedResponse(for: request),
          let http = saved.response as? HTTPURLResponse, http.statusCode == 200,
          saved.response.mimeType?.hasPrefix("image/") == true,
          saved.data.count <= 1_048_576
        {
          return saved.data
        }
        throw error
      }
    }
    pending[url] = task
    defer { pending[url] = nil }
    return try await task.value
  }
}
