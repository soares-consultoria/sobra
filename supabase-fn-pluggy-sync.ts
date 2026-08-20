// Sobra · Edge Function "pluggy-sync"
// Ponte segura entre o app e o provedor de Open Finance.
// Suporta dois provedores:
//   - Banco MCP (URL MCP de api.mcp.ai, protocolo MCP/JSON-RPC)  <- atual
//   - Pluggy direto (client_id/client_secret)                    <- legado
// As credenciais ficam na tabela bank_link, acessível apenas por esta função.
//
// Ações (POST, JSON):
//   {action:'status'}                       -> {linked, provider, items, last_sync}
//   {action:'save_mcp', key}                -> {ok, accounts} | {error}   (key = URL MCP)
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

/* ============ Banco MCP — protocolo MCP (JSON-RPC sobre HTTP) ============ */

function sseParse(text: string): any {
  // resposta pode vir como JSON puro ou como text/event-stream ("data: {...}")
  let out: any = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { out = JSON.parse(line.slice(6)); } catch (_e) { /* segue */ }
    }
  }
  if (!out) { try { out = JSON.parse(text); } catch (_e) { /* segue */ } }
  return out;
}

async function mcpPost(url: string, sid: string | null, body: any): Promise<{ status: number; sid: string | null; msg: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sid) headers['mcp-session-id'] = sid;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, sid: r.headers.get('mcp-session-id') || sid, msg: sseParse(text) };
  } catch (_e) {
    return { status: 0, sid, msg: null };
  }
}

// abre sessão MCP; retorna {sid} ou {error}
async function mcpConnect(url: string): Promise<{ sid: string | null } | { error: string }> {
  const init = await mcpPost(url, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sobra', version: '1.0' } },
  });
  if (init.status === 401 || init.status === 403 || init.status === 404) return { error: 'invalid_credentials' };
  if (init.status < 200 || init.status >= 300 || !init.msg || !init.msg.result) return { error: 'api_indisponivel' };
  const sid = init.sid;
  await mcpPost(url, sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return { sid };
}

// chama uma tool e devolve o JSON interno (content[0].text) ou null
async function mcpTool(url: string, sid: string | null, name: string, args: any): Promise<any | null> {
  const r = await mcpPost(url, sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args || {} } });
  const res = r.msg && r.msg.result;
  if (!res || res.isError) return null;
  if (Array.isArray(res.content)) {
    for (const c of res.content) {
      if (c && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch (_e) { /* segue */ }
      }
    }
  }
  return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// repete em caso de rate-limit do provedor (2 req/s) ou falha transitória
async function mcpToolRetry(url: string, sid: string | null, name: string, args: any): Promise<any | null> {
  for (let i = 0; i < 4; i++) {
    const d = await mcpTool(url, sid, name, args);
    const rl = d && d.error && (d.error.status === 429 || (d.error.details && d.error.details.code === 'RATE_LIMITED'));
    if (rl) { await sleep((d.error.details && d.error.details.retry_after_ms) || 1200); continue; }
    if (d === null && i < 2) { await sleep(1200); continue; }
    return d;
  }
  return null;
}

// aplicação/resgate/rentabilidade de investimento não é receita nem despesa
function isInvest(x: any): boolean {
  if (/RESGATE_APLIC|APLICACAO/i.test(String(x.operationType || ''))) return true;
  if (/invest|fixed income|proceeds interests/i.test(String(x.category || ''))) return true;
  if (String(x.categoryId || '').slice(0, 2) === '03') return true; // árvore "Investments" da Pluggy
  return false;
}

// próximo vencimento: mesmo dia do mês do último vencimento informado pelo banco
function nextDue(d: any, hoje: string): string | null {
  if (!d) return null;
  const day = +String(d).slice(8, 10);
  if (!day) return null;
  let y = +hoje.slice(0, 4), m = +hoje.slice(5, 7);
  const mk = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return yy + '-' + String(mm).padStart(2, '0') + '-' + String(Math.min(day, last)).padStart(2, '0');
  };
  let cand = mk(y, m);
  if (cand < hoje) { m++; if (m > 12) { m = 1; y++; } cand = mk(y, m); }
  return cand;
}

function normMcpUrl(s: string): string | null {
  s = String(s || '').trim();
  if (/^api\.mcp\.ai\//.test(s)) s = 'https://' + s;
  if (!/^https:\/\/api\.mcp\.ai\/tk_[A-Za-z0-9_-]+/.test(s)) return null;
  return s;
}

function contaLabel(acc: any): string {
  const bank = acc.bank || '';
  if (acc.type === 'CREDIT') return (bank ? bank + ' ' : '') + (acc.name || 'Cartão');
  const tipo = acc.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta';
  return (bank ? bank + ' ' : '') + tipo;
}

async function mcpSync(url: string, from: string) {
  const conn = await mcpConnect(url);
  if ('error' in conn) return conn;
  const sid = conn.sid;

  const accData = await mcpToolRetry(url, sid, 'openfinance_list_accounts', {});
  if (!accData) return { error: 'api_indisponivel' };
  const accounts = accData.results || accData.accounts || (Array.isArray(accData) ? accData : []);

  const hoje = new Date().toISOString().slice(0, 10);
  const out: any[] = [];
  const cards: any[] = [];
  for (const acc of accounts) {
    const accId = acc.account_id || acc.id;
    if (!accId) continue;
    const isCard = acc.type === 'CREDIT';
    // cartão: janela maior para cobrir todo o ciclo aberto da fatura
    const d40 = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
    const fromAcc = isCard && d40 < from ? d40 : from;
    const tData = await mcpToolRetry(url, sid, 'openfinance_list_transactions', { account_id: accId, from: fromAcc });
    await sleep(650); // respeita o rate-limit do provedor (2 req/s)
    const results = tData ? (tData.results || tData.transactions || (Array.isArray(tData) ? tData : [])) : null;

    if (isCard) {
      // fatura em aberto (parcial) = compras pendentes do ciclo até hoje,
      // NÃO o saldo devedor total (que inclui parcelas futuras / limite utilizado)
      if (results) {
        let fatura = 0;
        for (const x of results) {
          const date = String(x.date || '').slice(0, 10);
          const amt = Number(x.amount) || 0;
          if (String(x.status || '') === 'PENDING' && x.type === 'DEBIT' && amt > 0 && date <= hoje
              && String(x.category || '') !== 'Credit card payment') fatura += amt;
        }
        cards.push({
          nome: contaLabel(acc),
          fatura: Math.round(fatura * 100) / 100,
          vence: nextDue(acc.creditData && acc.creditData.balanceDueDate, hoje),
          divida: Math.abs(Number(acc.balance) || 0),
          limite: acc.creditData ? (Number(acc.creditData.creditLimit) || 0) : 0,
          disponivel: acc.creditData ? (Number(acc.creditData.availableCreditLimit) || 0) : 0,
          min: acc.creditData ? (Number(acc.creditData.minimumPayment) || 0) : 0,
        });
      }
    }

    if (!results) continue;
    for (const x of results) {
      const date = String(x.date || '').slice(0, 10);
      if (!x.id || !date || date < from) continue;
      if (String(x.status || '') === 'PENDING' && date > hoje) continue; // parcelas/fatura futura
      if (isInvest(x)) continue; // aplicação/resgate não entra no orçamento
      const amt = Math.abs(Number(x.amount) || 0);
      if (!amt) continue;
      out.push({
        id: x.id, date, desc: x.description || '', amount: amt,
        tipo: (x.type === 'CREDIT') ? 'receita' : 'despesa',
        cat: x.category || null, conta: contaLabel(acc),
        ctype: isCard ? 'CREDIT' : 'BANK',
      });
    }
  }
  // investimentos (carteira) — informativo, não entra em receitas/despesas
  const invest: any[] = [];
  const invData = await mcpToolRetry(url, sid, 'openfinance_list_investments', {});
  if (invData) {
    const grupos = Array.isArray(invData.items) ? invData.items : [invData];
    for (const g of grupos) {
      for (const r of (g && g.results) || []) {
        if (r.integrity === 'suspect_zeroed') continue; // saldo indisponível, não é R$0 real
        const saldo = Number(r.balance) || 0;
        if (!saldo) continue;
        invest.push({
          nome: r.name || 'Investimento',
          banco: g.bank || '',
          tipo: r.subtype || r.type || '',
          saldo: Math.round(saldo * 100) / 100,
          rent12: (r.lastTwelveMonthsRate === undefined || r.lastTwelveMonthsRate === null) ? null : Number(r.lastTwelveMonthsRate),
          vence: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
        });
      }
    }
    invest.sort((a, b) => b.saldo - a.saldo);
  }

  return { ok: true, items: accounts.length, tx: out, cards, invest };
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
      const url = normMcpUrl(body.key);
      if (!url) return json({ error: 'invalid_credentials' }, 400);
      const conn = await mcpConnect(url);
      if ('error' in conn) return json({ error: conn.error }, 400);
      const probe = await mcpTool(url, conn.sid, 'openfinance_list_accounts', {});
      if (!probe) return json({ error: 'api_indisponivel' }, 400);
      const accounts = probe.results || probe.accounts || [];
      const { error } = await supa.from('bank_link').upsert({
        user_id: uid, client_id: 'mcpai', client_secret: url, item_ids: [],
      });
      if (error) return json({ error: 'db' }, 500);
      return json({ ok: true, accounts: accounts.length });
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

    const result: any = link.client_id === 'mcpai'
      ? await mcpSync(link.client_secret, from)
      : await pluggySync(link, from);
    if (result.error) return json({ error: result.error }, 400);
    await supa.from('bank_link').update({ last_sync: new Date().toISOString() }).eq('user_id', uid);
    return json({ ok: true, items: result.items, tx: result.tx, cards: result.cards, invest: result.invest || [] });
  } catch (_e) {
    return json({ error: 'internal' }, 500);
  }
});
