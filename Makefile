.PHONY: dev up down logs migrate seed token test backup ios-generate
dev:
	docker compose -f compose.yaml -f compose.dev.yaml up -d --build
up:
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f --tail=100
migrate:
	docker compose run --rm migrate
seed:
	docker compose exec -e NODE_ENV=development api node dist/db/seed.js
token:
	docker compose exec api node dist/modules/auth/cli.js create --name "iPhone"
test:
	docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
check:
	cd server && npm run typecheck && npm run format:check
backup:
	sh deploy/backup.sh
ios-generate:
	cd ios && xcodegen generate
	mkdir -p ios/FinanceCockpit.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
	cp ios/Package.resolved ios/FinanceCockpit.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
