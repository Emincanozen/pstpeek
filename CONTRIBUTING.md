# Contributing to pstpeek

Thanks for helping. Small, focused pull requests are easiest to review.

## Set up

```bash
git clone https://github.com/Emincanozen/pstpeek.git
cd pstpeek
npm ci
npm run build
npm test
```

## Before you open a pull request

- Run the full test suite and make sure it passes.
- Add or update a test for every behaviour you change.
- Keep the zero-dependency promise: do not add a runtime dependency without opening an issue first.
- Describe the problem the change solves, and how you checked it.

## Reporting a bug

Open an issue with the command you ran, what you expected and what happened. For file-format tools, a minimal sample file helps a lot. Remove any personal data from it first.
