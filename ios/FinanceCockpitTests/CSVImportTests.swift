import Foundation
import Testing

@testable import FinanceCockpit

@MainActor struct CSVImportTests {
  private func client() throws -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [InteractionFixtureProtocol.self]
    return try APIClient(
      configuration: APIConfiguration(
        server: "https://fixtures.invalid", token: String(repeating: "a", count: 43)),
      session: URLSession(configuration: config))
  }
  @Test func selectsFilePreviewsAndConfirms() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".csv")
    try Data("fixture,data\n1,2".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let model = CSVImportModel()
    let api = try client()
    await model.select(url, api: api, accountID: nil)
    #expect(model.preview?.summary.new == 3)
    #expect(model.canConfirm)
    await model.confirm(api: api)
    #expect(model.preview?.result?.imported == 3)
    #expect(!model.canConfirm)
    #expect(model.error == nil)
  }
  @Test func validatesEmptyAndOversizedFiles() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString + ".csv")
    defer { try? FileManager.default.removeItem(at: url) }
    for bytes in [Data(), Data(repeating: 65, count: 10 * 1024 * 1024 + 1)] {
      try bytes.write(to: url)
      do {
        _ = try await CSVImportModel.readFile(url)
        Issue.record("Invalid file accepted")
      } catch {}
    }
  }
  @Test func duplicateOnlyPreviewIsConfirmableAndRecoveryBlocksAnotherCommit() {
    let model = CSVImportModel()
    model.preview = CSVFixtures.preview(duplicates: true)
    #expect(model.canConfirm)
    model.needsRecovery = true
    #expect(!model.canConfirm)
  }
  @Test func invalidSelectionShowsError() async throws {
    let model = CSVImportModel()
    await model.select(URL(fileURLWithPath: "/missing.csv"), api: try client(), accountID: nil)
    #expect(model.error != nil)
    #expect(model.preview == nil)
    #expect(!model.working)
  }
}
