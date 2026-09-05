import PhotosUI
import SwiftUI
import UIKit

struct ImportSessionDTO: Decodable, Sendable {
  struct Extraction: Decodable, Sendable {
    struct Candidate: Decodable, Sendable {
      let candidateId: UUID?
      let symbol: String?
      let name: String?
      let isin: String?
      let quantity: Amount?
      let currency: String?
      let marketValue: Amount?
      let confidence: Double
      let providerKey: String?
      let providerExchange: String?
      let matchStatus: String
      let quantitySource: String
      let quotePrice: Amount?
      let quoteCurrency: String?
      let quoteAt: Date?
      let fxRate: Amount?
      let sourceLines: Int
      let sourceCandidateIds: [UUID]
    }
    struct Derivative: Decodable, Sendable {
      let candidateId: UUID?
      let underlyingSymbol: String?
      let name: String?
      let optionType: String?
      let strike: Amount?
      let expiration: String?
      let contractSymbol: String?
      let quantity: Amount?
      let marketValue: Amount?
      let currency: String?
      let confidence: Double
      let quantitySource: String
      let sourceLines: Int
      let sourceCandidateIds: [UUID]
    }
    let likelyAccountName: String?
    let likelyInstitution: String?
    let capturedAt: Date?
    let capturedAtInferred: Bool
    let currency: String?
    let positions: [Candidate]
    let derivatives: [Derivative]
  }
  let id: UUID
  let status: String
  let revision: Int
  let summary: String?
  let extraction: Extraction?
  let questions: [String]?
  let blockers: [String]?
  let warnings: [String]?
  let changeSetId: UUID?
}
struct ImportView: View {
  var accountID: UUID?
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var selected: [PhotosPickerItem] = []
  @State private var session: ImportSessionDTO?
  @State private var accountName = ""
  @State private var answer = ""
  @State private var error: String?
  @State private var working = false
  @State private var reviewID: UUID?
  var body: some View {
    let pickerTitle = session == nil ? "Choose screenshots" : "Add screenshots"
    Form {
      Section {
        Text("Import explicit positions").font(.headline)
        Text(
          "Screenshots go to your server’s configured vision model. Only structured extraction is retained by your server. Missing history remains unknown."
        ).font(.callout).foregroundStyle(.secondary)
        PhotosPicker(selection: $selected, maxSelectionCount: 5, matching: .images) {
          HStack(spacing: 8) {
            AppIcon(name: .photo, size: 18)
            Text(pickerTitle)
          }
        }.disabled(working || !environment.aiAvailability.visionConfigured)
        if environment.sessionInfo != nil && !environment.aiAvailability.visionConfigured {
          Text("Configure an OpenRouter key and vision model on the server to enable extraction.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      if working { Section { ProgressView("Reading financial evidence…") } }
      if let session {
        Section("Session") { Text(session.summary ?? session.status) }
        if let positions = session.extraction?.positions {
          Section("Extracted candidates") {
            ForEach(Array(positions.enumerated()), id: \.offset) { _, position in
              HStack {
                Text(position.symbol ?? "Unknown asset")
                Spacer()
                Text(position.quantity.map { FinanceFormat.quantity($0) } ?? "Quantity missing")
                  .monospacedDigit()
              }
            }
          }
        }
        if let questions = session.questions, !questions.isEmpty {
          Section("Information needed") { ForEach(questions, id: \.self) { Text($0) } }
        }
        Section("Clarify or correct") {
          TextField(
            "For example: these holdings were observed on August 31, 2026", text: $answer,
            axis: .vertical)
          Button("Send clarification") { Task { await clarify() } }.disabled(
            working || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        if session.status == "ready_for_review" {
          Section("Final review") {
            if accountID == nil { TextField("Account name", text: $accountName) }
            Button("Prepare changes for review") { Task { await prepare() } }.disabled(working)
          }
        }
      }
      if let error { Section { Text(error).foregroundStyle(.red) } }
    }.navigationTitle("Import screenshot")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .task { await environment.testConnection() }
      .onChange(of: selected) { _, images in if !images.isEmpty { Task { await upload(images) } } }
      .navigationDestination(item: $reviewID) { ChangeSetReview(changeSetID: $0) }
  }
  private func upload(_ items: [PhotosPickerItem]) async {
    guard let api = environment.api, !working else { return }
    working = true
    error = nil
    defer {
      working = false
      selected = []
    }
    do {
      if session == nil {
        let body: [String: JSONValue] =
          accountID.map { ["accountId": .string($0.uuidString)] } ?? [:]
        session = try await api.send("imports", method: "POST", body: body)
      }
      guard let id = session?.id else { throw APIError(message: "Unable to start an import.") }
      for item in items {
        guard let original = try await item.loadTransferable(type: Data.self),
          let image = UIImage(data: original)
        else { throw APIError(message: "This image could not be read.") }
        var data = image.pngData()
        var mime = "image/png"
        if data == nil || (data?.count ?? 0) > 12 * 1024 * 1024 {
          let scale = min(1, 4000 / max(image.size.width, image.size.height))
          let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
          let format = UIGraphicsImageRendererFormat()
          format.scale = 1
          let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
          }
          data = resized.jpegData(compressionQuality: 0.9)
          mime = "image/jpeg"
        }
        guard let bytes = data, bytes.count <= 12 * 1024 * 1024 else {
          throw APIError(
            message: "The screenshot is too large. Crop it to the relevant financial lines.")
        }
        session = try await api.uploadScreenshot(id: id, data: bytes, mime: mime)
        if accountName.isEmpty { accountName = session?.extraction?.likelyAccountName ?? "" }
      }
    } catch { self.error = error.localizedDescription }
  }
  private func clarify() async {
    guard let api = environment.api, let session else { return }
    working = true
    defer { working = false }
    do {
      self.session = try await api.send(
        "imports/\(session.id)/message", method: "POST", body: ["message": .string(answer)])
      answer = ""
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func prepare() async {
    guard let api = environment.api, let session else { return }
    working = true
    defer { working = false }
    do {
      let body: [String: JSONValue] =
        accountName.isEmpty ? [:] : ["accountName": .string(accountName)]
      let change: ChangeSet = try await api.send(
        "imports/\(session.id)/prepare-change-set", method: "POST", body: body)
      reviewID = change.id
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
#Preview { NavigationStack { ImportView() }.environment(AppEnvironment()) }
