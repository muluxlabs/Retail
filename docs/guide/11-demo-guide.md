# 11. The demo guide

For anyone presenting the platform to a prospective client. It gives you the story, a 60-minute and a 120-minute script, what to say at each screen, the questions you will be asked, and a checklist for the day.

## The story in 30 seconds

> "Most retailers run on numbers they cannot trust. Stock goes negative and nobody knows why; deliveries are entered days late; the till is short and nobody owns it; prices get changed at the counter. This platform makes each of those impossible to hide. Every sale, delivery, count and cash movement is recorded as it happens and can never be edited — and anything unusual lands in front of a named manager. You see every branch, live, from your phone."

## Know your audience

| They are… | They care about | Spend your time on |
|---|---|---|
| **Owner / managing director** | Profit, theft, control, seeing all branches | Overview, profit report, exceptions, shift shortages, access control |
| **Finance / accountant / auditor** | Numbers that reconcile, audit trail, creditors and debtors | Stock ledger in accounting form, Z reports, supplier and customer statements, "what cannot happen" |
| **Operations / branch managers** | Speed at the till, stock accuracy, deliveries | Sell screen, stock take, goods received against orders, transfers, price lists |
| **IT** | Hosting, security, integration, hardware | Browser-based, any device, printers, access model, API ([chapter 12](12-api-reference.md)) |

Ask in the first five minutes: *How many branches? What do you use today? What goes wrong most often?* Then aim every screen at their answer.

## Before the demo — checklist

- [ ] A **demo system** with fictional data (never a real client's), signed in as an administrator in one browser window and as a **cashier** in another (a private window works).
- [ ] Loyalty **on** and shifts **optional** in Settings.
- [ ] A few barcodes to hand (on a sheet, or real products) and a USB scanner if you have one.
- [ ] A receipt printer connected, if possible — printing a real receipt lands well.
- [ ] A short supplier price list in a spreadsheet, to paste.
- [ ] Your phone signed in, to show the overview.
- [ ] Close other tabs; zoom the browser to 110–125 % on a projector.

## The 60-minute demo

| Min | Screen | Show | Say |
|---|---|---|---|
| 0–5 | — | Their problems | "Tell me what goes wrong today." Write down three things; come back to them. |
| 5–10 | **Overview** | Today's trading, stock value, owed to suppliers, exceptions | "This is every branch, live. Here on my phone too." |
| 10–22 | **Sell** (as cashier) | Open a shift (count the float) · scan three items · search one by name · sign up a customer by phone · split payment cash + mobile money · print the receipt | "The till is yours once your shift is open — nobody else can sell on it. Points bring the customer back." |
| 22–27 | **Sell** | Scan an unknown code → **Log as unlisted scan**; try to sell more than is in stock | "Under-the-counter sales become visible. Selling stock you don't have needs a manager — and is recorded." |
| 27–33 | **Sell → Cash** | Close the shift with a blind count $2 short → the shift report | "The cashier doesn't see the expected figure until they've counted. A shortage has a name." |
| 33–40 | **End of day** | X report · close the day · Z report | "Every sale is on exactly one Z report. It can never be changed." |
| 40–47 | **Buying** | A purchase order → **Goods received** against it (part delivery) → the supplier's statement | "Deliveries are checked against the order and the invoice; what you owe is always up to date." |
| 47–53 | **Exceptions** | The queue: price override, till short, unlisted scan | "Nothing unusual can happen quietly. Someone has to look at it and clear it." |
| 53–58 | **Reports › Sales and profit** | Trading account, this period vs last, by branch | "Profit uses the cost at the moment of sale — not an estimate." |
| 58–60 | — | Back to their three problems | "Here is where each of those is solved." Next step: a pilot at one branch. |

## The 120-minute demo

The 60-minute route, plus these (insert where they fit the audience):

| Min | Screen | Show | Say |
|---|---|---|---|
| +10 | **Stock ledger** | One item: opening balance b/f, receipts, issues, closing c/f, agrees to stock on hand. **Stock reconciliation** for a branch | For accountants: "This is the bin card, and it proves itself." |
| +10 | **Stock take** | Count a few items, leave others blank, post | "A blank is never treated as zero. Differences are valued and raised." |
| +8 | **Transfers** | Dispatch from the distribution centre; receive with one short | "The sender can't confirm their own delivery. Losses in transit are costed." |
| +10 | **Price lists** | Paste a supplier's list · keep margin · preview old/new cost, price and margin · apply | "A supplier's increase goes through every price in minutes — and never below cost." |
| +8 | **Customers** | A credit customer: sell on account up to the limit; take a payment; the aged debtors list; loyalty points history | "Credit is capped at the till, not at month-end." |
| +8 | **Payments / Owed** | Pay a supplier by bank transfer with a screenshot as proof; aged creditors | "Every payment has its proof attached." |
| +8 | **Staff › Access** | Give one cashier the item master; show it appear in their menu; put it back | "Access is by job, adjustable per person, and every change is on record." |
| +6 | **Item analysis** | Fast, not selling, days of cover | "What to reorder, what to stop buying." |
| +2 | **Phone** | Overview and exceptions on the phone | "Run the group from anywhere." |

## Questions you will be asked

| Question | Answer |
|---|---|
| *Does it work without internet?* | It runs in the browser and needs a connection. If a connection drops mid-sale, resending gives the same receipt, never a duplicate. A fully offline till mode is not available today. |
| *What hardware do we need?* | Any computer, tablet or phone with a modern browser. Any USB barcode scanner. Any receipt printer the computer can print to (58 or 80 mm). No special till hardware. |
| *Cash drawer?* | Drawers that open from the receipt printer work through the printer's driver settings; there is no separate drawer integration. |
| *Is it fiscalised / ZIMRA compliant?* | Not yet: fiscal-device integration needs the business's own tax credentials and device. It is on the roadmap. Receipts carry the tax number. |
| *Multiple currencies?* | Prices and reports are in one currency (USD) today; a second currency is on the roadmap. |
| *Can we import our items and stock?* | Yes — opening stock is pasted straight from a spreadsheet; items can be added in bulk or at the till. |
| *Can staff steal?* | Nothing can be deleted or edited; shortages are named per shift; price changes, below-zero sales and unknown scans are all exceptions. |
| *Who can see profit?* | Only people whose role (or personal access) includes it. Cashiers never see costs. |
| *Where is our data?* | In a managed PostgreSQL database in the cloud, with the application on Vercel. Access is over HTTPS only. |
| *Can it connect to our accounting system / website?* | Everything the screens do goes through an API ([chapter 12](12-api-reference.md)); integrations are built on it. |

## Talking points that land

- **"Nothing is ever deleted."** Show that a posted sale or delivery has no edit button — and that the database would refuse even if it did.
- **"Every shortage has a name."** The shift report with a named cashier is usually the moment owners lean forward.
- **"Numbers that prove themselves."** The stock reconciliation closing to stock on hand, and the Z reports adding up to every sale.
- **"Built for how you actually work."** Supplier price lists pasted from e-mail; opening stock from Excel; the till on any laptop.

## After the demo

Send the link to this guide, a one-page summary of their three problems and how each is solved, and propose a **pilot at one branch** for two weeks: set up the branch, import items and opening stock, train the cashiers in an hour, and compare the first Z reports with their current system.
