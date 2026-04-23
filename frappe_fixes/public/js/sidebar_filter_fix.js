// Fix for https://github.com/frappe/frappe/issues/38838
// generate_route() calls encodeURIComponent() on route_options values. When a
// value is an array (e.g. ["like", "%Admin%"]), JS coerces it via .toString()
// to "like,%Admin%", losing the operator/value split. Pre-converting arrays to
// JSON strings fixes this; parse_filters_from_route_options already handles
// JSON array strings (checks value.startsWith("[")).
frappe.utils.generate_route = (function (_original) {
	return function (item) {
		if (item && item.route_options) {
			item = Object.assign({}, item);
			item.route_options = Object.fromEntries(
				Object.entries(item.route_options).map(([k, v]) => [
					k,
					Array.isArray(v) ? JSON.stringify(v) : v,
				])
			);
		}
		return _original.call(this, item);
	};
})(frappe.utils.generate_route);
