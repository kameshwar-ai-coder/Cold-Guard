const API_URL = 'http://127.0.0.1:8000';
const temperatureRanges = Array.from({ length: 36 }, (_, index) => ({ min: index + 2, max: index + 5, label: `${index + 2}°C — ${index + 5}°C` }));
const savedRange = JSON.parse(localStorage.getItem('coldguard-temperature-range') || 'null');
const PREDICTION_ALERT_WINDOW_MINUTES = 15;
const SAFE_MIN = 2;
const SAFE_MAX = 8;
const savedName = localStorage.getItem('coldguard-user-name') || '';
const createLocationSearchState = () => ({ query: '', results: [], selected: null, message: '' });
const state = { role: null, name: savedName, userId: null, authToken: localStorage.getItem('coldguard-auth-token') || '', authMode: 'login', page: 'dashboard', readings: [], apiOnline: false, detailsOpen: false, expandedHistory: null, selectedDevice: null, completedDevices: {}, shipments: [], pharmacyUsers: [], pharmacyUsersLoaded: false, pharmacyUsersError: '', pharmacySearch: { query: '', selectedUserId: null, isOpen: false }, mapShipmentId: null, shipmentSearch: { origin: createLocationSearchState(), destination: createLocationSearchState() }, riskByDevice: {}, soundEnabled: localStorage.getItem('coldguard-sound-enabled') === 'true', lastAlertKey: 'unknown', alertTimer: null, temperatureRange: savedRange || { min: 4, max: 7 } };
const transportNav = [['dashboard', '▦', 'Dashboard'], ['all', '≡', 'All shipments'], ['current', '◉', 'Current shipment'], ['pending', '◷', 'Pending shipments'], ['add-shipment', '+', 'Add shipment'], ['completed', '✓', 'Completed shipments']];
const pharmacyNav = [['dashboard', '▦', 'Dashboard'], ['current', '◉', 'Current shipment'], ['history', '↺', 'Past shipment history']];
state.mlPrediction = null;
state.predictionHorizon = 30;

const $ = selector => document.querySelector(selector);
const formatTemp = value => value == null ? '--' : `${Number(value).toFixed(1)}°C`;
const formatTime = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
const devices = () => [...new Set(state.readings.map(item => item.device_id))];
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const placeLabel = properties => [...new Set([properties.name || properties.street, properties.district || properties.city || properties.county, properties.state, properties.country].filter(Boolean))].join(', ');
function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.authToken) headers.set('Authorization', `Bearer ${state.authToken}`);
  return fetch(`${API_URL}${path}`, { ...options, headers });
}
const currentDevice = () => {
  if (state.selectedDevice) return state.selectedDevice;
  const availableDevices = devices();
  const esp32 = availableDevices.find(device => device.toLowerCase().includes('esp32'));
  if (availableDevices.length === 1) return availableDevices[0];
  return esp32 && !state.completedDevices[esp32] ? esp32 : availableDevices.find(device => !state.completedDevices[device]);
};
const readingsFor = device => state.readings.filter(item => item.device_id === device);
const pendingShipments = () => state.shipments.filter(shipment => shipment.status === 'pending');
const currentShipment = () => pendingShipments()[0] || null;
const activeReadings = () => readingsFor(currentDevice());
const latest = () => activeReadings()[0];
const getRisk = readings => {
  if (!readings.length) return { key: 'safe', label: 'Safe', detail: 'No active sensor readings.' };
  const device = readings[0].device_id || currentDevice();
  const previous = state.riskByDevice[device];
  const outside = readings.some(item => item.temperature < safeMin() || item.temperature > safeMax());
  if (outside) {
    state.riskByDevice[device] = 'critical';
    return { key: 'critical', label: 'Critical', detail: 'Temperature excursion detected outside the required range.' };
  }
  if (previous === 'critical') return { key: 'critical', label: 'Critical', detail: 'Temperature excursion detected. Risk remains critical for this shipment.' };
  if (previous === 'warning') return { key: 'warning', label: 'Warning', detail: 'Temperature pattern changed. Risk remains under review for this shipment.' };
  const ordered = [...readings].sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at));
  const movement = ordered.length > 1 ? Math.abs(ordered[ordered.length - 1].temperature - ordered[0].temperature) : 0;
  if (movement >= .1) {
    state.riskByDevice[device] = 'warning';
    return { key: 'warning', label: 'Warning', detail: 'Temperature is moving, but remains within the required range.' };
  }
  return { key: 'safe', label: 'Safe', detail: 'Temperature is stable within the required range.' };
};
const risk = () => getRisk(activeReadings());
const safeMin = () => state.temperatureRange.min;
const safeMax = () => state.temperatureRange.max;
function recentTemperatureTrend(readings = activeReadings()) {
  const ordered = [...readings]
    .sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at))
    .slice(-5);
  if (ordered.length < 3) return { direction: 'insufficient_data', delta: null };
  const delta = ordered.at(-1).temperature - ordered[0].temperature;
  return {
    direction: delta > 0.2 ? 'increasing' : delta < -0.2 ? 'falling' : 'stable',
    delta
  };
}
const rangeLabel = () => `${safeMin()}°C — ${safeMax()}°C`;
function rangeSelector() { return `<label class="range-control"><span>Required range</span><select data-action="temperature-range" aria-label="Select required temperature range">${temperatureRanges.map(range => `<option value="${range.min}-${range.max}" ${range.min === safeMin() && range.max === safeMax() ? 'selected' : ''}>${range.label}</option>`).join('')}</select></label>`; }
function prediction(readings = activeReadings()) {
  if (readings.length < 3) return { key: 'unknown', title: 'Prediction unavailable', detail: 'At least 3 live readings are needed to calculate a temperature trend.' };
  const ordered = [...readings].sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at)).slice(-5);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const elapsedMinutes = (new Date(last.recorded_at) - new Date(first.recorded_at)) / 60000;
  if (elapsedMinutes <= 0) return { key: 'unknown', title: 'Prediction unavailable', detail: 'Reading timestamps are not spaced far enough apart.' };
  const averageTemperature = ordered.reduce((sum, reading) => sum + reading.temperature, 0) / ordered.length;
  const averageTime = ordered.reduce((sum, reading) => sum + new Date(reading.recorded_at).getTime(), 0) / ordered.length;
  const slope = ordered.reduce((sum, reading) => {
    const timeDelta = (new Date(reading.recorded_at).getTime() - averageTime) / 60000;
    return sum + timeDelta * (reading.temperature - averageTemperature);
  }, 0) / ordered.reduce((sum, reading) => {
    const timeDelta = (new Date(reading.recorded_at).getTime() - averageTime) / 60000;
    return sum + timeDelta ** 2;
  }, 0);
  const criticalTemperature = safeMax();
  const outsideRange = last.temperature < safeMin() || last.temperature > safeMax();
  if (outsideRange) return { key: 'critical', urgent: true, title: 'Temperature outside range', detail: `Driver alert: temperature is ${formatTemp(last.temperature)}, outside the selected ${rangeLabel()} range.` };
  if (last.temperature - first.temperature <= .2 || slope <= 0.01) return { key: 'safe', urgent: false, title: 'No rising trend', detail: `Temperature is ${formatTemp(last.temperature)} and is not currently trending toward the critical threshold.` };
  const minutesToCritical = (criticalTemperature - last.temperature) / slope;
  if (!Number.isFinite(minutesToCritical) || minutesToCritical > 60) return { key: 'safe', urgent: false, title: 'Stable for now', detail: `At the current trend, the selected range is not expected to be crossed within the next hour.` };
  const eta = new Date(new Date(last.recorded_at).getTime() + minutesToCritical * 60000);
  const urgent = minutesToCritical <= PREDICTION_ALERT_WINDOW_MINUTES;
  return { key: urgent ? 'critical' : 'warning', urgent, title: urgent ? 'Driver alert: critical soon' : 'Temperature rising', detail: `The recent pattern is rising. At this rate, ${formatTemp(criticalTemperature)} may be reached in about ${Math.max(1, Math.round(minutesToCritical))} minutes, around ${formatTime(eta)}.` };
}
function playAlert(level = 'warning') {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!state.soundEnabled || !AudioContextClass) return;
  const audio = new AudioContextClass();
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = level === 'critical' ? 880 : 660;
  gain.gain.setValueAtTime(.0001, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(.18, audio.currentTime + .02);
  gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .35);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + .36);
  oscillator.addEventListener('ended', () => audio.close());
}
function checkPredictionAlert() {
  if (state.role !== 'transport') {
    if (state.alertTimer) clearInterval(state.alertTimer);
    state.alertTimer = null;
    state.lastAlertKey = 'safe';
    return;
  }
  const forecast = prediction();
  const alertKey = forecast.urgent ? `${currentDevice()}-urgent` : 'safe';
  if (alertKey === 'safe' || !state.soundEnabled) {
    if (state.alertTimer) clearInterval(state.alertTimer);
    state.alertTimer = null;
  } else if (alertKey !== state.lastAlertKey || !state.alertTimer) {
    if (state.alertTimer) clearInterval(state.alertTimer);
    playAlert(forecast.key);
    state.alertTimer = setInterval(() => {
      const nextForecast = prediction();
      if (state.soundEnabled && nextForecast.urgent) playAlert(nextForecast.key);
      else {
        clearInterval(state.alertTimer);
        state.alertTimer = null;
        state.lastAlertKey = 'safe';
      }
    }, 2000);
  }
  state.lastAlertKey = alertKey;
}
const isDelivered = () => Boolean(!currentShipment() && currentDevice() && state.completedDevices[currentDevice()]);
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 4000);
}
async function markDelivered() {
  const shipment = currentShipment();
  if (shipment) {
    try {
      const response = await apiRequest(`/api/shipments/${encodeURIComponent(shipment.id)}/complete`, { method: 'POST' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        showToast(result.detail || 'Unable to complete shipment.');
        return;
      }
      await refreshShipments();
      state.selectedDevice = null;
      state.page = 'current';
      render();
      if (!currentShipment()) showToast('All assigned shipments are complete.');
    } catch (requestError) {
      showToast('Could not reach ColdGuard to complete the shipment.');
    }
    return;
  }
  if (!currentDevice()) return;
  const deliveredDevice = currentDevice();
  state.completedDevices[deliveredDevice] = { deliveredAt: new Date().toISOString(), risk: risk().key };
  localStorage.setItem('coldguard-completed-devices', JSON.stringify(state.completedDevices));
  state.selectedDevice = null;
  state.page = 'current';
  render();
}
function clearCompletedShipments() {
  state.completedDevices = {};
  localStorage.removeItem('coldguard-completed-devices');
}
clearCompletedShipments();
function renderNav() { $('#primary-nav').innerHTML = (state.role === 'transport' ? transportNav : pharmacyNav).map(([id, icon, label]) => `<button class="nav-item ${state.page === id ? 'active' : ''}" data-page="${id}"><span class="nav-icon">${icon}</span>${label}</button>`).join(''); }
function stat(label, value, foot, icon, warning = false) { return `<div class="stat-card"><span class="stat-accent">${icon}</span><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-foot ${warning ? 'warn' : ''}">${foot}</div></div>`; }
function badge(value) { return `<span class="badge ${value.key}">${value.label}</span>`; }
function pageHeader(title, copy) { return `<div class="page-intro"><div><div class="eyebrow">${state.role === 'transport' ? 'Fleet overview' : 'Receiving desk'}</div><h2>${title}</h2><p class="subtle">${copy}</p></div></div>`; }
function noData(message = 'No records are available from the backend yet.') { return `<div class="empty"><strong>No live data</strong><br>${message}</div>`; }
function shipmentMapSection() {
  return `<section class="panel map-panel"><div class="panel-heading"><h3>Shipment route</h3><span class="subtle" id="map-route-status">Road route with estimated truck location</span></div><div id="shipmentMap" role="img" aria-label="Map showing the shipment route and estimated truck location"></div></section>`;
}
function locationResultsMarkup(key) {
  const search = state.shipmentSearch[key];
  const results = search.results.map((place, index) => `<button class="location-result" type="button" role="option" aria-selected="false" data-location-option="${key}" data-place-index="${index}">${escapeHtml(place.label)}</button>`).join('');
  return `${results}${search.message ? `<div class="location-search-message" role="status">${escapeHtml(search.message)}</div>` : ''}`;
}
function shipmentLocationField(key, label) {
  const search = state.shipmentSearch[key];
  const id = `shipment-location-${key}`;
  return `<div class="location-search"><label for="${id}">${label}</label><input id="${id}" name="${key}" type="search" value="${escapeHtml(search.query)}" placeholder="Search city or address" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${search.results.length > 0}" aria-controls="location-results-${key}" data-location-search="${key}" required><div class="location-results" id="location-results-${key}" role="listbox">${locationResultsMarkup(key)}</div></div>`;
}
function pharmacyUserOptionsMarkup() {
  const query = state.pharmacySearch.query.trim().toLocaleLowerCase();
  const users = state.pharmacyUsers.filter(user => `${user.name} ${user.email}`.toLocaleLowerCase().includes(query));
  if (!users.length) return '<div class="location-search-message" role="status">No Pharmacy accounts match.</div>';
  return users.map(user => `<button class="location-result" type="button" role="option" aria-selected="${user.id === state.pharmacySearch.selectedUserId}" data-pharmacy-user-option="${user.id}">${escapeHtml(user.name)} (${escapeHtml(user.email)})</button>`).join('');
}
function pharmacyUserPickerMarkup() {
  const selectedUser = state.pharmacyUsers.find(user => user.id === state.pharmacySearch.selectedUserId);
  const query = selectedUser ? `${selectedUser.name} (${selectedUser.email})` : state.pharmacySearch.query;
  return `<div class="pharmacy-assignee"><label for="pharmacy-user-search">Pharmacy user</label><input id="pharmacy-user-search" type="search" value="${escapeHtml(query)}" placeholder="Search Pharmacy accounts" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${state.pharmacySearch.isOpen}" aria-controls="pharmacy-user-results" data-pharmacy-user-search required><input id="pharmacy-user-id" name="pharmacy_user_id" type="hidden" value="${state.pharmacySearch.selectedUserId || ''}"><div class="location-results pharmacy-user-results ${state.pharmacySearch.isOpen ? 'open' : ''}" id="pharmacy-user-results" role="listbox">${state.pharmacySearch.isOpen ? pharmacyUserOptionsMarkup() : ''}</div></div>`;
}
function renderPharmacyUserPicker() {
  const input = $('#pharmacy-user-search');
  const results = $('#pharmacy-user-results');
  const hiddenId = $('#pharmacy-user-id');
  if (!input || !results || !hiddenId) return;
  const selectedUser = state.pharmacyUsers.find(user => user.id === state.pharmacySearch.selectedUserId);
  const inputValue = selectedUser ? `${selectedUser.name} (${selectedUser.email})` : state.pharmacySearch.query;
  if (input.value !== inputValue) input.value = inputValue;
  input.setAttribute('aria-expanded', String(state.pharmacySearch.isOpen));
  hiddenId.value = selectedUser?.id || '';
  results.classList.toggle('open', state.pharmacySearch.isOpen);
  results.innerHTML = state.pharmacySearch.isOpen ? pharmacyUserOptionsMarkup() : '';
}
function addShipmentPage() {
  const pharmacyHelper = state.pharmacyUsersError ? `<p class="form-error" role="alert">${escapeHtml(state.pharmacyUsersError)}</p>` : state.pharmacyUsersLoaded && !state.pharmacyUsers.length ? '<p class="subtle">Register a Pharmacy account before creating a shipment.</p>' : '';
  return `${pageHeader('Add shipment', 'Choose both locations, select a Pharmacy account, and set the required temperature range.')}<section class="panel shipment-form-panel"><form id="add-shipment-form"><div class="shipment-locations">${shipmentLocationField('origin', 'Starting location')}${shipmentLocationField('destination', 'Destination location')}</div>${pharmacyUserPickerMarkup()}<div id="pharmacy-user-helper">${pharmacyHelper}</div><fieldset class="shipment-range"><legend>Required temperature range</legend><label for="shipment-min">Minimum (°C)<input id="shipment-min" name="min" type="number" min="-40" max="50" value="2" required></label><label for="shipment-max">Maximum (°C)<input id="shipment-max" name="max" type="number" min="-40" max="50" value="8" required></label></fieldset><p class="form-error" id="shipment-form-error" role="alert"></p><button class="button create-shipment-button" type="submit" ${state.pharmacyUsers.length ? '' : 'disabled'}><span aria-hidden="true">+</span> Add new shipment</button></form></section>`;
}
function shipmentDetailPage() {
  const content = detailPage();
  return content + (state.role === 'pharmacy' ? shipmentMapSection() : '');
}
function currentShipmentPage() {
  const shipment = currentShipment();
  if (!shipment) {
    if (!state.shipments.length) return shipmentDetailPage();
    return `${pageHeader('Current shipment', 'All assigned shipments are complete.')}<section class="panel">${noData('There are no shipments waiting in the current queue.')}</section>${shipmentMapSection()}`;
  }
  const current = latest();
  const currentRisk = risk();
  const graph = current ? `<div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div><div class="history-panel">${historyTable()}</div>` : noData('The shipment is current and waiting for its sensor feed.');
  const pharmacyUser = escapeHtml(shipment.pharmacy_user_name || 'Pharmacy');
  return `${pageHeader('Current shipment', `${pharmacyUser} · next in first-in, first-out order.`)}<section class="panel"><div class="panel-heading"><h3>${pharmacyUser}</h3><div class="detail-actions">${badge(currentRisk)}<button class="button" data-action="delivered">Delivered</button></div></div><div class="current-summary shipment-summary"><div><span>Required range</span><strong>${shipment.min}°C — ${shipment.max}°C</strong></div><div><span>Temperature</span><strong>${formatTemp(current?.temperature)}</strong></div><div><span>Queue</span><strong>Current</strong></div></div>${graph}</section>${shipmentMapSection()}`;
}
function pendingPage() {
  const activeShipment = currentShipment();
  const customShipments = pendingShipments().filter(shipment => shipment.id !== activeShipment?.id);
  const pendingDevices = devices().filter(device => !state.completedDevices[device] && device !== currentDevice());
  const customRows = customShipments.map(shipment => `<div class="custom-pending-row"><span>${escapeHtml(shipment.pharmacy_user_name || 'Pharmacy')}</span><span class="temp">${shipment.min}°C — ${shipment.max}°C</span><span class="pending-status">Pending</span></div>`).join('');
  const deviceRows = pendingDevices.map(device => { const readings = readingsFor(device); return `<div class="shipment-row"><span class="shipment-id">${escapeHtml(device)}</span><span>${readings.length}</span><span class="temp">${formatTemp(readings[0]?.temperature)}</span><span>${badge(getRisk(readings))}</span><span>Pending</span></div>`; }).join('');
  return `${pageHeader('Pending shipments', 'These shipments are queued behind the current shipment in first-in, first-out order.')}<section class="panel">${customShipments.length ? `<div class="custom-pending-list"><div class="custom-pending-row custom-pending-head"><span>Pharmacy user</span><span>Required range</span><span>Status</span></div>${customRows}</div>` : ''}${pendingDevices.length ? `<div class="shipment-row header"><span>Device</span><span>Readings</span><span>Latest temperature</span><span>Risk</span><span>Status</span></div>${deviceRows}` : ''}${customShipments.length || pendingDevices.length ? '' : noData('No pending shipments are available.')}</section>`;
}
function dashboard() {
  const current = latest();
  const currentRisk = risk();
  const forecast = prediction();
  const stream = current ? `<div class="shipment-row" style="border:0;padding-top:0"><span class="shipment-id">${current.device_id}</span><span class="medicine"><span class="medicine-image">⌁</span>Sensor device</span><span class="location">Live sensor feed</span><span class="temp">${formatTemp(current.temperature)}</span><span>${badge(currentRisk)}</span></div><div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe range</span></div>` : noData(state.readings.length ? 'All available sensor shipments have been delivered.' : 'Connect a device to see its latest reading.');
  const predictionAlert = state.role === 'transport' ? `<section class="prediction-alert ${forecast.key}"><strong>${forecast.title}</strong><span>${forecast.detail}</span></section>` : '';
  const rangeControls = state.role === 'transport' ? `<div class="transport-tools" id="range-controls-container">${rangeSelector()}</div>` : '';
  const mlSections = state.role === 'transport' ? `${mlPredictionSection()}${routeWeatherSection()}` : '';
  return `${pageHeader(state.role === 'transport' ? `Welcome, ${state.name}` : 'Receiving overview', state.role === 'transport' ? 'Monitor connected devices and shipment conditions.' : 'Review live conditions before accepting a delivery.')} ${rangeControls}<div class="stats-grid">${stat('Sensor readings', state.readings.length, state.apiOnline ? 'From live API' : 'API unavailable', '⌁', !state.apiOnline)}${stat('Current temperature', formatTemp(current?.temperature), current ? `Updated ${formatTime(current.recorded_at)}` : 'No reading', '°')}${stat('Current humidity', current ? `${Number(current.humidity).toFixed(1)}%` : '--', current ? 'From latest reading' : 'No reading', '%')}${stat('Temperature risk', currentRisk.label, currentRisk.detail, '!', currentRisk.key !== 'safe')}</div>${predictionAlert}${mlSections}<div class="grid-main"><section class="panel"><div class="panel-heading"><h3>Live sensor stream</h3><span class="subtle">${state.readings.length} readings</span></div>${stream}</section><section class="panel risk-panel"><div class="panel-heading"><h3>Current risk</h3><span class="subtle">Based on history</span></div><div class="risk-score"><div class="risk-light ${currentRisk.key}">●</div><div><strong>${currentRisk.label}</strong><small>${state.readings.length ? `${state.readings.length} readings analyzed` : 'No readings analyzed'}</small></div></div><div class="risk-meter"><i class="${currentRisk.key === 'safe' ? 'on' : ''}"></i><i class="${currentRisk.key === 'warning' || currentRisk.key === 'critical' ? 'on' : ''}"></i><i class="${currentRisk.key === 'critical' ? 'on' : ''}"></i></div><div class="risk-copy">${currentRisk.detail}</div><div class="mini-detail"><span>Required range</span><strong>${rangeLabel()}</strong></div><div class="mini-detail"><span>Connected device</span><strong>${current?.device_id || 'None'}</strong></div></section></div>${shipmentMapSection()}`;
}
function mlPredictionSection() {
  const result = state.mlPrediction;
  const shipment = currentShipment();
  const routeWeather = result?.route_weather || [];
  const warmest = routeWeather.filter(point => point.forecast_available).sort((left, right) => right.outside_temperature - left.outside_temperature)[0];
  const riskKey = result?.risk?.toLowerCase();
  const mlRiskMarkup = result?.prediction_available ? badge({ key: riskKey, label: result.ml_risk || result.risk }) : 'Unavailable';
  const currentActualRisk = risk();
  const actualRiskMarkup = activeReadings().length
    ? badge(currentActualRisk)
    : 'Insufficient data';
  const predictionNote = result?.prediction_available
    ? result.model_kind === 'sensor_history'
      ? `ML prediction · sensor history only${result.model_evaluation?.r2 < 0 ? ` · experimental (holdout R² ${result.model_evaluation.r2.toFixed(2)})` : ''}`
      : `ML prediction · historical sensor and weather data${result.model_evaluation?.r2 < 0 ? ` · experimental (holdout R² ${result.model_evaluation.r2.toFixed(2)})` : ''}`
    : result?.reason || 'ML model not trained';
  const recentTrend = recentTemperatureTrend();
  const trendLabel = recentTrend.direction === 'increasing'
    ? '↑ Increasing'
    : recentTrend.direction === 'falling'
      ? '↓ Falling'
      : recentTrend.direction === 'stable'
        ? '→ Stable'
        : 'Insufficient data';
  const message = result?.message || 'ML prediction unavailable — using standard risk assessment.';
  const safeMin = result?.safe_min ?? shipment?.min;
  const safeMax = result?.safe_max ?? shipment?.max;
  return `<section class="panel ml-prediction-panel"><div class="panel-heading"><h3>ML Temperature Prediction</h3><label class="horizon-control">Horizon<select data-action="prediction-horizon" aria-label="Prediction horizon"><option value="15" ${state.predictionHorizon === 15 ? 'selected' : ''}>15 min</option><option value="30" ${state.predictionHorizon === 30 ? 'selected' : ''}>30 min</option><option value="60" ${state.predictionHorizon === 60 ? 'selected' : ''}>60 min</option></select></label></div><div class="ml-metrics"><div><span>Actual container</span><strong>${formatTemp(latest()?.temperature)}</strong><small>DHT11 measurement</small></div><div><span>Predicted container</span><strong>${result?.prediction_available ? formatTemp(result.predicted_temperature) : 'Unavailable'}</strong><small>${escapeHtml(predictionNote)}</small></div><div><span>Required range</span><strong>${safeMin != null && safeMax != null ? `${safeMin}–${safeMax}°C` : '--'}</strong><small>Shipment medicine limits</small></div><div><span>Future outside weather</span><strong>${warmest ? formatTemp(warmest.outside_temperature) : '--'}</strong><small>${warmest ? `${escapeHtml(warmest.label)} forecast` : 'Forecast unavailable'}</small></div><div><span>Temperature trend</span><strong>${trendLabel}</strong><small>${recentTrend.delta == null ? 'At least 3 recent readings needed' : `Last 5 readings · ${recentTrend.delta > 0 ? '+' : ''}${recentTrend.delta.toFixed(1)}°C`}</small></div></div><div class="ml-risk-summary"><div><span>Current actual risk</span><strong>${actualRiskMarkup}</strong><small>Based on measured container temperature</small></div><div><span>ML risk</span><strong>${mlRiskMarkup}</strong><small>Calculated from the predicted container temperature</small></div></div><p class="ml-message" role="status">${escapeHtml(message)}</p></section>`;
}
function routeWeatherSection() {
  const points = state.mlPrediction?.route_weather || [];
  const rows = points.length ? points.map(point => {
    const routePrediction = state.mlPrediction.route_predictions?.find(item => item.location_label === point.label);
    const mlOutput = routePrediction
      ? `Container prediction ${formatTemp(routePrediction.predicted_temperature)} · ${escapeHtml(routePrediction.risk)}`
      : state.mlPrediction?.model_available === false
        ? 'ML unavailable — insufficient paired history'
        : 'ML prediction unavailable';
    return `<div class="weather-point"><strong>${escapeHtml(point.label)}</strong><span>${point.forecast_available ? formatTemp(point.outside_temperature) : 'Unavailable'}</span><span>${point.forecast_available ? escapeHtml(point.weather_condition) : 'Weather forecast unavailable.'}</span><span>${mlOutput}</span></div>`;
  }).join('') : `<p class="subtle">${escapeHtml(state.mlPrediction?.message || 'Weather forecast unavailable.')}</p>`;
  return `<section class="panel route-weather-panel"><div class="panel-heading"><h3>Weather Along Shipment Route</h3><span class="forecast-label">Forecasted external weather</span></div><div class="weather-point weather-point-header"><span>Location</span><span>Outside temperature</span><span>Condition</span><span>ML container prediction</span></div>${rows}</section>`;
}
function historyTable(readings = activeReadings()) { if (!readings.length) return noData(); const sorted = [...readings].sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at)); const significant = sorted.filter((item, index) => index === 0 || Math.abs(item.temperature - sorted[index - 1].temperature) >= 1); return `<div class="history-scroll"><div class="shipment-row header"><span>Recorded</span><span>Temperature</span><span>Humidity</span><span>State</span><span>Device</span></div>${significant.reverse().map(item => { const itemRisk = getRisk([{ temperature: item.temperature }]); return `<div class="shipment-row"><span class="shipment-id">${formatTime(item.recorded_at)}</span><span class="temp">${formatTemp(item.temperature)}</span><span>${Number(item.humidity).toFixed(1)}%</span><span>${badge(itemRisk)}</span><span class="location">${item.device_id}</span></div>`; }).join('')}</div><p class="history-note">Showing ${significant.length} significant changes from ${readings.length} readings.</p>`; }
function detailPage() { const current = latest(); const delivered = isDelivered(); const forecast = prediction(); const predictionAlert = state.role === 'transport' ? `<div class="prediction-alert ${forecast.key}"><strong>${forecast.title}</strong><span>${forecast.detail}</span></div>` : ''; const currentSummary = ''; const details = state.role === 'pharmacy' ? (state.detailsOpen ? `<div class="detail-content"><div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div><div class="history-panel">${historyTable()}</div></div>` : '') : `<div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div><div class="history-panel">${historyTable()}</div>`; return `${pageHeader('Current shipment', 'Live condition for the active device.')}<section class="panel">${current ? `<div class="panel-heading"><h3>Temperature monitoring</h3><div class="detail-actions">${badge(risk())}<button class="button ${delivered ? 'light' : ''}" data-action="delivered" ${delivered ? 'disabled' : ''}>Delivered</button></div></div>${currentSummary}${state.role === 'pharmacy' ? `<button class="button light details-toggle" data-action="toggle-details" aria-expanded="${state.detailsOpen}">${state.detailsOpen ? 'Hide temperature details' : 'View temperature details'} <span>${state.detailsOpen ? '↑' : '↓'}</span></button>` : ''}${details}` : noData(state.readings.length ? 'All available shipments have been delivered.' : 'No current shipment data has been provided by the backend.')}</section>`; }
function listPage(kind) { const completedDevices = devices().filter(device => state.completedDevices[device]); const pendingDevices = devices().filter(device => !state.completedDevices[device] && device !== currentDevice()); const current = currentDevice(); const activeDevices = [...new Set([...(current ? [current] : []), ...pendingDevices])]; if (kind === 'pending') return `${pageHeader('Pending shipments', 'Only undelivered shipments waiting behind the current shipment.')}<section class="panel">${pendingDevices.length ? `<div class="shipment-row header"><span>Device</span><span>Readings</span><span>Latest temperature</span><span>Risk</span><span>Status</span></div>${pendingDevices.map(device => { const readings = readingsFor(device); return `<div class="shipment-row"><span class="shipment-id">${device}</span><span>${readings.length}</span><span class="temp">${formatTemp(readings[0]?.temperature)}</span><span>${badge(getRisk(readings))}</span><span>Pending</span></div>`; }).join('')}` : noData('No pending shipments are available.')}</section>`; if (kind === 'all') { const activeShipments = state.shipments.filter(shipment => shipment.status === 'pending'); const currentShipmentId = currentShipment()?.id; return `${pageHeader('All shipments', 'All active shipments currently in queue.')}<section class="panel">${activeShipments.length ? `<div class="shipment-row header"><span>Pharmacy user</span><span>Status</span></div>${activeShipments.map(shipment => `<div class="shipment-row"><span class="shipment-id">${escapeHtml(shipment.pharmacy_user_name || 'Pharmacy')}</span><span>${shipment.id === currentShipmentId ? 'Current' : 'Pending'}</span></div>`).join('')}` : noData('No active shipments are available.')}</section>`; } const rows = completedDevices.map(device => { const readings = readingsFor(device); const item = readings[0]; const expanded = state.expandedHistory === device; return `<div class="shipment-row history-summary"><span class="shipment-id">${device}</span><span>${readings.length}</span><span class="temp">${formatTemp(item?.temperature)}</span><span>${badge(getRisk(readings))}</span><button class="button light dropdown-button" data-action="history-toggle" data-device="${device}">${expanded ? 'Hide history ↑' : 'View history ↓'}</button></div>${expanded ? `<div class="history-detail"><div class="graph-heading">Temperature graph and significant history</div><div class="chart-wrap"><canvas data-chart-device="${device}"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div>${historyTable(readings)}</div>` : ''}`; }).join(''); return `${pageHeader(kind === 'completed' || kind === 'history' ? 'Past shipments' : 'Shipment records', completedDevices.length ? 'Expand a delivery to review its temperature history.' : 'No completed shipments yet.')}<section class="panel">${completedDevices.length ? `<div class="shipment-row header"><span>Device</span><span>Readings</span><span>Latest temperature</span><span>Risk</span><span>History</span></div>${rows}` : noData('The current backend provides sensor readings only; no shipment records were returned.')}</section>`; }
function render() {
  if (!state.role) return;
  renderNav();

  const oldMap = document.getElementById('shipmentMap');
  const oldRange = document.getElementById('range-controls-container');
  const shipmentDraft = state.page === 'add-shipment' ? {
    origin: state.shipmentSearch.origin.selected?.label ?? document.getElementById('shipment-location-origin')?.value ?? state.shipmentSearch.origin.query,
    destination: state.shipmentSearch.destination.selected?.label ?? document.getElementById('shipment-location-destination')?.value ?? state.shipmentSearch.destination.query,
    min: document.getElementById('shipment-min')?.value ?? '2',
    max: document.getElementById('shipment-max')?.value ?? '8',
    pharmacyQuery: document.getElementById('pharmacy-user-search')?.value ?? state.pharmacySearch.query,
    pharmacyUserId: state.pharmacySearch.selectedUserId,
    error: document.getElementById('shipment-form-error')?.textContent ?? ''
  } : null;

  const content = state.page === 'dashboard' ? dashboard() : state.page === 'current' ? currentShipmentPage() : state.page === 'add-shipment' ? addShipmentPage() : state.page === 'pending' ? pendingPage() : listPage(state.page);
  $('#page-content').innerHTML = content;
  if (shipmentDraft) {
    state.shipmentSearch.origin.query = shipmentDraft.origin;
    state.shipmentSearch.destination.query = shipmentDraft.destination;
    $('#shipment-location-origin').value = shipmentDraft.origin;
    $('#shipment-location-destination').value = shipmentDraft.destination;
    $('#shipment-min').value = shipmentDraft.min;
    $('#shipment-max').value = shipmentDraft.max;
    state.pharmacySearch.query = shipmentDraft.pharmacyQuery;
    state.pharmacySearch.selectedUserId = shipmentDraft.pharmacyUserId;
    if ($('#pharmacy-user-search')) renderPharmacyUserPicker();
    $('#shipment-form-error').textContent = shipmentDraft.error;
  }

  $('#page-title').textContent = state.page === 'dashboard' ? 'Control tower' : state.page[0].toUpperCase() + state.page.slice(1).replace('-', ' ');
  $('#workspace-role').textContent = state.role === 'transport' ? 'Transport team' : 'Pharmacy';

  const soundButton = document.querySelector('[data-action="sound"]');
  soundButton.style.display = state.role === 'transport' ? 'inline-flex' : 'none';

  const newMap = document.getElementById('shipmentMap');
  if (oldMap && newMap && shipmentMap) {
    newMap.replaceWith(oldMap);
  } else if (newMap && !shipmentMap) {
    initializeShipmentMap();
  } else if (!newMap && shipmentMap) {
    shipmentMap.remove();
    shipmentMap = null;
    displayedRouteKey = null;
    routeRequestId += 1;
  }

  const newRange = document.getElementById('range-controls-container');
  if (oldRange && newRange) {
    newRange.replaceWith(oldRange);
  }

  if (newMap && shipmentMap) {
    window.setTimeout(() => {
      shipmentMap.invalidateSize();
      drawShipmentRoute();
    }, 0);
  }

  drawChart();
  drawPastGraphs();
}
function drawChart() { const canvas = $('#temperature-chart'); const readings = activeReadings(); if (!canvas || !readings.length) return; const context = canvas.getContext('2d'); const box = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = box.width * ratio; canvas.height = box.height * ratio; context.scale(ratio, ratio); const width = box.width; const height = box.height; const values = [...readings].reverse().map(item => item.temperature); const dataMin = Math.min(safeMin(), ...values); const dataMax = Math.max(safeMax(), ...values); const padding = Math.max((dataMax - dataMin) * .15, 1); const min = Math.floor(dataMin - padding); const max = Math.ceil(dataMax + padding); const x = index => 30 + (index / Math.max(values.length - 1, 1)) * (width - 30); const y = value => height - 18 - (value - min) / (max - min) * (height - 30); context.font = '10px DM Mono'; context.fillStyle = '#8b9892'; const ticks = 4; for (let index = 0; index <= ticks; index += 1) { const value = min + ((max - min) / ticks) * index; context.fillText(`${value.toFixed(1)}°`, 0, y(value) + 3); context.strokeStyle = '#edf0ed'; context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); } context.strokeStyle = '#dfb34b'; context.setLineDash([4, 4]);[safeMin(), safeMax()].forEach(value => { context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); }); context.setLineDash([]); context.strokeStyle = '#21835c'; context.lineWidth = 2.5; context.beginPath(); values.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value))); context.stroke(); values.forEach((value, index) => { context.fillStyle = value < safeMin() || value > safeMax() ? '#c34538' : '#21835c'; context.beginPath(); context.arc(x(index), y(value), 3.5, 0, Math.PI * 2); context.fill(); }); }
async function fetchReadings() { if (!state.role) return; try { const response = await fetch(`${API_URL}/api/sensor-data`); if (!response.ok) throw new Error('API error'); state.readings = (await response.json()).sort((left, right) => new Date(right.recorded_at) - new Date(left.recorded_at)); if (!state.readings.length) state.riskByDevice = {}; state.apiOnline = true; $('#connection-label').textContent = 'API connected'; if (state.page !== 'add-shipment') render(); checkPredictionAlert(); } catch (error) { state.apiOnline = false; $('#connection-label').textContent = 'API unavailable'; if (state.page !== 'add-shipment') render(); } }
async function fetchMlPrediction() {
  if (state.role !== 'transport') return;
  if (!currentShipment()) {
    state.mlPrediction = { prediction_available: false, message: 'No active shipment is available for prediction.', route_weather: [] };
    if (state.page === 'dashboard') render();
    return;
  }
  const parameters = new URLSearchParams({ horizon_minutes: String(state.predictionHorizon) });
  if (currentDevice()) parameters.set('device_id', currentDevice());
  try {
    const response = await apiRequest(`/api/ml/prediction?${parameters}`);
    if (!response.ok) {
      const message = response.status === 401
        ? 'Your session expired. Sign in again to load route forecasts and ML prediction.'
        : response.status === 403
          ? 'This account cannot access Transport predictions.'
          : `Prediction API unavailable (HTTP ${response.status}). Standard ColdGuard monitoring remains active.`;
      throw new Error(message);
    }
    state.mlPrediction = await response.json();
  } catch (error) {
    state.mlPrediction = {
      prediction_available: false,
      weather_available: false,
      message: error.message || 'Prediction service unavailable. Standard ColdGuard monitoring remains active.',
      route_weather: []
    };
  }
  if (state.page === 'dashboard') render();
}
function drawPastGraphs() { document.querySelectorAll('canvas[data-chart-device]').forEach(canvas => { const readings = readingsFor(canvas.dataset.chartDevice); if (!readings.length) return; const context = canvas.getContext('2d'); const box = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = box.width * ratio; canvas.height = box.height * ratio; context.scale(ratio, ratio); const width = box.width; const height = box.height; const values = [...readings].reverse().map(item => item.temperature); const minValue = Math.floor(Math.min(SAFE_MIN, ...values) - 1); const maxValue = Math.ceil(Math.max(SAFE_MAX, ...values) + 1); const x = index => 30 + index / Math.max(values.length - 1, 1) * (width - 30); const y = value => height - 18 - (value - minValue) / (maxValue - minValue) * (height - 30); context.font = '10px DM Mono'; context.fillStyle = '#8b9892'; for (let index = 0; index <= 4; index += 1) { const value = minValue + (maxValue - minValue) * index / 4; context.fillText(`${value.toFixed(1)}°`, 0, y(value) + 3); context.strokeStyle = '#edf0ed'; context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); } context.strokeStyle = '#dfb34b'; context.setLineDash([4, 4]);[SAFE_MIN, SAFE_MAX].forEach(value => { context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); }); context.setLineDash([]); context.strokeStyle = '#21835c'; context.lineWidth = 2.5; context.beginPath(); values.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value))); context.stroke(); values.forEach((value, index) => { context.fillStyle = value < SAFE_MIN || value > SAFE_MAX ? '#c34538' : '#21835c'; context.beginPath(); context.arc(x(index), y(value), 3.5, 0, Math.PI * 2); context.fill(); }); }); }
function setProfileName() { if (!state.name) return; const initials = state.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); $('#top-avatar').textContent = initials; $('#top-profile-name').textContent = state.name; $('#profile-menu-name').textContent = state.name; }
async function enterWorkspace(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = { email: form.get('email'), password: form.get('password') };
  if (state.authMode === 'register') {
    payload.name = form.get('name');
    payload.role = form.get('role');
  }
  const error = $('#auth-error');
  error.textContent = '';

  try {
    const response = await fetch(`${API_URL}/api/auth/${state.authMode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      error.textContent = result.detail || 'Unable to sign in.';
      return;
    }
    state.authToken = result.token;
    localStorage.setItem('coldguard-auth-token', state.authToken);
    await startUserSession(result.user);
  } catch (requestError) {
    error.textContent = 'Could not connect to ColdGuard. Check that the backend is running.';
  }
}
async function startUserSession(user) {
  state.userId = user.id;
  state.name = user.name;
  state.role = user.role;
  state.page = 'dashboard';
  state.shipments = [];
  state.pharmacySearch = { query: '', selectedUserId: null, isOpen: false };
  state.pharmacyUsersLoaded = false;
  await refreshShipments();
  $('#login-screen').classList.add('hidden');
  setProfileName();
  render();
  await fetchReadings();
  void fetchMlPrediction();
}
async function refreshShipments() {
  const response = await apiRequest('/api/shipments');
  if (!response.ok) throw new Error('Could not load shipments');
  state.shipments = await response.json();
  state.mapShipmentId = currentShipment()?.id || null;
  if (state.mapShipmentId) localStorage.setItem('coldguard-selected-shipment', state.mapShipmentId);
  else localStorage.removeItem('coldguard-selected-shipment');
}
async function syncShipmentQueue() {
  if (!state.role) return;
  const previousQueue = state.shipments.map(shipment => `${shipment.id}:${shipment.status}`).join('|');
  try {
    await refreshShipments();
  } catch (requestError) {
    return;
  }
  const nextQueue = state.shipments.map(shipment => `${shipment.id}:${shipment.status}`).join('|');
  if (previousQueue !== nextQueue) {
    if (state.page !== 'add-shipment') render();
    void fetchMlPrediction();
  }
}
async function loadPharmacyUsers() {
  state.pharmacyUsersError = '';
  try {
    const response = await apiRequest('/api/pharmacy-users');
    if (!response.ok) throw new Error('Could not load Pharmacy accounts');
    state.pharmacyUsers = await response.json();
  } catch (requestError) {
    state.pharmacyUsers = [];
    state.pharmacyUsersError = 'Could not load Pharmacy accounts. Check your connection and sign in again.';
  }
  state.pharmacyUsersLoaded = true;
  if (state.page === 'add-shipment') {
    const helper = $('#pharmacy-user-helper');
    const submitButton = $('#add-shipment-form button[type="submit"]');
    if (helper) helper.innerHTML = state.pharmacyUsersError ? `<p class="form-error" role="alert">${escapeHtml(state.pharmacyUsersError)}</p>` : state.pharmacyUsers.length ? '' : '<p class="subtle">Register a Pharmacy account before creating a shipment.</p>';
    if (submitButton) submitButton.disabled = !state.pharmacyUsers.length;
    renderPharmacyUserPicker();
  }
}
async function restoreSession() {
  if (!state.authToken) return;
  try {
    const response = await apiRequest('/api/auth/me');
    if (!response.ok) throw new Error('Session is invalid');
    await startUserSession(await response.json());
  } catch (requestError) {
    state.authToken = '';
    localStorage.removeItem('coldguard-auth-token');
  }
}
function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $('#registration-fields').classList.toggle('hidden', !registering);
  $('#account-name').required = registering;
  $('#account-password').minLength = registering ? 8 : 1;
  $('#account-password').autocomplete = registering ? 'new-password' : 'current-password';
  $('#auth-heading').textContent = registering ? 'Create your account' : 'Sign in to your workspace';
  $('#auth-description').textContent = registering ? 'Register to access assigned cold-chain shipments.' : 'Use your account email and password to continue.';
  $('#auth-submit').innerHTML = registering ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  $('[data-action="auth-mode"]').textContent = registering ? 'Already have an account? Sign in' : 'Create an account';
  $('#auth-error').textContent = '';
}
async function signOut() {
  if (state.authToken) {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {}
  }
  if (state.alertTimer) clearInterval(state.alertTimer);
  state.alertTimer = null;
  state.authToken = '';
  state.userId = null;
  state.shipments = [];
  state.pharmacySearch = { query: '', selectedUserId: null, isOpen: false };
  state.role = null;
  state.name = '';
  state.page = 'dashboard';
  state.selectedDevice = null;
  state.expandedHistory = null;
  localStorage.removeItem('coldguard-auth-token');
  localStorage.removeItem('coldguard-user-name');
  $('#profile-menu').classList.remove('open');
  $('#login-screen').classList.remove('hidden');
  $('#login-form').reset();
  setAuthMode('login');
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-action="logout"]')) {
    event.stopImmediatePropagation();
    void signOut();
    return;
  }
  if (event.target.closest('[data-action="auth-mode"]')) {
    setAuthMode(state.authMode === 'login' ? 'register' : 'login');
  }
});
async function createShipment(form) {
  const formData = new FormData(form);
  const min = Number(formData.get('min'));
  const max = Number(formData.get('max'));
  const error = $('#shipment-form-error');
  const origin = state.shipmentSearch.origin.selected;
  const destination = state.shipmentSearch.destination.selected;
  if (!state.pharmacySearch.selectedUserId) {
    error.textContent = 'Select a Pharmacy account from the search results.';
    return;
  }
  if (!origin || !destination) {
    error.textContent = 'Choose both locations from the search results before adding the shipment.';
    return;
  }
  if (min > max) {
    error.textContent = 'Minimum temperature must be less than or equal to maximum.';
    return;
  }
  const payload = {
    origin_label: origin.label,
    origin_latitude: origin.coordinates[0],
    origin_longitude: origin.coordinates[1],
    destination_label: destination.label,
    destination_latitude: destination.coordinates[0],
    destination_longitude: destination.coordinates[1],
    temperature_min: min,
    temperature_max: max,
    pharmacy_user_id: state.pharmacySearch.selectedUserId
  };
  let response;
  try {
    response = await apiRequest('/api/shipments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (requestError) {
    error.textContent = 'Could not reach ColdGuard. Check that the backend is running.';
    return;
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    error.textContent = result.detail || 'Unable to create this shipment.';
    return;
  }
  const shipment = await response.json();
  state.shipments.push(shipment);
  state.mapShipmentId = currentShipment()?.id || shipment.id;
  localStorage.setItem('coldguard-selected-shipment', state.mapShipmentId);
  state.shipmentSearch = { origin: createLocationSearchState(), destination: createLocationSearchState() };
  state.pharmacySearch = { query: '', selectedUserId: null, isOpen: false };
  state.page = 'pending';
  render();
}
const locationSearchTimers = { origin: null, destination: null };
const locationSearchCache = new Map();
function renderLocationResults(key) {
  const results = document.getElementById(`location-results-${key}`);
  const input = document.getElementById(`shipment-location-${key}`);
  if (!results || !input) return;
  results.innerHTML = locationResultsMarkup(key);
  input.setAttribute('aria-expanded', String(state.shipmentSearch[key].results.length > 0));
}
async function searchLocations(key, query) {
  const search = state.shipmentSearch[key];
  const cacheKey = query.toLocaleLowerCase();
  if (locationSearchCache.has(cacheKey)) {
    search.results = locationSearchCache.get(cacheKey);
    search.message = search.results.length ? '' : 'No matching locations found.';
    renderLocationResults(key);
    return;
  }
  try {
    const response = await apiRequest(`/api/locations?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('Location search failed');
    const result = await response.json();
    if (search.query.trim() !== query) return;
    search.results = result.results || [];
    locationSearchCache.set(cacheKey, search.results);
    search.message = search.results.length ? '' : 'No matching locations found.';
  } catch (searchError) {
    if (search.query.trim() !== query) return;
    search.results = [];
    search.message = 'Location search is unavailable. Check your connection and try again.';
  }
  renderLocationResults(key);
}
$('#login-form').addEventListener('submit', enterWorkspace);
document.addEventListener('input', event => {
  const pharmacyInput = event.target.closest('[data-pharmacy-user-search]');
  if (pharmacyInput) {
    state.pharmacySearch.query = pharmacyInput.value;
    state.pharmacySearch.selectedUserId = null;
    state.pharmacySearch.isOpen = true;
    renderPharmacyUserPicker();
    return;
  }
  const input = event.target.closest('[data-location-search]');
  if (!input) return;
  const key = input.dataset.locationSearch;
  const search = state.shipmentSearch[key];
  search.query = input.value;
  search.selected = null;
  search.results = [];
  search.message = search.query.trim().length >= 2 ? 'Searching locations...' : 'Enter at least 2 characters.';
  renderLocationResults(key);
  clearTimeout(locationSearchTimers[key]);
  if (search.query.trim().length >= 2) {
    const query = search.query.trim();
    locationSearchTimers[key] = setTimeout(() => searchLocations(key, query), 120);
  }
});
document.addEventListener('focusin', event => {
  if (!event.target.matches('[data-pharmacy-user-search]')) return;
  state.pharmacySearch.isOpen = true;
  renderPharmacyUserPicker();
});
document.addEventListener('click', event => {
  const pharmacyOption = event.target.closest('[data-pharmacy-user-option]');
  if (pharmacyOption) {
    state.pharmacySearch.selectedUserId = Number(pharmacyOption.dataset.pharmacyUserOption);
    const selectedUser = state.pharmacyUsers.find(user => user.id === state.pharmacySearch.selectedUserId);
    if (selectedUser) state.pharmacySearch.query = `${selectedUser.name} (${selectedUser.email})`;
    state.pharmacySearch.isOpen = false;
    renderPharmacyUserPicker();
    return;
  }
  if (!event.target.closest('.pharmacy-assignee') && state.pharmacySearch.isOpen) {
    state.pharmacySearch.isOpen = false;
    renderPharmacyUserPicker();
  }
  const option = event.target.closest('[data-location-option]');
  if (!option) return;
  const key = option.dataset.locationOption;
  const search = state.shipmentSearch[key];
  const selected = search.results[Number(option.dataset.placeIndex)];
  if (!selected) return;
  search.selected = selected;
  search.query = selected.label;
  search.results = [];
  search.message = '';
  render();
});
document.addEventListener('submit', event => {
  if (event.target.id === 'add-shipment-form') {
    event.preventDefault();
    void createShipment(event.target);
  }
});
setProfileName();
if (state.soundEnabled) { const soundToggle = document.querySelector('[data-action="sound"]'); soundToggle.textContent = '🔊 Sound on'; soundToggle.setAttribute('aria-pressed', 'true'); }
document.addEventListener('click', event => { const pageButton = event.target.closest('[data-page]'); const historyToggle = event.target.closest('[data-action="history-toggle"]'); const viewCurrent = event.target.closest('[data-action="view-current"]'); const soundButton = event.target.closest('[data-action="sound"]'); if (pageButton) { event.preventDefault(); state.page = pageButton.dataset.page; state.selectedDevice = null; render(); if (state.page === 'add-shipment') void loadPharmacyUsers(); $('#sidebar').classList.remove('open'); } if (historyToggle) { state.expandedHistory = state.expandedHistory === historyToggle.dataset.device ? null : historyToggle.dataset.device; render(); } if (viewCurrent) { state.selectedDevice = viewCurrent.dataset.device; state.page = 'current'; state.detailsOpen = true; render(); } if (soundButton) { state.soundEnabled = !state.soundEnabled; localStorage.setItem('coldguard-sound-enabled', state.soundEnabled); soundButton.textContent = state.soundEnabled ? '🔊 Sound on' : '🔇 Sound off'; soundButton.setAttribute('aria-pressed', String(state.soundEnabled)); checkPredictionAlert(); } if (event.target.id === 'menu-toggle') $('#sidebar').classList.toggle('open'); if (event.target.closest('[data-action="delivered"]')) markDelivered(); if (event.target.closest('[data-action="toggle-details"]')) { state.detailsOpen = !state.detailsOpen; render(); } if (event.target.closest('[data-action="profile"]')) $('#profile-menu').classList.toggle('open'); if (event.target.closest('[data-action="logout"]')) { if (state.authToken) void apiRequest('/api/auth/logout', { method: 'POST' }); if (state.alertTimer) clearInterval(state.alertTimer); state.alertTimer = null; state.authToken = ''; state.userId = null; state.shipments = []; localStorage.removeItem('coldguard-auth-token'); localStorage.removeItem('coldguard-user-name'); state.role = null; state.name = ''; state.page = 'dashboard'; state.selectedDevice = null; state.expandedHistory = null; $('#profile-menu').classList.remove('open'); $('#login-screen').classList.remove('hidden'); $('#login-form').reset(); setAuthMode('login'); } });
document.addEventListener('change', event => { if (event.target.matches('[data-action="temperature-range"]')) { const [min, max] = event.target.value.split('-').map(Number); state.temperatureRange = { min, max }; state.riskByDevice = {}; localStorage.setItem('coldguard-temperature-range', JSON.stringify(state.temperatureRange)); state.lastAlertKey = 'unknown'; render(); checkPredictionAlert(); } });
document.addEventListener('change', event => { if (event.target.matches('[data-action="prediction-horizon"]')) { state.predictionHorizon = Number(event.target.value); render(); void fetchMlPrediction(); } });
window.addEventListener('resize', () => { drawChart(); drawPastGraphs(); });
window.addEventListener('storage', event => { if (event.key === 'coldguard-completed-devices') { state.completedDevices = JSON.parse(event.newValue || '{}'); render(); } if (event.key === 'coldguard-selected-shipment') { state.mapShipmentId = event.newValue; render(); } if (event.key === 'coldguard-auth-token' && !event.newValue && state.role) { state.authToken = ''; state.role = null; state.name = ''; $('#login-screen').classList.remove('hidden'); } });
void restoreSession();
setInterval(fetchReadings, 4000);
setInterval(() => void syncShipmentQueue(), 5000);
setInterval(() => void fetchMlPrediction(), 15 * 60 * 1000);
let shipmentMap = null;
let displayedRouteKey = null;
let displayedRouteStatus = 'Road route from Chennai hub';
let routeRequestId = 0;
const shipmentOrigin = { coordinates: [13.0827, 80.2707], label: 'Chennai hub' };
const demoDestination = { coordinates: [11.0168, 76.9558], label: 'Coimbatore' };

async function drawShipmentRoute() {
  if (!shipmentMap) return;
  const shipment = currentShipment() || [...state.shipments].reverse().find(item => item.status === 'delivered');
  const origin = shipment?.origin || shipmentOrigin;
  const destination = shipment?.destination || (shipment?.coordinates ? { coordinates: shipment.coordinates, label: shipment.location } : shipment ? null : demoDestination);
  const isDemoCorridor = destination && Math.abs(origin.coordinates[0] - 13.0827) < 0.4 && Math.abs(origin.coordinates[1] - 80.2707) < 0.4 && Math.abs(destination.coordinates[0] - 11.0168) < 0.4 && Math.abs(destination.coordinates[1] - 76.9558) < 0.4;
  const intermediateStops = isDemoCorridor ? [{ coordinates: [12.9716, 77.5946], label: 'Bengaluru' }] : [];
  const routeStops = [origin, ...intermediateStops, ...(destination ? [destination] : [])];
  const key = `${shipment?.id || 'demo'}:${routeStops.map(point => point.coordinates.join(',')).join(':') || 'unresolved'}`;
  const status = document.getElementById('map-route-status');
  if (key === displayedRouteKey) {
    if (status) status.textContent = displayedRouteStatus;
    renderWeatherMarkers();
    return;
  }
  displayedRouteKey = key;
  const requestId = ++routeRequestId;

  shipmentMap.eachLayer(layer => {
    if (!(layer instanceof L.TileLayer)) shipmentMap.removeLayer(layer);
  });
  weatherMarkerLayer = null;
  weatherMarkerSignature = null;
  L.marker(origin.coordinates).addTo(shipmentMap).bindPopup(`<strong>Starting location</strong><br>${escapeHtml(origin.label)}`);

  if (!destination) {
    displayedRouteStatus = 'Destination is unavailable';
    if (status) status.textContent = displayedRouteStatus;
    addTruckMarker(origin.coordinates, 'At the starting location');
    shipmentMap.setView(origin.coordinates, 7);
    renderWeatherMarkers();
    return;
  }

  const target = destination.coordinates;
  L.marker(target).addTo(shipmentMap).bindPopup(`<strong>Destination</strong><br>${escapeHtml(destination.label)}`);
  intermediateStops.forEach(stop => L.marker(stop.coordinates).addTo(shipmentMap).bindPopup(`<strong>Route waypoint</strong><br>${escapeHtml(stop.label)}`));
  displayedRouteStatus = `Routing from ${origin.label} to ${destination.label}...`;
  if (status) status.textContent = displayedRouteStatus;

  try {
    const coordinates = routeStops.map(point => `${point.coordinates[1]},${point.coordinates[0]}`).join(';');
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`);
    if (!response.ok) throw new Error('Road routing failed');
    const result = await response.json();
    if (requestId !== routeRequestId) return;
    if (result.code !== 'Ok' || !result.routes?.length) throw new Error('No driving route found');
    const route = result.routes[0];
    const path = route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
    L.polyline(path, { color: '#17211f', weight: 9, opacity: .32 }).addTo(shipmentMap);
    L.polyline(path, { color: '#18794e', weight: 5 }).addTo(shipmentMap);
    const truckProgress = .5;
    const truckPosition = path[Math.round((path.length - 1) * truckProgress)];
    addTruckMarker(truckPosition, `Estimated at ${Math.round(truckProgress * 100)}% of the road route`);
    displayedRouteStatus = `Road route · ${Math.round(route.distance / 1000)} km · truck estimate ${Math.round(truckProgress * 100)}%`;
    if (status) status.textContent = displayedRouteStatus;
    shipmentMap.fitBounds(path, { padding: [30, 30] });
    renderWeatherMarkers();
  } catch (routeError) {
    if (requestId !== routeRequestId) return;
    addTruckMarker(origin.coordinates, 'Estimated at the starting location; road route unavailable');
    displayedRouteStatus = 'Road route unavailable; truck estimate at starting location';
    if (status) status.textContent = displayedRouteStatus;
    shipmentMap.fitBounds([origin.coordinates, target], { padding: [30, 30] });
    renderWeatherMarkers();
  }
}

let weatherMarkerLayer = null;
let weatherMarkerSignature = null;
function renderWeatherMarkers() {
  if (!shipmentMap || !state.mlPrediction?.route_weather) return;
  const signature = JSON.stringify([state.mlPrediction.route_weather, state.mlPrediction.route_predictions]);
  if (weatherMarkerLayer && signature === weatherMarkerSignature) return;
  if (!weatherMarkerLayer) weatherMarkerLayer = L.layerGroup().addTo(shipmentMap);
  weatherMarkerLayer.clearLayers();
  weatherMarkerSignature = signature;
  state.mlPrediction.route_weather.filter(point => point.forecast_available).forEach(point => {
    const prediction = state.mlPrediction.route_predictions?.find(item => item.location_label === point.label);
    const risk = prediction ? `<br>ML predicted container: ${formatTemp(prediction.predicted_temperature)}<br>Risk: ${escapeHtml(prediction.risk)}` : '';
    L.circleMarker([point.latitude, point.longitude], {
      radius: 8,
      color: prediction?.risk === 'CRITICAL' ? '#bd4038' : prediction?.risk === 'WARNING' ? '#b47812' : '#18794e',
      fillColor: '#ffffff',
      fillOpacity: 1,
      weight: 3
    }).addTo(weatherMarkerLayer).bindPopup(`<strong>${escapeHtml(point.label)}</strong><br>Forecasted external weather: ${formatTemp(point.outside_temperature)}${risk}`);
  });
}

function addTruckMarker(position, locationDescription) {
  const truckIcon = L.divIcon({
    className: 'truck-marker',
    html: '<span aria-hidden="true">&#128666;</span>',
    iconSize: [42, 42],
    iconAnchor: [21, 21]
  });
  L.marker(position, { icon: truckIcon })
    .addTo(shipmentMap)
    .bindPopup(`<strong>Estimated current location</strong><br>${escapeHtml(locationDescription)}<br><small>Live GPS is not connected</small>`);
}

function initializeShipmentMap() {
  const mapElement = document.getElementById('shipmentMap');

  if (!mapElement) return;

  if (shipmentMap) {
    shipmentMap.remove();
    shipmentMap = null;
  }

  shipmentMap = L.map('shipmentMap').setView([11.5, 78.5], 7);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri'
  }).addTo(shipmentMap);
}