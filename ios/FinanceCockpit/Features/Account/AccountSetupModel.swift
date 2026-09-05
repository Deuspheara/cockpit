import Foundation
import Observation

enum AccountTracking: String, CaseIterable, Identifiable {
  case connected, manual
  var id: Self { self }
}
enum AccountProvider: String, CaseIterable, Identifiable {
  case hyperliquid, dydx
  case evmWallet = "evm_wallet"
  var id: Self { self }
  var title: String {
    switch self {
    case .hyperliquid: "Hyperliquid"
    case .dydx: "dYdX"
    case .evmWallet: "EVM wallet"
    }
  }
}
enum ManualAccountCategory: String, CaseIterable, Identifiable {
  case equities, crypto, cash, other
  var id: Self { self }
  var title: String {
    switch self {
    case .equities: "Investments"
    case .crypto: "Crypto"
    case .cash: "Cash"
    case .other: "Other"
    }
  }
}
enum AccountSetupStep: Int, Hashable {
  case type = 2
  case details, review, holding, finish
}

struct AccountDraft {
  var tracking: AccountTracking = .connected
  var provider: AccountProvider = .hyperliquid
  var category: ManualAccountCategory = .equities
  var name = ""
  var currency = "EUR"
  var address = ""
  var subaccount = "0"
  var suggestedName: String { tracking == .connected ? provider.title : category.title }
  var effectiveName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      ? suggestedName : name.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  var cleanCurrency: String {
    currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
  }
  var cleanAddress: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }
  var nameError: String? { effectiveName.count > 120 ? "Use 120 characters or fewer." : nil }
  var currencyError: String? {
    cleanCurrency.range(of: "^[A-Z]{3}$", options: .regularExpression) == nil
      ? "Enter a three-letter currency, such as EUR or USD." : nil
  }
  var addressError: String? {
    guard tracking == .connected else { return nil }
    let pattern = provider == .dydx ? "^dydx1[0-9a-z]{38}$" : "^0x[0-9a-fA-F]{40}$"
    return cleanAddress.range(of: pattern, options: .regularExpression) == nil
      ? (provider == .dydx
        ? "Enter a public dYdX address starting with dydx1."
        : "Enter a public address starting with 0x (42 characters).") : nil
  }
  var subaccountError: String? {
    guard tracking == .connected, provider == .dydx else { return nil }
    guard let value = Int(subaccount), (0...128000).contains(value) else {
      return "Enter a subaccount from 0 to 128000."
    }
    return nil
  }
  var isValid: Bool {
    [nameError, currencyError, addressError, subaccountError].allSatisfy { $0 == nil }
  }
  func body() throws -> [String: JSONValue] {
    guard isValid else { throw APIError(message: "Check the highlighted account details.") }
    var result: [String: JSONValue] = [
      "name": .string(effectiveName), "baseCurrency": .string(cleanCurrency),
      "assetClass": .string(tracking == .connected ? "crypto" : category.rawValue),
      "sourceType": .string(tracking == .connected ? provider.rawValue : "manual"),
    ]
    if tracking == .connected {
      result["externalAddress"] = .string(cleanAddress)
      if provider == .dydx { result["externalSubaccount"] = .number(Decimal(Int(subaccount)!)) }
    }
    return result
  }
}

struct AccountSyncResult: Decodable, Sendable {
  let status: String
  var id: UUID? = nil
  var provider: String? = nil
  var failure: ImportJobDTO.Failure? = nil
  var warnings: [String]? = nil
}

@MainActor @Observable
final class AccountSetupModel {
  var draft = AccountDraft()
  var path: [AccountSetupStep] = []
  private(set) var account: Account?
  private(set) var working = false
  private(set) var error: String?
  private(set) var synced = false
  private(set) var syncMessage = "Your first sync is queued."

  func create(using create: ([String: JSONValue]) async throws -> Account) async {
    guard !working else { return }
    if account != nil { return }
    working = true
    error = nil
    defer { working = false }
    do {
      account = try await create(draft.body())
      path = [draft.tracking == .manual ? .holding : .finish]
    } catch { self.error = error.localizedDescription }
  }
  func sync(using sync: (UUID) async throws -> AccountSyncResult) async {
    guard !working, let account, !synced else { return }
    error = nil
    do {
      let result = try await sync(account.id)
      switch result.status {
      case "success": syncMessage = "Your first sync has completed."
      case "partial":
        syncMessage =
          "Your account is connected, but some data is unavailable. "
          + (result.warnings ?? []).joined(separator: " ")
      case "queued", "running": syncMessage = "Synchronization continues in the background. You can open your account now."
      default: throw APIError(message: "The last sync did not complete. Try again shortly.")
      }
      synced = true
    } catch { self.error = "Account created. Sync could not finish: \(error.localizedDescription)" }
  }
}
