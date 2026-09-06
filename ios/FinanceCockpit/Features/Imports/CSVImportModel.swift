import Foundation
import Observation

struct CSVCounts: Codable, Sendable {
  let rows: Int
  let new: Int
  let duplicates: Int
  let conflicts: Int
  let skipped: Int
  let warnings: Int
}
struct CSVDestination: Codable, Identifiable, Sendable {
  var id: String { group }
  let group: String
  var accountId: UUID?
  var name: String
  var included: Bool
  let summary: CSVCounts
  var body: JSONValue {
    .object([
      "group": .string(group), "accountId": accountId.map { .string($0.uuidString) } ?? .null,
      "name": .string(name), "included": .bool(included),
    ])
  }
}
struct CSVImportIssue: Codable, Sendable {
  let row: Int
  let severity: String
  let code: String
  let message: String
}
struct CSVAccountCandidate: Codable, Identifiable, Sendable {
  let id: UUID
  let name: String
  let group: String?
}
struct CSVImportResult: Codable, Sendable {
  let imported: Int
  let duplicates: Int
  let skipped: Int
  let conflicts: Int
  let positionsUpdated: Int
  let completedAt: Date
}
struct CSVImportPreview: Codable, Identifiable, Sendable {
  let id: UUID
  let provider: String
  let filename: String
  let status: String
  let revision: Int
  let expiresAt: Date
  let summary: CSVCounts
  var destinations: [CSVDestination]
  let issues: [CSVImportIssue]
  let categories: [String: Int]
  let assets: Int
  let candidates: [CSVAccountCandidate]
  let result: CSVImportResult?
}
struct CSVImportHistoryItem: Codable, Identifiable, Sendable {
  let id: UUID
  let filename: String
  let status: String
  let completedAt: Date
  let importedRows: Int
  let duplicateRows: Int
}

@MainActor @Observable final class CSVImportModel {
  var provider = "auto"
  var preview: CSVImportPreview?
  var working = false
  var error: String?
  var needsRecovery = false
  var phase = ""
  var canConfirm: Bool {
    guard let preview else { return false }
    return !working && !needsRecovery && preview.status == "preview"
      && preview.expiresAt > Date() && preview.destinations.contains(where: \.included)
      && (preview.summary.new > 0 || preview.summary.duplicates > 0)
  }
  func select(_ url: URL, api: APIClient, accountID: UUID?) async {
    guard !working else { return }
    working = true
    error = nil
    phase = "Reading CSV…"
    defer { working = false }
    do {
      let data = try await Self.readFile(url)
      phase = "Preparing preview…"
      preview = try await api.uploadCSV(
        data: data, filename: url.lastPathComponent, provider: provider, accountID: accountID)
      needsRecovery = false
    } catch { self.error = error.localizedDescription }
  }
  nonisolated static func readFile(_ url: URL) async throws -> Data {
    try await Task.detached {
      let access = url.startAccessingSecurityScopedResource()
      defer { if access { url.stopAccessingSecurityScopedResource() } }
      guard url.pathExtension.lowercased() == "csv" else {
        throw APIError(message: "Choose a .csv file.")
      }
      var coordinationError: NSError?
      var result: Result<Data, Error>?
      NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) {
        coordinated in
        result = Result {
          let file = try FileHandle(forReadingFrom: coordinated)
          defer { try? file.close() }
          let bytes = try file.read(upToCount: 10 * 1024 * 1024 + 1) ?? Data()
          guard bytes.count <= 10 * 1024 * 1024 else {
            throw APIError(message: "CSV exceeds the 10 MB limit.")
          }
          guard !bytes.isEmpty else {
            throw APIError(message: "This CSV doesn't contain any transactions.")
          }
          return bytes
        }
      }
      if let coordinationError { throw coordinationError }
      guard let result else { throw APIError(message: "The selected file could not be read.") }
      return try result.get()
    }.value
  }
  func saveDestinations(_ destinations: [CSVDestination], api: APIClient) async {
    guard let preview else { return }
    working = true
    error = nil
    phase = "Updating preview…"
    defer { working = false }
    do {
      self.preview = try await api.send(
        "imports/csv/\(preview.id)", method: "PATCH",
        body: [
          "revision": .number(Decimal(preview.revision)),
          "destinations": .array(destinations.map(\.body)),
        ])
    } catch { self.error = error.localizedDescription }
  }
  func confirm(api: APIClient) async {
    guard canConfirm, let preview else { return }
    working = true
    error = nil
    phase = "Importing…"
    defer { working = false }
    do {
      self.preview = try await api.send(
        "imports/csv/\(preview.id)/confirm", method: "POST",
        body: ["revision": .number(Decimal(preview.revision))])
      if self.preview?.result == nil {
        error = "The preview changed. Review the issues before confirming again."
      }
    } catch {
      needsRecovery = true
      await recover(api: api)
    }
  }
  func recover(api: APIClient) async {
    guard let preview else { return }
    let wasWorking = working
    working = true
    defer { working = wasWorking }
    do {
      self.preview = try await api.send("imports/csv/\(preview.id)")
      needsRecovery = false
      error =
        self.preview?.result == nil
        ? "No completed import was found. Review the preview before retrying." : nil
    } catch {
      self.error = "Couldn't check the import result. Reconnect and check again before retrying."
    }
  }
  func cancel(api: APIClient) async {
    guard let preview, preview.result == nil, !needsRecovery else { return }
    struct Cancelled: Decodable, Sendable { let cancelled: Bool }
    let _: Cancelled? = try? await api.send("imports/csv/\(preview.id)", method: "DELETE")
  }
}
