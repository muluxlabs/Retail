# 1. What the platform is

The Retail Operations Platform runs a multi-branch retail business — a supermarket group, a chain of wholesalers, a set of hardware stores — from one place. Every branch sells, receives, counts and banks through the same system, and head office sees all of it as it happens.

It was built to replace an older point-of-sale package whose numbers could not be trusted: stock that went negative without anyone noticing, deliveries entered days late, cash differences nobody owned, prices changed at the till with no trace. Each of those problems has a specific answer in this platform.

## What it does

| Area | In plain words | Main screens |
|---|---|---|
| **Selling** | Scan or search items, take cash, mobile money, card, account or loyalty points, print a receipt. | Sell |
| **Shifts and cash** | Each cashier counts their float in and their cash out. Money moving between tills, safe and bank is recorded. The day closes with a Z report. | Cash, Shifts, End of day |
| **Items and prices** | One item master for the group: items, pack sizes, barcodes, selling prices. Prices set one by one, in bulk, or from a supplier's price list. | Item master, Prices |
| **Stock** | Stock on hand at every branch, the full stock ledger, stock takes, opening stock, transfers between branches. | Stock on hand, Stock ledger, Stock entry, Transfers |
| **Buying** | Suppliers, purchase orders, goods received, returns, payments, what is owed, supplier price lists. | Buying |
| **Customers** | Customers on credit with limits, payments received, aged debtors; loyalty points. | Customers |
| **Reports** | Sales, cost and profit; item analysis; stock movement; the group overview. | Overview, Reports |
| **Controls** | The exception queue, the audit trail, roles and per-person access. | Exceptions, Staff |

## Who uses it

| Person | What they do in the system |
|---|---|
| **Cashier** | Sells, opens and closes their shift, signs up customers, takes payments on account. |
| **Shift supervisor** | Watches the tills, closes shifts, moves float, closes the day. |
| **Goods receiver** | Receives deliveries against orders, sends and receives transfers. |
| **Stock controller** | Keeps the item master and prices, runs stock takes, orders from suppliers. |
| **Branch manager** | Runs one branch end to end: selling, stock, buying, cash, customers, its reports. |
| **Finance** | Pays suppliers, manages customer credit, reads sales and profit. |
| **Auditor** | Reads everything, changes nothing except clearing exceptions. |
| **Administrator** | Sets up branches, staff, access and settings. |

## What makes it different

**It cannot quietly be wrong.** Stock and cash are *ledgers*: lists of movements that are only ever added to. Stock on hand is the sum of the movements, so it always agrees with the history, and any figure can be traced to the documents behind it. Documents — receipts, goods received notes, Z reports, price lists — are numbered without gaps and cannot be edited once posted.

**It notices.** When something happens that a careful manager would want to know about, it becomes an **exception** with a person, a time, a branch and a value. Examples: an item sold with no stock on record, a price changed at the till, a delivery short in transit, a till $12 short at the end of Tariro's shift, a customer's credit limit raised. Exceptions stay open until someone clears them, and clearing them is recorded too.

**It speaks the accountant's language.** Reports use *opening balance b/f, receipts, issues, closing balance c/f, cost of sales, gross profit, aged creditors and debtors* — and they reconcile on the page.

**It is honest about what it does not know.** Items sold before they had a cost show as "no cost on record" rather than an invented margin. Sales made before prices existed show units, not made-up revenue.

## Words used in this guide

| Word | Meaning |
|---|---|
| **Branch** | A shop or warehouse. Staff can be tied to one branch or work across the group. |
| **Item / pack** | An item is the product (e.g. *White sugar*). A pack is how it is sold or bought (*2 kg bag*, *bale of 10*). Each pack has its own barcode and price. |
| **Base unit** | The smallest unit stock is counted in (one bag). A bale of 10 is 10 base units. |
| **Stock ledger** | The list of every stock movement: sales, deliveries, transfers, counts, adjustments. |
| **Cash point** | Anywhere cash is kept: a till, a safe, the bank. |
| **Float** | The cash in a till at the start of a shift, for giving change. |
| **Shift** | One cashier's session on one till, from counting the float in to counting the cash out. |
| **Blind count** | Counting cash without being told what the books expect, so the count is honest. |
| **X report / Z report** | X: the day so far. Z: the numbered, final close of the day. |
| **GRN** | Goods received note — the record of a delivery. |
| **PO** | Purchase order. |
| **PRN** | Purchase return note — goods sent back to a supplier. |
| **Exception** | Something unusual, put in a queue for a named person to review. |
| **Permission** | One thing a person may do (e.g. *Sell at the till*). Roles are bundles of permissions. |

## A day in the life

1. **07:45** — Tariro opens her shift on Till 1 by counting the float: $50.00. The system agrees; her shift is open.
2. **08:00–17:00** — She sells. Joseph Sibanda gives his phone number and earns points. Mai Rudo's tuckshop buys on account. When a customer queries a price, only her supervisor (who holds the permission to change prices at the till) can sell away from the list price — and doing so is recorded as an exception.
3. **11:30** — A delivery from Harvest Foods arrives. The receiver checks it against the purchase order; four cartons are short, and the order stays open for the rest.
4. **13:00** — The supervisor moves $400 from Till 1 to the safe.
5. **17:10** — Tariro closes her shift with a blind count. She is $2.50 short; it is posted to the till and named against her shift.
6. **17:30** — The supervisor closes the day. The Z report covers receipts 000231 to 000318, lists takings by payment method and by cashier, and compares every till's cash.
7. **Next morning** — The owner opens the **Overview** on her phone: sales by branch, profit, stock value, and three exceptions to look at.
