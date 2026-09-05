import Charts
import SwiftUI

struct MarketPriceHistory: Decodable, Sendable {
  let currency: String
  let source: String
  let resolution: String
  let limited: Bool
  let chart: [ValuationPoint]
}
struct MarketPriceView: View {
  let assetID: UUID
  let symbol: String
  @Environment(AppEnvironment.self) private var environment
  @State private var history: MarketPriceHistory?
  @State private var range: PortfolioRange = .month
  @State private var selectedDate: Date?
  @State private var error: String?
  private var selected: ValuationPoint? {
    guard let date = selectedDate else { return history?.chart.last }
    return history?.chart.min {
      abs($0.at.timeIntervalSince(date)) < abs($1.at.timeIntervalSince(date))
    }
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let history {
          if let selected {
            Text(FinanceFormat.amount(selected.value, currency: history.currency)).font(
              .largeTitle.bold()
            ).monospacedDigit()
            Text(selected.at.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(
              .secondary)
          }
          Chart(history.chart) { point in
            LineMark(
              x: .value("Date", point.at),
              y: .value("Price", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
            ).interpolationMethod(.monotone).foregroundStyle(Color.accentColor)
            if point.at == selectedDate {
              RuleMark(x: .value("Selected", point.at)).foregroundStyle(.secondary)
            }
          }.chartYScale(domain: .automatic(includesZero: false)).chartXSelection(
            value: $selectedDate
          ).frame(height: 260)
          if history.chart.isEmpty {
            Text("No market candles available for this period").foregroundStyle(.secondary)
          }
          Text("dYdX · \(history.resolution) candle close · USD").font(.caption).foregroundStyle(
            .secondary)
          Text("Market price history is separate from account equity and leveraged PnL.").font(
            .caption
          ).foregroundStyle(.secondary)
          if history.limited {
            Text("Provider history is incomplete for this range.").font(.caption).foregroundStyle(
              .orange)
          }
        } else if error == nil {
          ProgressView("Loading market prices")
        }
        ChartRangePicker(selection: $range)
        if let error { Text(error).foregroundStyle(.red) }
      }.padding(20)
    }.navigationTitle(symbol).navigationBarTitleDisplayMode(.inline)
      .task(id: range) {
        selectedDate = nil
        do {
          let fresh: MarketPriceHistory? = try await environment.api?.send(
            "assets/\(assetID)/market-history",
            query: [URLQueryItem(name: "range", value: range.rawValue)])
          guard !Task.isCancelled else { return }
          history = fresh
          error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
      }
  }
}
