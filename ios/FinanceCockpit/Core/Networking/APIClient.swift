import Foundation

struct APIError: LocalizedError, Sendable {
  let message: String
  var code: String? = nil
  var retryable: Bool = true
  var errorDescription: String? { message }
}
struct APIConfiguration: Sendable {
  let baseURL: URL
  let token: String
  init(server: String, token: String) throws {
    guard let url = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
      url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/"
    else { throw APIError(message: "Enter a server origin, such as https://finance.example.com.") }
    var allowed = url.scheme == "https"
    #if DEBUG
      allowed =
        allowed
        || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""))
    #endif
    guard allowed else { throw APIError(message: "The server must use HTTPS.") }
    guard token.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
      throw APIError(message: "Enter the full device token generated on your server.")
    }
    baseURL = url
    self.token = token
  }
  func request(path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil)
    throws -> URLRequest
  {
    let endpoint = baseURL.appending(path: "api/v1").appending(path: path)
    guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
      throw APIError(message: "Invalid endpoint.")
    }
    if !query.isEmpty { components.queryItems = query }
    guard let url = components.url else { throw APIError(message: "Invalid endpoint.") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    request.timeoutInterval = 90
    return request
  }
}
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
private struct ErrorEnvelope: Decodable {
  struct Detail: Decodable {
    let message: String
    let code: String?
    let retryable: Bool?
  }
  let error: Detail
}
actor APIClient {
  let configuration: APIConfiguration
  private let session: URLSession
  init(configuration: APIConfiguration, session suppliedSession: URLSession? = nil) {
    self.configuration = configuration
    let settings = URLSessionConfiguration.ephemeral
    settings.urlCache = nil
    session =
      suppliedSession
      ?? URLSession(
        configuration: settings, delegate: NoRedirectDelegate(), delegateQueue: nil)
  }
  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: value) { return date }
      formatter.formatOptions = [.withInternetDateTime]
      guard let date = formatter.date(from: value) else {
        throw APIError(message: "Invalid server date.")
      }
      return date
    }
    return decoder
  }
  func send<T: Decodable & Sendable>(
    _ path: String, query: [URLQueryItem] = [], method: String = "GET",
    body: [String: JSONValue]? = nil
  ) async throws -> T {
    let data = try body.map { try JSONEncoder().encode($0) }
    let request = try configuration.request(path: path, query: query, method: method, body: data)
    return try await perform(request)
  }
  func uploadScreenshot(id: UUID, data: Data, mime: String) async throws -> ImportSessionDTO {
    let boundary = "Finance-" + UUID().uuidString
    var body = Data(
      "--\(boundary)\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot\"\r\nContent-Type: \(mime)\r\n\r\n"
        .utf8)
    body.append(data)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    var request = try configuration.request(
      path: "imports/\(id)/screenshots", method: "POST", body: body)
    request.setValue(
      "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    return try await perform(request)
  }
  static func failure(_ data: Data, status: Int) -> APIError {
    if let detail = try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error {
      return APIError(
        message: detail.message, code: detail.code, retryable: detail.retryable ?? true)
    }
    let message: String
    switch status {
    case 401, 403:
      message = "Your device connection is not authorized. Check the token in Settings."
    case 429: message = "Too many requests. Wait briefly before retrying."
    case 408, 504:
      message = "The server took too long to respond. Reconnect to recover saved progress."
    case 502, 503:
      message = "The server or its AI provider is unavailable. Reconnect to recover saved progress."
    default: message = "The request could not be completed. Please try again."
    }
    return APIError(message: message)
  }
  func stream(
    _ path: String, method: String = "GET", body: [String: JSONValue]? = nil,
    after: String = "0", receive: @escaping @Sendable (AgentStreamEvent) async -> Void
  ) async throws {
    let data = try body.map { try JSONEncoder().encode($0) }
    var request = try configuration.request(path: path, method: method, body: data)
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue(after, forHTTPHeaderField: "Last-Event-ID")
    request.timeoutInterval = 75
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw APIError(message: "No response from server.")
    }
    guard (200..<300).contains(http.statusCode) else {
      var errorData = Data()
      for try await byte in bytes {
        errorData.append(byte)
        if errorData.count > 16384 { break }
      }
      throw Self.failure(errorData, status: http.statusCode)
    }
    guard http.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true
    else {
      throw APIError(message: "This server needs the streaming chat update.", retryable: false)
    }
    var parser = AgentSSEParser()
    for try await byte in bytes {
      try Task.checkCancellation()
      if let event = try parser.feed(byte) { await receive(event) }
    }
  }
  private func perform<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
    let (responseData, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw APIError(message: "No response from server.")
    }
    guard (200..<300).contains(http.statusCode) else {
      throw Self.failure(responseData, status: http.statusCode)
    }
    return try Self.decoder().decode(T.self, from: responseData)
  }
}
