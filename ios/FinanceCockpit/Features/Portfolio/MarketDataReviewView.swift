import SwiftUI

struct MarketDataSecuritySummary: Decodable, Identifiable, Sendable {
  let id: UUID
  let isin: String
  let name: String
  let assetType: String
  let identityStatus: String
  let selectionLocked: Bool
  let revision: Int
  let selectionStatus: String
  let priceStatus: String
  let historyStatus: String
  let message: String?
  let resolutionReason: String?
  let nextRetryAt: Date?
  let marketDate: String?
  let close: Amount?
  let currency: String?
  let assetCount: Int
}

struct MarketDataStateDTO: Decodable, Identifiable, Sendable {
  var id: String { stage }
  let stage: String
  let status: String
  let errorClass: String?
  let message: String?
  let nextRetryAt: Date?
}

struct MarketDataMappingDTO: Decodable, Identifiable, Sendable {
  let id: UUID
  let provider: String
  let providerSymbol: String
  let providerExchange: String?
  let verificationStatus: String
  let ticker: String
  let mic: String?
  let name: String
  let quoteCurrency: String
  let quoteUnit: String
  let unitMultiplier: Amount
  let timezone: String?
  let active: Bool
  let selected: Bool
  let selectable: Bool
}

struct MarketDataPriceDTO: Decodable, Sendable {
  let close: Amount
  let currency: String
  let marketDate: String
  let timePrecision: String
}

struct MarketDataSecurityDetail: Decodable, Identifiable, Sendable {
  let id: UUID
  let isin: String
  let name: String
  let assetType: String
  let identityStatus: String
  let preferredMappingId: UUID?
  let selectionLocked: Bool
  let revision: Int
  let resolutionReason: String?
  let nextRetryAt: Date?
  let states: [MarketDataStateDTO]
  let mappings: [MarketDataMappingDTO]
  let latestPrice: MarketDataPriceDTO?
}

struct MarketDataReviewView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var rows: [MarketDataSecuritySummary] = []
  @State private var loading = false
  @State private var error: String?

  var body: some View {
    List {
      if rows.isEmpty && !loading && error == nil {
        ContentUnavailableView(
          "No market-data reviews",
          systemImage: "checkmark.circle",
          description: Text("Held ISIN securities have a selected and usable valuation route."))
      }
      ForEach(rows) { security in
        NavigationLink {
          MarketDataSecurityView(securityID: security.id)
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            Text(security.name).font(.headline)
            Text("\(security.isin) · \(marketStatusTitle(security))")
              .font(.caption).foregroundStyle(.secondary)
            if let message = marketResolutionMessage(
              reason: security.resolutionReason,
              fallback: security.message,
              retryAt: security.nextRetryAt)
            {
              Text(message).font(.caption).foregroundStyle(.orange)
            }
            if let date = security.marketDate, let close = security.close,
              let currency = security.currency
            {
              Text("Close · \(marketDateTitle(date)) · \(FinanceFormat.amount(close, currency: currency))")
                .font(.caption).foregroundStyle(.secondary)
            }
          }.padding(.vertical, 4)
        }
      }
      if loading { ProgressView("Loading market data…") }
      if let error {
        Text(error).foregroundStyle(.red)
        Button("Retry") { Task { await load() } }
      }
    }
    .navigationTitle("Market data")
    .task { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    guard let api = environment.api, !loading else { return }
    loading = true
    defer { loading = false }
    do {
      rows = try await api.send(
        "market-data/securities", query: [.init(name: "needsReview", value: "true")])
      error = nil
    } catch is CancellationError {
      return
    } catch {
      self.error = error.localizedDescription
    }
  }
}

struct MarketDataSecurityView: View {
  let securityID: UUID
  @Environment(AppEnvironment.self) private var environment
  @State private var detail: MarketDataSecurityDetail?
  @State private var working = false
  @State private var error: String?

  var body: some View {
    List {
      if let detail {
        Section("Security") {
          LabeledContent("ISIN", value: detail.isin)
          LabeledContent("Identity", value: statusTitle(detail.identityStatus))
          LabeledContent("Selection", value: detail.selectionLocked ? "Locked by you" : "Automatic")
          if let price = detail.latestPrice {
            LabeledContent(
              "Latest close",
              value: FinanceFormat.amount(price.close, currency: price.currency))
            LabeledContent("Market date", value: marketDateTitle(price.marketDate))
          }
        }
        if !detail.states.isEmpty {
          Section("Status") {
            ForEach(detail.states) { state in
              VStack(alignment: .leading, spacing: 3) {
                LabeledContent(stageTitle(state.stage), value: statusTitle(state.status))
                if let message = state.message {
                  Text(message).font(.caption).foregroundStyle(.secondary)
                }
                if let retryAt = state.nextRetryAt {
                  Text("Next retry · \(retryAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        Section("Verified EODHD listings") {
          if detail.mappings.isEmpty {
            Text(
              marketResolutionMessage(
                reason: detail.resolutionReason,
                fallback: "Listing verification is pending.",
                retryAt: detail.nextRetryAt)!)
              .foregroundStyle(.secondary)
          }
          ForEach(detail.mappings) { mapping in
            Button {
              Task { await select(mapping.id, revision: detail.revision) }
            } label: {
              HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(mapping.name).foregroundStyle(.primary)
                  Text(
                    [mapping.providerSymbol, mapping.mic, mapping.quoteCurrency]
                      .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                  Text("Exact ISIN verified · EODHD daily route")
                    .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if mapping.selected { Image(systemName: "checkmark.circle.fill") }
              }
            }.disabled(working || !mapping.selectable)
          }
        }
        Section {
          if detail.preferredMappingId != nil {
            Button("Refresh prices") { Task { await refresh() } }
              .disabled(working)
          }
          Button("Re-resolve listings") { Task { await reResolve(revision: detail.revision) } }
            .disabled(working || detail.selectionLocked)
          if detail.selectionLocked {
            Button("Return to automatic selection") {
              Task { await select(nil, revision: detail.revision) }
            }.disabled(working)
          }
        }
      } else if error == nil {
        ProgressView("Loading security…")
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle(detail?.name ?? "Market data")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: securityID) { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    guard let api = environment.api else { return }
    do {
      detail = try await api.send("market-data/securities/\(securityID)")
      error = nil
    } catch is CancellationError {
      return
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func select(_ mappingID: UUID?, revision: Int) async {
    guard let api = environment.api else { return }
    working = true
    defer { working = false }
    do {
      detail = try await api.send(
        "market-data/securities/\(securityID)/selection", method: "PUT",
        body: [
          "mappingId": mappingID.map { .string($0.uuidString) } ?? .null,
          "expectedRevision": .number(Decimal(revision)),
        ])
      error = nil
      environment.dataRevision += 1
    } catch {
      self.error = error.localizedDescription
      await load()
    }
  }

  private func refresh() async {
    guard let api = environment.api else { return }
    working = true
    defer { working = false }
    do {
      let _: JSONValue = try await api.send(
        "market-data/securities/\(securityID)/refresh", method: "POST")
      await load()
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func reResolve(revision: Int) async {
    guard let api = environment.api else { return }
    working = true
    defer { working = false }
    do {
      detail = try await api.send(
        "market-data/securities/\(securityID)/re-resolve", method: "POST",
        body: ["expectedRevision": .number(Decimal(revision))])
      error = nil
    } catch {
      self.error = error.localizedDescription
      await load()
    }
  }
}

private func statusTitle(_ status: String) -> String {
  status.replacingOccurrences(of: "_", with: " ").capitalized
}

private func stageTitle(_ stage: String) -> String {
  stage.replacingOccurrences(of: "_", with: " ").capitalized
}

private func marketStatusTitle(_ security: MarketDataSecuritySummary) -> String {
  if security.resolutionReason == "listing_selection_required" { return "Listing selection required" }
  if security.resolutionReason == "verification_quota_delayed" {
    return "Verification delayed"
  }
  if security.resolutionReason == "exact_isin_not_found" { return "No exact listing found" }
  if security.identityStatus != "identity_resolved" { return statusTitle(security.identityStatus) }
  if security.selectionStatus != "selected" { return statusTitle(security.selectionStatus) }
  return statusTitle(security.priceStatus)
}

func marketResolutionMessage(reason: String?, fallback: String?, retryAt: Date?) -> String? {
  let message: String?
  switch reason {
  case "listing_selection_required": message = "Listing selection required"
  case "verification_quota_delayed": message = "Verification delayed until EODHD quota resets"
  case "exact_isin_not_found": message = "No exact-ISIN EODHD listing found"
  default: message = fallback
  }
  guard let message else { return nil }
  guard reason == "verification_quota_delayed", let retryAt else { return message }
  return "\(message) · Next retry \(retryAt.formatted(date: .abbreviated, time: .shortened))"
}

private func marketDateTitle(_ value: String) -> String {
  let formatter = DateFormatter()
  formatter.locale = .current
  formatter.dateStyle = .medium
  formatter.timeStyle = .none
  let parser = DateFormatter()
  parser.locale = Locale(identifier: "en_US_POSIX")
  parser.dateFormat = "yyyy-MM-dd"
  return parser.date(from: value).map(formatter.string) ?? value
}
