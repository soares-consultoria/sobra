// Sobra · Edge Function "pluggy-sync"
// Ponte segura entre o app e o provedor de Open Finance.
// Suporta dois provedores:
//   - Banco MCP (api.mcp.ai, chave sk_live_...)  <- atual
//   - Pluggy direto (client_id/client_secret)    <- legado
// As credenciais ficam na tabela bank_link, acessível apenas por esta função.
//
// Ações (POST, JSON):
//   {action:'status'}                       -> {linked, provider, items, last_sync}
//   {action:'save_mcp', key}                -> {ok, accounts} | {error}
//   {action:'save', client_id, client_secret, item_ids} -> legado Pluggy
//   {action:'delete'}                       -> {ok}
//   {action:'sync', from:'YYYY-MM-DD'}      -> {ok, items, tx:[...], cards:[...]}

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ============ Banco MCP (api.mcp.ai) ============ */
const MCP_BASES = ['https://api.mcp.ai/v1/openfinance', 'https://banco.mcp.ai/v1/openfinance'];

async function mcpGet(url: string, key: string): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (_e) {
    return { ok: false, status: 0, data: null };
  }
}

async function mcpFindBase(key: string): Promise<{ base: string; accounts: any[] } | { error: string; detail?: any }> {
  let lastStatus = 0;
  for (const base of MCP_BASES) {
    const r = await mcpGet(base + '/accounts', key);
    if (r.ok && r.data) {
      const accounts = r.data.results || r.data.accounts || (Array.isArray(r.data) ? r.data : []);
      return { base, accounts };
    }
    lastStatus = r.status;
    if (r.status === 401 || r.status === 403) return { error: 'invalid_credentials', detail: r.data };
  }
  return { error: 'api_indisponivel', detail: lastStatus };
}

function contaLabel(acc: any): string {
  const bank = acc.bank || '';
  if (acc.type === 'CREDIT') return (bank ? bank + ' ' : '') + (acc.name || 'Cartão');
  const tipo = acc.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta';
  return (bank ? bank + ' ' : '') + tipo;
}

async function mcpSync(key: string, meta: any, from: string) {
  let base = meta && meta.base;
  let accounts: any[] | null = null;
  if (base) {
    const r = await mcpGet(base + '/accounts', key);
    if (r.ok && r.data) accounts = r.data.results || r.data.accounts || [];
    else if (r.status === 401 || r.status === 403) return { error: 'invalid_credentials' };
    else base = null;
  }
  if (!base) {
    const found = await mcpFindBase(key);
    if ('error' in found) return found;
    base = found.base;
    accounts = found.accounts;
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const out: any[] = [];
  const cards: any[] = [];
  for (const acc of accounts || []) {
    if (acc.type === 'CREDIT') {
      cards.push({
        nome: contaLabel(acc),
        fatura: Math.abs(Number(acc.balance) || 0),
        vence: acc.creditData && acc.creditData.balanceDueDate ? String(acc.creditData.balanceDueDate).slice(0, 10) : null,
      });
    }
    const accId = acc.account_id || acc.id;
    if (!accId) continue;
    const q = `?account_id=${encodeURIComponent(accId)}&accountId=${encodeURIComponent(accId)}&since=${from}&from=${from}`;
    const t = await mcpGet(base + '/transactions' + q, key);
    if (!t.ok || !t.data) continue;
    const results = t.data.results || t.data.transactions || (Array.isArray(t.data) ? t.data : []);
    for (const x of results) {
      const date = String(x.date || '').slice(0, 10);
      if (!x.id || !date) continue;
      if (String(x.status || '') === 'PENDING' && date > hoje) continue; // parcelas/fatura futura
      const amt = Math.abs(Number(x.amount) || 0);
      if (!amt) continue;
      out.push({
        id: x.id,
        date,
        desc: x.description || '',
        amount: amt,
        tipo: (x.type === 'CREDIT') ? 'receita' : 'despesa',
        cat: x.category || null,
        conta: contaLabel(acc),
        ctype: acc.type === 'CREDIT' ? 'CREDIT' : 'BANK',
      });
    }
  }
  return { ok: true, base, items: (accounts || []).length, tx: out, cards };
}

/* ============ Pluggy direto (legado) ============ */
function normItem(s: string): string {
  s = String(s || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  if (/^eyJ/.test(s)) {
    try {
      const p = JSON.parse(atob(s.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const d = String(p.data || p.itemId || p.id || '').replace(/-/g, '');
      if (/^[0-9a-f]{32}$/i.test(d)) return d.slice(0,8)+'-'+d.slice(8,12)+'-'+d.slice(12,16)+'-'+d.slice(16,20)+'-'+d.slice(20);
    } catch (_e) { /* ignora */ }
  }
  return s;
}
async function pluggyAuth(clientId: string, clientSecret: string): Promise<string | null> {
  const r = await fetch('https://api.pluggy.ai/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) });
  if (!r.ok) return null;
  const d = await r.json();
  return d.apiKey || null;
}
async function pget(path: string, apiKey: string): Promise<any | null> {
  const r = await fetch('https://api.pluggy.ai/' + path, { headers: { 'X-API-KEY': apiKey } });
  if (!r.ok) return null;
  return r.json();
}
async function pluggySync(link: any, from: string) {
  const apiKey = await pluggyAuth(link.client_id, link.client_secret);
  if (!apiKey) return { error: 'invalid_credentials' };
  const out: any[] = [];
  const cards: any[] = [];
  for (const itemId of (link.item_ids || []).map(normItem)) {
    const accs = await pget(`accounts?itemId=${encodeURIComponent(itemId)}`, apiKey);
    for (const a of accs?.results || []) {
      if (a.type === 'CREDIT') {
        cards.push({ nome: a.name || 'Cartão', fatura: Math.abs(Number(a.balance) || 0), vence: a.creditData && a.creditData.balanceDueDate ? String(a.creditData.balanceDueDate).slice(0, 10) : null });
      }
      let page = 1, totalPages = 1;
      while (page <= totalPages && page <= 10) {
        const t = await pget(`transactions?accountId=${encodeURIComponent(a.id)}&from=${from}&pageSize=500&page=${page}`, apiKey);
        if (!t) break;
        totalPages = t.totalPages || 1;
        for (const x of t.results || []) {
          out.push({ id: x.id, date: String(x.date || '').slice(0, 10), desc: x.description || '', amount: Math.abs(Number(x.amount) || 0), tipo: x.type === 'CREDIT' ? 'receita' : 'despesa', cat: x.category || null, conta: a.name || '', ctype: a.type || '' });
        }
        page++;
      }
    }
  }
  return { ok: true, items: (link.item_ids || []).length, tx: out, cards };
}

/* ============ servidor ============ */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: uerr } = await supa.auth.getUser(token);
    if (uerr || !userData?.user) return json({ error: 'unauthorized' }, 401);
    const uid = userData.user.id;

    const body = await req.json().catch(() => ({} as any));
    const action = body.action || 'sync';

    if (action === 'status') {
      const { data } = await supa.from('bank_link').select('client_id,item_ids,last_sync').eq('user_id', uid).maybeSingle();
      if (!data) return json({ linked: false });
      const provider = data.client_id === 'mcpai' ? 'mcpai' : 'pluggy';
      return json({ linked: true, provider, items: (data.item_ids || []).length, last_sync: data.last_sync });
    }

    if (action === 'save_mcp') {
      const key = String(body.key || '').trim();
      if (!/^sk_live_/.test(key)) return json({ error: 'invalid_credentials' }, 400);
      const found = await mcpFindBase(key);
      if ('error' in found) return json({ error: found.error }, 400);
      const { error } = await supa.from('bank_link').upsert({
        user_id: uid, client_id: 'mcpai', client_secret: key,
        item_ids: [found.base],
      });
      if (error) return json({ error: 'db' }, 500);
      return json({ ok: true, accounts: (found.accounts || []).length });
    }

    if (action === 'save') { // legado Pluggy
      const client_id = String(body.client_id || '').trim();
      const client_secret = String(body.client_secret || '').trim();
      const item_ids = Array.isArray(body.item_ids) ? body.item_ids.map((s: string) => normItem(s)).filter(Boolean) : [];
      if (!client_id || !client_secret || !item_ids.length) return json({ error: 'missing' }, 400);
      const key = await pluggyAuth(client_id, client_secret);
      if (!key) return json({ error: 'invalid_credentials' }, 400);
      const { error } = await supa.from('bank_link').upsert({ user_id: uid, client_id, client_secret, item_ids });
      if (error) return json({ error: 'db' }, 500);
      return json({ ok: true });
    }

    if (action === 'delete') {
      await supa.from('bank_link').delete().eq('user_id', uid);
      return json({ ok: true });
    }

    // sync
    const { data: link } = await supa.from('bank_link').select('*').eq('user_id', uid).maybeSingle();
    if (!link) return json({ error: 'not_linked' }, 400);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : new Date().toISOString().slice(0, 8) + '01';

    let result: any;
    if (link.client_id === 'mcpai') {
      const meta = { base: (link.item_ids || [])[0] || null };
      result = await mcpSync(link.client_secret, meta, from);
      if (result.ok && result.base && result.base !== meta.base) {
        await supa.from('bank_link').update({ item_ids: [result.base] }).eq('user_id', uid);
      }
    } else {
      result = await pluggySync(link, from);
    }
    if (result.error) return json({ error: result.error }, 400);
    await supa.from('bank_link').update({ last_sync: new Date().toISOString() }).eq('user_id', uid);
    return json({ ok: true, items: result.items, tx: result.tx, cards: result.cards });
  } catch (_e) {
    return json({ error: 'internal' }, 500);
  }
});
