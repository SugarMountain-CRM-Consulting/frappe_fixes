# frappe_fixes

A Frappe app that patches upstream Frappe bugs while waiting for official fixes.

Each fix is isolated, documented with a root-cause analysis, and removed as
soon as the upstream version ships the fix.

---

## Fix 1: Chrome PDF header race condition (`asyncio.InvalidStateError`)

### Symptom

Generating a PDF via Chrome (`pdf_generator=chrome`) raises a 500 error for
some doctypes but works fine for others (e.g. Sales Invoice with QR code):

```
asyncio.exceptions.InvalidStateError: Result is not set
  File "frappe/utils/pdf_generator/page.py", line 320, in get_pdf_stream_id
    future = task.result()
```

### Root cause

Frappe's Chrome PDF generator renders the **letter head** and the **document
body** as separate Chrome tabs and merges them into one PDF. To maximise
throughput it kicks off the header PDF generation asynchronously while the body
page is still loading:

```
[browser.py]
try_async_header_footer_pdf()          # 1. sends Page.printToPDF to Chrome (non-blocking)
body_page.wait_for_set_content()       # 2. wait for body page load event
body_pdf = body_page.generate_pdf()    # 3. generate body PDF (blocking)
header_pdf = get_pdf_from_stream(      # 4. now read the async header result
    get_pdf_stream_id()
)
```

The async send (`step 1`) goes through two layers of futures:

```python
# cdp_connection.py — send() with return_future=True
self.wait_for_pdf = asyncio.ensure_future(
    _send(..., wait_future_fulfill=False)   # outer Task
)

# _send() — returns immediately after sending the WebSocket message
async def _send(..., wait_future_fulfill=False):
    inner_future = asyncio.Future()          # fulfilled when Chrome responds
    pending_messages[message_id] = inner_future
    await connection.send(message)
    return inner_future                      # does NOT await inner_future
```

`get_pdf_stream_id()` in the buggy version:

```python
def get_pdf_stream_id(self):
    self.session.wait_for_event(self.wait_for_pdf)  # waits for outer Task ✓
    task = self.wait_for_pdf.result()               # gets inner_future
    future = task.result()                          # BUG: inner_future not fulfilled yet
    return future["result"]["stream"]
```

`wait_for_event` only waits for the **outer Task** (i.e. the moment the
WebSocket message was sent), **not** for Chrome to respond with the rendered
PDF.

**Why it works for Sales Invoice:** the QR Rechnung print format embeds an
external image (`https://qrgen.sugarmountain.ch/...`). Chrome must fetch that
image before the body page fires its `load` event, adding ~300–500 ms. That
window is enough for Chrome to finish generating the header PDF.

**Why it fails for other doctypes:** print formats without external resources
(only local `/files/` images, which are served inline by Frappe's CDP
interceptor) cause the body `load` event to fire in milliseconds — before
Chrome has returned the header PDF — triggering `InvalidStateError`.

### The fix

`get_pdf_stream_id()` needs a second `wait_for_event` call for the **inner
future** (Chrome's actual `Page.printToPDF` response):

```python
# frappe/utils/pdf_generator/page.py  (upstream fix: 1 line added)
def get_pdf_stream_id(self):
    self.session.wait_for_event(self.wait_for_pdf)   # wait for outer Task
    task = self.wait_for_pdf.result()
    self.session.wait_for_event(task, timeout=30)    # ← wait for Chrome response
    future = task.result()
    return future["result"]["stream"]
```

### How this app applies the fix without touching core files

Frappe's `override_whitelisted_methods` hook lets an app replace any
whitelisted API endpoint without touching core files. This app replaces
`frappe.utils.print_format.download_pdf` with a wrapper that monkey-patches
`Page.get_pdf_stream_id` once (guarded by a flag so it runs only on the first
call per worker process) and then delegates to the original function.

```
hooks.py
  override_whitelisted_methods = {
      "frappe.utils.print_format.download_pdf":
          "frappe_fixes.utils.pdf.download_pdf"
  }

utils/pdf.py
  download_pdf()              ← @frappe.whitelist(allow_guest=True), mirrors original signature
    _apply_chrome_pdf_patch() ← patches Page.get_pdf_stream_id once per worker
    _original(...)            ← calls frappe's download_pdf directly
```

The monkey-patch is applied lazily inside the request context (not at module
import time) so Frappe is fully initialised when it runs.

### Removing this fix once upstream ships it

```bash
bench --site <site> uninstall-app frappe_fixes
```

---

## Installation

```bash
bench get-app https://github.com/sugarmountain/frappe_fixes
bench --site <your-site> install-app frappe_fixes
bench --site <your-site> migrate
```

## Compatibility

Tested against Frappe **v16** (`version-16` branch). The race condition exists
in the Chrome PDF generator introduced in that version.
