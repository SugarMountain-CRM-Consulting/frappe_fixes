// Fix: notification bell dot indicator broken in Frappe v16 after sidebar redesign.
//
// Root causes in frappe/public/js/frappe/ui/notifications/notifications.js:
//   1. .notifications-icon selector finds nothing — class absent from new HTML
//   2. .notifications-seen/.notifications-unseen child elements never in DOM
//   3. show.bs.dropdown event never fires on sidebar (uses .toggleClass("hidden"),
//      not a Bootstrap dropdown)
//
// Strategy: extend frappe.ui.Notifications and patch the NotificationsView instance
// right after make() runs, before the async notifications fetch resolves.
// This means our overridden toggle_notification_icon is in place when the fetch
// callback fires and calls it for the initial unseen state.

(function () {
	const _OriginalNotifications = frappe.ui.Notifications;

	frappe.ui.Notifications = class extends _OriginalNotifications {
		make() {
			super.make();
			this._fix_notification_bell();
		}

		_fix_notification_bell() {
			const view = this.tabs && this.tabs.notifications;
			if (!view) return;

			// Fix 1: resolve the actual bell icon container for both locations.
			//
			// /desk page: the bell <button> is inside .dropdown-notifications and
			// should carry class "desktop-notification-icon" (added in upstream fix
			// commit c5aa51a7e6 — not yet released as of v16.18.2, so fall back to
			// the button[data-toggle] selector for now).
			//
			// Workspace sidebar: the icon <span> is outside .dropdown-notifications,
			// reached via .closest(".body-sidebar").
			let bell = this.dropdown.find(".desktop-notification-icon");
			if (!bell.length) {
				bell = this.dropdown.find("button[data-toggle='dropdown']");
				// Ensure v16.18.2 CSS (.desktop-notification-icon.indicator::before)
				// applies — the class is absent from desktop.html in this release.
				if (bell.length) bell.addClass("desktop-notification-icon");
			}
			if (!bell.length) {
				bell = this.dropdown
					.closest(".body-sidebar")
					?.find(".sidebar-notification .sidebar-item-icon");
			}
			view.bell_indicator = bell;

			// Fix 2: override toggle_notification_icon to add/remove the standard
			// Frappe "indicator blue" CSS class instead of toggling the missing
			// .notifications-seen / .notifications-unseen child elements.
			view.toggle_notification_icon = function (seen) {
				view.bell_indicator?.toggleClass("indicator blue", !seen);
			};

			// Patch toggle_seen to update boot data synchronously so that lazily-
			// initialised bells (e.g. navigating to /desk after clearing via sidebar)
			// read the correct seen state before the async server call returns.
			const _origToggleSeen = view.toggle_seen.bind(view);
			view.toggle_seen = function (flag) {
				frappe.boot.notification_settings = frappe.boot.notification_settings || {};
				frappe.boot.notification_settings.seen = flag ? 1 : 0;
				_origToggleSeen(flag);
			};

			// Same-page sync: clear dot on this view whenever any bell is opened,
			// even when socket.io is unavailable (e.g. local dev without a socket server).
			$(document).on("notification_indicator_hide.notification_fix", () => {
				view.toggle_notification_icon(true);
			});

			// Fix 3a: sidebar never emits show.bs.dropdown — add a click listener on
			// the bell button so opening the panel clears the dot there too.
			if (!this.dropdown.find("[data-toggle='dropdown']").length) {
				$(".standard-items-sections .sidebar-notification").on(
					"click.notification_seen",
					function () {
						view.toggle_seen(true);
						if (view.bell_indicator?.hasClass("indicator")) {
							view.toggle_notification_icon(true);
							$(document).trigger("notification_indicator_hide");
							frappe.call(
								"frappe.desk.doctype.notification_log.notification_log.trigger_indicator_hide"
							);
						}
					}
				);
			}

			// Fix 3b: /desk Bootstrap dropdown does emit show.bs.dropdown, but the
			// original handler's clearing condition (.notifications-unseen visible) is
			// always false in v16. Add our own handler with the correct check.
			if (this.dropdown.find("[data-toggle='dropdown']").length) {
				this.dropdown.on("show.bs.dropdown.notification_fix", () => {
					view.toggle_seen(true);
					if (view.bell_indicator?.hasClass("indicator")) {
						view.toggle_notification_icon(true);
						$(document).trigger("notification_indicator_hide");
						frappe.call(
							"frappe.desk.doctype.notification_log.notification_log.trigger_indicator_hide"
						);
					}
				});
			}
		}
	};
})();
