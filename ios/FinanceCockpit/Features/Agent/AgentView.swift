import SwiftUI
import UIKit

struct AgentMessage: Codable, Identifiable, Sendable {
  let id: UUID
  let role: String
  let content: String
  let changeSetIds: [UUID]
}

struct AgentConversation: Decodable, Sendable {
  let id: UUID
  let messages: [AgentMessage]?
}

struct AgentView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss
  @FocusState private var composerFocused: Bool
  @State private var conversationID: UUID?
  @State private var messages: [AgentMessage] = []
  @State private var text = ""
  @State private var error: String?
  @State private var working = false
  @State private var importPresented = false
  @State private var restored = false

  private let suggestions = [
    "Summarize my portfolio",
    "Where is my exposure concentrated?",
    "Help me correct a position",
  ]

  init(messages: [AgentMessage] = [], working: Bool = false) {
    _messages = State(initialValue: messages)
    _working = State(initialValue: working)
  }

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
            .disabled(messages.isEmpty && conversationID == nil)
        }
      }
    }
    .sheet(isPresented: $importPresented) { NavigationStack { ImportView() } }
    .task {
      await environment.testConnection()
      if environment.sessionInfo?.ai.chatConfigured == true { await restore() }
    }
    .onChange(of: environment.sessionInfo?.ai.chatConfigured) { _, ready in
      if ready == true && !restored { Task { await restore() } }
    }
  }

  private var conversation: some View {
    ScrollViewReader { scroll in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 22) {
          if messages.isEmpty {
            assistantWelcome
          }
          ForEach(messages.filter { $0.role != "tool" }) { message in
            AgentMessageView(message: message)
              .id(message.id)
          }
          if working {
            HStack(spacing: 9) {
              ProgressView().controlSize(.small)
              Text("Checking your records…")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
          }
          if let error {
            Text(error).font(.callout).foregroundStyle(.red)
          }
        }
        .frame(maxWidth: 720)
        .padding(.horizontal, 20)
        .padding(.top, messages.isEmpty ? 52 : 20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: messages.count) {
        if let last = messages.last {
          withAnimation { scroll.scrollTo(last.id, anchor: .bottom) }
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
          importPresented = true
        } label: {
          AppIcon(name: .attachment, size: 21)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Import screenshot")
        .accessibilityHint("Adds portfolio evidence using the vision model")

        TextField("Ask anything", text: $text, axis: .vertical)
          .lineLimit(1...6)
          .focused($composerFocused)
          .padding(.horizontal, 4)
          .padding(.vertical, 11)
          .submitLabel(.send)
          .onSubmit { Task { await send() } }

        Button {
          Task { await send() }
        } label: {
          AppIcon(name: .send, size: 20)
            .foregroundStyle(.white)
            .frame(width: 42, height: 42)
            .background(Color.accentColor, in: Circle())
        }
        .accessibilityLabel("Send")
        .disabled(working || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .opacity(
          working || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
      }
      .padding(6)
      .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 25))
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 8)
  }

  private func restore() async {
    guard !restored, let api = environment.api else { return }
    restored = true
    let key = conversationKey
    guard let saved = UserDefaults.standard.string(forKey: key), let id = UUID(uuidString: saved)
    else { return }
    do {
      let conversation: AgentConversation = try await api.send("agent/conversations/\(id)")
      conversationID = id
      messages = conversation.messages ?? []
    } catch {
      UserDefaults.standard.removeObject(forKey: key)
    }
  }

  private func resetConversation() {
    UserDefaults.standard.removeObject(forKey: conversationKey)
    conversationID = nil
    messages = []
    error = nil
    text = ""
    composerFocused = true
  }

  private var conversationKey: String {
    "agentConversation-" + environment.serverURL
  }

  private func send() async {
    guard let api = environment.api else { return }
    let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty, !working else { return }
    working = true
    error = nil
    text = ""
    messages.append(AgentMessage(id: UUID(), role: "user", content: input, changeSetIds: []))
    defer { working = false }
    do {
      if conversationID == nil {
        let conversation: AgentConversation = try await api.send(
          "agent/conversations", method: "POST")
        conversationID = conversation.id
        UserDefaults.standard.set(conversation.id.uuidString, forKey: conversationKey)
      }
      guard let id = conversationID else { return }
      let response: AgentMessage = try await api.send(
        "agent/conversations/\(id)/messages", method: "POST", body: ["text": .string(input)])
      messages.append(response)
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct AgentMessageView: View {
  let message: AgentMessage

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
        Text(message.content)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
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
