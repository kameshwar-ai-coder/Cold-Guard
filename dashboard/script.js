const API_URL = 'http://127.0.0.1:8000';
const temperatureRanges = Array.from({ length: 36 }, (_, index) => ({ min: index + 2, max: index + 5, label: `${index + 2}°C — ${index + 5}°C` }));
const savedRange = JSON.parse(localStorage.getItem('coldguard-temperature-range') || 'null');
const PREDICTION_ALERT_WINDOW_MINUTES = 15;
const SAFE_MIN = 2;
const SAFE_MAX = 8;
const savedName = localStorage.getItem('coldguard-user-name') || '';
const state = { role: null, name: savedName, page: 'dashboard', readings: [], apiOnline: false, detailsOpen: false, expandedHistory: null, selectedDevice: null, completedDevices: {}, riskByDevice: {}, soundEnabled: localStorage.getItem('coldguard-sound-enabled') === 'true', lastAlertKey: 'unknown', alertTimer: null, temperatureRange: savedRange || { min: 4, max: 7 } };
const transportNav = [['dashboard', '▦', 'Dashboard'], ['all', '≡', 'All shipments'], ['current', '◉', 'Current shipment'], ['pending', '◷', 'Pending shipments'], ['completed', '✓', 'Completed shipments']];
const pharmacyNav = [['dashboard', '▦', 'Dashboard'], ['current', '◉', 'Current shipment'], ['history', '↺', 'Past shipment history']];

const $ = selector => document.querySelector(selector);
const formatTemp = value => value == null ? '--' : `${Number(value).toFixed(1)}°C`;
const formatTime = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--';
const devices = () => [...new Set(state.readings.map(item => item.device_id))];
const currentDevice = () => {
  if (state.selectedDevice) return state.selectedDevice;
  const availableDevices = devices();
  const esp32 = availableDevices.find(device => device.toLowerCase().includes('esp32'));
  if (availableDevices.length === 1) return availableDevices[0];
  return esp32 && !state.completedDevices[esp32] ? esp32 : availableDevices.find(device => !state.completedDevices[device]);
};
const readingsFor = device => state.readings.filter(item => item.device_id === device);
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
const rangeLabel = () => `${safeMin()}°C — ${safeMax()}°C`;
function rangeSelector() { return `<label class="range-control"><span>Required range</span><select data-action="temperature-range" aria-label="Select required temperature range">${temperatureRanges.map(range => `<option value="${range.min}-${range.max}" ${range.min === safeMin() && range.max === safeMax() ? 'selected' : ''}>${range.label}</option>`).join('')}</select></label>`; }
function prediction(readings = activeReadings()) {
  if (readings.length < 3) return { key: 'unknown', title: 'Prediction unavailable', detail: 'At least 3 live readings are needed to calculate a temperature trend.' };
  const ordered = [...readings].sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at)).slice(-8);
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
  if (slope <= 0.01) return { key: 'safe', urgent: false, title: 'No rising trend', detail: `Temperature is ${formatTemp(last.temperature)} and is not currently trending toward the critical threshold.` };
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
const isDelivered = () => Boolean(currentDevice() && state.completedDevices[currentDevice()]);
function markDelivered() {
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
function badge(value) { return `<span class="badge ${value.key}"><span>●</span>${value.label}</span>`; }
function pageHeader(title, copy) { return `<div class="page-intro"><div><div class="eyebrow">${state.role === 'transport' ? 'Fleet overview' : 'Receiving desk'}</div><h2>${title}</h2><p class="subtle">${copy}</p></div></div>`; }
function noData(message = 'No records are available from the backend yet.') { return `<div class="empty"><strong>No live data</strong><br>${message}</div>`; }
function dashboard() {
  const current = latest();
  const currentRisk = risk();
  const forecast = prediction();
  const stream = current ? `<div class="shipment-row" style="border:0;padding-top:0"><span class="shipment-id">${current.device_id}</span><span class="medicine"><span class="medicine-image">⌁</span>Sensor device</span><span class="location">Live sensor feed</span><span class="temp">${formatTemp(current.temperature)}</span><span>${badge(currentRisk)}</span></div><div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe range</span></div>` : noData(state.readings.length ? 'All available sensor shipments have been delivered.' : 'Connect a device to see its latest reading.');
  const predictionAlert = state.role === 'transport' ? `<section class="prediction-alert ${forecast.key}"><strong>${forecast.title}</strong><span>${forecast.detail}</span></section>` : '';
  const rangeControls = state.role === 'transport' ? `<div class="transport-tools">${rangeSelector()}</div>` : '';
  return `${pageHeader(state.role === 'transport' ? `Welcome, ${state.name}` : 'Receiving overview', state.role === 'transport' ? 'Monitor connected devices and shipment conditions.' : 'Review live conditions before accepting a delivery.')} ${rangeControls}<div class="stats-grid">${stat('Sensor readings', state.readings.length, state.apiOnline ? 'From live API' : 'API unavailable', '⌁', !state.apiOnline)}${stat('Current temperature', formatTemp(current?.temperature), current ? `Updated ${formatTime(current.recorded_at)}` : 'No reading', '°')}${stat('Current humidity', current ? `${Number(current.humidity).toFixed(1)}%` : '--', current ? 'From latest reading' : 'No reading', '%')}${stat('Temperature risk', currentRisk.label, currentRisk.detail, '!', currentRisk.key !== 'safe')}</div>${predictionAlert}<div class="grid-main"><section class="panel"><div class="panel-heading"><h3>Live sensor stream</h3><span class="subtle">${state.readings.length} readings</span></div>${stream}</section><section class="panel risk-panel"><div class="panel-heading"><h3>Current risk</h3><span class="subtle">Based on history</span></div><div class="risk-score"><div class="risk-light ${currentRisk.key}">●</div><div><strong>${currentRisk.label}</strong><small>${state.readings.length ? `${state.readings.length} readings analyzed` : 'No readings analyzed'}</small></div></div><div class="risk-meter"><i class="${currentRisk.key === 'safe' ? 'on' : ''}"></i><i class="${currentRisk.key === 'warning' || currentRisk.key === 'critical' ? 'on' : ''}"></i><i class="${currentRisk.key === 'critical' ? 'on' : ''}"></i></div><div class="risk-copy">${currentRisk.detail}</div><div class="mini-detail"><span>Required range</span><strong>${rangeLabel()}</strong></div><div class="mini-detail"><span>Connected device</span><strong>${current?.device_id || 'None'}</strong></div></section></div>`;
}
function historyTable(readings = activeReadings()) { if (!readings.length) return noData(); const sorted = [...readings].sort((left, right) => new Date(left.recorded_at) - new Date(right.recorded_at)); const significant = sorted.filter((item, index) => index === 0 || Math.abs(item.temperature - sorted[index - 1].temperature) >= 1); return `<div class="history-scroll"><div class="shipment-row header"><span>Recorded</span><span>Temperature</span><span>Humidity</span><span>State</span><span>Device</span></div>${significant.reverse().map(item => { const itemRisk = getRisk([{ temperature: item.temperature }]); return `<div class="shipment-row"><span class="shipment-id">${formatTime(item.recorded_at)}</span><span class="temp">${formatTemp(item.temperature)}</span><span>${Number(item.humidity).toFixed(1)}%</span><span>${badge(itemRisk)}</span><span class="location">${item.device_id}</span></div>`; }).join('')}</div><p class="history-note">Showing ${significant.length} significant changes from ${readings.length} readings.</p>`; }
function detailPage() { const current = latest(); const delivered = isDelivered(); const forecast = prediction(); const predictionAlert = state.role === 'transport' ? `<div class="prediction-alert ${forecast.key}"><strong>${forecast.title}</strong><span>${forecast.detail}</span></div>` : ''; const currentSummary = current ? `<div class="current-summary"><div><span>Latest reading</span><strong>${formatTime(current.recorded_at)}</strong></div><div><span>Temperature</span><strong>${formatTemp(current.temperature)}</strong></div><div><span>Humidity</span><strong>${Number(current.humidity).toFixed(1)}%</strong></div><div><span>State</span><strong>${delivered ? 'Delivered' : 'In transit'}</strong></div><div><span>Device</span><strong>${current.device_id}</strong></div></div>${predictionAlert}` : ''; const details = state.role === 'pharmacy' ? (state.detailsOpen ? `<div class="detail-content"><div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div><div class="history-panel">${historyTable()}</div></div>` : '') : `<div class="chart-wrap"><canvas id="temperature-chart"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div><div class="history-panel">${historyTable()}</div>`; return `${pageHeader('Current shipment', 'Live condition for the active device.')}<section class="panel">${current ? `<div class="panel-heading"><h3>Temperature monitoring</h3><div class="detail-actions">${badge(risk())}<button class="button ${delivered ? 'light' : ''}" data-action="delivered" ${delivered ? 'disabled' : ''}>Delivered</button></div></div>${currentSummary}${state.role === 'pharmacy' ? `<button class="button light details-toggle" data-action="toggle-details" aria-expanded="${state.detailsOpen}">${state.detailsOpen ? 'Hide temperature details' : 'View temperature details'} <span>${state.detailsOpen ? '↑' : '↓'}</span></button>` : ''}${details}` : noData(state.readings.length ? 'All available shipments have been delivered.' : 'No current shipment data has been provided by the backend.')}</section>`; }
function listPage(kind) { const completedDevices = devices().filter(device => state.completedDevices[device]); const pendingDevices = devices().filter(device => !state.completedDevices[device] && device !== currentDevice()); if (kind === 'pending') return `${pageHeader('Pending shipments', 'Only undelivered shipments waiting behind the current shipment.')}<section class="panel">${pendingDevices.length ? `<div class="shipment-row header"><span>Device</span><span>Readings</span><span>Latest temperature</span><span>Risk</span><span>Status</span></div>${pendingDevices.map(device => { const readings = readingsFor(device); return `<div class="shipment-row"><span class="shipment-id">${device}</span><span>${readings.length}</span><span class="temp">${formatTemp(readings[0]?.temperature)}</span><span>${badge(getRisk(readings))}</span><span>Pending</span></div>`; }).join('')}` : noData('No pending shipments are available.')}</section>`; const rows = completedDevices.map(device => { const readings = readingsFor(device); const item = readings[0]; const expanded = state.expandedHistory === device; return `<div class="shipment-row history-summary"><span class="shipment-id">${device}</span><span>${readings.length}</span><span class="temp">${formatTemp(item?.temperature)}</span><span>${badge(getRisk(readings))}</span><button class="button light dropdown-button" data-action="history-toggle" data-device="${device}">${expanded ? 'Hide history ↑' : 'View history ↓'}</button></div>${expanded ? `<div class="history-detail"><div class="graph-heading">Temperature graph and significant history</div><div class="chart-wrap"><canvas data-chart-device="${device}"></canvas></div><div class="chart-legend"><span class="legend-key"><i></i> Temperature</span><span class="legend-key"><i class="dashed"></i> Safe limits</span></div>${historyTable(readings)}</div>` : ''}`; }).join(''); return `${pageHeader(kind === 'completed' || kind === 'history' ? 'Past shipments' : 'Shipment records', completedDevices.length ? 'Expand a delivery to review its temperature history.' : 'No completed shipments yet.')}<section class="panel">${completedDevices.length ? `<div class="shipment-row header"><span>Device</span><span>Readings</span><span>Latest temperature</span><span>Risk</span><span>History</span></div>${rows}` : noData('The current backend provides sensor readings only; no shipment records were returned.')}</section>`; }
function render() { if (!state.role) return; renderNav(); const content = state.page === 'dashboard' ? dashboard() : state.page === 'current' ? detailPage() : listPage(state.page); $('#page-content').innerHTML = content; $('#page-title').textContent = state.page === 'dashboard' ? 'Control tower' : state.page[0].toUpperCase() + state.page.slice(1).replace('-', ' '); $('#workspace-role').textContent = state.role === 'transport' ? 'Transport team' : 'Pharmacy'; const soundButton = document.querySelector('[data-action="sound"]'); soundButton.style.display = state.role === 'transport' ? 'inline-flex' : 'none'; drawChart(); drawPastGraphs(); }
function drawChart() { const canvas = $('#temperature-chart'); const readings = activeReadings(); if (!canvas || !readings.length) return; const context = canvas.getContext('2d'); const box = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = box.width * ratio; canvas.height = box.height * ratio; context.scale(ratio, ratio); const width = box.width; const height = box.height; const values = [...readings].reverse().map(item => item.temperature); const dataMin = Math.min(safeMin(), ...values); const dataMax = Math.max(safeMax(), ...values); const padding = Math.max((dataMax - dataMin) * .15, 1); const min = Math.floor(dataMin - padding); const max = Math.ceil(dataMax + padding); const x = index => 30 + (index / Math.max(values.length - 1, 1)) * (width - 30); const y = value => height - 18 - (value - min) / (max - min) * (height - 30); context.font = '10px DM Mono'; context.fillStyle = '#8b9892'; const ticks = 4; for (let index = 0; index <= ticks; index += 1) { const value = min + ((max - min) / ticks) * index; context.fillText(`${value.toFixed(1)}°`, 0, y(value) + 3); context.strokeStyle = '#edf0ed'; context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); } context.strokeStyle = '#dfb34b'; context.setLineDash([4, 4]); [safeMin(), safeMax()].forEach(value => { context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); }); context.setLineDash([]); context.strokeStyle = '#21835c'; context.lineWidth = 2.5; context.beginPath(); values.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value))); context.stroke(); values.forEach((value, index) => { context.fillStyle = value < safeMin() || value > safeMax() ? '#c34538' : '#21835c'; context.beginPath(); context.arc(x(index), y(value), 3.5, 0, Math.PI * 2); context.fill(); }); }
async function fetchReadings() { if (!state.role) return; try { const response = await fetch(`${API_URL}/api/sensor-data`); if (!response.ok) throw new Error('API error'); state.readings = (await response.json()).sort((left, right) => new Date(right.recorded_at) - new Date(left.recorded_at)); if (!state.readings.length) state.riskByDevice = {}; state.apiOnline = true; $('#connection-label').textContent = 'API connected'; render(); checkPredictionAlert(); } catch (error) { state.apiOnline = false; $('#connection-label').textContent = 'API unavailable'; render(); } }
function drawPastGraphs() { document.querySelectorAll('canvas[data-chart-device]').forEach(canvas => { const readings = readingsFor(canvas.dataset.chartDevice); if (!readings.length) return; const context = canvas.getContext('2d'); const box = canvas.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1; canvas.width = box.width * ratio; canvas.height = box.height * ratio; context.scale(ratio, ratio); const width = box.width; const height = box.height; const values = [...readings].reverse().map(item => item.temperature); const minValue = Math.floor(Math.min(SAFE_MIN, ...values) - 1); const maxValue = Math.ceil(Math.max(SAFE_MAX, ...values) + 1); const x = index => 30 + index / Math.max(values.length - 1, 1) * (width - 30); const y = value => height - 18 - (value - minValue) / (maxValue - minValue) * (height - 30); context.font = '10px DM Mono'; context.fillStyle = '#8b9892'; for (let index = 0; index <= 4; index += 1) { const value = minValue + (maxValue - minValue) * index / 4; context.fillText(`${value.toFixed(1)}°`, 0, y(value) + 3); context.strokeStyle = '#edf0ed'; context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); } context.strokeStyle = '#dfb34b'; context.setLineDash([4, 4]); [SAFE_MIN, SAFE_MAX].forEach(value => { context.beginPath(); context.moveTo(30, y(value)); context.lineTo(width, y(value)); context.stroke(); }); context.setLineDash([]); context.strokeStyle = '#21835c'; context.lineWidth = 2.5; context.beginPath(); values.forEach((value, index) => index ? context.lineTo(x(index), y(value)) : context.moveTo(x(index), y(value))); context.stroke(); values.forEach((value, index) => { context.fillStyle = value < SAFE_MIN || value > SAFE_MAX ? '#c34538' : '#21835c'; context.beginPath(); context.arc(x(index), y(value), 3.5, 0, Math.PI * 2); context.fill(); }); }); }
function setProfileName() { if (!state.name) return; const initials = state.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); $('#top-avatar').textContent = initials; $('#top-profile-name').textContent = state.name; $('#profile-menu-name').textContent = state.name; }
function enterWorkspace(event) { event.preventDefault(); const form = new FormData(event.target); state.name = form.get('user-name').trim(); localStorage.setItem('coldguard-user-name', state.name); state.role = form.get('role'); state.page = 'dashboard'; $('#login-screen').classList.add('hidden'); setProfileName(); $('#user-avatar').textContent = state.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); $('#user-name-label').textContent = state.name; $('#user-role-label').textContent = state.role === 'transport' ? 'Transport team' : 'Pharmacy'; render(); fetchReadings(); }
$('#login-form').addEventListener('submit', enterWorkspace);
setProfileName();
if (state.soundEnabled) { const soundToggle = document.querySelector('[data-action="sound"]'); soundToggle.textContent = '🔊 Sound on'; soundToggle.setAttribute('aria-pressed', 'true'); }
document.addEventListener('click', event => { const pageButton = event.target.closest('[data-page]'); const historyToggle = event.target.closest('[data-action="history-toggle"]'); const viewCurrent = event.target.closest('[data-action="view-current"]'); const soundButton = event.target.closest('[data-action="sound"]'); if (pageButton) { event.preventDefault(); state.page = pageButton.dataset.page; state.selectedDevice = null; render(); $('#sidebar').classList.remove('open'); } if (historyToggle) { state.expandedHistory = state.expandedHistory === historyToggle.dataset.device ? null : historyToggle.dataset.device; render(); } if (viewCurrent) { state.selectedDevice = viewCurrent.dataset.device; state.page = 'current'; state.detailsOpen = true; render(); } if (soundButton) { state.soundEnabled = !state.soundEnabled; localStorage.setItem('coldguard-sound-enabled', state.soundEnabled); soundButton.textContent = state.soundEnabled ? '🔊 Sound on' : '🔇 Sound off'; soundButton.setAttribute('aria-pressed', String(state.soundEnabled)); checkPredictionAlert(); } if (event.target.id === 'menu-toggle') $('#sidebar').classList.toggle('open'); if (event.target.closest('[data-action="delivered"]')) markDelivered(); if (event.target.closest('[data-action="toggle-details"]')) { state.detailsOpen = !state.detailsOpen; render(); } if (event.target.closest('[data-action="profile"]')) $('#profile-menu').classList.toggle('open'); if (event.target.closest('[data-action="logout"]')) { if (state.alertTimer) clearInterval(state.alertTimer); state.alertTimer = null; state.role = null; state.name = ''; localStorage.removeItem('coldguard-user-name'); state.page = 'dashboard'; state.selectedDevice = null; state.expandedHistory = null; $('#profile-menu').classList.remove('open'); $('#login-screen').classList.remove('hidden'); $('#login-form').reset(); } });
document.addEventListener('change', event => { if (event.target.matches('[data-action="temperature-range"]')) { const [min, max] = event.target.value.split('-').map(Number); state.temperatureRange = { min, max }; state.riskByDevice = {}; localStorage.setItem('coldguard-temperature-range', JSON.stringify(state.temperatureRange)); state.lastAlertKey = 'unknown'; render(); checkPredictionAlert(); } });
window.addEventListener('resize', () => { drawChart(); drawPastGraphs(); });
window.addEventListener('storage', event => { if (event.key === 'coldguard-completed-devices') { state.completedDevices = JSON.parse(event.newValue || '{}'); render(); } });
setInterval(fetchReadings, 4000);
