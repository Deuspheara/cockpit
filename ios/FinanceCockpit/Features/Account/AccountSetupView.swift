import SwiftUI

struct AccountSetupView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @State private var model = AccountSetupModel()
  var onOpen: (Account) -> Void

  var body: some View {
    NavigationStack(path: $model.path) {
      Form {
        progress(1)
        Section {
          Text("How would you like to track this account?").font(.title2.bold())
          choice("Connect a crypto account", detail: "Keep balances updated from a public address.")
          {
            model.draft.tracking = .connected
            model.path.append(.type)
          }
          choice("Track manually", detail: "Add investments, crypto, or cash yourself.") {
            model.draft.tracking = .manual
            model.path.append(.type)
          }
        }
      }
      .navigationTitle("Add account")
      .navigationDestination(for: AccountSetupStep.self) { step in
        stepView(step)
          .navigationTitle(title(step))
          .navigationBarTitleDisplayMode(.inline)
          .navigationBarBackButtonHidden(model.account != nil)
          .toolbar { closeButton }
      }
      .toolbar { closeButton }
    }
    .interactiveDismissDisabled(model.working && model.account == nil)
  }

  @ToolbarContentBuilder private var closeButton: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Close") { dismiss() }.disabled(model.working && model.account == nil)
    }
  }
  private func progress(_ step: Int) -> some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text("Step \(step) of 4").font(.caption).foregroundStyle(.secondary)
        ProgressView(value: Double(step), total: 4).accessibilityLabel("Setup progress")
      }
    }
  }
  private func title(_ step: AccountSetupStep) -> String {
    switch step {
    case .type: "Account type"
    case .details: "Account details"
    case .review: "Review account"
    case .holding: "First holding"
    case .finish: "Account ready"
    }
  }
  private func choice(_ title: String, detail: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        VStack(alignment: .leading, spacing: 5) {
          Text(title).font(.headline).foregroundStyle(.primary)
          Text(detail).font(.subheadline).foregroundStyle(.secondary)
        }
        Spacer()
        AppIcon(name: .arrowRight, size: 18)
      }.padding(.vertical, 10).frame(minHeight: 44)
    }.buttonStyle(.plain)
  }
  @ViewBuilder private func stepView(_ step: AccountSetupStep) -> some View {
    switch step {
    case .type:
      Form {
        progress(2)
        Section(model.draft.tracking == .connected ? "Choose a provider" : "What will you track?") {
          if model.draft.tracking == .connected {
            ForEach(AccountProvider.allCases) { provider in
              choice(
                provider.title,
                detail: provider == .evmWallet
                  ? (environment.sessionInfo?.walletConfigured == true ? "Track a public wallet" : "Alchemy not configured. Configure ALCHEMY_API_KEY on the server.") : "Sync your account read-only"
              ) {
                model.draft.provider = provider
                model.path.append(.details)
              }.disabled(provider == .evmWallet && environment.sessionInfo?.walletConfigured != true)
            }
          } else {
            ForEach(ManualAccountCategory.allCases) { category in
              choice(
                category.title,
                detail: category == .cash
                  ? "Savings or a cash balance" : "Add your holdings at your own pace"
              ) {
                model.draft.category = category
                model.path.append(.details)
              }
            }
          }
        }
      }
    case .details:
      Form {
        progress(3)
        Section("Make it yours") {
          TextField(
            "Account name", text: $model.draft.name, prompt: Text(model.draft.suggestedName)
          )
          .accessibilityIdentifier("setup-name")
          Text("Leave blank to use “\(model.draft.suggestedName)”.").font(.caption).foregroundStyle(
            .secondary)
          validation(model.draft.nameError)
          TextField("Currency", text: $model.draft.currency)
            .textInputAutocapitalization(.characters).autocorrectionDisabled()
          validation(model.draft.currencyError)
        }
        if model.draft.tracking == .connected {
          Section("Connect \(model.draft.provider.title)") {
            TextField("Public address", text: $model.draft.address, axis: .vertical)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .accessibilityIdentifier("setup-address")
            if !model.draft.address.isEmpty { validation(model.draft.addressError) }
            Text("Public address only. No signature, password, or trading permission needed.")
              .font(.caption).foregroundStyle(.secondary)
            if model.draft.provider == .dydx {
              DisclosureGroup("Advanced") {
                TextField("Subaccount", text: $model.draft.subaccount).keyboardType(.numberPad)
                Text("Most accounts use subaccount 0.").font(.caption).foregroundStyle(.secondary)
                validation(model.draft.subaccountError)
              }
            }
          }
        }
        Section {
          Button("Continue") { model.path.append(.review) }
            .disabled(!model.draft.isValid)
        }
      }
    case .review:
      Form {
        progress(4)
        Section("Ready to add") {
          LabeledContent("Name", value: model.draft.effectiveName)
          LabeledContent(
            "Type",
            value: model.draft.tracking == .connected
              ? model.draft.provider.title : model.draft.category.title)
          LabeledContent("Currency", value: model.draft.cleanCurrency)
          if model.draft.tracking == .connected {
            LabeledContent("Public address", value: model.draft.cleanAddress)
            if model.draft.provider == .dydx {
              LabeledContent("Subaccount", value: model.draft.subaccount)
            }
          }
          Button("Edit details") { model.path.removeLast() }.disabled(model.working)
        }
        Section {
          Text(
            model.draft.tracking == .manual
              ? "Next, add your first holding or balance. You can also skip and do this later."
              : "We’ll create the account and start its first sync."
          )
          .font(.subheadline).foregroundStyle(.secondary)
          if let error = model.error { Text(error).foregroundStyle(.red) }
          Button(model.working ? "Creating…" : "Create account") { Task { await create() } }
            .disabled(model.working).accessibilityIdentifier("setup-create")
        }
      }.navigationBarBackButtonHidden(model.working)
    case .holding:
      if let account = model.account {
        FirstHoldingView(account: account, showsClose: false) {
          model.path = [.finish]
        }
      }
    case .finish:
      Form {
        if let account = model.account {
          Section {
            Text("\(account.name) is ready").font(.title2.bold())
            Text(
              account.sourceType == "manual"
                ? "Your account is saved. You can add or update holdings whenever you like."
                : (model.synced ? model.syncMessage : "Your account is saved.")
            )
            .foregroundStyle(.secondary)
            if account.sourceType != "manual" { AccountSyncStatusView(accountID: account.id) }
            if let error = model.error {
              Text(error).foregroundStyle(.red)
              Button("Retry sync") { Task { await sync() } }.disabled(model.working)
            }
          }
          Section {
            Button("View account") { onOpen(account) }
          }
        }
      }
    }
  }
  @ViewBuilder private func validation(_ message: String?) -> some View {
    if let message { Text(message).font(.caption).foregroundStyle(.red) }
  }
  private func create() async {
    guard let api = environment.api else { return }
    await model.create { try await api.send("accounts", method: "POST", body: $0) }
    if let account = model.account {
      environment.dataRevision += 1
      if account.sourceType != "manual" { await sync() }
    }
  }
  private func sync() async {
    guard let api = environment.api else { return }
    await model.sync { id in
      try await api.send("accounts/\(id)/sync-runs", method: "POST")
    }
    environment.dataRevision += 1
  }
}
