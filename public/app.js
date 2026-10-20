const $ = id => document.getElementById(id);
let token = '';
let records = [];
let cursor = null;
let revision = 0;
let loading = false;
let resultURL = '';
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function logout() {
  revision++; token = ''; records = []; cursor = null; loading = false; resultURL = '';
  $('dashboard').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true;
  $('links').replaceChildren(); $('result').hidden = true; $('result-link').removeAttribute('href'); $('result-link').textContent = '';
  $('token').value = ''; $('create').reset(); $('search').value = ''; notice('');
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) logout(); throw new Error(data.error || '요청을 처리하지 못했습니다.'); }
  return data;
}
function shortURL(code) { return `${location.origin}/${code}`; }
async function copy(text) { try { await navigator.clipboard.writeText(text); notice('링크를 복사했습니다.'); } catch { notice(`복사할 주소: ${text}`); } }
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
    const meta = document.createElement('small'); meta.textContent = `생성 ${new Date(record.createdAt).toLocaleString('ko-KR')} · ${record.expiresAt ? `만료 ${new Date(record.expiresAt * 1000).toLocaleString('ko-KR')}` : '무기한'}`;
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
$('login').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; token = $('token').value.trim(); notice('로그인 중…');
  try { await load(true); $('token').value = ''; $('login-panel').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; notice(''); }
  catch (e) { token = ''; notice(e.message, true); }
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
$('logout').onclick = logout;
$('search').oninput = render;
$('refresh').onclick = () => load(true).catch(e => notice(e.message, true));
$('more').onclick = () => load().catch(e => notice(e.message, true));
