# Sobra — esteira de deploy Blue-Green (Vercel + GitHub)

App: **Sobra** — orçamento mensal em 3 segundos (PWA, dados 100% no dispositivo).

## Como funciona a esteira

A Vercel cria um deploy **imutável** para cada commit. A infra blue-green fica assim:

| Ambiente | Branch | URL | Papel |
|---|---|---|---|
| 🟢 **Green** (pré-produção) | `staging` | URL de preview gerada a cada push (ex.: `sobra-git-staging-<conta>.vercel.app`) | Validar a nova versão com tráfego zero de usuários |
| 🔵 **Blue** (produção) | `main` | `https://sobra-<conta>.vercel.app` (domínio de produção) | Versão estável que os usuários acessam |

## Fluxo de release

1. **Suba a mudança para `staging`** (via upload no GitHub ou `git push origin staging`).
   → A Vercel gera automaticamente a URL de preview (ambiente green).
2. **Valide o green**: abra a URL de preview, teste lançamentos, envelopes, previsão.
3. **Promova para blue**: abra um Pull Request `staging → main` e faça o merge
   (ou `git push origin main`).
   → A Vercel publica em produção. A troca é atômica: o alias de produção passa a
   apontar para o novo deploy de uma vez, sem downtime.
4. **Rollback instantâneo**: painel Vercel → projeto **sobra** → aba *Deployments* →
   deploy anterior → menu ⋯ → **Instant Rollback**. O alias de produção volta ao
   deploy antigo em segundos (nenhum rebuild necessário).

## Promover um deploy específico (alternativa sem merge)

No painel da Vercel, qualquer deploy de preview pode virar produção:
*Deployments* → escolha o deploy validado → ⋯ → **Promote to Production**.

## Comandos úteis (Vercel CLI, opcional)

```bash
npm i -g vercel
vercel login                    # autentica no navegador
vercel deploy                   # deploy green (preview) da pasta atual
vercel promote <url-do-deploy>  # promove o green validado para produção (blue)
vercel rollback                 # volta a produção para o deploy anterior
```

## Observações

- Site 100% estático (HTML/CSS/JS puro) — sem build, sem servidor, sem banco.
- Os dados dos usuários ficam no `localStorage` do navegador de cada um; nada é
  enviado a servidores — deploys nunca afetam dados já lançados.
- O `sw.js` (service worker) é servido com `no-cache` (ver `vercel.json`) para que
  novas versões sejam detectadas imediatamente após um release.
