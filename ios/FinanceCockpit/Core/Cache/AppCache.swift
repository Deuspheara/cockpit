import CryptoKit
import Foundation

actor AppCache {
  private(set) var generation = 0
  private let folder: URL
  init(namespace: String) {
    let digest = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
    let support = URL.applicationSupportDirectory
    folder = support.appending(path: "FinanceCache").appending(path: digest)
  }
  private func file(_ key: String) -> URL {
    let safe = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    return folder.appending(path: safe + ".json")
  }
  func read<T: Codable & Sendable>(_ key: String, as: T.Type) -> T? {
    guard let data = try? Data(contentsOf: file(key)) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
  func write<T: Codable & Sendable>(_ value: T, key: String, generation expected: Int? = nil) {
    guard expected == nil || expected == generation else { return }
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(value)
      try data.write(to: file(key), options: [.atomic, .completeFileProtection])
      var protected = folder
      var resources = URLResourceValues()
      resources.isExcludedFromBackup = true
      try protected.setResourceValues(resources)
    } catch { /* Disposable cache failure must not hide a successful response. */  }
  }
  func clear() {
    generation += 1
    try? FileManager.default.removeItem(at: folder)
  }
}
