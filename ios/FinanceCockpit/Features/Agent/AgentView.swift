import PhotosUI
import SwiftUI
import UIKit

struct AgentView: View {
  @MotionPreference private var reduceMotion
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @FocusState private var composerFocused: Bool
  @Environment(\.scenePhase) private var scenePhase
  @State private var model = AgentModel()
  @State private var nearBottom = true
  @State private var userScrolling = false
  @State private var text = ""
  @State private var restored = false
  @State private var importRoute: ImportRoute?
  @State private var importError: String?

  private let startsWithImport: Bool
  private let importAccountID: UUID?

  private let suggestions = [
    "Summarize my portfolio",
    "Where is my exposure concentrated?",
    "Help me correct a position",
  ]

  init(
    messages: [AgentMessage] = [], working: Bool = false,
    startImport: Bool = false, accountID: UUID? = nil
  ) {
    let model = AgentModel()
    model.messages = messages
    model.phase = working ? "thinking" : "idle"
    _model = State(initialValue: model)
    startsWithImport = startImport
    importAccountID = accountID
  }

  private var messages: [AgentMessage] { model.messages }
  private var agentWorking: Bool { model.working || model.activeAttempt != nil }
  private var working: Bool { agentWorking }

  var body: some View {
    Group {
      if let ai = environment.sessionInfo?.ai {
        if ai.chatConfigured {
          conversation
        } else {
          OpenRouterOnboarding(ai: ai) {
            await environment.testConnection()
          }
        }
      } else {
        ProgressView("Checking assistant availability…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task { await restore() }
      } else if phase == .background {
        model.detach()
      }
    }
    .onDisappear { model.detach() }
    .navigationTitle("Assistant")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Close") { dismiss() }
          .accessibilityHint("Returns to your portfolio")
      }
      if environment.sessionInfo?.ai.chatConfigured == true {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New conversation") { resetConversation() }
            .disabled(working || messages.isEmpty && model.conversationID == nil)
        }
      }
    }
    .fullScreenCover(item: $importRoute, onDismiss: { Task { await restore() } }) { route in
      NavigationStack { ImportView(accountID: importAccountID, sessionID: route.id) }
    }
    .task {
      await environment.testConnection()
      if environment.sessionInfo?.ai.chatConfigured == true {
        await restore()
        if startsWithImport { await startImport() }
      }
    }
    .onChange(of: environment.sessionInfo?.ai.chatConfigured) { _, ready in
      if ready == true && !restored { Task { await restore() } }
    }
  }

  private var conversation: some View {
    ScrollViewReader { scroll in
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          if messages.isEmpty {
            assistantWelcome
          }
          ForEach(messages.filter { $0.role != "tool" }) { message in
            if ["import_result", "screenshot_import"].contains(message.kind ?? ""), let id = message.importSessionId {
              Button { importRoute = ImportRoute(id: id) } label: {
                Label(message.kind == "import_result" ? message.content : "Screenshot import · Open result", systemImage: "photo")
                  .font(.callout).padding(12)
              }.id(message.id)
            } else {
              AgentMessageView(
                message: message, steps: message.attemptId.flatMap { model.steps[$0] } ?? []
              )
              .id(message.id)
            }
          }
          if agentWorking {
            HStack(spacing: 9) {
              ProgressView().controlSize(.small)
              Text(
                model.phase == "sending"
                  ? "Sending…"
                  : model.phase == "reconnecting"
                    ? "Reconnecting…"
                    : model.phase == "stopping"
                      ? "Stopping…" : model.phase == "streaming" ? "Responding…" : "Thinking…")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
          }
          if let error = model.error {
            Text(error).font(.callout).foregroundStyle(.red)
          }
          if let importError { Text(importError).font(.callout).foregroundStyle(.red) }
          if model.canRetry { Button("Retry response") { model.retry() } }
          if model.phase == "disconnected" || model.phase == "failed" {
            Button("Reconnect") { Task { await model.restore() } }
          }
          Color.clear.frame(height: 1).id("chat-bottom")
        }
        .frame(maxWidth: 720)
        .padding(.horizontal, 20)
        .padding(.top, messages.isEmpty ? 52 : 20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentSize.height - geometry.visibleRect.maxY < 100
      } action: { _, value in
        if userScrolling || value { nearBottom = value }
      }
      .onScrollPhaseChange { _, phase in
        userScrolling = phase == .interacting || phase == .decelerating
      }
      .onChange(of: model.revision) {
        if nearBottom { scroll.scrollTo("chat-bottom", anchor: .bottom) }
      }
      .onChange(of: messages.count) {
        if nearBottom {
          withAnimation(AppMotion.selection(reduceMotion)) {
            scroll.scrollTo("chat-bottom", anchor: .bottom)
          }
        }
      }
      .overlay(alignment: .bottomTrailing) {
        if !nearBottom {
          Button("Jump to latest", systemImage: "arrow.down") {
            nearBottom = true
            withAnimation(AppMotion.selection(reduceMotion)) {
              scroll.scrollTo("chat-bottom", anchor: .bottom)
            }
          }
          .buttonStyle(.borderedProminent).padding()
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        composer
      }
    }
  }

  private var assistantWelcome: some View {
    VStack(spacing: 18) {
      AppIcon(name: .assistant, size: 34)
        .foregroundStyle(.primary)
        .frame(width: 58, height: 58)
        .background(Color.primary.opacity(0.06), in: Circle())
      VStack(spacing: 7) {
        Text("What would you like to understand?")
          .font(.title2.weight(.semibold))
          .multilineTextAlignment(.center)
        Text("I can inspect your records and prepare financial changes for review.")
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      VStack(spacing: 10) {
        ForEach(suggestions, id: \.self) { suggestion in
          Button {
            text = suggestion
            Task { await send() }
          } label: {
            HStack {
              Text(suggestion)
              Spacer()
              AppIcon(name: .arrowRight, size: 16)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: 440, minHeight: 48)
            .background(Color.primary.opacity(0.055), in: .rect(cornerRadius: 15))
          }
          .buttonStyle(.plain)
        }
      }
    }
    .frame(maxWidth: .infinity)
  }

  private var composer: some View {
    GlassEffectContainer(spacing: 10) {
      HStack(alignment: .bottom, spacing: 8) {
        Button {
          Task { await startImport() }
        } label: {
          AppIcon(name: .attachment, size: 21)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Import screenshot")
        .accessibilityHint("Adds portfolio evidence using the vision model")
        .disabled(working || !environment.aiAvailability.visionConfigured)

        TextField("Ask anything", text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($composerFocused)
          .padding(.horizontal, 4)
          .padding(.vertical, 11)
          .submitLabel(.send)
          .onSubmit { Task { await send() } }

        Button {
          if agentWorking { Task { await model.stop() } } else { Task { await send() } }
        } label: {
          Image(systemName: agentWorking ? "stop.fill" : "arrow.up")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 42, height: 42)
            .background(Color.accentColor, in: Circle())
        }
        .accessibilityLabel(agentWorking ? "Stop response" : "Send")
        .disabled(
          (agentWorking
            ? model.phase == "stopping"
            : (!model.canSend || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        )
        .opacity(
          !agentWorking && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
      }
      .padding(6)
      .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 25))
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 8)
  }

  private func restore() async {
    guard let api = environment.api else { return }
    restored = true
    model.configure(api: api, server: environment.serverURL)
    await model.restore()

  }
  private func resetConversation() {
    model.reset()
    text = ""
    composerFocused = true
  }
  private func send() async {
    let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty, model.canSend else { return }
    guard input.utf16.count <= 4000 else {
      model.error = "Please keep your message under 4,000 characters."
      return
    }
    text = ""
    model.send(input)
  }

  private func startImport() async {
    do {
      let session = try await model.createImport(accountID: importAccountID)
      importRoute = ImportRoute(id: session.id)
    } catch { importError = error.localizedDescription }
  }
}

struct ImportRoute: Identifiable { let id: UUID }

private struct AgentMessageView: View {
  let message: AgentMessage
  let steps: [AgentToolStep]

  var body: some View {
    if message.role == "user" {
      HStack {
        Spacer(minLength: 48)
        Text(message.content)
          .textSelection(.enabled)
          .padding(.horizontal, 15)
          .padding(.vertical, 11)
          .background(Color.accentColor.opacity(0.14), in: .rect(cornerRadius: 18))
      }
    } else {
      VStack(alignment: .leading, spacing: 12) {
        if !steps.isEmpty { AgentToolActivity(steps: steps) }
        if !message.content.isEmpty { AgentMarkdown(content: message.content) }
        if let status = message.status, status == "interrupted" || status == "failed" {
          Label(
            status == "interrupted" ? "Response interrupted" : "Response failed",
            systemImage: "exclamationmark.circle"
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(message.changeSetIds, id: \.self) { id in
          NavigationLink {
            ChangeSetReview(changeSetID: id)
          } label: {
            HStack(spacing: 9) {
              AppIcon(name: .review, size: 18)
              Text("Review proposed changes")
              Spacer()
              AppIcon(name: .arrowRight, size: 15)
            }
            .padding(14)
            .background(Color.accentColor.opacity(0.09), in: .rect(cornerRadius: 14))
          }
          .buttonStyle(.plain)
        }
      }
    }
  }
}

struct OpenRouterOnboarding: View {
  let ai: SessionInfo.AI
  let checkAgain: () async -> Void
  @State private var copied = false
  @State private var checking = false

  private var missingVariables: [String] {
    var values: [String] = []
    if !ai.keyConfigured { values.append("OPENROUTER_API_KEY") }
    if ai.primaryModel.isEmpty { values.append("OPENROUTER_MODEL_PRIMARY") }
    if ai.visionModel.isEmpty { values.append("OPENROUTER_MODEL_VISION") }
    return values
  }

  private var configurationTemplate: String {
    """
    OPENROUTER_API_KEY=replace_with_your_server_key
    OPENROUTER_MODEL_PRIMARY=openai/gpt-4.1-mini
    OPENROUTER_MODEL_VISION=openai/gpt-4.1-mini
    """
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 10) {
          AppIcon(name: .assistant, size: 34)
            .frame(width: 58, height: 58)
            .background(Color.primary.opacity(0.06), in: Circle())
          Text("Connect the assistant")
            .font(.title2.weight(.semibold))
          Text(
            "OpenRouter is configured on your private server. Keys never appear in this app or in session responses."
          )
          .foregroundStyle(.secondary)
        }

        VStack(alignment: .leading, spacing: 12) {
          Text("Add these variables to the server .env")
            .font(.headline)
          ForEach(missingVariables, id: \.self) { variable in
            Text(variable)
              .font(.callout.monospaced())
              .textSelection(.enabled)
          }
          if missingVariables.isEmpty {
            Text("Restart the server, then check the configuration again.")
              .foregroundStyle(.secondary)
          }
        }
        .padding(16)
        .background(Color.secondary.opacity(0.08), in: .rect(cornerRadius: 16))

        VStack(spacing: 12) {
          Link(destination: URL(string: "https://openrouter.ai/keys")!) {
            HStack {
              Text("Create an OpenRouter key")
              Spacer()
              AppIcon(name: .arrowUp, size: 17)
            }
            .frame(minHeight: 44)
          }
          Button {
            UIPasteboard.general.string = configurationTemplate
            copied = true
          } label: {
            HStack {
              Text(copied ? "Configuration copied" : "Copy configuration template")
              Spacer()
              AppIcon(name: copied ? .connected : .review, size: 18)
            }
            .frame(minHeight: 44)
          }
          Button {
            checking = true
            Task {
              await checkAgain()
              checking = false
            }
          } label: {
            HStack {
              Text("Check again")
              Spacer()
              if checking { ProgressView() } else { AppIcon(name: .refresh, size: 18) }
            }
            .frame(minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .disabled(checking)
        }
      }
      .frame(maxWidth: 560)
      .padding(24)
      .frame(maxWidth: .infinity)
    }
  }
}
