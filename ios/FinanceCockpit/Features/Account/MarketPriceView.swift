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
  @State private var snapshot = SnapshotLoader<MarketPriceHistory>()
  private var history: MarketPriceHistory? { snapshot.value }

  @State private var range: PortfolioRange = .month
  @State private var selectedDate: Date?
  private var selected: ValuationPoint? {
    guard let date = selectedDate else { return history?.chart.last }
    return history?.chart.min {
      abs($0.at.timeIntervalSince(date)) < abs($1.at.timeIntervalSince(date))
    }
  }
  var body: some View {
    let selected = self.selected
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        VStack(alignment: .leading, spacing: 12) {
          Text(
            selected.map { FinanceFormat.amount($0.value, currency: history?.currency ?? "USD") }
              ?? "—"
          )
          .font(.largeTitle.bold()).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
          Text(
            selected.map { $0.at.formatted(date: .abbreviated, time: .shortened) } ?? "Market price"
          )
          .font(.subheadline).foregroundStyle(.secondary)
          .frame(minHeight: 44, alignment: .leading)
          ZStack {
            if let history, !history.chart.isEmpty {
              Chart(history.chart) { point in
                LineMark(
                  x: .value("Date", point.at),
                  y: .value("Price", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
                )
                .interpolationMethod(.monotone).foregroundStyle(Color.accentColor)
                if history.chart.count == 1 {
                  PointMark(
                    x: .value("Date", point.at),
                    y: .value("Price", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
                  )
                  .foregroundStyle(Color.accentColor)
                }
                if selectedDate != nil, point.id == selected?.id {
                  RuleMark(x: .value("Selected", point.at)).foregroundStyle(.secondary)
                }
              }.chartYScale(domain: .automatic(includesZero: false))
                .chartXSelection(value: $selectedDate)
            } else if history == nil && snapshot.isLoading {
              ProgressView("Loading market prices")
            } else {
              Text("No market candles available for this period").foregroundStyle(.secondary)
            }
          }
          .frame(height: 260)
          .modifier(DatasetTransition(key: snapshot.displayedKey))
          ChartRangePicker(selection: $range)
        }
        if let history {
          Text("dYdX · \(history.resolution) candle close · \(history.currency)")
            .font(.caption).foregroundStyle(.secondary)
          Text("Market price history is separate from account equity and leveraged PnL.")
            .font(.caption).foregroundStyle(.secondary)
          if history.limited {
            Text("Provider history is incomplete for this range.").font(.caption).foregroundStyle(
              .orange)
          }
        }
        if let error = snapshot.error {
          Text(error).foregroundStyle(.red)
          Button("Retry") { Task { await load() } }
        }
      }.padding(20)
    }.navigationTitle(symbol).navigationBarTitleDisplayMode(.inline)
      .task(id: range) {
        selectedDate = nil
        await load()
      }
  }
  private func load() async {
    guard let api = environment.api else { return }
    let requested = range
    let id = assetID
    await snapshot.load(
      key: requested.rawValue,
      fetch: {
        try await api.send(
          "assets/\(id)/market-history",
          query: [URLQueryItem(name: "range", value: requested.rawValue)])
      })
  }
}
