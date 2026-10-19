# Calendário de conteúdo · Spice

Gerador de calendário de Instagram para restaurantes. A pessoa responde as perguntas estratégicas,
deixa nome e contato na última etapa e recebe o calendário gerado com IA.

- `index.html`: o gerador (página pública).
- `leads.html`: lista de contatos e de quem desistiu no meio (protegida por senha).
- `api/spice.js`: salva respostas e contatos no Redis e gera o calendário com a API da Anthropic.

## Links

- `/?evento=mindhub`, `/?evento=jotaja`, `/?evento=delivery`: abrem só no dia do evento.
- `/?evento=geral` (ou só `/`): sempre aberto.
- Acrescente `&teste=1` para abrir um link de evento fora do dia.

## Configuração na Vercel

1. Importar este repositório como projeto novo (Framework: Other, sem build).
2. Storage → criar um banco Redis (Upstash) e conectar ao projeto.
3. Settings → Environment Variables:
   - `ANTHROPIC_API_KEY`: chave criada em console.anthropic.com.
   - `SPICE_ADMIN_TOKEN`: senha para abrir `/leads.html`.
   - `SPICE_LIMITE_DIARIO` (opcional): máximo de gerações por dia (padrão 600).
4. Redeploy.

Sem `ANTHROPIC_API_KEY`, o gerador continua salvando contatos e mostra um calendário de exemplo.
