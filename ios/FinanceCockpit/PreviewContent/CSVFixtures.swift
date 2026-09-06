#if DEBUG
  import Foundation

  enum CSVFixtures {
    static let id = UUID(uuidString: "00000000-0000-4000-8000-000000000123")!
    static func preview(completed: Bool = false, duplicates: Bool = false) -> CSVImportPreview {
      let counts = CSVCounts(
        rows: 3, new: duplicates ? 0 : 3, duplicates: duplicates ? 3 : 0, conflicts: 0, skipped: 0,
        warnings: 0)
      return CSVImportPreview(
        id: id, provider: "trade_republic", filename: "trade-republic.csv",
        status: completed ? "completed" : "preview", revision: 1,
        expiresAt: Date().addingTimeInterval(86400),
        summary: counts,
        destinations: [
          CSVDestination(
            group: "DEFAULT", accountId: nil, name: "Trade Republic", included: true,
            summary: counts)
        ],
        issues: [], categories: ["BUY": 2, "TRANSFER_INBOUND": 1], assets: 1, candidates: [],
        result: completed
          ? CSVImportResult(
            imported: duplicates ? 0 : 3, duplicates: duplicates ? 3 : 0, skipped: 0, conflicts: 0,
            positionsUpdated: duplicates ? 0 : 2, completedAt: Date()) : nil)
    }
  }
#endif
