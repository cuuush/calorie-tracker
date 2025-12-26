# Playwright Tests

Simple end-to-end tests for the calorie tracker app.

## Setup

1. Install Playwright browsers:
```bash
npx playwright install chromium
```

2. Enable test flags in `.dev.vars`:
```
DEBUG_MODE=true
BYPASS_AUTH=true
```

This enables test mode with:
- `DEBUG_MODE=true` - Returns canned AI responses
- `BYPASS_AUTH=true` - Skips authentication

## Running Tests

Run all tests:
```bash
npm test
```

Run tests with UI:
```bash
npm run test:ui
```

Debug mode:
```bash
npm run test:debug
```

## Test Flags

### DEBUG_MODE

When `DEBUG_MODE=true`, the app returns canned responses instead of querying OpenRouter:

- **Test Meal**: Returns a sample meal with grilled chicken, brown rice, and broccoli
- Saves on API costs during testing
- Faster test execution

### BYPASS_AUTH

When `BYPASS_AUTH=true`, authentication is completely bypassed:

- Creates a fake test user (`test@example.com`)
- No need to handle magic links or sessions
- Tests can access authenticated routes directly

## Tests

- `basic.spec.js`: Login page tests
- `tracking.spec.js`: Food tracking functionality, navigation, and UI interaction

All tests run with a mocked authenticated user and canned AI responses.
