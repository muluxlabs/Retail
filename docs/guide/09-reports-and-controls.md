# 9. Reports and controls

## The overview

**Overview** is the first screen for managers and owners: today's trading, stock position and value, what is owed to suppliers, and the exceptions waiting — for the whole group or one branch. It works well on a phone.

![The overview](images/overview.jpg)

## Sales and profit

**Reports › Sales and profit** — for any period (day, week, month, year or your own dates), branch, category, cashier or payment method:

- the **trading account**: sales, discounts, net sales, cost of sales, gross profit and gross margin;
- **this period beside the one before it**;
- a chart by hour, day, week or month, and **time of day**;
- **where the sales and profit come from**: by branch, category, item, cashier, payment method;
- **sales with no cost on record** shown separately, never guessed.

![Sales and profit](images/report-profit.jpg)

**Reports › Sales receipts** lists every receipt; open any one to see or reprint it.

![Sales receipts](images/report-sales.jpg)

## Item analysis

**Reports › Item analysis** — for each item: units sold per week, sell-through, **days of cover** at the current rate of sale, and a status: **Fast**, **Not selling**, **Out of stock**. Open an item for its full sales and stock history. *How these figures are worked out* explains each measure on the page.

![Item analysis](images/report-items.jpg)

## Stock movement

**Reports › Stock movement** — by week, month or year: opening stock, purchases, transfers, sales, adjustments and closing stock, in units and value, reconciling period by period.

![Stock movement](images/report-stock-movement.jpg)

## The exception queue

**Exceptions** lists everything unusual that needs a person to look at it: what happened, where, who did it, when, and what it is worth. Each stays open until someone with the permission **clears** it (with a note), or acknowledges or escalates it. Nothing in the queue can be deleted.

![The exception queue](images/exceptions.jpg)

| Exception | Raised when |
|---|---|
| **Sold below zero** | A sale took stock the records say was not there (authorised override). |
| **Unlisted barcode scanned** | A code not in the item master was scanned and logged. |
| **Product added at the till** | A cashier added a new item; approve it or merge it into an existing one. |
| **Price override** | An item was sold away from its list price, or discounted. |
| **Backdated entry** | Something was recorded long after it happened. |
| **Count variance** | A stock take found a different quantity from the records. |
| **Lost in transit** | Less (or more) arrived than was dispatched. |
| **Cash variance** | A cash count disagreed with the books. |
| **Till over / short on a shift** | A cashier's count at the start or end of a shift differed. |
| **Opening stock introduced** | Stock was brought onto the books at a branch. |
| **Branch stock set to zero** | A branch was started fresh. |
| **Credit limit raised** | A customer was allowed to owe more. |
| **Loyalty points changed by hand** | Points were added or taken away. |
| **Access given beyond a role** | Someone was given a permission their role does not include. |

## The audit trail

Beyond the documents themselves (which cannot be edited), the system keeps an **audit log** of changes to configuration: prices, items, staff, roles and access, settings, credit limits, sign-ins. Each entry records who, when, the value before and after, and — where given — why.

> **Current limitation:** the audit log is recorded in full, but there is not yet a screen to browse it inside the system. Until there is, it is read from the database on request. The changes that matter most day to day — prices overridden, access added, credit limits raised, points adjusted — also appear in the exception queue.

## What cannot happen

These are guaranteed by the database itself, not just by the screens:

- A sale, delivery, return, transfer, count, Z report, price list or payment **cannot be edited or deleted** once posted.
- Stock and cash **ledgers only ever grow**; balances are always their sum.
- Document numbers (receipts, GRNs, Z reports…) have **no gaps**.
- The same sale sent twice (a dropped connection, a double click) is **recorded once**.
