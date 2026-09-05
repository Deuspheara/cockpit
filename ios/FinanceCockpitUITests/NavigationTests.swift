import XCTest

@MainActor
final class NavigationTests: XCTestCase {
  func testPrimaryNavigationAndSecondaryBotsDestination() throws {
    let app = XCUIApplication()
    app.launch()
    let portfolio = app.navigationBars["Portfolio"]
    guard portfolio.waitForExistence(timeout: 10) else {
      throw XCTSkip(
        "Pair this simulator with the development server before running navigation tests.")
    }
    XCTAssertEqual(app.tabBars.buttons.count, 3)
    XCTAssertFalse(app.tabBars.buttons["Assistant"].exists)
    XCTAssertTrue(app.tabBars.buttons["Home"].exists)
    app.tabBars.buttons["Activity"].tap()
    XCTAssertTrue(app.navigationBars["Activity"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Home"].tap()
    app.buttons["portfolio-assistant"].tap()
    XCTAssertTrue(app.navigationBars["Assistant"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    XCTAssertTrue(portfolio.waitForExistence(timeout: 5))
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    app.buttons["Bots"].tap()
    XCTAssertTrue(app.navigationBars["Bots"].waitForExistence(timeout: 5))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["Integration diagnostics"].tap()
    XCTAssertTrue(app.navigationBars["Diagnostics"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Database"].waitForExistence(timeout: 10))
    let diagnosticScreenshot = XCTAttachment(screenshot: app.screenshot())
    diagnosticScreenshot.name = "Integration diagnostics"
    diagnosticScreenshot.lifetime = .keepAlways
    add(diagnosticScreenshot)
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["Recurring investments"].tap()
    XCTAssertTrue(app.navigationBars["Recurring investments"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Home"].tap()
    XCTAssertTrue(portfolio.waitForExistence(timeout: 5))
  }
  func testAssistantPreservesPortfolioAndAddMenu() throws {
    let app = XCUIApplication()
    app.launch()
    let portfolio = app.navigationBars["Portfolio"]
    guard portfolio.waitForExistence(timeout: 10) else {
      throw XCTSkip("Pair a simulator before live navigation tests")
    }
    app.buttons["Crypto"].tap()
    XCTAssertTrue(app.buttons["3M"].waitForExistence(timeout: 10))
    app.buttons["3M"].tap()
    let assets = app.segmentedControls["portfolio-content-picker"].buttons["Assets"]
    for _ in 0..<5 {
      if assets.isHittable { break }
      app.swipeUp()
    }
    guard assets.exists else { throw XCTSkip("Add an account to verify the Assets selection") }
    assets.tap()
    for _ in 0..<2 {
      app.buttons["portfolio-assistant"].tap()
      XCTAssertTrue(app.navigationBars["Assistant"].waitForExistence(timeout: 5))
      app.buttons["Close"].tap()
      XCTAssertTrue(portfolio.waitForExistence(timeout: 5))
      XCTAssertTrue(assets.isSelected)
    }
    for _ in 0..<5 {
      if app.buttons["3M"].isHittable { break }
      app.swipeDown()
    }
    XCTAssertTrue(app.buttons["Crypto"].isSelected)
    XCTAssertTrue(app.buttons["3M"].isSelected)
    let assistant = app.buttons["portfolio-assistant"]
    let add = portfolio.buttons["Add"]
    XCTAssertLessThan(assistant.frame.midX, add.frame.midX)
    XCTAssertGreaterThanOrEqual(assistant.frame.width, 44)
    XCTAssertGreaterThanOrEqual(assistant.frame.height, 44)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "Portfolio assistant toolbar"
    capture.lifetime = .keepAlways
    self.add(capture)
    add.tap()
    XCTAssertTrue(app.buttons["Import screenshot"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Add manually or connect account"].exists)
  }

  func testConnectedDerivativesChartsAndLeverage() throws {
    let app = XCUIApplication()
    app.launch()
    guard app.navigationBars["Portfolio"].waitForExistence(timeout: 10) else {
      throw XCTSkip("Pair a simulator before live navigation tests")
    }
    app.buttons["Crypto"].tap()
    app.buttons["3M"].tap()
    let portfolioCapture = XCTAttachment(screenshot: app.screenshot())
    portfolioCapture.name = "Real equity history"
    portfolioCapture.lifetime = .keepAlways
    add(portfolioCapture)
    let row = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "portfolio-account-")
    ).firstMatch
    for _ in 0..<4 {
      if row.isHittable { break }
      app.swipeUp()
    }
    guard row.exists else { throw XCTSkip("Connect a derivatives account for this test") }
    row.tap()
    guard app.buttons["Trading PnL"].waitForExistence(timeout: 10) else {
      let failureCapture = XCTAttachment(screenshot: app.screenshot())
      failureCapture.name = "Account detail diagnostic"
      failureCapture.lifetime = .keepAlways
      add(failureCapture)
      XCTFail("Connected account did not show its provider PnL")
      return
    }
    app.buttons["Trading PnL"].tap()
    XCTAssertTrue(app.staticTexts["Cumulative trading PnL · dYdX"].waitForExistence(timeout: 5))
    let pnlCapture = XCTAttachment(screenshot: app.screenshot())
    pnlCapture.name = "Trading PnL history"
    pnlCapture.lifetime = .keepAlways
    add(pnlCapture)
    for _ in 0..<4 {
      if app.staticTexts["Effective leverage"].isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(app.staticTexts["Effective leverage"].isHittable)
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Free collateral"))
        .firstMatch.exists)
    let riskCapture = XCTAttachment(screenshot: app.screenshot())
    riskCapture.name = "Leverage and exposure"
    riskCapture.lifetime = .keepAlways
    add(riskCapture)
    for _ in 0..<4 {
      if app.descendants(matching: .any)["market-price-history"].isHittable { break }
      app.swipeUp()
    }
    app.descendants(matching: .any)["market-price-history"].tap()
    XCTAssertTrue(app.staticTexts["dYdX · 1DAY candle close · USD"].waitForExistence(timeout: 20))
    let priceCapture = XCTAttachment(screenshot: app.screenshot())
    priceCapture.name = "Actual market prices"
    priceCapture.lifetime = .keepAlways
    add(priceCapture)
  }

}
