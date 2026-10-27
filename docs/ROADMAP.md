# Roadmap / ideas parked for later

Shipped recently: live view-only sharing, shared link opens on the oval table, hand-ranking cheat sheet
(host app + shared link), "That's me" highlight with "you pay / you receive", standings strip, save the
settlement as a picture, and **handing the table to another host** (QR/one-time link for anyone, or request to a
player in the list that the host confirms).

## Deliberately skipped for now
- **Payment deep links** (Venmo / Zelle / Cash App / UPI / PayPal.me): after settle, each payer gets a tap-to-pay
  button with the amount pre-filled; the host saves a handle once. Skipped by request. Likely the most useful
  next feature. Zelle has no public deep link, so it would be "copy handle + amount".

## Shared link (viewers)
- **Pay confirmations:** a viewer taps "I paid" and the host approves. Needs a second kind of write, so the
  host-only permission model must be extended carefully (separate, narrowly scoped viewer token).
- **Notifications:** web push / in-app ping when the host settles or a payment is marked.
- **QR code** for the link so people at the table can scan it (needs a small QR generator, no dependency today).
- **Reactions / chat:** fun, but needs moderation and rate limits.
- **Remember "that's me" across visits** (today it lives only in the browser tab on purpose, so a viewer never
  stores anything on their device).
- **Per-seat history sparkline** (how each stack moved during the night; needs the host to log changes).

## Host app
- **Roster and regulars:** saved names with avatars and a lifetime stat card (net, win rate, biggest win).
- **Quick-add buttons:** common rebuy amounts, "same as last time" for returning players.
- **Blinds timer and rake helper:** simple clock with level changes; rake as a percentage with a cap.
- **Tournament mode:** payout structure (50/30/20), bounties, re-entries.
- **Chip-count helper:** tap chip denominations to total a stack instead of typing it.
- **Undo and audit log:** every buy-in/chip change with a timestamp, for settling disputes.
- **Photo of a stack** attached to a cash-out (opt-in, on-device by default; camera data is sensitive).
- **Co-host:** a second key that can also edit at the same time (today the role *moves*; it is never shared). Needs conflict handling when two people change the same player.
- **Recovery key:** copy a backup of the host key so a *lost* phone (no chance to hand over) can be recovered.
- **Host-offline notice on the shared link:** "Host last updated 7 min ago" and a gentle warning after ~10 min.
- **Export:** CSV / PDF season report and monthly summary.
- **Languages and currency symbol.**
- **"Which hand wins?" mini quiz** built on the hand-ranking data.

## Housekeeping
- `api/share.js` is a generated bundle (`npm run build:api`); keep it in sync with `server/`.
- Real Vercel + Upstash Redis path is untested; production 429 limits are only unit tested.
