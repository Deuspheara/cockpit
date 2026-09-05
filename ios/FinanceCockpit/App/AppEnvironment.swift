import Foundation
import Observation

struct AIAvailability: Equatable, Sendable {
  let keyConfigured: Bool
  let chatConfigured: Bool
  let visionConfigured: Bool

  static let unknown = AIAvailability(
    keyConfigured: false, chatConfigured: false, visionConfigured: false)
}

@MainActor @Observable
final class AppEnvironment {
  var api: APIClient?
  var cache: AppCache?
  var serverURL: String
  var sessionInfo: SessionInfo?
  var connectionError: String?
  var lastSuccessfulRefresh: Date?
  var dataRevision = 0
  var aiAvailability: AIAvailability {
    guard let ai = sessionInfo?.ai else { return .unknown }
    return AIAvailability(
      keyConfigured: ai.keyConfigured,
      chatConfigured: ai.chatConfigured,
      visionConfigured: ai.visionConfigured)
  }
  init() {
    serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    do {
      if let token = try TokenKeychain.read(), !serverURL.isEmpty {
        let configuration = try APIConfiguration(server: serverURL, token: token)
        api = APIClient(configuration: configuration)
        cache = AppCache(namespace: serverURL + token)
      }
    } catch { connectionError = error.localizedDescription }
  }
  func connect(server: String, token: String) async throws {
    let configuration = try APIConfiguration(server: server, token: token)
    let client = APIClient(configuration: configuration)
    let info: SessionInfo = try await client.send("session")
    try TokenKeychain.save(token)
    serverURL = configuration.baseURL.absoluteString
    UserDefaults.standard.set(serverURL, forKey: "serverURL")
    api = client
    cache = AppCache(namespace: serverURL + token)
    sessionInfo = info
    connectionError = nil
  }
  func testConnection() async {
    guard let api else { return }
    do {
      sessionInfo = try await api.send("session")
      connectionError = nil
    } catch { connectionError = error.localizedDescription }
  }
  func logout() async throws {
    try TokenKeychain.remove()
    await cache?.clear()
    api = nil
    cache = nil
    sessionInfo = nil
    UserDefaults.standard.removeObject(forKey: "serverURL")
    serverURL = ""
  }
}
