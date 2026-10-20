const $ = id => document.getElementById(id);
let records = [];
let cursor = null;
let revision = 0;
let loading = false;
let resultURL = '';
let setupRequired = false;
const adminPage = ['/admin', '/admin/'].includes(location.pathname);
let guestResultURL = '';
let apiKeys = [];
let keyCursor = null;
let keysLoading = false;
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function setSetupMode(required) {
  setupRequired = required;
  $('login-title').textContent = required ? '관리자 비밀번호 설정' : '관리자 로그인';
  $('login-submit').textContent = required ? '비밀번호 설정 →' : '로그인 →';
  $('setup-confirm').hidden = !required;
  $('setup-confirm-password').required = required;
  $('password').autocomplete = required ? 'new-password' : 'current-password';
  $('password').minLength = required ? 10 : 1;
  $('password').maxLength = required ? 128 : 256;
  $('login-hint').textContent = required ? '최초 한 번만 설정합니다. 10자 이상의 비밀번호를 입력하세요.' : '로그인은 최대 7일 유지됩니다. 공용 기기에서는 사용 후 로그아웃하세요.';
}
function showLogin() {
  revision++; records = []; cursor = null; loading = false; resultURL = '';
  $('api-settings').hidden = true; $('api-panel').hidden = true; $('key-result').hidden = true; $('new-api-key').value = ''; $('api-keys').replaceChildren(); $('create-api-key').reset(); apiKeys = []; keyCursor = null;
  $('password-settings').hidden = true; $('password-panel').hidden = true; $('change-password').reset();
  $('dashboard').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('links').replaceChildren(); $('result').hidden = true; $('result-link').removeAttribute('href'); $('result-link').textContent = '';
  $('password').value = ''; $('setup-confirm-password').value = ''; $('create').reset(); $('search').value = ''; notice('');
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json();
  if (!response.ok) {
    if (path === '/api/auth/setup' && response.status === 409) setSetupMode(false);
    if (data.setupRequired) setSetupMode(true);
    if (response.status === 401 && path !== '/api/auth/login') showLogin(); throw new Error(data.error || '요청을 처리하지 못했습니다.'); }
  return data;
}
function shortURL(code) { return `${location.origin}/${code}`; }
async function copy(text, label = '링크') { try { await navigator.clipboard.writeText(text); notice(`${label}를 복사했습니다.`); } catch { notice('자동 복사를 사용할 수 없습니다. 표시된 값을 직접 선택해 복사하세요.', true); } }
function render() {
  const query = $('search').value.trim().toLowerCase();
  const items = records.filter(r => `${r.code} ${r.url}`.toLowerCase().includes(query));
  $('links').replaceChildren();
  if (!items.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = query ? '검색 결과가 없습니다.' : '아직 링크가 없습니다. 첫 번째 링크를 만들어 보세요.'; $('links').append(p); }
  for (const record of items) {
    const row = document.createElement('article'); row.className = 'link-row';
    const content = document.createElement('div'); content.className = 'link-content';
    const link = document.createElement('a'); link.href = shortURL(record.code); link.textContent = shortURL(record.code); link.target = '_blank'; link.rel = 'noopener noreferrer';
    const original = document.createElement('p'); original.className = 'original'; original.textContent = record.url; original.title = record.url;
    const meta = document.createElement('small'); meta.textContent = `생성 ${new Date(record.createdAt).toLocaleString('ko-KR')} · ${record.createdBy === 'guest' ? '게스트 · ' : ''}${record.expiresAt ? `만료 ${new Date(record.expiresAt * 1000).toLocaleString('ko-KR')}` : '무기한'}`;
    content.append(link, original, meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const copyButton = document.createElement('button'); copyButton.className = 'quiet'; copyButton.textContent = '복사'; copyButton.onclick = () => copy(shortURL(record.code));
    const remove = document.createElement('button'); remove.className = 'quiet danger'; remove.textContent = '삭제';
    remove.onclick = async () => {
      if (!confirm(`${shortURL(record.code)}\n이 링크를 삭제할까요? 삭제는 되돌릴 수 없습니다.`)) return;
      remove.disabled = true;
      const current = revision;
      try { await api(`/api/links/${record.code}`, { method: 'DELETE' }); if (current !== revision) return; records = records.filter(r => r.code !== record.code); render(); notice('삭제 요청이 완료되었습니다. 다른 지역에서는 반영에 시간이 걸릴 수 있습니다.'); }
      catch (e) { notice(e.message, true); remove.disabled = false; }
    };
    actions.append(copyButton, remove); row.append(content, actions); $('links').append(row);
  }
  $('more').hidden = !cursor;
}
async function load(reset = false) {
  if (loading) return;
  loading = true; $('refresh').disabled = true; $('more').disabled = true;
  const current = revision;
  try {
    const page = await api(`/api/links${!reset && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (current !== revision) return;
    if (reset) records = [];
    const merged = new Map(records.map(r => [r.code, r]));
    for (const r of page.links) merged.set(r.code, r);
    records = [...merged.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)); cursor = page.cursor; render();
  } finally { loading = false; $('refresh').disabled = false; $('more').disabled = false; }
}
function showDashboard() {
  $('login-panel').hidden = true; $('dashboard').hidden = false;
  $('logout').hidden = false; $('password-settings').hidden = false; $('api-settings').hidden = false;
}
$('login').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; notice('로그인 중…');
  try {
    if (setupRequired) {
      if ($('password').value !== $('setup-confirm-password').value) throw new Error('비밀번호 확인이 일치하지 않습니다.');
      await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
      $('password').value = ''; $('setup-confirm-password').value = ''; setSetupMode(false);
      notice('관리자 비밀번호를 설정했습니다. 로그인하세요. 바로 로그인되지 않으면 1분 정도 후 다시 시도하세요.');
      return;
    }
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = ''; showDashboard(); await load(true); notice('');
  } catch (e) { notice(e.message, true); }
  finally { button.disabled = false; }
};
$('password-settings').onclick = () => { $('password-panel').hidden = !$('password-panel').hidden; $('change-password').reset(); };
$('cancel-password').onclick = () => { $('password-panel').hidden = true; $('change-password').reset(); };
$('change-password').onsubmit = async event => {
  event.preventDefault();
  if ($('new-password').value !== $('confirm-password').value) { notice('새 비밀번호 확인이 일치하지 않습니다.', true); return; }
  const button = event.submitter; button.disabled = true;
  try {
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('current-password').value, newPassword: $('new-password').value }) });
    showLogin(); notice('비밀번호가 변경되었습니다. 새 비밀번호로 로그인하세요. 바로 로그인되지 않으면 1분 정도 후 다시 시도하세요.');
  } catch (e) { notice(e.message, true); }
  finally { button.disabled = false; }
};
$('create').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; const current = revision;
  try {
    const expiry = $('expires').value;
    const data = await api('/api/links', { method: 'POST', body: JSON.stringify({ url: $('url').value.trim(), expiresAt: expiry ? new Date(expiry).toISOString() : null }) });
    if (current !== revision) return;
    resultURL = shortURL(data.code); $('result-link').href = resultURL; $('result-link').textContent = resultURL; $('result').hidden = false;
    records.unshift(data); render(); $('create').reset(); notice('생성되었습니다. 링크가 바로 열리지 않으면 잠시 후 다시 시도하세요.');
  } catch (e) { notice(e.message, true); } finally { button.disabled = false; }
};
$('copy-result').onclick = () => copy(resultURL);
$('logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); showLogin(); notice('로그아웃되었습니다.'); }
  catch (e) { notice(e.message, true); }
};
$('search').oninput = render;
$('refresh').onclick = () => load(true).catch(e => notice(e.message, true));
$('more').onclick = () => load().catch(e => notice(e.message, true));

async function restoreSession() {
  const button = $('login').querySelector('button[type="submit"]'); button.disabled = true;
  try { const session = await api('/api/auth/session'); setSetupMode(!!session.setupRequired); if (session.setupRequired) return; showDashboard(); await load(true); }
  catch (e) { if (e.message !== '관리자 로그인이 필요합니다.') notice(e.message, true); }
  finally { button.disabled = false; }
}

function renderKeys() {
  $('api-keys').replaceChildren();
  for (const key of apiKeys) {
    const row = document.createElement('article'); row.className = 'link-row';
    const description = document.createElement('div'); description.className = 'link-content';
    const name = document.createElement('strong'); name.textContent = key.name;
    const date = document.createElement('p'); date.className = 'original'; date.textContent = `생성 ${new Date(key.createdAt).toLocaleString('ko-KR')}`;
    description.append(name, date);
    const revoke = document.createElement('button'); revoke.className = 'quiet danger'; revoke.textContent = '폐기';
    revoke.onclick = async () => {
      if (!confirm(`${key.name} 키를 폐기할까요? 이 키를 사용하는 프로그램은 더 이상 인증할 수 없습니다.`)) return;
      revoke.disabled = true; const current = revision;
      try {
        await api(`/api/keys/${key.id}`, { method: 'DELETE' });
        if (current !== revision) return;
        apiKeys = apiKeys.filter(k => k.id !== key.id); renderKeys();
        $('key-result').hidden = true; $('new-api-key').value = '';
        notice('키를 폐기했습니다. 반영까지 시간이 걸릴 수 있습니다.');
      } catch (e) { notice(e.message, true); revoke.disabled = false; }
    };
    row.append(description, revoke); $('api-keys').append(row);
  }
  $('more-keys').hidden = !keyCursor;
}
async function loadKeys(reset = false) {
  if (keysLoading) return;
  keysLoading = true; $('more-keys').disabled = true; const current = revision;
  try {
    const page = await api(`/api/keys${!reset && keyCursor ? `?cursor=${encodeURIComponent(keyCursor)}` : ''}`);
    if (current !== revision) return;
    if (reset) apiKeys = [];
    const merged = new Map(apiKeys.map(k => [k.id,k]));
    for (const key of page.keys) merged.set(key.id,key);
    apiKeys = [...merged.values()]; keyCursor = page.cursor; renderKeys();
  } finally { keysLoading = false; $('more-keys').disabled = false; }
}
$('api-settings').onclick = () => {
  $('api-panel').hidden = !$('api-panel').hidden;
  $('key-result').hidden = true; $('new-api-key').value = '';
  if (!$('api-panel').hidden) loadKeys(true).catch(e => notice(e.message,true));
};
$('close-api').onclick = () => { $('api-panel').hidden = true; $('key-result').hidden = true; $('new-api-key').value = ''; };
$('create-api-key').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; const current = revision;
  try {
    const created = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: $('key-name').value }) });
    if (current !== revision) return;
    $('new-api-key').value = created.key; $('key-result').hidden = false;
    apiKeys.unshift({ id: created.id, name: created.name, createdAt: created.createdAt }); renderKeys(); $('create-api-key').reset();
    notice('API 키가 발급되었습니다. 원문은 다시 조회할 수 없습니다.');
  } catch (e) { notice(e.message,true); } finally { button.disabled = false; }
};
$('copy-api-key').onclick = () => copy($('new-api-key').value, 'API 키');
$('more-keys').onclick = () => loadKeys().catch(e => notice(e.message,true));

$('guest-create').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const created = await api('/api/guest/links', { method: 'POST', body: JSON.stringify({ url: $('guest-url').value.trim() }) });
    guestResultURL = shortURL(created.code); $('guest-result-link').href = guestResultURL; $('guest-result-link').textContent = guestResultURL;
    $('guest-expiry').textContent = `만료: ${new Date(created.expiresAt * 1000).toLocaleString('ko-KR')}`;
    $('guest-result').hidden = false; $('guest-create').reset(); notice('7일 동안 사용할 수 있는 링크를 만들었습니다.');
  } catch (e) { notice(e.message, true); } finally { button.disabled = false; }
};
$('copy-guest').onclick = () => copy(guestResultURL);
if (adminPage) { $('admin-link').hidden = true; $('login-panel').hidden = false; restoreSession(); }
else { $('guest-panel').hidden = false; }
