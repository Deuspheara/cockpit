import Foundation
import Observation

/// Retains the last usable snapshot while a replacement is requested.
@MainActor @Observable
final class SnapshotLoader<Value: Sendable> {
  var value: Value?
  private(set) var displayedKey: String?
  private(set) var requestedKey: String?
  private(set) var isLoading = false
  private(set) var isCached = false
  private(set) var error: String?
  private var generation = 0
  private var request: Task<Value, Error>?

  func invalidate() {
    generation += 1
    request?.cancel()
    value = nil
    displayedKey = nil
    error = nil
  }

  func load(
    key: String,
    cached: () async -> Value? = { nil },
    fetch: @escaping @Sendable () async throws -> Value,
    save: (Value) async -> Void = { _ in }
  ) async {
    generation += 1
    let ticket = generation
    request?.cancel()
    requestedKey = key
    isLoading = true
    error = nil
    defer { if generation == ticket { isLoading = false } }
    if displayedKey != key, let saved = await cached() {
      guard generation == ticket, !Task.isCancelled else { return }
      value = saved
      displayedKey = key
      isCached = true
    }
    guard generation == ticket, !Task.isCancelled else { return }
    let task = Task { try await fetch() }
    request = task
    do {
      let fresh = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
      guard generation == ticket, !Task.isCancelled else { return }
      value = fresh
      displayedKey = key
      isCached = false
      await save(fresh)
    } catch {
      guard generation == ticket, !Task.isCancelled, !(error is CancellationError) else { return }
      self.error = error.localizedDescription
    }
  }
}
