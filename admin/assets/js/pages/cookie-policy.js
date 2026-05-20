/**
 * Admin JS — Cookie Policy generator (Spec 002 FR-02 + US-05).
 *
 * DOM-safe construction (createElement + textContent + appendChild) for
 * all dynamic content. No innerHTML for user input or API responses.
 * Preview HTML is server-rendered through wp_kses_post() at the Renderer
 * boundary — we still treat it as trusted-but-sanitized and write via a
 * sandbox iframe so any future regression cannot escape the preview modal.
 */
(function () {
	'use strict';

	var root = document.getElementById('faz-cookie-policy-app');
	if (!root) { return; }

	var REST_URL   = root.dataset.fazRestUrl || '';
	var REST_NONCE = root.dataset.fazRestNonce || '';

	function api(method, path, body) {
		var FAZ = window.FAZ;
		var verb = String(method || 'GET').toUpperCase();
		if (FAZ && typeof FAZ.api === 'function') {
			switch (verb) {
				case 'GET':  return FAZ.get('cookie-policy/' + path);
				case 'POST': return FAZ.post('cookie-policy/' + path, body || {});
			}
		}
		return fetch(REST_URL + path, {
			method:      verb,
			credentials: 'same-origin',
			headers:     { 'X-WP-Nonce': REST_NONCE, 'Content-Type': 'application/json' },
			body:        body ? JSON.stringify(body) : undefined
		}).then(function (r) {
			if (!r.ok) {
				return r.json().then(function (j) { throw new Error(j.message || 'HTTP ' + r.status); });
			}
			return r.json();
		});
	}

	// ---------- form ↔ settings serialization ----------

	// Dot-path setter: setDeep(obj, "company.name", "ACME")
	function setDeep(obj, path, value) {
		var parts = path.split('.');
		var cur = obj;
		for (var i = 0; i < parts.length - 1; i++) {
			if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
				cur[parts[i]] = {};
			}
			cur = cur[parts[i]];
		}
		cur[parts[parts.length - 1]] = value;
	}

	function getDeep(obj, path, fallback) {
		var parts = path.split('.');
		var cur = obj;
		for (var i = 0; i < parts.length; i++) {
			if (cur === null || typeof cur !== 'object') { return fallback; }
			cur = cur[parts[i]];
		}
		return (cur === undefined || cur === null) ? fallback : cur;
	}

	function readForm() {
		var form = document.getElementById('faz-cookie-policy-form');
		var out = {
			third_party_services: []
		};
		// Plain inputs / selects / textareas with name="X.Y"
		form.querySelectorAll('input[name],select[name],textarea[name]').forEach(function (el) {
			if (el.id === 'cp-services-list') { return; }
			var name = el.name;
			if (el.type === 'checkbox') {
				// Service checkboxes use name="third_party_services[]" effectively, value=svc id
				if (el.dataset.serviceId) {
					if (el.checked) { out.third_party_services.push(el.dataset.serviceId); }
					return;
				}
			}
			var v = el.value;
			if (el.type === 'number') { v = parseInt(v, 10); if (isNaN(v)) { v = 0; } }
			setDeep(out, name, v);
		});
		return out;
	}

	function writeForm(settings) {
		// Scalar fields.
		[
			'company.name', 'company.address', 'company.email', 'company.registry',
			'dpo.name', 'dpo.email',
			'jurisdiction', 'retention_months', 'privacy_policy_url', 'default_lang'
		].forEach(function (path) {
			var el = document.querySelector('[name="' + path + '"]');
			if (el) {
				var v = getDeep(settings, path, '');
				el.value = v;
			}
		});
		// Service checkboxes.
		var services = settings.third_party_services || [];
		document.querySelectorAll('#cp-services-list input[type=checkbox]').forEach(function (cb) {
			cb.checked = services.indexOf(cb.dataset.serviceId) !== -1;
		});
	}

	// ---------- services list (renders the checkboxes) ----------

	function renderServicesList() {
		var container = document.getElementById('cp-services-list');
		if (!container) { return; }
		while (container.firstChild) { container.removeChild(container.firstChild); }
		var services = [
			{ id: 'ga4',       label: 'Google Analytics 4' },
			{ id: 'gtm',       label: 'Google Tag Manager' },
			{ id: 'meta',      label: 'Meta (Facebook) Pixel' },
			{ id: 'tiktok',    label: 'TikTok Pixel' },
			{ id: 'linkedin',  label: 'LinkedIn Insight Tag' },
			{ id: 'msuet',     label: 'Microsoft UET' },
			{ id: 'clarity',   label: 'Microsoft Clarity' },
			{ id: 'cf',        label: 'Cloudflare' },
			{ id: 'recaptcha', label: 'Google reCAPTCHA' },
			{ id: 'hotjar',    label: 'Hotjar' }
		];
		services.forEach(function (svc) {
			var label = document.createElement('label');
			label.style.display = 'inline-block';
			label.style.marginRight = '14px';
			label.style.marginBottom = '6px';
			var cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.dataset.serviceId = svc.id;
			label.appendChild(cb);
			label.appendChild(document.createTextNode(' ' + svc.label));
			container.appendChild(label);
		});
	}

	// ---------- preview modal ----------

	function showPreview(html) {
		var modal = document.getElementById('cp-preview-modal');
		var content = document.getElementById('cp-preview-content');
		// Use a sandboxed iframe so the preview HTML cannot reach back into the admin page.
		while (content.firstChild) { content.removeChild(content.firstChild); }
		var iframe = document.createElement('iframe');
		iframe.style.cssText = 'width:100%; height:70vh; border:1px solid #ccd0d4; background:#fff;';
		iframe.setAttribute('sandbox', 'allow-same-origin'); // no scripts, no top navigation
		content.appendChild(iframe);
		// Render after attach so contentWindow exists.
		setTimeout(function () {
			var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
			if (!doc) { return; }
			doc.open();
			doc.write('<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; padding:18px; line-height:1.55;} .faz-cookie-policy-disclaimer{margin-top:24px;padding:12px 14px;background:#fff5d6;border-left:3px solid #d4a017;font-size:13px;}</style></head><body>' + html + '</body></html>');
			doc.close();
		}, 0);
		modal.hidden = false;
	}

	function hidePreview() {
		document.getElementById('cp-preview-modal').hidden = true;
	}

	// ---------- wire-up ----------

	function setStatus(msg, kind) {
		var el = document.getElementById('cp-save-status');
		if (!el) { return; }
		el.textContent = msg || '';
		el.style.color = kind === 'error' ? '#c4302b' : (kind === 'ok' ? '#1d7d28' : '');
		if (msg && kind === 'ok') {
			setTimeout(function () { el.textContent = ''; }, 3000);
		}
	}

	function init() {
		renderServicesList();

		api('GET', 'settings')
			.then(function (data) { writeForm(data); })
			.catch(function (err) { setStatus('Load failed: ' + err.message, 'error'); });

		document.getElementById('faz-cookie-policy-form').addEventListener('submit', function (e) {
			e.preventDefault();
			var payload = readForm();
			setStatus('Saving...', '');
			api('POST', 'settings', payload)
				.then(function () { setStatus('Saved.', 'ok'); })
				.catch(function (err) { setStatus('Save failed: ' + err.message, 'error'); });
		});

		document.getElementById('cp-preview-btn').addEventListener('click', function () {
			var payload = readForm();
			api('POST', 'preview', { settings: payload, lang: payload.default_lang || '', jurisdiction: payload.jurisdiction || '' })
				.then(function (resp) { showPreview(resp.html || ''); })
				.catch(function (err) { setStatus('Preview failed: ' + err.message, 'error'); });
		});

		var modal = document.getElementById('cp-preview-modal');
		modal.querySelector('.faz-cp-modal-close').addEventListener('click', hidePreview);
		modal.addEventListener('click', function (e) {
			if (e.target === modal) { hidePreview(); }
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && !modal.hidden) { hidePreview(); }
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
