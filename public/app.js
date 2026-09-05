(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const form = byId('lookup-form');
  const input = byId('ip');
  const result = byId('result');
  const message = byId('lookup-message');
  let lookupController;
  let lookupSequence = 0;
  let statusController;
  let statusSequence = 0;
  let rawJSON = '';

  function row(list, label, value) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value ?? 'Not available';
    group.append(term, definition);
    list.append(group);
  }

  function displayValue(value) {
    if (value === null || value === undefined) return 'Not available';
    if (value === '') return '"" (empty string)';
    return String(value);
  }

  // Inspect arbitrary JSON without an allowlist. Nested objects are built on
  // expansion, so deeply nested future records do not block the initial render.
  function inspectValue(label, value, path) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const collection = value !== null && typeof value === 'object';
    const entries = collection ? Object.entries(value) : [];
    const kind = Array.isArray(value) ? 'array' : 'object';
    summary.textContent = collection
      ? `${label} — ${kind}, ${entries.length} ${Array.isArray(value) ? 'items' : 'fields'}`
      : `${label} — ${displayValue(value)}`;
    summary.title = path;
    details.append(summary);
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      rendered = true;
      if (!collection || entries.length === 0) {
        const text = document.createElement('p');
        text.className = 'small muted';
        text.textContent = collection ? `Empty ${kind}: ${Array.isArray(value) ? '[]' : '{}'}` : displayValue(value);
        details.append(text);
        return;
      }
      const list = document.createElement('dl');
      list.className = 'field-list';
      for (const [key, child] of entries) {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        const definition = document.createElement('dd');
        const childPath = `${path}[${JSON.stringify(key)}]`;
        term.textContent = Array.isArray(value) ? `[${key}]` : (key || '"" (empty key)');
        term.title = childPath;
        if (child !== null && typeof child === 'object') {
          definition.append(inspectValue(key, child, childPath));
        } else {
          const content = document.createElement('span');
          content.className = 'field-value';
          content.textContent = displayValue(child);
          const type = document.createElement('span');
          type.className = 'field-type';
          type.textContent = ` (${child === null ? 'null' : typeof child})`;
          definition.append(content, type);
        }
        group.append(term, definition);
        list.append(group);
      }
      details.append(list);
    });
    return details;
  }

  function renderRecords(records) {
    const inspector = byId('record-inspector');
    inspector.replaceChildren();
    const labels = { country: 'GeoLite2 Country', city: 'GeoLite2 City', asn: 'GeoLite2 ASN' };
    for (const [key, record] of Object.entries(records)) {
      const label = Object.hasOwn(labels, key) ? labels[key] : key;
      inspector.append(inspectValue(label, record, `records[${JSON.stringify(key)}]`));
    }
  }

  function placeName(place) {
    const names = place?.names;
    if (typeof names?.en === 'string' && names.en) return names.en;
    if (names && typeof names === 'object') {
      const name = Object.values(names).find((value) => typeof value === 'string' && value);
      if (name) return name;
    }
    return place?.iso_code ?? place?.code ?? null;
  }

  function measurement(value, unit) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value}${unit}` : null;
  }

  function validDatabase(database) {
    return database && typeof database.version === 'string' &&
      typeof database.updatedAt === 'string' && Array.isArray(database.sources) &&
      database.sources.every((source) => source && typeof source.name === 'string' &&
        typeof source.url === 'string' && typeof source.license === 'string');
  }

  function validLookup(data) {
    const nullableString = (value) => value === null || typeof value === 'string';
    return data && typeof data.ip === 'string' && [4, 6].includes(data.version) &&
      (data.country === null || (data.country && typeof data.country.name === 'string' && typeof data.country.code === 'string')) &&
      (data.asn === null || (data.asn && Number.isSafeInteger(data.asn.number) && typeof data.asn.name === 'string')) &&
      data.network && nullableString(data.network.country) && nullableString(data.network.asn) &&
      nullableString(data.network.city) && data.records &&
      ['country', 'city', 'asn'].every((key) => data.records[key] === null ||
        (typeof data.records[key] === 'object' && !Array.isArray(data.records[key]))) && validDatabase(data.database);
  }

  async function request(path, controller) {
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error(`The service returned an unreadable response (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        const apiError = data?.error;
        if (typeof apiError?.message === 'string') {
          const code = typeof apiError.code === 'string' ? `${apiError.code}: ` : '';
          throw new Error(`${code}${apiError.message}`);
        }
        throw new Error(`Request failed (HTTP ${response.status}). Please try again.`);
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The request timed out. Please try again.');
      if (error instanceof TypeError) throw new Error('Could not reach the service. Check your connection and try again.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookup(ip) {
    const sequence = ++lookupSequence;
    lookupController?.abort();
    lookupController = new AbortController();
    result.hidden = true;
    result.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    rawJSON = '';
    byId('raw-json').textContent = '';
    byId('copy-message').textContent = '';
    byId('raw-details').open = false;
    input.removeAttribute('aria-invalid');
    message.dataset.error = 'false';
    message.textContent = ip ? `Looking up ${ip}…` : 'Looking up your public IP address…';
    try {
      const path = ip ? `/api/lookup?${new URLSearchParams({ ip })}` : '/api/lookup';
      const data = await request(path, lookupController);
      if (sequence !== lookupSequence) return;
      if (!validLookup(data)) throw new Error('The service returned an unexpected lookup response. Please try again.');
      const list = byId('result-list');
      list.replaceChildren();
      row(list, 'IP address', data.ip);
      row(list, 'Address family', `IPv${data.version}`);
      row(list, 'Country', data.country ? `${data.country.name} (${data.country.code})` : null);
      row(list, 'ASN', data.asn ? `AS${data.asn.number}` : null);
      row(list, 'AS name', data.asn?.name);
      const cityRecord = data.records.city;
      row(list, 'Continent', placeName(cityRecord?.continent));
      row(list, 'City (approx.)', placeName(cityRecord?.city));
      const regions = Array.isArray(cityRecord?.subdivisions)
        ? cityRecord.subdivisions.map(placeName).map((name) => name ?? 'Not available')
        : [];
      row(list, 'Region(s)', regions.length ? regions.join(' / ') : null);
      row(list, 'Postal code', cityRecord?.postal?.code);
      row(list, 'Time zone', cityRecord?.location?.time_zone);
      row(list, 'Latitude (approx.)', measurement(cityRecord?.location?.latitude, '°'));
      row(list, 'Longitude (approx.)', measurement(cityRecord?.location?.longitude, '°'));
      row(list, 'Accuracy radius', measurement(cityRecord?.location?.accuracy_radius, ' km'));
      row(list, 'Country network', data.network.country);
      row(list, 'City network', data.network.city);
      row(list, 'ASN network', data.network.asn);
      row(list, 'Database version', data.database.version);
      row(list, 'Database updated', data.database.updatedAt);
      renderRecords(data.records);
      rawJSON = JSON.stringify(data, null, 2);
      byId('raw-json').textContent = rawJSON;
      result.hidden = false;
      message.textContent = `Lookup complete for ${data.ip}.` + (data.database.stale ? ' Database refresh failed; using the last validated version.' : '');
    } catch (error) {
      if (sequence !== lookupSequence) return;
      message.dataset.error = 'true';
      message.textContent = `Lookup failed. ${error.message}`;
    } finally {
      if (sequence === lookupSequence) {
        result.setAttribute('aria-busy', 'false');
        form.setAttribute('aria-busy', 'false');
      }
    }
  }

  function rejectEmptyInput() {
    ++lookupSequence;
    lookupController?.abort();
    result.hidden = true;
    result.setAttribute('aria-busy', 'false');
    form.setAttribute('aria-busy', 'false');
    rawJSON = '';
    byId('raw-json').textContent = '';
    byId('copy-message').textContent = '';
    input.setAttribute('aria-invalid', 'true');
    message.dataset.error = 'true';
    message.textContent = 'Enter a public IPv4 or IPv6 address, or choose “Use my IP”.';
    input.focus();
  }
  // Native required validation precedes submit; cancel pending requests there too.
  input.addEventListener('invalid', () => {
    if (!input.value.trim()) rejectEmptyInput();
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const ip = input.value.trim();
    if (!ip) {
      rejectEmptyInput();
      return;
    }
    // The API validates the address and public-address restrictions authoritatively.
    lookup(ip);
  });
  byId('own-ip').addEventListener('click', () => lookup());

  byId('copy-json').addEventListener('click', async () => {
    if (!rawJSON) return;
    const sequence = lookupSequence;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(rawJSON);
      if (sequence === lookupSequence) byId('copy-message').textContent = 'JSON copied.';
    } catch {
      if (sequence === lookupSequence) byId('copy-message').textContent = 'Copy unavailable. Select and copy the JSON above manually.';
    }
  });

  async function refreshStatus() {
    const sequence = ++statusSequence;
    statusController?.abort();
    statusController = new AbortController();
    const statusMessage = byId('database-message');
    const list = byId('database-list');
    const sources = byId('database-sources');
    const refresh = byId('refresh-status');
    refresh.disabled = true;
    list.replaceChildren();
    sources.replaceChildren();
    statusMessage.textContent = 'Checking database availability…';
    try {
      const data = await request('/api/status', statusController);
      if (sequence !== statusSequence) return;
      if (!['ok', 'degraded'].includes(data?.status) || !validDatabase(data.database)) throw new Error('The service returned an unexpected status response.');
      row(list, 'Version', data.database.version);
      row(list, 'Updated', data.database.updatedAt);
      for (const source of data.database.sources) {
        const item = document.createElement('li');
        let url;
        try { url = new URL(source.url); } catch { /* Render invalid URLs as text. */ }
        if (url && ['https:', 'http:'].includes(url.protocol)) {
          const link = document.createElement('a');
          link.href = url.href;
          link.rel = 'external noreferrer';
          link.textContent = source.name;
          item.append(link);
        } else {
          item.append(document.createTextNode(source.name));
        }
        item.append(document.createTextNode(` — ${source.license}`));
        sources.append(item);
      }
      statusMessage.textContent = data.database.stale
        ? 'Database available. Last refresh failed; using the last validated version.'
        : data.status === 'degraded' ? 'Database available with degraded status.' : 'Database available.';
    } catch (error) {
      if (sequence === statusSequence) statusMessage.textContent = `Database status unavailable. ${error.message}`;
    } finally {
      if (sequence === statusSequence) refresh.disabled = false;
    }
  }
  byId('refresh-status').addEventListener('click', refreshStatus);

  const origin = window.location.origin;
  byId('api-ipv4').textContent = `GET ${origin}/api/lookup?ip=1.1.1.1`;
  byId('api-ipv6').textContent = `GET ${origin}/api/lookup?ip=2606%3A4700%3A4700%3A%3A1111`;
  byId('api-other').textContent = `GET ${origin}/api/lookup\nGET ${origin}/api/status`;
  // Status checks carry no lookup query. Visitor lookup is always an explicit action.
  refreshStatus();
})();
