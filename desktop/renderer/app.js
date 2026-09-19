import { Microphone } from './audio.js';

const $ = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
const names = { overview: 'Обзор', notes: 'Заметки', reminders: 'Напоминания', settings: 'Настройки' };
const wakeNames = { hey_jarvis: 'Hey Jarvis', alexa: 'Alexa', hey_mycroft: 'Hey Mycroft', hey_rhasspy: 'Hey Rhasspy' };
let snapshot = { notes: [], reminders: [], settings: {}, providers: {} }, voice = false, starting = false, busy = false, lastCommand = '', toastTimer, voiceGeneration = 0;
function mockBridge() {
  const data = { notes: [], reminders: [], settings: { wakeWord: 'hey_jarvis', wakeThreshold: .5, speakReplies: true, autoStart: false, cloudEnabled: false }, providers: { typesafe: false, assemblyai: false, gemini: false }, version: 'Предпросмотр' };
  return { snapshot: async () => structuredClone(data), addNote: async text => { data.notes.unshift({ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }); }, addReminder: async item => { data.reminders.push({ id: crypto.randomUUID(), ...item }); }, deleteNote: async id => { data.notes = data.notes.filter(item => item.id !== id); }, deleteReminder: async id => { data.reminders = data.reminders.filter(item => item.id !== id); }, completeReminder: async id => { data.reminders = data.reminders.filter(item => item.id !== id); }, updateSettings: async patch => Object.assign(data.settings, patch), command: async () => ({ ok: true, message: 'Это предпросмотр интерфейса. Команды и облачные модели здесь не запускаются.', route: 'Предпросмотр' }), onEvent: () => () => {} };
}
const api = window.jeff || (preview ? mockBridge() : null);
const microphone = new Microphone(chunk => { if (voice) Promise.resolve(api.audioChunk(chunk)).catch(handleVoiceError); });
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
function messageOf(error) { return error?.message || 'Не удалось выполнить действие. Попробуйте ещё раз.'; }
async function guarded(action) { try { const result = await action(); if (result?.ok === false) throw new Error(result.message || result.error || 'Не удалось выполнить действие.'); return result; } catch (error) { toast(messageOf(error)); throw error; } }
function switchTab(name) { if (!names[name]) return; document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== name; }); document.querySelectorAll('.nav-item').forEach(button => { const active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }); $('page-name').textContent = names[name]; }
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); switchTab('overview'); });
$('today').textContent = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', weekday: 'short' }).format(new Date());
function dateValue(value) { if (value == null) return null; const result = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(result.getTime()) ? null : result; }
function formatDate(value) { const date = dateValue(value); return date ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date) : ''; }
function reminderDue(item) { return item.dueAt ?? item.due_at ?? item.due_ts; }
function noteCreated(item) { return item.createdAt ?? item.created_at ?? item.created_ts; }
function emptyState(title, description) { const element = document.createElement('div'); element.className = 'empty-state'; const heading = document.createElement('strong'), text = document.createElement('p'); heading.textContent = title; text.textContent = description; element.append(heading, text); return element; }
function actionButton(label, symbol, action) { const button = document.createElement('button'); button.className = 'icon-button'; button.type = 'button'; button.textContent = symbol; button.setAttribute('aria-label', label); button.title = label; button.addEventListener('click', async () => { button.disabled = true; try { await guarded(action); await refresh(false); } catch {} finally { button.disabled = false; } }); return button; }
function renderList(target, items, type, compact = false) {
  const container = $(target); container.replaceChildren();
  if (!items.length) { container.append(emptyState(type === 'notes' ? 'Здесь появятся ваши мысли' : 'Пока ничего не запланировано', type === 'notes' ? 'Запишите первую заметку голосом или текстом.' : 'Добавьте напоминание — и освободите голову.')); return; }
  for (const item of items) {
    const card = document.createElement('article'), content = document.createElement('div'), text = document.createElement('p'), time = document.createElement('time'); card.className = compact ? 'summary-item' : 'item-card'; content.className = 'item-content'; text.textContent = item.text ?? item.content ?? item.title ?? ''; const date = type === 'notes' ? noteCreated(item) : reminderDue(item); time.textContent = formatDate(date); if (dateValue(date)) time.dateTime = dateValue(date).toISOString(); content.append(text, time); card.append(content);
    if (!compact) { const actions = document.createElement('div'); actions.className = 'item-actions'; if (type === 'reminders') actions.append(actionButton('Отметить выполненным', '✓', () => api.completeReminder(item.id))); actions.append(actionButton(type === 'notes' ? 'Удалить заметку' : 'Удалить напоминание', '×', () => type === 'notes' ? api.deleteNote(item.id) : api.deleteReminder(item.id))); card.append(actions); }
    container.append(card);
  }
}
function renderSettings() {
  const settings = snapshot.settings || {}, form = $('settings-form');
  for (const name of ['wakeWord', 'wakeThreshold', 'microphoneId', 'speakReplies', 'autoStart', 'cloudEnabled']) { const field = form.elements.namedItem(name); const value = settings[name]; if (value !== undefined) { if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value; } }
  $('threshold-value').value = $('wake-threshold').value;
  $('orb-caption').textContent = (wakeNames[settings.wakeWord] || 'Hey Jarvis').toUpperCase();
  $('providers').replaceChildren();
  for (const [key, name] of [['typesafe', 'TypeSafe · Jev'], ['assemblyai', 'AssemblyAI'], ['gemini', 'Gemini']]) {
    const provider = snapshot.providers?.[key], configured = typeof provider === 'object' ? Boolean(provider?.configured ?? provider?.available ?? provider?.enabled) : Boolean(provider);
    const card = document.createElement('div'), title = document.createElement('strong'), status = document.createElement('span'); card.className = 'provider-card'; title.textContent = name; status.textContent = configured ? 'Ключ настроен' : 'Не настроено'; card.append(title, status); if (key === 'assemblyai') { const detail = document.createElement('span'); detail.textContent = 'Whisper realtime · экспериментальный'; card.append(detail); } $('providers').append(card);
  }
}
async function refresh(settings = true) {
  if (!api) return;
  const result = await api.snapshot(); snapshot = { ...snapshot, ...result }; snapshot.notes ||= []; snapshot.reminders ||= [];
  const reminders = snapshot.reminders.filter(item => !item.completed && !item.done && !item.completed_at).sort((a, b) => (dateValue(reminderDue(a))?.getTime() ?? Infinity) - (dateValue(reminderDue(b))?.getTime() ?? Infinity));
  $('note-count').textContent = snapshot.notes.length; $('reminder-count').textContent = reminders.length;
  renderList('notes-list', snapshot.notes, 'notes'); renderList('reminders-list', reminders, 'reminders'); renderList('recent-notes', snapshot.notes.slice(0, 2), 'notes', true); renderList('recent-reminders', reminders.slice(0, 2), 'reminders', true);
  if (settings) renderSettings(); if (snapshot.version) $('version').textContent = `ASSISTANT JEFF · ${snapshot.version}`;
}
function showReply(result) {
  const conversation = $('conversation'); conversation.hidden = false; conversation.replaceChildren();
  if (lastCommand) { const question = document.createElement('div'); question.className = 'user-message'; question.textContent = lastCommand; conversation.append(question); }
  const reply = document.createElement('div'); reply.className = 'reply-message'; reply.textContent = result.message || result.text || 'Готово.'; conversation.append(reply);
  if (result.route || result.latencyMs) { const meta = document.createElement('div'); meta.className = 'reply-meta'; meta.textContent = [result.route, result.latencyMs != null ? `${Math.round(result.latencyMs)} мс` : ''].filter(Boolean).join(' · '); conversation.append(meta); }
}
$('command-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('command-input').value.trim(); if (!text || busy || !api) return; busy = true; $('send-command').disabled = true; lastCommand = text;
  try { const result = await api.command(text); showReply(result); if (result.ok !== false) $('command-input').value = ''; await refresh(false); } catch (error) { showReply({ ok: false, message: messageOf(error) }); } finally { busy = false; $('send-command').disabled = false; }
});
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { $('command-input').value = button.dataset.command; $('command-input').focus(); }));
$('note-form').addEventListener('submit', async event => { event.preventDefault(); const text = $('note-text').value.trim(); if (!text || !api) return; const button = event.submitter; button.disabled = true; try { await guarded(() => api.addNote(text)); $('note-text').value = ''; await refresh(false); toast('Заметка сохранена'); } catch {} finally { button.disabled = false; } });
$('reminder-form').addEventListener('submit', async event => { event.preventDefault(); const text = $('reminder-text').value.trim(), due = new Date($('reminder-date').value); if (!text || !api) return; if (Number.isNaN(due.getTime()) || due <= new Date()) { toast('Выберите дату и время в будущем.'); return; } const button = event.submitter; button.disabled = true; try { await guarded(() => api.addReminder({ text, dueAt: due.toISOString() })); $('reminder-form').reset(); await refresh(false); toast('Напоминание добавлено'); } catch {} finally { button.disabled = false; } });
$('wake-threshold').addEventListener('input', () => { $('threshold-value').value = $('wake-threshold').value; });
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); if (!api) return; const form = event.currentTarget, patch = { wakeWord: form.elements.wakeWord.value, wakeThreshold: Number(form.elements.wakeThreshold.value), microphoneId: form.elements.microphoneId.value, speakReplies: form.elements.speakReplies.checked, autoStart: form.elements.autoStart.checked, cloudEnabled: form.elements.cloudEnabled.checked }; const button = event.submitter; button.disabled = true; try { if (voice) await stopVoice(); await guarded(() => api.updateSettings(patch)); await refresh(); $('settings-feedback').textContent = 'Сохранено'; toast('Настройки сохранены. Микрофон можно включить снова.'); } catch {} finally { button.disabled = false; } });
function setStatus(state, message) {
  const labels = { idle: 'Готов помочь', stopped: 'Микрофон выключен', waiting: 'Жду вашего обращения', listening: 'Слушаю вас', recording: 'Слушаю вас', transcribing: 'Распознаю речь', thinking: 'Обрабатываю команду', processing: 'Обрабатываю команду', speaking: 'Отвечаю', error: 'Нужно внимание', starting: 'Подключаю микрофон' };
  const label = message || labels[state] || state || 'Готов помочь'; $('state-label').lastChild.textContent = label; $('top-status').textContent = voice || starting ? label : 'Микрофон выключен'; $('top-dot').classList.toggle('muted', !voice); document.body.classList.toggle('voice-active', voice); $('voice-button-label').textContent = voice ? 'Выключить микрофон' : starting ? 'Подключение…' : 'Включить микрофон';
  $('activate-voice').hidden = !voice || !['waiting', 'idle'].includes(state);
  $('finish-voice').hidden = !voice || !['listening', 'recording'].includes(state);
}
async function stopVoice(notifyMain = true) { voiceGeneration++; voice = false; starting = false; setStatus('stopped'); await microphone.stop(); try { if (notifyMain && api?.stopVoice) await api.stopVoice(); } finally { setStatus('stopped'); $('voice-toggle').disabled = !api || preview; } }
async function handleVoiceError(error) { if (!voice && !starting) return; await stopVoice().catch(() => {}); toast(messageOf(error)); }
microphone.onEnded = () => handleVoiceError(new Error('Микрофон отключён. Проверьте устройство и включите его снова.'));
async function loadDevices() { if (!navigator.mediaDevices) return; const devices = await navigator.mediaDevices.enumerateDevices(); const selected = snapshot.settings.microphoneId || ''; $('microphone').replaceChildren(new Option('Системный по умолчанию', '')); for (const device of devices.filter(item => item.kind === 'audioinput' && item.deviceId && item.deviceId !== 'default' && item.deviceId !== 'communications')) $('microphone').append(new Option(device.label || 'Микрофон', device.deviceId)); $('microphone').value = selected; }
async function startVoice() {
  if (!api || preview || starting || voice) return;
  const generation = ++voiceGeneration; starting = true; $('voice-toggle').disabled = true; setStatus('starting');
  try {
    const result = await api.startVoice(); if (generation !== voiceGeneration) return;
    if (result?.ok === false) throw new Error(result.message || result.error || 'Голосовой режим недоступен.');
    await microphone.start(snapshot.settings.microphoneId); if (generation !== voiceGeneration) { await microphone.stop(); return; }
    voice = true; starting = false; setStatus('waiting'); await loadDevices();
  } catch (error) { if (generation === voiceGeneration) { await stopVoice().catch(() => {}); toast(messageOf(error)); } }
  finally { if (generation === voiceGeneration) { starting = false; $('voice-toggle').disabled = false; } }
}
$('voice-toggle').addEventListener('click', () => { if (voice) stopVoice().catch(error => toast(messageOf(error))); else startVoice(); });
for (const [id, method] of [['activate-voice', 'activateVoice'], ['finish-voice', 'finishVoice']]) $(id).addEventListener('click', async () => { if (!voice || !api?.[method]) return; $(id).disabled = true; try { await guarded(() => api[method]()); } catch {} finally { $(id).disabled = false; } });
const unsubscribe = api?.onEvent(event => {
  if (event.type === 'stop-capture') { stopVoice(false).catch(error => toast(messageOf(error))); }
  else if (event.type === 'auto-start') { refresh().then(() => { if (snapshot.settings.autoStart) return startVoice(); }).catch(error => toast(messageOf(error))); }
  else if (event.type === 'status') { setStatus(event.state, event.message); if (event.state === 'error') handleVoiceError(new Error(event.message || 'Ошибка голосового режима.')); else if (['stopped', 'off'].includes(event.state) && (voice || starting)) stopVoice(false).catch(error => toast(messageOf(error))); }
  else if (event.type === 'wake') { microphone.beep(); setStatus('listening'); }
  else if (event.type === 'transcript') { $('command-input').value = event.text || ''; if (event.final) lastCommand = event.text || ''; }
  else if (event.type === 'reply') { showReply(event); refresh(false).catch(error => toast(messageOf(error))); }
  else if (event.type === 'changed') refresh(false).catch(error => toast(messageOf(error)));
  else if (event.type === 'reminder') { toast(`Пора: ${event.text || event.message || event.reminder?.text || 'проверить напоминание'}`); refresh(false).catch(() => {}); }
});
window.addEventListener('beforeunload', () => { unsubscribe?.(); microphone.stop(); if (voice) api?.stopVoice?.(); });
if (!api || preview) { $('availability').hidden = false; $('availability').textContent = preview ? 'Предпросмотр интерфейса. Данные временные, микрофон и облачные запросы отключены.' : 'Откройте Assistant Jeff как приложение Windows. В браузере управление компьютером и микрофон недоступны.'; $('voice-toggle').disabled = true; if (!api) document.querySelectorAll('form button, form input, form textarea, form select').forEach(element => { element.disabled = true; }); }
renderList('recent-notes', [], 'notes', true); renderList('recent-reminders', [], 'reminders', true); renderList('notes-list', [], 'notes'); renderList('reminders-list', [], 'reminders');
refresh().catch(error => toast(messageOf(error)));
