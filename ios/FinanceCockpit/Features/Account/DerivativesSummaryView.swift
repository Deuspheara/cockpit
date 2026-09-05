import Charts
import SwiftUI

struct DerivativesSummaryView: View {
  let summary: DerivativesSummary
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Margin & exposure").font(.headline)
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 5) {
          Text("Effective leverage").font(.caption).foregroundStyle(.secondary)
          Text(
            summary.effectiveLeverage.map {
              NSDecimalNumber(decimal: $0.decimal).doubleValue.formatted(
                .number.precision(.fractionLength(2))) + "×"
            } ?? "Unavailable"
          )
          .font(.title.bold()).monospacedDigit()
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 5) {
          Text("Gross exposure").font(.caption).foregroundStyle(.secondary)
          Text(FinanceFormat.amount(summary.grossExposure, currency: summary.currency)).font(
            .title3.bold()
          ).monospacedDigit()
        }
      }
      LabeledContent(
        "Account equity", value: FinanceFormat.amount(summary.equity, currency: summary.currency))
      LabeledContent(
        "Free collateral",
        value: summary.freeCollateral.map { FinanceFormat.amount($0, currency: summary.currency) }
          ?? "Unavailable")
      Text(
        "Effective leverage = gross position exposure ÷ account equity. It changes with prices and collateral; it is not the leverage selected when opening a trade."
      ).font(.caption).foregroundStyle(.secondary)
      Text("dYdX · " + summary.asOf.formatted(date: .abbreviated, time: .shortened)).font(.caption2)
        .foregroundStyle(.secondary)
    }.accessibilityIdentifier("derivatives-summary")
  }
}
struct TradingPerformanceView: View {
  let performance: TradingPerformance
  @MotionPreference private var reduceMotion
  @Binding var range: PortfolioRange
  var displayedRange: PortfolioRange
  @State private var selectedDate: Date?
  private var selected: ValuationPoint? {
    guard let selectedDate else { return nil }
    return performance.chart.min {
      abs($0.at.timeIntervalSince(selectedDate)) < abs($1.at.timeIntervalSince(selectedDate))
    }
  }
  var body: some View {
    let selected = self.selected
    VStack(alignment: .leading, spacing: 12) {
      Text(
        FinanceFormat.amount(
          selected?.value ?? performance.totalPnl, currency: performance.currency)
      )
      .font(.largeTitle.bold()).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
      ZStack(alignment: .leading) {
        Text("Cumulative trading PnL · dYdX")
          .opacity(selected == nil ? 1 : 0).accessibilityHidden(selected != nil)
        Text(
          (selected?.sourceAt ?? selected?.at ?? performance.asOf).formatted(
            date: .abbreviated, time: .shortened)
        )
        .opacity(selected == nil ? 0 : 1).accessibilityHidden(selected == nil)
      }
      .font(.subheadline).foregroundStyle(.secondary)
      .frame(minHeight: 44, alignment: .leading)
      .animation(AppMotion.fade(reduceMotion), value: selected != nil)
      Chart(performance.chart) { point in
        LineMark(
          x: .value("Date", point.at),
          y: .value("PnL", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
        )
        .interpolationMethod(.monotone).foregroundStyle(Color.accentColor)
        if performance.chart.count == 1 {
          PointMark(
            x: .value("Date", point.at),
            y: .value("PnL", NSDecimalNumber(decimal: point.value.decimal).doubleValue))
        }
        if point.id == selected?.id {
          RuleMark(x: .value("Selected", point.at)).foregroundStyle(.secondary)
        }
      }.chartYScale(domain: .automatic(includesZero: false)).chartYAxis(.hidden)
        .chartXSelection(value: $selectedDate).frame(height: 200)
        .modifier(DatasetTransition(key: displayedRange))
      ChartRangePicker(selection: $range)
      LabeledContent(
        "Net deposits at last record",
        value: FinanceFormat.amount(performance.netTransfers, currency: performance.currency))
      Text(
        "Provider-reported PnL excludes net deposits. USD series; updated "
          + performance.asOf.formatted(date: .abbreviated, time: .shortened)
      )
      .font(.caption).foregroundStyle(.secondary)
    }.onChange(of: range) { selectedDate = nil }
  }
}
