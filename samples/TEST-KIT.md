# Test kit: run Glossa on a real website

Two ready-made tests. Each one has a public website that allows crawling, an old glossary to upload, and a style guide to paste. Everything below goes into the **Run on a website** form.

## Before you start

1. `cp .env.example .env` and add a free key (Google AI Studio for Gemini).
2. Free Gemini keys allow about **5 requests per minute** and **20 requests per day per model**. One test uses about 20–25 calls, so put the drafter and the judge on **different models**. Each model has its own quota, and a separate judge is also more independent:
   ```
   LLM_MODEL=gemini-3.7-flash
   JUDGE_MODEL=gemini-3-flash-preview
   LLM_REASONING_EFFORT=low
   LLM_MIN_GAP_MS=13000
   ```
   Model names change. If a run fails with "model not found", pick another model from the list in Google AI Studio.
3. `node server.mjs`, then open http://localhost:8787.
4. If a run stops on a quota or "high demand" error, click **Retry**. Every finished step is cached, so it resumes where it stopped.

---

## Test A: health information (Critical-heavy)

Public-domain drug information from the US National Library of Medicine. The old glossary comes from the **official Spanish edition of the same pages**, which is written in Latin American Spanish. Many of its entries are therefore wrong for Spain, and the system should catch them.

| Field | Value |
|---|---|
| Website URL | `https://medlineplus.gov/druginfo/meds/a682878.html` |
| Specific pages | `https://medlineplus.gov/druginfo/meds/a682159.html`<br>`https://medlineplus.gov/druginfo/meds/a681004.html`<br>`https://medlineplus.gov/highbloodpressure.html`<br>`https://medlineplus.gov/ency/article/007490.htm` |
| Site name | `MedlinePlus (NIH): drug information` |
| Max pages | `5` |
| Target locale | Spanish (Spain) |
| Sibling locale | Spanish (Mexico) |
| Industry | Healthcare |
| Linguist hours | leave blank |
| Old glossary CSV | upload `samples/test-a-medlineplus/old-glossary.csv` |
| Style guide | paste `samples/test-a-medlineplus/style-guide.txt` |

**What to look for**
- Dosage and safety wording ("Do not take more or less…", "Do not break, crush, or chew") is Critical, so it's always in the queue.
- The Report → Imported glossary section lists disagreements such as *accidente cerebrovascular → ictus*, *tableta masticable → comprimido masticable* and *etiqueta del empaque → etiqueta del envase*. Most of them are in the queue.
- Enforcement preview: translations must keep every hard term; misses are retried.

## Test B: online shop (UI and commerce terms)

A sandbox bookshop built for crawling practice. Its old glossary contains two Latin American entries ("Añadir al carrito", "En existencia") that the Spain style guide rejects.

| Field | Value |
|---|---|
| Website URL | `https://books.toscrape.com/` |
| Specific pages | `https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html`<br>`https://books.toscrape.com/catalogue/sapiens-a-brief-history-of-humankind_996/index.html`<br>`https://books.toscrape.com/catalogue/category/books/travel_2/index.html` |
| Site name | `Books to Scrape (sandbox shop)` |
| Max pages | `6` |
| Target locale | Spanish (Spain) |
| Sibling locale | Spanish (Mexico) |
| Industry | Retail |
| Linguist hours | leave blank |
| Old glossary CSV | upload `samples/test-b-bookshop/old-glossary.csv` |
| Style guide | paste `samples/test-b-bookshop/style-guide.txt` |

**What to look for**
- Buttons and labels (Add to basket, Price (excl. tax), Availability) are High, enforced as hard.
- The demo-site disclaimer is Critical.
- "Add to basket" should be drafted as *Añadir a la cesta*, disagreeing with the imported *Añadir al carrito*.
- Book titles and UPC codes stay as in the source.

## After a run

1. Review a few entries in **Queue**: accept, edit, reject and ask client. Edit a Critical one to see escalation.
2. **Auto-approved**: reopen one to show nothing is hidden.
3. **Publish**: export the glossary as JSON or CSV.
4. **Report**: the numbers to share (pages, terms, what needs review, imported-glossary agreement, enforcement preview, what it learned).
