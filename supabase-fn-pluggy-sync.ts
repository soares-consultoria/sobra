// Sobra · Edge Function "pluggy-sync"
// Ponte segura entre o app e o provedor de Open Finance (Pluggy / meu.pluggy.ai).
// As credenciais ficam na tabela bank_link, acessível apenas por esta função.
//
// Ações (POST, JSON):
//   {action:'status'}                       -> {linked, provider, items, last_sync}
//   {action:'save', client_id, client_secret, item_ids} -> {ok} | {error}
//   {action:'delete'}                       -> {ok}
//   {action:'sync', from:'YYYY-MM-DD'}      -> {ok, items, tx:[...], cards:[...], invest, contas, avisos}

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/* ============ Pluggy ============ */
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
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.pluggy.ai/' + path, { headers: { 'X-API-KEY': apiKey } });
    if (r.status === 429) { await sleep(1200); continue; } // rate limit: espera e repete
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

// Pede ao Pluggy uma coleta nova dos dados do item (com as credenciais já guardadas lá)
// e espera a coleta terminar (até ~24s). Sem isso os dados podem ficar parados por dias
// e a sincronização não traz lançamentos novos nem a fatura atual do cartão.
// Conector com MFA responde 400 — segue com os dados que já existem.
async function pitemRefresh(itemId: string, apiKey: string): Promise<any | null> {
  let updating = false;
  try {
    const r = await fetch('https://api.pluggy.ai/items/' + encodeURIComponent(itemId), {
      method: 'PATCH',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    console.log('[item-refresh]', itemId, r.status);
    if (r.ok) updating = true;
    try { await r.text(); } catch (_e) { /* ignora */ }
  } catch (_e) { /* segue com os dados existentes */ }
  let it: any = null;
  for (let i = 0; i < (updating ? 8 : 1); i++) {
    if (updating || i > 0) await sleep(3000);
    it = await pget(`items/${encodeURIComponent(itemId)}`, apiKey);
    const st = String((it && it.status) || '');
    if (!it) break;
    if (st !== 'UPDATING' && st !== 'CREATING' && st !== 'MERGING') break;
  }
  if (!it) it = await pget(`items/${encodeURIComponent(itemId)}`, apiKey);
  return it;
}

async function pluggySync(link: any, from: string) {
  const apiKey = await pluggyAuth(link.client_id, link.client_secret);
  if (!apiKey) return { error: 'invalid_credentials' };
  const hoje = new Date().toISOString().slice(0, 10);
  const out: any[] = [];
  const cards: any[] = [];
  const contas: any[] = [];
  const invest: any[] = [];
  const avisos = new Set<string>();
  for (const itemId of (link.item_ids || []).map(normItem)) {
    // dispara atualização e lê o estado do item; um item quebrado (LOGIN_ERROR/OUTDATED)
    // não derruba a sincronização — os dados persistidos ainda são lidos
    const it = await pitemRefresh(itemId, apiKey);
    const bank = (it && it.connector && (it.connector.name || '')) || '';
    const st = String((it && it.status) || '');
    const upd = (it && (it.lastUpdatedAt || it.updatedAt)) || null;
    const idadeH = upd ? Math.round((Date.now() - new Date(upd).getTime()) / 36e5) : null;
    console.log('[item]', itemId, JSON.stringify({ status: st, exec: it && it.executionStatus, upd, idadeH }));
    if (st === 'LOGIN_ERROR' || st === 'WAITING_USER_INPUT' || st === 'INVALID_CREDENTIALS') {
      avisos.add('Uma conexão bancária precisa da sua atenção: entre em meu.pluggy.ai e refaça a conexão do banco. Até lá, os lançamentos novos não chegam.');
    } else if (st === 'OUTDATED') {
      avisos.add('Uma conexão bancária não conseguiu se atualizar. Abra o meu.pluggy.ai, atualize a conexão do banco e sincronize de novo.');
    } else if (idadeH !== null && idadeH > 48) {
      avisos.add('Os dados do banco estão com ' + Math.round(idadeH / 24) + ' dias. Abra o meu.pluggy.ai, atualize suas conexões e sincronize de novo.');
    }
    await sleep(400);
    const accs = await pget(`accounts?itemId=${encodeURIComponent(itemId)}`, apiKey);
    await sleep(400);
    for (const a of (accs && accs.results) || []) {
      const isCard = a.type === 'CREDIT';
      // via Meu Pluggy o conector vem como "MeuPluggy" — o nome real do banco está na própria conta
      const generico = !bank || /meu\s*pluggy/i.test(bank);
      const label = isCard
        ? ((generico ? '' : bank + ' ') + (a.name || 'Cartão')).trim()
        : (generico
            ? ((a.name || 'Conta') + (a.subtype === 'SAVINGS_ACCOUNT' ? ' — Poupança' : ''))
            : bank + ' ' + (a.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta'));
      if (!isCard) contas.push({ nome: label, banco: generico ? (a.name || '') : bank, saldo: Number(a.balance) || 0 });
      // cartão: janela maior para cobrir todo o ciclo aberto da fatura
      const d40 = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
      const fromAcc = isCard && d40 < from ? d40 : from;
      const cardRaw: any[] = [];
      let page = 1, totalPages = 1;
      while (page <= totalPages && page <= 10) {
        const t = await pget(`transactions?accountId=${encodeURIComponent(a.id)}&from=${fromAcc}&pageSize=500&page=${page}`, apiKey);
        await sleep(400);
        if (!t) break;
        totalPages = t.totalPages || 1;
        for (const x of t.results || []) {
          const date = String(x.date || '').slice(0, 10);
          if (!x.id || !date) continue;
          const amt = Math.abs(Number(x.amount) || 0);
          const tipoTx = (x.type === 'CREDIT' || Number(x.amount) > 0) ? (x.type === 'DEBIT' ? 'despesa' : 'receita') : 'despesa';
          if (isCard) cardRaw.push({ date, amt, type: x.type, status: String(x.status || ''), cat: String(x.category || '') });
          if (date < from) continue;
          if (String(x.status || '') === 'PENDING' && date > hoje) continue; // parcelas/fatura futura
          if (isInvest(x)) continue; // aplicação/resgate não entra no orçamento
          if (!amt) continue;
          out.push({
            id: x.id, date, desc: x.description || '', amount: amt,
            tipo: tipoTx, cat: x.category || null, conta: label,
            ctype: isCard ? 'CREDIT' : 'BANK',
          });
        }
        page++;
      }
      if (isCard) {
        // 1) fatura parcial via compras PENDING do ciclo (quando o conector as expõe)
        let fatura = 0;
        let nPend = 0;
        for (const c of cardRaw) {
          if (c.status === 'PENDING' && c.type === 'DEBIT' && c.amt > 0 && c.date <= hoje && c.cat !== 'Credit card payment') { fatura += c.amt; nPend++; }
        }
        let vence = nextDue(a.creditData && a.creditData.balanceDueDate, hoje);
        let fechada = false;
        if (fatura === 0) {
          // 2) endpoint oficial de faturas: a de vencimento futuro mais próximo é a atual
          const bills = await pget(`bills?accountId=${encodeURIComponent(a.id)}`, apiKey);
          await sleep(400);
          const brs = (bills && (bills.results || bills.bills)) || [];
          let cur: any = null;
          for (const b of brs) {
            const d = String(b.dueDate || b.due_date || '').slice(0, 10);
            const v = Math.abs(Number(b.totalAmount !== undefined ? b.totalAmount : (b.amount !== undefined ? b.amount : b.total)) || 0);
            if (d && d >= hoje && v > 0 && (!cur || d < cur.d)) cur = { d, v };
          }
          console.log('[fatura]', label, JSON.stringify({ nTx: cardRaw.length, nPend, vence, nBills: brs.length, billsAmostra: brs.slice(0, 3).map((b: any) => ({ due: b.dueDate, total: b.totalAmount })), cur }));
          if (cur) { fatura = cur.v; vence = cur.d; }
          else if (cardRaw.length === 0 && brs.length) {
            // sem compras individuais nesta via: mostra a última fatura FECHADA (ignora valores-lixo < R$1)
            let ult: any = null;
            for (const b of brs) {
              const d = String(b.dueDate || b.due_date || '').slice(0, 10);
              const v = Math.abs(Number(b.totalAmount !== undefined ? b.totalAmount : (b.amount !== undefined ? b.amount : b.total)) || 0);
              if (d && d < hoje && v >= 1 && (!ult || d > ult.d)) ult = { d, v };
            }
            if (ult) { fatura = ult.v; vence = ult.d; fechada = true; }
          }
          else if (vence) {
            // 3) estimativa: compras do ciclo (5 semanas antes do vencimento até hoje)
            const ini = new Date(new Date(vence + 'T12:00:00Z').getTime() - 37 * 864e5).toISOString().slice(0, 10);
            let nCiclo = 0;
            for (const c of cardRaw) {
              if (c.type !== 'CREDIT' && c.amt > 0 && c.date >= ini && c.date <= hoje && c.cat !== 'Credit card payment') { fatura += c.amt; nCiclo++; }
            }
            console.log('[fatura-estimativa]', label, JSON.stringify({ ini, hoje, nCiclo, fatura, amostraTx: cardRaw.slice(0, 3) }));
          }
        }
        cards.push({
          nome: label,
          fatura: Math.round(fatura * 100) / 100,
          vence,
          fechada,
          temCompras: cardRaw.length > 0,
          divida: Math.abs(Number(a.balance) || 0),
          limite: a.creditData ? (Number(a.creditData.creditLimit) || 0) : 0,
          disponivel: a.creditData ? (Number(a.creditData.availableCreditLimit) || 0) : 0,
          min: a.creditData ? (Number(a.creditData.minimumPayment) || 0) : 0,
        });
      }
    }
    // investimentos do item — informativo
    const inv = await pget(`investments?itemId=${encodeURIComponent(itemId)}`, apiKey);
    await sleep(400);
    for (const r of (inv && inv.results) || []) {
      const saldo = Number(r.balance) || 0;
      if (!saldo) continue;
      invest.push({
        nome: r.name || 'Investimento',
        banco: /meu\s*pluggy/i.test(bank) ? '' : bank,
        tipo: r.subtype || r.type || '',
        saldo: Math.round(saldo * 100) / 100,
        rent12: (r.lastTwelveMonthsRate === undefined || r.lastTwelveMonthsRate === null) ? null : Number(r.lastTwelveMonthsRate),
        vence: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
      });
    }
  }
  invest.sort((a, b) => b.saldo - a.saldo);
  return { ok: true, items: (link.item_ids || []).length, tx: out, cards, invest, contas, avisos: [...avisos] };
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
      // conexões antigas do Banco MCP (descontinuado) aparecem como "não conectado":
      // o usuário refaz a conexão pelo caminho gratuito da Pluggy
      if (!data || data.client_id === 'mcpai') return json({ linked: false });
      return json({ linked: true, provider: 'pluggy', items: (data.item_ids || []).length, last_sync: data.last_sync });
    }

    if (action === 'save') {
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
    if (!link || link.client_id === 'mcpai') return json({ error: 'not_linked' }, 400);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : new Date().toISOString().slice(0, 8) + '01';

    const result: any = await pluggySync(link, from);
    if (result.error) return json({ error: result.error }, 400);
    await supa.from('bank_link').update({ last_sync: new Date().toISOString() }).eq('user_id', uid);
    return json({ ok: true, items: result.items, tx: result.tx, cards: result.cards, invest: result.invest || [], contas: result.contas || [], avisos: result.avisos || [] });
  } catch (_e) {
    return json({ error: 'internal' }, 500);
  }
});
