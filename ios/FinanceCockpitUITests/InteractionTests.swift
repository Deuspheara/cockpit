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
  func testPartialBaseHistoryCoverageAndRetry() {
    let app = launch(["--wallet-layout", "--partial-history", "--advanced-ui"])
    XCTAssertTrue(app.buttons["valuation-coverage"].waitForExistence(timeout: 5))
    capture("Partial Base chart", app)
    app.buttons["valuation-coverage"].tap()
    XCTAssertTrue(app.staticTexts["Unpriced Base token"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["base-mainnet"].exists)
    capture("Missing token diagnostics", app)
    app.buttons["Done"].tap()
    let row = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "portfolio-account-")
    ).firstMatch
    reveal(row, app)
    row.tap()
    let retry = app.buttons["recover-base-history"]
    reveal(retry, app)
    XCTAssertTrue(retry.waitForExistence(timeout: 5))
    retry.tap()
    XCTAssertTrue(app.staticTexts["Recovering balances and prices"].waitForExistence(timeout: 8))
    capture("Base backfill progress", app)
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
  func testUnresolvedFundSearchSelectionAndGuidedContinue() { guidedSelection(largeText: false) }
  func testGuidedSelectionWithLargeText() { guidedSelection(largeText: true) }
  private func guidedSelection(largeText: Bool) {
    let app = XCUIApplication()
    app.launchArguments =
      ["--ui-fixtures", "--fresh-import", "--unresolved-import", "--dark"]
      + (largeText ? ["--large-text"] : [])
    app.launch()
    XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 15))
    app.buttons["Add"].tap()
    app.buttons["Import screenshot"].tap()
    XCTAssertTrue(app.buttons["Use sample screenshots"].waitForExistence(timeout: 8))
    app.buttons["Use sample screenshots"].tap()
    XCTAssertTrue(app.staticTexts["Account & Date"].waitForExistence(timeout: 10))
    app.buttons["Continue"].tap()
    app.buttons["Continue"].tap()
    XCTAssertTrue(app.staticTexts["Suggested match"].waitForExistence(timeout: 5))
    let choice = app.buttons.containing(.staticText, identifier: "iShares Core MSCI World")
      .firstMatch
    for _ in 0..<4 {
      if choice.isHittable { break }
      app.swipeUp()
    }
    choice.tap()
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = largeText ? "Guided selection large text" : "Guided investment selection"
    capture.lifetime = .keepAlways
    add(capture)
    app.buttons["import-review-next"].tap()
    XCTAssertTrue(app.buttons["Save and continue"].waitForExistence(timeout: 5))
    app.buttons["Save and continue"].tap()
    XCTAssertTrue(app.buttons["Apply"].waitForExistence(timeout: 5))
  }
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
    XCTAssertTrue(app.buttons["Edit quantity or ticker"].waitForExistence(timeout: 5))
    app.buttons["Edit quantity or ticker"].tap()
    XCTAssertTrue(app.textFields["import-quantity"].waitForExistence(timeout: 5))
    app.swipeUp()
    app.buttons["Save and continue"].tap()
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

@MainActor final class WalletLayoutTests: XCTestCase {
  func testPartialWalletKeepsPositionsVisibleAndDetailsExpandable() {
    checkLayout(largeText: false)
  }
  func testPartialWalletWithAccessibilityText() {
    checkLayout(largeText: true)
  }
  private func checkLayout(largeText: Bool) {
    let app = XCUIApplication()
    app.launchArguments =
      ["--ui-fixtures", "--wallet-layout", "--dark"] + (largeText ? ["--large-text"] : [])
    app.launch()
    let wallet = app.buttons.containing(.staticText, identifier: "Base Eth").firstMatch
    XCTAssertTrue(wallet.waitForExistence(timeout: 15))
    for _ in 0..<5 {
      if wallet.isHittable { break }
      app.swipeUp()
    }
    wallet.tap()
    XCTAssertTrue(app.staticTexts["EVM wallet"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No recorded values for this period"].exists)
    XCTAssertFalse(app.staticTexts["evm_wallet"].exists)
    XCTAssertFalse(app.buttons["Retry sync"].exists)
    let balance = app.staticTexts["ETH"]
    for _ in 0..<5 {
      if balance.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(balance.isHittable)
    let capture = XCTAttachment(screenshot: app.screenshot())
    capture.name = largeText ? "Wallet accessibility" : "Wallet compact dark"
    capture.lifetime = .keepAlways
    add(capture)
    let details = app.buttons["account-sync-details"]
    for _ in 0..<5 {
      if details.isHittable { break }
      app.swipeDown()
    }
    details.tap()
    XCTAssertTrue(app.buttons["Retry sync"].waitForExistence(timeout: 5))
  }
}

@MainActor final class SimpleInterfaceTests: XCTestCase {
  private func openAccount(_ app: XCUIApplication) {
    let row = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "portfolio-account-")
    ).firstMatch
    for _ in 0..<5 {
      if row.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    XCTAssertTrue(app.staticTexts["Holdings"].waitForExistence(timeout: 5))
  }
  private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testSimpleAccountsAndAdvancedDetails() {
    for account in ["--wallet-layout", "--csv-account", "--dydx-layout"] {
      for appearance in [[], ["--dark"], ["--large-text"]] {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixtures", account] + appearance
        app.launch()
        XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
        openAccount(app)
        XCTAssertFalse(app.staticTexts["Effective leverage"].exists)
        XCTAssertFalse(app.staticTexts["Base history"].exists)
        XCTAssertFalse(app.staticTexts["Exposure / equity"].exists)
        capture("Simple \(account) \(appearance)", app)
        app.tabBars.buttons["Settings"].tap()
        XCTAssertFalse(app.staticTexts["OpenRouter key"].exists)
        app.segmentedControls["interface-mode"].buttons["Advanced"].tap()
        for _ in 0..<4 {
          if app.staticTexts["OpenRouter key"].exists { break }
          app.swipeUp()
        }
        XCTAssertTrue(app.staticTexts["OpenRouter key"].exists)
        app.tabBars.buttons["Home"].tap()
        if account == "--dydx-layout" {
          for _ in 0..<3 {
            if app.staticTexts["Effective leverage"].isHittable { break }
            app.swipeUp()
          }
          XCTAssertTrue(app.staticTexts["Effective leverage"].exists)
        }
        capture("Advanced \(account) \(appearance)", app)
        app.terminate()
      }
    }
  }
  func testManualTransactionDeletionNeedsOneConfirmation() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures", "--manual-activity"]
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    app.tabBars.buttons["Activity"].tap()
    let row = app.cells.containing(.staticText, identifier: "Purchase").firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.swipeLeft()
    app.buttons["Delete transaction"].tap()
    XCTAssertTrue(app.staticTexts["Delete this transaction?"].waitForExistence(timeout: 5))
    app.sheets["Delete this transaction?"].buttons["Delete transaction"].tap()
    XCTAssertTrue(app.staticTexts["No activity yet"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.navigationBars["Review changes"].exists)
  }
  func testModePersistsAndAccountRemovalIsSimple() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures", "--csv-account"]
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    app.tabBars.buttons["Settings"].tap()
    app.segmentedControls["interface-mode"].buttons["Advanced"].tap()
    app.terminate()
    app.launchArguments += ["--preserve-mode"]
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.segmentedControls["interface-mode"].buttons["Advanced"].isSelected)
    app.segmentedControls["interface-mode"].buttons["Simple"].tap()
    app.tabBars.buttons["Home"].tap()
    openAccount(app)
    app.buttons["Account actions"].tap()
    app.buttons["Remove account"].tap()
    app.buttons["Remove account"].tap()
    XCTAssertTrue(app.staticTexts["Your portfolio is empty"].waitForExistence(timeout: 10))
  }
}
