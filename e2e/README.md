# Browser checks (Playwright)

Run against a built copy of the app:

```
npm run build && npx vite preview --port 4174 &
BASE=http://localhost:4174/ node e2e/chips.cjs    # chip-count game: setup, chips back, settlement, viewer
BASE=http://localhost:4174/ node e2e/ipaid.cjs    # "I paid" request and host approval
```

Each line prints PASS or FAIL. Run them before merging anything to main.
