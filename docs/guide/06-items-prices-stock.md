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

### Packs and pack prices

Each pack has **its own selling price**, chosen by the business. A pack can be cheaper per unit than singles — that is the point of selling in bulk:

| Pack | Units in it | Selling price | The form shows |
|---|---|---|---|
| single | 1 | $4.00 | |
| pack of 3 | 3 | $10.00 | $3.33 a unit · saves $2.00 against 3 singles |
| case of 24 | 24 | *(blank if not sold by the case)* | tick **we buy**: the pack ordered from suppliers |

- The **per unit** line appears as a price is typed; a pack that costs **more** than the same number of singles is shown in red — almost always a typing mistake.
- At the till, **scanning the pack's barcode** sells the pack at its price ($10.00) and takes 3 off stock; scanning a single sells one at $4.00. Stock is always counted in singles, so counts and reports stay right however an item is sold.
- **Till sells** marks the pack the till adds when a cashier finds the item by name; **we buy** marks the pack ordered from suppliers.
- Three singles scanned one by one are charged as three singles ($12.00): the till does not switch them to the pack price by itself.

### Barcodes: what they hold, and three ways to enter them

A barcode holds **only a number** (such as 6001234567890) — no name and no price. When it is scanned, the system looks the number up in the item master; the price always comes from here. A barcode is **optional**: an item without one is found at the till by name or SKU.

| Way | Best for |
|---|---|
| **A USB or Bluetooth barcode scanner** (about $20–40) | Tills and receiving. It works like a keyboard: click any box — in this system or an Excel cell — scan, and the number is typed with Enter. |
| **The camera button** beside every barcode box | Phones, tablets and laptops without a scanner. Point the camera at the barcode; it is read and filled in. Allow the camera when the browser asks. |
| **Typing** | A damaged label. |

In the **Excel template**, the Barcode and SKU columns are formatted as text, so Excel keeps all 13 digits and any leading zeros (instead of showing 6.00123E+12).

### Deleting and archiving items

Tick items in the **Item master** — or **Select all** for a clean start — and press **Delete or archive…** (each item's page has the same button). Before anything happens the system shows what will happen to each:

- **Deleted for good**: items never sold, received, ordered or counted — a typo, a test, a wrong import. A full copy stays in the audit log, and their barcodes are free to use again.
- **Archived**: items with history. They are hidden rather than erased — gone from the till, the item master and searches, and refused at checkout — while every past receipt, stock figure and report stays exactly as it was. The dialog warns if any still has stock on hand.

Type the number of items to confirm. Removing **ten or more at once** is sent to the exception queue for a second person to review. **Show archived** lists archived items, each with **Restore**. (People with *Add and change items*.)

## Importing items from Excel or CSV

For a new shop, or a big range change, add hundreds or thousands of items at once: **Item master › Import from Excel / CSV**.

**1. Get the template.** **Download Excel template** (or CSV). It has the right columns, example rows, and a second sheet, *How to fill this in*, explaining every column. One row is one **pack**; rows with the same SKU (or, with no SKU, the same item name) become **one item with several packs**.

| Column | Needed? | What to put |
|---|---|---|
| SKU | optional | Your code for the item. Blank: one is made up (ITM-000123). |
| Item name | **needed** | The item as customers know it, without the pack — *White sugar 2kg*. |
| Category | optional | Created if it does not exist yet. |
| Base unit | optional | What stock is counted in: each, kg, litre, box. Default *each*. |
| Weighed | optional | *yes* if sold by weight. Default *no*. |
| Pack | **needed** | single, bale of 10, case of 24… |
| Units in pack | **needed** | 1 for a single, 10 for a bale of 10. |
| Barcode | optional | 8, 12 or 13 digits, or your own code. One barcode, one pack. |
| Selling price | optional | Set only if you have price access; otherwise left for the Prices screen. |
| Sell this pack / Buy this pack | optional | *yes* for the pack the till sells by default / you order by. Default: smallest / largest. |
| Cost price | optional | What one of this pack cost you. |
| Stock on hand | optional | How many of this pack are on the shelf now (on one pack row per item). |

> **Tip:** in Excel, format the Barcode column as **Text** before typing, or long barcodes turn into numbers like 6.0E+12. The import spots this and tells you which rows to fix.

**2. Upload it** — Excel (.xlsx) or CSV — or paste rows copied from a spreadsheet. **Nothing is saved yet**: every row is checked and the preview shows

- how many rows were read, new items and packs, and new categories;
- **rows with problems**, by row and column (*Row 12, Units in pack: "two" is not a number*) — **Download these rows to fix**, correct them, upload them again;
- **items already in the item master** — skipped, with the reason;
- **items that look like ones you already have** — see below;
- the **stock on hand** in the file, if any.

![Checking a spreadsheet before importing](images/import-preview.jpg)

**3. Import.** All the new items are created together, or none are. You stay on the same screen and get the report, item by item: what was created (with its stock), what was already there, and which look-alikes were left out. Each import is numbered (ITM-IMP-000001), listed under *Recent imports*, and recorded in the audit log.

![The import report](images/import-report.jpg)

### How duplicates are prevented

Two records for one item split its stock and its sales in two, so the import is strict:

| The row… | What happens |
|---|---|
| has a **SKU** already in the item master | **Not created.** Shown as *already in the item master*. |
| has a **barcode** already on another item | **Not created.** |
| has the **same name** as an existing item — ignoring capitals, spaces, punctuation and how units are written (*2 kg* = *2kg*, *litre* = *l*) — and no SKU | **Not created.** |
| **looks like** an existing item — a spelling difference (*Suger 2kg* / *Sugar 2kg*), or the same name under a different SKU | **Held back** under *Look like items you already have*, beside the item it resembles and how alike they are. **Created only if you tick *Create anyway*.** |
| looks like **another row of the same file** | Held back the same way, pointing at that row. |

Sizes count: *Sugar 1kg* and *Sugar 2kg* are different items and are never flagged as look-alikes. Importing the same file twice creates nothing the second time.

### Bringing in stock with the items

If the file has **Stock on hand**, tick *Bring this stock onto the books as opening stock* and choose the **branch** it is at. The new items' stock becomes one numbered [opening stock](#opening-stock) document, valued at the file's **cost prices**. This needs the permission to bring in opening stock. Items already in the item master are never touched — their stock changes through a stock take.

### Adding one item: the same protection

**Add product** checks too. If an item with the same or a near-identical name exists, it stops and shows it: *"You may already have this item … Is this really a different item?"* — **Yes, it is different — create it**, or **No, don't create it**. A SKU that already exists is refused outright.

![Warned before creating a duplicate](images/add-product-warning.jpg)

## Prices

**Prices** shows every pack with its **cost**, **selling price** and **margin**.

![Prices](images/prices.jpg)

- **One price:** type it in the row.
- **Many at once:** tick items (a category, a search, every unpriced item) and apply a rule — *an exact price*, *a percentage up or down*, or *cost plus a markup*. The new prices are shown for review; nothing changes until **Save**.
- **Every unpriced item at once:** show only items with *no price yet*, tick them all, and apply *cost plus a markup* (rounded up). Items with no known cost are left for you to price by hand.
- **From a supplier's price list:** see [Buying › Supplier price lists](07-buying.md#supplier-price-lists).

Every price change is recorded in the [audit log](09-reports-and-controls.md#the-audit-log) with the old and new price and who made it. An item with no price cannot be sold.

## Stock on hand

**Stock on hand** shows what each branch holds, item by item, and what it is worth at cost. **Below zero only** lists the positions the records say are impossible — where selling below zero has been authorised and a count is due.

![Stock on hand](images/stock-on-hand.jpg)

## Not moving: stock that is not selling

**Stock › Not moving** shows, for one branch, stock that is sitting there and not selling — and the money tied up in it.

- **Not selling**: in stock at this branch, nothing sold here in the period you choose (30, 60, 90 or 180 days).
- **Slow**: it sold, but at that pace the stock here would last more than 180 days.
- Each shows what is on hand, its value at average cost, and when it last sold here. The total at the top is the money tied up.
- **Sells at**: if another branch is selling the same item, it is named with its pace and what it holds. **Move … there** opens a transfer already filled in — from this branch, to that one, with the suggested quantity (what that branch would sell over the same period, less what it already holds). Check it and press **Dispatch**.
- Nowhere selling it? Consider a lower price, a promotion, or not buying it again.

## The stock ledger

**Stock ledger** is the bin card, in the form an accountant reads it:

- **Stock ledger** — one item at one branch: *opening balance b/f*, each receipt and issue with a running balance, *closing balance c/f*, and a line proving it agrees with stock on hand.
- **Stock reconciliation** — every item at a branch on one page: *opening + receipts − issues = closing*, with separate columns for purchases, transfers in and out, sales, returns, stock-take adjustments and opening stock introduced.
- **Transaction log** — every movement, newest first, including how long after the event it was recorded (late entries are flagged).

![The stock ledger](images/stock-ledger.jpg)

## Stock take

**Stock entry › Stock take**: choose the branch, count, type what is on the shelf.

**Counting by scanning:** scan an item, type how many are on that shelf, press Enter, scan the next. A box's barcode counts boxes (5 boxes of 24 = 120 units). The same item scanned again somewhere else **adds up** — 40 on the shelf plus 20 in the store room is 60 — and **Undo** takes an entry back. A phone's camera makes walking the aisles easy.

**Counting on paper or in Excel:** **Download count sheet** gives an Excel file listing every item at the branch with a blank *Counted* column (in the item's base unit). Fill it in — on a tablet, or print it — and **Upload counts**: the counts fill in on screen, items found by SKU or barcode that were not on the list are added, and any code it cannot find is named. Nothing is posted until you check the screen and press **Post count**.

Only items you typed a count for are posted — an item left blank stays as it was; it is never assumed to be zero. Posting writes each difference to the ledger, valued at average cost, and differences become *count variance* exceptions.

![Stock take](images/stock-take.jpg)

## Opening stock

**Stock entry › Opening stock** brings the stock already on a branch's shelves onto the books — for a new branch, or when starting fresh. Search items, **paste a list from a spreadsheet**, or **open a file** — *Paste a list › Download template*, fill in SKU or barcode, quantity and cost per pack, then *Open a file (Excel or CSV)*: its rows go through exactly the same checks as a paste. Items that already have stock at the branch are flagged: those need a stock take instead. Posting creates one numbered document (OPN-…), and a work item for the auditor to check it.

![Opening stock](images/opening-stock.jpg)

## Transfers between branches

**Transfers** moves stock from one branch (or the distribution centre) to another in two steps, done by different people:

1. **Dispatch** at the sending branch — stock leaves immediately and is *in transit*.
2. **Receive** at the receiving branch — they confirm what actually arrived. Shortages or extras are costed and raised as *lost in transit* exceptions.

![Transfers](images/transfers.jpg)

## Starting a branch fresh

A branch manager can set every item at a branch to zero (**Stock on hand › Start a branch fresh**), for example before a full opening count after moving from another system. It cannot be undone, asks for confirmation, is recorded as one document and is raised as an exception.
