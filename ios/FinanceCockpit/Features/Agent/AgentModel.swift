import Foundation
import Observation

struct AgentMessage: Codable, Identifiable, Sendable {
  let id: UUID
  let role: String
  var content: String
  var changeSetIds: [UUID]
  var attemptId: UUID? = nil
  var status: String? = nil
}
struct AgentAttempt: Codable, Identifiable, Sendable {
  let id: UUID
  let runId: UUID
  var status: String
  var requestId: UUID? = nil
}
struct AgentToolStep: Codable, Identifiable, Sendable {
  let id: UUID
  let name: String
  let label: String
  var status: String
  var summary: String?
}
struct AgentEventPayload: Codable, Sendable {
  let version: Int
  let runId: UUID
  let attemptId: UUID
  var messageId: UUID?
  var userMessageId: UUID?
  var text: String?
  var step: AgentToolStep?
  var proposalId: UUID?
  var status: String?
  var error: AgentFailure?
}
struct AgentFailure: Codable, Sendable {
  let code: String
  let message: String
  var retryable: Bool?
}
struct AgentStreamEvent: Codable, Sendable {
  let id: String
  let type: String
  let payload: AgentEventPayload
}
struct AgentConversation: Codable, Sendable {
  let id: UUID
  var messages: [AgentMessage]?
  var attempts: [AgentAttempt]?
  var events: [AgentStreamEvent]?
  var cursor: String?
}

/// Byte-oriented framing preserves fragmented UTF-8. Only complete SSE frames are decoded.
struct AgentSSEParser {
  private var line: [UInt8] = []
  private var data: [String] = []
  private var event = "message"
  private var id = "0"
  private var wasCR = false
  mutating func feed(_ byte: UInt8) throws -> AgentStreamEvent? {
    if byte == 10 && wasCR {
      wasCR = false
      return nil
    }
    wasCR = byte == 13
    if byte != 10 && byte != 13 {
      line.append(byte)
      if line.count > 1_000_000 { throw APIError(message: "The server sent an oversized event.") }
      return nil
    }
    guard let text = String(bytes: line, encoding: .utf8) else {
      throw APIError(message: "The server sent invalid text.")
    }
    line.removeAll(keepingCapacity: true)
    if text.isEmpty {
      defer {
        data = []
        event = "message"
      }
      guard !data.isEmpty else { return nil }
      let payload = try JSONDecoder().decode(
        AgentEventPayload.self, from: Data(data.joined(separator: "\n").utf8))
      guard payload.version == 1 else {
        throw APIError(message: "Update the app to read this chat protocol.", retryable: false)
      }
      return AgentStreamEvent(id: id, type: event, payload: payload)
    }
    if text.hasPrefix(":") { return nil }
    let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    var value = parts.count > 1 ? String(parts[1]) : ""
    if value.hasPrefix(" ") { value.removeFirst() }
    switch parts[0] {
    case "data": data.append(value)
    case "event": event = value
    case "id": if !value.contains("\0") { id = value }
    default: break
    }
    if data.reduce(0, { $0 + $1.utf8.count }) > 1_000_000 {
      throw APIError(message: "The server sent an oversized event.")
    }
    return nil
  }
}

@MainActor @Observable
final class AgentModel {
  var messages: [AgentMessage] = []
  var steps: [UUID: [AgentToolStep]] = [:]
  var attempts: [AgentAttempt] = []
  var phase = "idle"
  var error: String?
  var revision = 0
  var conversationID: UUID?
  private(set) var cursor = "0"
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var api: APIClient?
  private var key = ""
  private var pending: Pending?
  private struct Pending: Codable {
    let conversationRequest: UUID
    let messageRequest: UUID
    let text: String
    var retryAttempt: UUID?
    var cancelRequested: Bool?
  }
  var working: Bool {
    ["sending", "thinking", "streaming", "reconnecting", "stopping"].contains(phase)
  }
  var activeAttempt: UUID? { attempts.last(where: { $0.status == "running" })?.id }
  var canSend: Bool { !working && pending == nil && activeAttempt == nil }
  var canRetry: Bool {
    !working
      && (pending != nil || attempts.last?.status == "failed"
        || attempts.last?.status == "interrupted")
  }
  func configure(api: APIClient, server: String) {
    guard self.api == nil else { return }
    self.api = api
    key = "agentConversation-" + server
    conversationID = UserDefaults.standard.string(forKey: key).flatMap(UUID.init(uuidString:))
    if let data = UserDefaults.standard.data(forKey: key + "-pending") {
      pending = try? JSONDecoder().decode(Pending.self, from: data)
    }
  }
  private func savePending() {
    if let pending {
      UserDefaults.standard.set(try? JSONEncoder().encode(pending), forKey: key + "-pending")
    } else {
      UserDefaults.standard.removeObject(forKey: key + "-pending")
    }
  }
  func send(_ text: String) {
    guard canSend, !text.isEmpty else { return }
    let request = Pending(conversationRequest: UUID(), messageRequest: UUID(), text: text)
    pending = request
    savePending()
    messages.append(
      AgentMessage(id: request.messageRequest, role: "user", content: text, changeSetIds: []))
    launchSubmit(request)
  }
  func retry() {
    guard !working else { return }
    if var pending {
      pending.cancelRequested = false
      self.pending = pending
      savePending()
      launchSubmit(pending)
      return
    }
    guard let last = attempts.last, last.status != "completed" else { return }
    let request = Pending(
      conversationRequest: UUID(), messageRequest: UUID(), text: "", retryAttempt: last.id)
    pending = request
    savePending()
    launchSubmit(request)
  }
  private func launchSubmit(_ request: Pending) {
    task?.cancel()
    generation = UUID()
    let token = generation
    phase = "sending"
    error = nil
    task = Task { [weak self] in
      guard let self, let api = self.api else { return }
      do {
        if self.conversationID == nil {
          let conversation: AgentConversation = try await api.send(
            "agent/conversations", method: "POST",
            body: ["requestId": .string(request.conversationRequest.uuidString)])
          guard token == self.generation else { return }
          self.conversationID = conversation.id
          UserDefaults.standard.set(conversation.id.uuidString, forKey: self.key)
        }
        guard let id = self.conversationID else { return }
        let path =
          request.retryAttempt.map { "agent/attempts/\($0)/retry" }
          ?? "agent/conversations/\(id)/messages"
        var body: [String: JSONValue] = ["requestId": .string(request.messageRequest.uuidString)]
        if request.retryAttempt == nil { body["text"] = .string(request.text) }
        try await api.stream(path, method: "POST", body: body) { [weak self] event in
          await self?.consume(event, generation: token)
        }
        guard token == self.generation else { return }
        if self.working { await self.reconnect(token: token) }
      } catch {
        guard token == self.generation, !Task.isCancelled else { return }
        if self.activeAttempt != nil {
          await self.reconnect(token: token)
        } else {
          self.phase = "failed"
          self.error = error.localizedDescription
        }
      }
    }
  }
  func restore() async {
    guard let api, let id = conversationID else {
      if let pending, !working { launchSubmit(pending) }
      return
    }
    task?.cancel()
    generation = UUID()
    let token = generation
    do {
      let snapshot: AgentConversation = try await api.send("agent/conversations/\(id)")
      guard token == generation else { return }
      load(snapshot)
      if let pending, activeAttempt == nil {
        launchSubmit(pending)
      } else if activeAttempt != nil {
        phase = "reconnecting"
        task = Task { [weak self] in await self?.reconnect(token: token) }
      }
    } catch {
      guard token == generation, !Task.isCancelled else { return }
      phase = "failed"
      self.error = error.localizedDescription
    }
  }
  private func load(_ snapshot: AgentConversation) {
    let savedPending = pending
    error = nil
    messages = snapshot.messages ?? []
    attempts = snapshot.attempts ?? []
    steps = [:]
    for event in snapshot.events ?? [] { apply(event, restoring: true) }
    cursor = snapshot.cursor ?? "0"
    pending = savedPending
    if let pending,
      messages.contains(where: { $0.id == pending.messageRequest })
        || attempts.contains(where: { $0.requestId == pending.messageRequest })
    {
      self.pending = nil
      savePending()
    }
    savePending()
    phase = activeAttempt == nil ? "idle" : "thinking"
    revision += 1
    if savedPending?.cancelRequested == true, activeAttempt != nil { Task { await self.stop() } }
  }
  private func reconnect(token: UUID) async {
    guard let api else { return }
    for retry in 0..<5 {
      guard token == generation, !Task.isCancelled else { return }
      phase = "reconnecting"
      do {
        if retry > 0 { try await Task.sleep(for: .seconds(min(8, 1 << retry))) }
        guard let id = conversationID else { return }
        let snapshot: AgentConversation = try await api.send("agent/conversations/\(id)")
        guard token == generation else { return }
        load(snapshot)
        guard let attempt = activeAttempt else { return }
        try await api.stream("agent/attempts/\(attempt)/events", after: cursor) {
          [weak self] event in
          await self?.consume(event, generation: token)
        }
        if !working { return }
      } catch {
        guard token == generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
    phase = "disconnected"
    error = "Connection lost. Server work may still be running. Reconnect to recover progress."
  }
  func consume(_ event: AgentStreamEvent, generation token: UUID? = nil) {
    if let token, token != generation { return }
    guard let next = Int64(event.id), next > (Int64(cursor) ?? 0) else { return }
    apply(event)
    cursor = event.id
    revision += 1
  }
  private func apply(_ event: AgentStreamEvent, restoring: Bool = false) {
    let payload = event.payload
    if event.type == "run.started" {
      if !attempts.contains(where: { $0.id == payload.attemptId }) {
        attempts.append(
          AgentAttempt(id: payload.attemptId, runId: payload.runId, status: "running"))
      }
      if let id = payload.messageId, !messages.contains(where: { $0.id == id }) {
        messages.append(
          AgentMessage(
            id: id, role: "assistant", content: "", changeSetIds: [], attemptId: payload.attemptId,
            status: "running"))
      }
      if !restoring {
        let shouldStop = pending?.cancelRequested == true
        pending = nil
        savePending()
        phase = "thinking"
        error = nil
        if shouldStop { Task { await self.stop() } }
      }
    }
    if let step = payload.step {
      var list = steps[payload.attemptId] ?? []
      if let index = list.firstIndex(where: { $0.id == step.id }) {
        list[index] = step
      } else {
        list.append(step)
      }
      steps[payload.attemptId] = list
    }
    if let index = messages.firstIndex(where: { $0.attemptId == payload.attemptId }) {
      if event.type == "text.delta", let text = payload.text {
        messages[index].content += text
        if phase != "stopping" { phase = "streaming" }
      }
      if let proposal = payload.proposalId, !messages[index].changeSetIds.contains(proposal) {
        messages[index].changeSetIds.append(proposal)
      }
      if let status = payload.status { messages[index].status = status }
    }
    if ["run.completed", "run.interrupted", "run.error"].contains(event.type) {
      let status = payload.status ?? "failed"
      if let index = attempts.firstIndex(where: { $0.id == payload.attemptId }) {
        attempts[index].status = status
      }
      phase = status
      error = payload.error?.message
      steps[payload.attemptId] = steps[payload.attemptId]?.map { step in
        var step = step
        if step.status == "pending" || step.status == "running" {
          step.status = "cancelled"
          step.summary = "Interrupted before completion"
        }
        return step
      }
    }
  }
  func stop() async {
    guard let api else { return }
    guard let id = activeAttempt else {
      pending?.cancelRequested = true
      savePending()
      phase = "stopping"
      return
    }
    phase = "stopping"
    do {
      let _: AgentAttempt = try await api.send("agent/attempts/\(id)/cancel", method: "POST")
    } catch {
      self.error = "Could not confirm Stop. Server work may still be running. Try Stop again."
      phase = "streaming"
    }
  }
  func detach() {
    task?.cancel()
    generation = UUID()
    if working { phase = "disconnected" }
  }
  func reset() {
    guard !working && activeAttempt == nil else { return }
    detach()
    messages = []
    attempts = []
    steps = [:]
    conversationID = nil
    cursor = "0"
    pending = nil
    savePending()
    UserDefaults.standard.removeObject(forKey: key)
    error = nil
    phase = "idle"
  }
}
