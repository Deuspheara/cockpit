import XCTest

@MainActor final class InteractionTests: XCTestCase {
  private func launch(_ arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures"] + arguments
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    return app
  }
  private func openSetup(_ app: XCUIApplication) {
    app.navigationBars["Portfolio"].buttons["Add"].tap()
    app.buttons["Add account"].tap()
    XCTAssertTrue(
      app.buttons.containing(.staticText, identifier: "Track manually").firstMatch.waitForExistence(
        timeout: 5))
  }
  private func tapChoice(_ text: String, _ app: XCUIApplication) {
    app.buttons.containing(.staticText, identifier: text).firstMatch.tap()
  }
  private func reveal(_ element: XCUIElement, _ app: XCUIApplication) {
    for _ in 0..<6 {
      if element.isHittable { return }
      app.swipeUp()
    }
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = name
    capture.lifetime = .keepAlways
    add(capture)
  }
  func testChartScrubbingAndRangeChangesKeepLayout() {
    let app = launch()
    let picker = app.buttons["1M"]
    let initial = picker.frame
    capture("Chart before drag", app)
    let plot = app.descendants(matching: .any)["portfolio-chart-plot"].firstMatch
    XCTAssertTrue(plot.exists)
    let start = plot.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    let end = plot.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
    start.press(forDuration: 0.2, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.5)
    XCTAssertEqual(picker.frame.minY, initial.minY, accuracy: 1)
    for title in ["3M", "1D", "1W", "1M"] {
      app.buttons[title].tap()
      XCTAssertTrue(picker.exists)
      capture("Chart range " + title, app)
      XCTAssertEqual(picker.frame.minY, initial.minY, accuracy: 1)
    }
    capture("Stable chart and range picker", app)
  }
  func testManualAccountCashBalanceReviewAndFinish() {
    let app = launch()
    openSetup(app)
    tapChoice("Track manually", app)
    tapChoice("Cash", app)
    app.buttons["Continue"].tap()
    app.buttons["setup-create"].tap()
    let amount = app.textFields["holding-quantity"]
    XCTAssertTrue(amount.waitForExistence(timeout: 5))
    amount.tap()
    amount.typeText("2500")
    let review = app.buttons["Review holding"]
    reveal(review, app)
    review.tap()
    let apply = app.buttons["Apply reviewed changes"]
    XCTAssertTrue(app.navigationBars["Review changes"].waitForExistence(timeout: 5))
    capture("First balance review", app)
    reveal(apply, app)
    apply.tap()
    XCTAssertTrue(app.buttons["View account"].waitForExistence(timeout: 5))
    app.buttons["View account"].tap()
    XCTAssertTrue(app.navigationBars["Cash"].waitForExistence(timeout: 5))
  }
  func testManualSkipAndBackPreserveDetails() {
    let app = launch()
    openSetup(app)
    tapChoice("Track manually", app)
    tapChoice("Investments", app)
    let name = app.textFields["setup-name"]
    name.tap()
    name.typeText("My portfolio")
    app.buttons["Continue"].tap()
    app.buttons["Edit details"].tap()
    XCTAssertEqual(name.value as? String, "My portfolio")
    app.buttons["Continue"].tap()
    app.buttons["setup-create"].tap()
    XCTAssertTrue(app.buttons["Skip for now"].waitForExistence(timeout: 5))
    app.buttons["Skip for now"].tap()
    XCTAssertTrue(app.buttons["View account"].waitForExistence(timeout: 5))
    capture("Manual account ready", app)
  }
  func testNewInvestmentAssetAndReview() {
    let app = launch()
    openSetup(app)
    tapChoice("Track manually", app)
    tapChoice("Investments", app)
    app.buttons["Continue"].tap()
    app.buttons["setup-create"].tap()
    let toggle = app.switches["Add a new asset"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5))
    toggle.switches.firstMatch.tap()
    app.textFields["Symbol, e.g. AAPL"].tap()
    app.textFields["Symbol, e.g. AAPL"].typeText("TEST")
    app.textFields["Asset name"].tap()
    app.textFields["Asset name"].typeText("Test holding")
    let next = app.buttons["Continue"]
    reveal(next, app)
    next.tap()
    let quantity = app.textFields["holding-quantity"]
    XCTAssertTrue(quantity.waitForExistence(timeout: 5))
    quantity.tap()
    quantity.typeText("12")
    let review = app.buttons["Review holding"]
    reveal(review, app)
    review.tap()
    XCTAssertTrue(app.buttons["Apply reviewed changes"].waitForExistence(timeout: 5))
    capture("First investment review", app)
    app.buttons["Apply reviewed changes"].tap()
    XCTAssertTrue(app.buttons["View account"].waitForExistence(timeout: 5))
  }

  func testDarkLargeTextAndReducedMotion() {
    let app = launch(["--dark", "--large-text", "--reduce-motion"])
    reveal(app.buttons["1M"], app)
    capture("Chart dark accessibility Reduce Motion", app)
    openSetup(app)
    tapChoice("Track manually", app)
    tapChoice("Cash", app)
    capture("Account details dark accessibility", app)
    let next = app.buttons["Continue"]
    reveal(next, app)
    next.tap()
    let create = app.buttons["setup-create"]
    reveal(create, app)
    create.tap()
    let skip = app.buttons["Skip for now"]
    XCTAssertTrue(skip.waitForExistence(timeout: 5))
    reveal(skip, app)
    skip.tap()
    XCTAssertTrue(app.buttons["View account"].waitForExistence(timeout: 5))
  }

  func testConnectedValidationAndSyncFailureCanOpenAccount() {
    let app = launch(["--sync-failure"])
    openSetup(app)
    tapChoice("Connect a crypto account", app)
    tapChoice("Hyperliquid", app)
    XCTAssertFalse(app.buttons["Continue"].isEnabled)
    let address = app.textFields["setup-address"]
    address.tap()
    address.typeText("0x" + String(repeating: "a", count: 40))
    let next = app.buttons["Continue"]
    reveal(next, app)
    next.tap()
    let create = app.buttons["setup-create"]
    reveal(create, app)
    create.tap()
    XCTAssertTrue(app.buttons["Retry sync"].waitForExistence(timeout: 5))
    app.buttons["Retry sync"].tap()
    XCTAssertTrue(app.buttons["View account"].isEnabled)
    capture("Connected account sync retry", app)
    app.buttons["View account"].tap()
    XCTAssertTrue(app.navigationBars["Hyperliquid"].waitForExistence(timeout: 5))
  }
}

@MainActor final class ScreenshotWizardTests: XCTestCase {
  func testReviewEditBackApplyUndoWithLargeText() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures", "--fresh-import", "--large-text"]
    app.launch()
    XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 15))
    app.buttons["Add"].tap()
    app.buttons["Import screenshot"].tap()
    XCTAssertTrue(app.staticTexts["Upload & Analysis"].waitForExistence(timeout: 8))
    app.buttons["Use sample screenshots"].tap()
    XCTAssertTrue(app.staticTexts["Account & Date"].waitForExistence(timeout: 10))
    app.buttons["Continue"].tap()
    XCTAssertTrue(app.staticTexts["Holdings"].waitForExistence(timeout: 5))
    app.buttons.containing(.staticText, identifier: "Apple").firstMatch.tap()
    XCTAssertTrue(app.textFields["import-quantity"].waitForExistence(timeout: 5))
    app.swipeUp()
    app.buttons["Save correction"].tap()
    XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
    app.buttons["Continue"].tap()
    XCTAssertTrue(app.buttons["Apply"].waitForExistence(timeout: 5))
    app.buttons["Back"].tap()
    XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 5))
    app.buttons["Continue"].tap()
    app.buttons["Apply"].tap()
    XCTAssertTrue(app.buttons["Open Account"].waitForExistence(timeout: 5))
    app.buttons["Undo"].tap()
    XCTAssertTrue(app.staticTexts["Import undone"].waitForExistence(timeout: 5))
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = "Separate screenshot import complete at accessibility size"
    capture.lifetime = .keepAlways
    add(capture)
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["portfolio-assistant"].waitForExistence(timeout: 5))
  }
  func testDismissDuringAnalysisDoesNotRequireCancellation() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures", "--fresh-import"]
    app.launch()
    XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 15))
    app.buttons["Add"].tap()
    app.buttons["Import screenshot"].tap()
    XCTAssertTrue(app.buttons["Use sample screenshots"].waitForExistence(timeout: 8))
    app.buttons["Use sample screenshots"].tap()
    app.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["portfolio-assistant"].waitForExistence(timeout: 5))
  }
}
