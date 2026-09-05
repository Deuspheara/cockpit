import SwiftUI

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
  @State private var conversationID: UUID?
  @State private var messages: [AgentMessage] = []
  @State private var text = ""
  @State private var error: String?
  @State private var working = false
  @State private var importPresented = false
  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { scroll in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 24) {
            if messages.isEmpty {
              Text("Organize and correct your portfolio").font(.title3.weight(.semibold))
              Text(
                "Ask about a holding, clarify a mismatch, or change a recurring investment. Financial changes always open a review."
              ).foregroundStyle(.secondary)
              Button("Import screenshots", systemImage: "photo") { importPresented = true }
            }
            ForEach(messages.filter { $0.role != "tool" }) { message in
              VStack(alignment: .leading, spacing: 12) {
                Text(message.role == "user" ? "You" : "Assistant").font(.caption.weight(.medium))
                  .foregroundStyle(.secondary)
                Text(message.content).textSelection(.enabled)
                ForEach(message.changeSetIds, id: \.self) { id in
                  NavigationLink {
                    ChangeSetReview(changeSetID: id)
                  } label: {
                    Label("Review proposed changes", systemImage: "doc.text.magnifyingglass")
                      .padding(.vertical, 10)
                  }
                }
              }.frame(maxWidth: .infinity, alignment: .leading).id(message.id)
            }
            if working { ProgressView("Checking your records…") }
            if let error { Text(error).foregroundStyle(.red) }
          }.padding(20)
        }.onChange(of: messages.count) {
          if let last = messages.last { scroll.scrollTo(last.id, anchor: .bottom) }
        }
      }
      HStack(alignment: .bottom) {
        TextField("Ask about your portfolio", text: $text, axis: .vertical).lineLimit(1...5)
          .textFieldStyle(.roundedBorder)
        Button("Send", systemImage: "arrow.up.circle.fill") { Task { await send() } }.labelStyle(
          .iconOnly
        ).font(.title).frame(minWidth: 44, minHeight: 44).disabled(
          working || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }.padding()
    }.navigationTitle("Assistant").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Import screenshot", systemImage: "photo") { importPresented = true }
        }
      }
      .sheet(isPresented: $importPresented) { NavigationStack { ImportView() } }
      .task { await restore() }
  }
  private func restore() async {
    guard let api = environment.api else { return }
    let key = "agentConversation-" + environment.serverURL
    if let saved = UserDefaults.standard.string(forKey: key), let id = UUID(uuidString: saved) {
      do {
        let conversation: AgentConversation = try await api.send("agent/conversations/\(id)")
        conversationID = id
        messages = conversation.messages ?? []
      } catch { UserDefaults.standard.removeObject(forKey: key) }
    }
  }
  private func send() async {
    guard let api = environment.api else { return }
    working = true
    error = nil
    defer { working = false }
    do {
      if conversationID == nil {
        let conversation: AgentConversation = try await api.send(
          "agent/conversations", method: "POST")
        conversationID = conversation.id
        UserDefaults.standard.set(
          conversation.id.uuidString, forKey: "agentConversation-" + environment.serverURL)
      }
      guard let id = conversationID else { return }
      let input = text
      text = ""
      messages.append(AgentMessage(id: UUID(), role: "user", content: input, changeSetIds: []))
      let response: AgentMessage = try await api.send(
        "agent/conversations/\(id)/messages", method: "POST", body: ["text": .string(input)])
      messages.append(response)
    } catch { self.error = error.localizedDescription }
  }
}
#Preview { NavigationStack { AgentView() }.environment(AppEnvironment()) }
