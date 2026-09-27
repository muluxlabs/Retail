# 6. Items, prices and stock

## The item master

**Item master** holds every item the group sells, once, with its **packs** and **barcodes**. A pack is a way the item is sold or bought — a *single*, a *bale of 10*, a *case of 24* — each with its own barcode and selling price, and all counted in the same **base unit** so stock adds up across packs.

![The item master](images/item-master.jpg)

| To… | Do this |
|---|---|
| Add an item | **Add product**: name, SKU, category, base unit; then open it to add its packs and barcodes. |
| Add a pack or barcode | Open the item and add it; a barcode can belong to one pack only. |
| Review items added at the till | They are marked **pending review** here, and each one is waiting in the **Exceptions** queue (*Product added at the till*), where a manager approves it or **merges** it into the item it duplicates — its history moves with it. |
| Find messy data | Items with no pack or no barcode are flagged, not hidden. |

## Prices

**Prices** shows every pack with its **cost**, **selling price** and **margin**.

![Prices](images/prices.jpg)

- **One price:** type it in the row.
- **Many at once:** tick items (a category, a search, every unpriced item) and apply a rule — *an exact price*, *a percentage up or down*, or *cost plus a markup*. The new prices are shown for review; nothing changes until **Save**.
- **Every unpriced item at once:** show only items with *no price yet*, tick them all, and apply *cost plus a markup* (rounded up). Items with no known cost are left for you to price by hand.
- **From a supplier's price list:** see [Buying › Supplier price lists](07-buying.md#supplier-price-lists).

Every price change is recorded in the audit log with the old and new price and who made it. An item with no price cannot be sold.

## Stock on hand

**Stock on hand** shows what each branch holds, item by item, and what it is worth at cost. **Below zero only** lists the positions the records say are impossible — where selling below zero has been authorised and a count is due.

![Stock on hand](images/stock-on-hand.jpg)

## The stock ledger

**Stock ledger** is the bin card, in the form an accountant reads it:

- **Stock ledger** — one item at one branch: *opening balance b/f*, each receipt and issue with a running balance, *closing balance c/f*, and a line proving it agrees with stock on hand.
- **Stock reconciliation** — every item at a branch on one page: *opening + receipts − issues = closing*, with separate columns for purchases, transfers in and out, sales, returns, stock-take adjustments and opening stock introduced.
- **Transaction log** — every movement, newest first, including how long after the event it was recorded (late entries are flagged).

![The stock ledger](images/stock-ledger.jpg)

## Stock take

**Stock entry › Stock take**: choose the branch, count, type what is on the shelf. Only items you typed a count for are posted — an item left blank stays as it was; it is never assumed to be zero. Posting writes each difference to the ledger, valued at average cost, and differences become *count variance* exceptions.

![Stock take](images/stock-take.jpg)

## Opening stock

**Stock entry › Opening stock** brings the stock already on a branch's shelves onto the books — for a new branch, or when starting fresh. Search items or **paste a list from a spreadsheet** (item, quantity, cost per pack). Items that already have stock at the branch are flagged: those need a stock take instead. Posting creates one numbered document (OPN-…), and a work item for the auditor to check it.

![Opening stock](images/opening-stock.jpg)

## Transfers between branches

**Transfers** moves stock from one branch (or the distribution centre) to another in two steps, done by different people:

1. **Dispatch** at the sending branch — stock leaves immediately and is *in transit*.
2. **Receive** at the receiving branch — they confirm what actually arrived. Shortages or extras are costed and raised as *lost in transit* exceptions.

![Transfers](images/transfers.jpg)

## Starting a branch fresh

A branch manager can set every item at a branch to zero (**Stock on hand › Start a branch fresh**), for example before a full opening count after moving from another system. It cannot be undone, asks for confirmation, is recorded as one document and is raised as an exception.
