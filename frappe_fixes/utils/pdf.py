from typing import Literal

import frappe


@frappe.whitelist(allow_guest=True)
def download_pdf(
	doctype: str,
	name: str,
	format=None,
	doc=None,
	no_letterhead=0,
	language=None,
	letterhead=None,
	pdf_generator: Literal["wkhtmltopdf", "chrome"] | None = None,
):
	"""Override of frappe.utils.print_format.download_pdf.

	Applies a fix for a race condition in Chrome PDF header generation before
	delegating to the original implementation.

	Bug: get_pdf_stream_id() only waits for the CDP WebSocket send to complete,
	not for Chrome's Page.printToPDF response. On pages without external
	resources the body loads in milliseconds and the inner future hasn't been
	fulfilled yet, causing asyncio.InvalidStateError.
	"""
	_apply_chrome_pdf_patch()

	from frappe.utils.print_format import download_pdf as _original

	return _original(
		doctype=doctype,
		name=name,
		format=format,
		doc=doc,
		no_letterhead=no_letterhead,
		language=language,
		letterhead=letterhead,
		pdf_generator=pdf_generator,
	)


def _apply_chrome_pdf_patch():
	from frappe.utils.pdf_generator.page import Page

	if getattr(Page, "_patched_by_frappe_fixes", False):
		return

	def _fixed_get_pdf_stream_id(self):
		self.session.wait_for_event(self.wait_for_pdf)
		task = self.wait_for_pdf.result()
		self.session.wait_for_event(task, timeout=30)
		return task.result()["result"]["stream"]

	Page.get_pdf_stream_id = _fixed_get_pdf_stream_id
	Page._patched_by_frappe_fixes = True
