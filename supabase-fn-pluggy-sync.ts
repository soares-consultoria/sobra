// Sobra · Edge Function "pluggy-sync"
// Ponte segura entre o app e a API da Pluggy (Meu Pluggy).
// Os códigos (client_id/client_secret) de cada usuário ficam na tabela bank_link,
// acessível apenas por esta função (service role) — nunca pelo navegador.
//
// Ações (POST, JSON):
//   {action:'status'}                                    -> {linked, items, last_sync}
//   {action:'save', client_id, client_secret, item_ids}  -> {ok} | {error:'invalid_credentials'}
//   {action:'delete'}                                    -> {ok}
//   {action:'sync', from:'YYYY-MM-DD'}                   -> {ok, items, tx:[{id,date,desc,amount,tipo,cat,conta}]}

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function pluggyAuth(clientId: string, clientSecret: string): Promise<string | null> {
  const r = await fetch('https://api.pluggy.ai/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.apiKey || null;
}

async function pget(path: string, apiKey: string): Promise<any | null> {
  const r = await fetch('https://api.pluggy.ai/' + path, { headers: { 'X-API-KEY': apiKey } });
  if (!r.ok) return null;
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // identifica o usuário pelo token da sessão
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: uerr } = await supa.auth.getUser(token);
    if (uerr || !userData?.user) return json({ error: 'unauthorized' }, 401);
    const uid = userData.user.id;

    const body = await req.json().catch(() => ({} as any));
    const action = body.action || 'sync';

    if (action === 'status') {
      const { data } = await supa.from('bank_link').select('item_ids,last_sync').eq('user_id', uid).maybeSingle();
      if (!data) return json({ linked: false });
      return json({ linked: true, items: (data.item_ids || []).length, last_sync: data.last_sync });
    }

    if (action === 'save') {
      const client_id = String(body.client_id || '').trim();
      const client_secret = String(body.client_secret || '').trim();
      const item_ids = Array.isArray(body.item_ids) ? body.item_ids.map((s: string) => String(s).trim()).filter(Boolean) : [];
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
    const apiKey = await pluggyAuth(link.client_id, link.client_secret);
    if (!apiKey) return json({ error: 'invalid_credentials' }, 400);

    const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || '') ? body.from : new Date().toISOString().slice(0, 8) + '01';
    const out: any[] = [];

    for (const itemId of link.item_ids || []) {
      const accs = await pget(`accounts?itemId=${encodeURIComponent(itemId)}`, apiKey);
      for (const a of accs?.results || []) {
        let page = 1, totalPages = 1;
        while (page <= totalPages && page <= 10) {
          const t = await pget(`transactions?accountId=${encodeURIComponent(a.id)}&from=${from}&pageSize=500&page=${page}`, apiKey);
          if (!t) break;
          totalPages = t.totalPages || 1;
          for (const x of t.results || []) {
            out.push({
              id: x.id,
              date: String(x.date || '').slice(0, 10),
              desc: x.description || '',
              amount: Math.abs(Number(x.amount) || 0),
              tipo: (x.type === 'CREDIT') ? 'receita' : 'despesa',
              cat: x.category || null,
              conta: a.name || '',
              ctype: a.type || '',
            });
          }
          page++;
        }
      }
    }

    await supa.from('bank_link').update({ last_sync: new Date().toISOString() }).eq('user_id', uid);
    return json({ ok: true, items: (link.item_ids || []).length, tx: out });
  } catch (e) {
    return json({ error: 'internal' }, 500);
  }
});
