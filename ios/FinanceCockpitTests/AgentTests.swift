import Foundation
import Testing

@testable import FinanceCockpit

struct AgentParserTests {
  @Test func fragmentedUTF8CRLFCommentsAndMultilineData() throws {
    let run = UUID()
    let attempt = UUID()
    let source =
      ": heartbeat\r\nid: 7\r\nevent: text.delta\r\ndata: {\r\ndata: \"version\":1,\"runId\":\"\(run)\",\"attemptId\":\"\(attempt)\",\"text\":\"€你好\"}\r\n\r\n"
    var parser = AgentSSEParser()
    var events: [AgentStreamEvent] = []
    for byte in source.utf8 { if let event = try parser.feed(byte) { events.append(event) } }
    #expect(events.count == 1)
    #expect(events[0].id == "7")
    #expect(events[0].payload.text == "€你好")
  }
  @Test func incompleteFrameNeverPublishesAndMalformedFrameFails() throws {
    var parser = AgentSSEParser()
    for byte in "data: {".utf8 { #expect(try parser.feed(byte) == nil) }
    #expect(throws: (any Error).self) {
      for byte in "bad}\n\n".utf8 { _ = try parser.feed(byte) }
    }
  }
  @Test func safeProxyFallbackAndDeviceAuthenticationAreUseful() {
    #expect(
      APIClient.failure(Data("<html>private proxy</html>".utf8), status: 502).message.contains(
        "unavailable"))
    #expect(APIClient.failure(Data(), status: 401).message.contains("token"))
    #expect(!APIClient.failure(Data(), status: 502).message.contains("HTTP 502"))
  }
}

@MainActor struct AgentReducerTests {
  private func event(
    _ id: Int, _ type: String, run: UUID, attempt: UUID, message: UUID? = nil, text: String? = nil,
    step: AgentToolStep? = nil, proposal: UUID? = nil, status: String? = nil
  ) -> AgentStreamEvent {
    AgentStreamEvent(
      id: String(id), type: type,
      payload: AgentEventPayload(
        version: 1, runId: run, attemptId: attempt, messageId: message, text: text, step: step,
        proposalId: proposal, status: status))
  }
  @Test func replayIsIdempotentAndInterruptedTextAndProposalsRemainVisible() {
    let model = AgentModel()
    let run = UUID()
    let attempt = UUID()
    let message = UUID()
    let proposal = UUID()
    let stepID = UUID()
    let start = event(1, "run.started", run: run, attempt: attempt, message: message)
    model.consume(start)
    model.consume(start)
    let delta = event(2, "text.delta", run: run, attempt: attempt, text: "**Partial")
    model.consume(delta)
    model.consume(delta)
    model.consume(
      event(
        3, "tool.updated", run: run, attempt: attempt,
        step: AgentToolStep(
          id: stepID, name: "list_accounts", label: "Checking your accounts", status: "running")))
    model.consume(event(4, "proposal.created", run: run, attempt: attempt, proposal: proposal))
    model.consume(event(5, "run.interrupted", run: run, attempt: attempt, status: "interrupted"))
    #expect(model.messages.count == 1)
    #expect(model.messages[0].content == "**Partial")
    #expect(model.messages[0].changeSetIds == [proposal])
    #expect(model.steps[attempt]?.first?.status == "cancelled")
    #expect(model.canRetry)
    #expect(!model.working)
  }
  @Test func staleCallbackCannotPublishAfterDetach() {
    let model = AgentModel()
    let run = UUID()
    let attempt = UUID()
    model.detach()
    model.consume(
      event(1, "run.started", run: run, attempt: attempt, message: UUID()), generation: UUID())
    #expect(model.messages.isEmpty)
  }
  @Test func newAttemptPreservesEarlierInterruptedMessage() {
    let model = AgentModel()
    let run = UUID()
    let first = UUID()
    let second = UUID()
    model.consume(event(1, "run.started", run: run, attempt: first, message: UUID()))
    model.consume(event(2, "text.delta", run: run, attempt: first, text: "Saved partial"))
    model.consume(event(3, "run.error", run: run, attempt: first, status: "failed"))
    model.consume(event(4, "run.started", run: run, attempt: second, message: UUID()))
    model.consume(event(5, "text.delta", run: run, attempt: second, text: "Resumed answer"))
    model.consume(event(6, "run.completed", run: run, attempt: second, status: "completed"))
    #expect(model.messages.map(\.content) == ["Saved partial", "Resumed answer"])
    #expect(!model.canRetry)
  }
}

private final class AgentSnapshotProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "chat-tests.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let isFailure = request.url?.path.contains("11111111-1111-4111-8111-111111111111") == true
    if isFailure {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
    let body =
      #"{"id":"22222222-2222-4222-8222-222222222222","messages":[{"id":"33333333-3333-4333-8333-333333333333","role":"assistant","content":"Saved **partial** reply","changeSetIds":[],"attemptId":"44444444-4444-4444-8444-444444444444","status":"interrupted"}],"attempts":[{"id":"44444444-4444-4444-8444-444444444444","runId":"55555555-5555-4555-8555-555555555555","status":"interrupted","requestId":"66666666-6666-4666-8666-666666666666"}],"events":[],"cursor":"42"}"#
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@MainActor struct AgentRestorationTests {
  private func client() throws -> APIClient {
    let settings = URLSessionConfiguration.ephemeral
    settings.protocolClasses = [AgentSnapshotProtocol.self]
    return APIClient(
      configuration: try APIConfiguration(
        server: "https://chat-tests.invalid", token: String(repeating: "a", count: 43)),
      session: URLSession(configuration: settings))
  }
  @Test func offlineReloadRetainsConversationReferenceAndVisibleMessages() async throws {
    let namespace = UUID().uuidString
    let id = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    let key = "agentConversation-" + namespace
    UserDefaults.standard.set(id.uuidString, forKey: key)
    defer { UserDefaults.standard.removeObject(forKey: key) }
    let model = AgentModel()
    model.configure(api: try client(), server: namespace)
    model.messages = [
      AgentMessage(id: UUID(), role: "assistant", content: "Retained content", changeSetIds: [])
    ]
    await model.restore()
    #expect(model.conversationID == id)
    #expect(model.messages.first?.content == "Retained content")
    #expect(UserDefaults.standard.string(forKey: key) == id.uuidString)
    #expect(model.error != nil)
  }
  @Test func lostRetryAcknowledgementIsResolvedFromSnapshotWithoutResubmission() async throws {
    let namespace = UUID().uuidString
    let key = "agentConversation-" + namespace
    UserDefaults.standard.set("22222222-2222-4222-8222-222222222222", forKey: key)
    let pending =
      #"{"conversationRequest":"77777777-7777-4777-8777-777777777777","messageRequest":"66666666-6666-4666-8666-666666666666","text":"","retryAttempt":"88888888-8888-4888-8888-888888888888"}"#
    UserDefaults.standard.set(Data(pending.utf8), forKey: key + "-pending")
    defer {
      UserDefaults.standard.removeObject(forKey: key)
      UserDefaults.standard.removeObject(forKey: key + "-pending")
    }
    let model = AgentModel()
    model.configure(api: try client(), server: namespace)
    await model.restore()
    #expect(UserDefaults.standard.data(forKey: key + "-pending") == nil)
    #expect(model.canSend)
    #expect(model.messages.count == 1)
  }
  @Test func snapshotReplacesPartialStateAndItsCursorPreventsReplayDuplication() async throws {
    let namespace = UUID().uuidString
    let id = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    let key = "agentConversation-" + namespace
    UserDefaults.standard.set(id.uuidString, forKey: key)
    defer { UserDefaults.standard.removeObject(forKey: key) }
    let model = AgentModel()
    model.configure(api: try client(), server: namespace)
    await model.restore()
    #expect(model.cursor == "42")
    #expect(model.messages.first?.content == "Saved **partial** reply")
    #expect(model.canRetry)
    model.consume(
      AgentStreamEvent(
        id: "41", type: "text.delta",
        payload: AgentEventPayload(
          version: 1, runId: UUID(), attemptId: model.messages[0].attemptId!, text: "duplicate")))
    #expect(model.messages[0].content == "Saved **partial** reply")
  }
}
