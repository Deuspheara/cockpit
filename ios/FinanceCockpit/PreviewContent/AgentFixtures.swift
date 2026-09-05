#if DEBUG
  import Foundation

  /// Deterministic UI-only server. Generation belongs to the store, not to its subscribers.
  @MainActor final class AgentFixtureStore {
    static let shared = AgentFixtureStore()
    private var conversationID = UUID()
    private var messages: [AgentMessage] = []
    private var attempts: [AgentAttempt] = []
    private var events: [AgentStreamEvent] = []
    private var requests: [UUID: UUID] = [:]
    private var sequence = 0
    private var producer: Task<Void, Never>?
    private let runID = UUID()
    private func body(_ request: URLRequest) -> [String: String] {
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&bytes, maxLength: bytes.count)
          if count <= 0 { break }
          data.append(contentsOf: bytes.prefix(count))
        }
      }
      return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }
    private func emit(
      _ type: String, _ attempt: UUID, message: UUID? = nil, text: String? = nil,
      step: AgentToolStep? = nil, status: String? = nil
    ) {
      sequence += 1
      events.append(
        AgentStreamEvent(
          id: String(sequence), type: type,
          payload: AgentEventPayload(
            version: 1, runId: runID, attemptId: attempt, messageId: message, text: text,
            step: step, status: status)))
      if let index = messages.firstIndex(where: { $0.attemptId == attempt }) {
        if let text { messages[index].content += text }
        if let status { messages[index].status = status }
      }
      if let status, let index = attempts.firstIndex(where: { $0.id == attempt }) {
        attempts[index].status = status
      }
    }
    private func start(text: String, request: UUID, retry: Bool) -> UUID {
      if let existing = requests[request] { return existing }
      let attempt = UUID()
      let message = UUID()
      requests[request] = attempt
      if !retry {
        messages.append(AgentMessage(id: request, role: "user", content: text, changeSetIds: []))
      }
      attempts.append(
        AgentAttempt(id: attempt, runId: runID, status: "running", requestId: request))
      messages.append(
        AgentMessage(
          id: message, role: "assistant", content: "", changeSetIds: [], attemptId: attempt,
          status: "running"))
      emit("run.started", attempt, message: message)
      producer = Task {
        do {
          let first = UUID()
          let second = UUID()
          for (stepID, name, label) in [
            (first, "list_accounts", "Checking your accounts"),
            (second, "get_portfolio_overview", "Checking your portfolio"),
          ] {
            emit(
              "tool.updated", attempt,
              step: AgentToolStep(id: stepID, name: name, label: label, status: "pending"))
            try await Task.sleep(for: .milliseconds(200))
            emit(
              "tool.updated", attempt,
              step: AgentToolStep(id: stepID, name: name, label: label, status: "running"))
            try await Task.sleep(for: .milliseconds(700))
            emit(
              "tool.updated", attempt,
              step: AgentToolStep(
                id: stepID, name: name, label: label, status: "completed",
                summary: "3 records loaded"))
          }
          let parts =
            [
              "## Portfolio overview\n\n", "Your **recorded balances** are ready. ",
              "Some acquisition costs are *unknown*.\n\n",
              "> These are recorded values, not investment recommendations.\n\n",
              "- Accounts checked\n- Missing costs remain unknown\n\n",
              "| Account | Value | Currency | Cost basis | Source | Updated |\n| --- | ---: | --- | --- | --- | --- |\n| Investments | 12,345.67 | EUR | Unknown | Manual records | Today |\n| Cash | 2,000.00 | EUR | Not applicable | Manual records | Today |\n\n",
              "Use `recordedValue` when comparing stored balances. [Documentation](https://example.com).\n\n",
              "```swift\n", "let currency = \"EUR\"\n", "let recordedValue: Decimal = 12345.67\n",
              "```\n\n",
            ]
            + (1...14).map {
              "### Detail \($0)\n\nThis is a long response fixture for testing scrolling and selection. Values stay readable while new paragraphs arrive. No changes have been applied.\n\n"
            }
          for part in parts {
            try Task.checkCancellation()
            emit("text.delta", attempt, text: part)
            try await Task.sleep(for: .milliseconds(250))
          }
          emit("run.completed", attempt, status: "completed")
        } catch { /* Explicit cancel already records terminal state. */  }
      }
      return attempt
    }
    func respond(to request: URLRequest, transport: URLProtocol) async {
      do {
        let path = request.url!.path
        let input = body(request)
        let encoder = JSONEncoder()
        var data: Data
        var streamAttempt: UUID?
        if path.hasSuffix("/session") {
          data = Data(
            #"{"apiVersion":"1","ai":{"configured":true,"keyConfigured":true,"chatConfigured":true,"visionConfigured":true,"primaryModel":"fixture","visionModel":"fixture"},"walletConfigured":false}"#
              .utf8)
        } else if path.hasSuffix("/conversations"), request.httpMethod == "POST" {
          data = try encoder.encode(AgentConversation(id: conversationID))
        } else if path.hasSuffix("/messages") || path.hasSuffix("/retry") {
          streamAttempt = start(
            text: input["text"] ?? "",
            request: UUID(uuidString: input["requestId"] ?? "") ?? UUID(),
            retry: path.hasSuffix("/retry"))
          data = Data()
        } else if path.hasSuffix("/cancel") {
          producer?.cancel()
          if let attempt = attempts.last, attempt.status == "running" {
            emit("run.interrupted", attempt.id, status: "interrupted")
          }
          data = try encoder.encode(attempts.last!)
        } else if path.hasSuffix("/events") {
          streamAttempt = UUID(uuidString: String(path.split(separator: "/").dropLast().last!))
          data = Data()
        } else {
          data = try encoder.encode(
            AgentConversation(
              id: conversationID, messages: messages, attempts: attempts,
              events: events.filter { $0.type != "text.delta" }, cursor: String(sequence)))
        }
        let response = HTTPURLResponse(
          url: request.url!, statusCode: 200, httpVersion: nil,
          headerFields: [
            "Content-Type": streamAttempt == nil ? "application/json" : "text/event-stream"
          ])!
        transport.client?.urlProtocol(
          transport, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let attempt = streamAttempt {
          var after = Int(request.value(forHTTPHeaderField: "Last-Event-ID") ?? "0") ?? 0
          while !Task.isCancelled {
            for event in events
            where event.payload.attemptId == attempt && (Int(event.id) ?? 0) > after {
              let payload = String(data: try encoder.encode(event.payload), encoding: .utf8)!
              let frame = Data("id: \(event.id)\nevent: \(event.type)\ndata: \(payload)\n\n".utf8)
              // Fragment even the UTF-8 payload to exercise the client parser.
              for offset in stride(from: 0, to: frame.count, by: 7) {
                transport.client?.urlProtocol(
                  transport, didLoad: frame.subdata(in: offset..<min(offset + 7, frame.count)))
              }
              after = Int(event.id)!
            }
            if attempts.first(where: { $0.id == attempt })?.status != "running" { break }
            try await Task.sleep(for: .milliseconds(50))
          }
        } else {
          transport.client?.urlProtocol(transport, didLoad: data)
        }
        if !Task.isCancelled { transport.client?.urlProtocolDidFinishLoading(transport) }
      } catch {
        if !Task.isCancelled { transport.client?.urlProtocol(transport, didFailWithError: error) }
      }
    }
  }
#endif
