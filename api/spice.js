import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';

// Gerador de calendário de conteúdo da Spice (página em /).
// POST { etapa: 'parcial' | 'lead' | 'estrategia' | 'semana', ... }
// GET  ?token=SPICE_ADMIN_TOKEN  -> lista de contatos e respostas (página /leads.html)

export const config = { maxDuration: 120 };

const MODEL = 'claude-opus-5-5';
const LIMITE_POR_SESSAO = 15;       // gerações por visitante por dia
const LIMITE_DIARIO = Number(process.env.SPICE_LIMITE_DIARIO || 600);
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const sessaoOk = s => typeof s === 'string' && /^[a-z0-9-]{8,64}$/i.test(s);
const curto = (v, n = 200) => String(v == null ? '' : v).slice(0, n);

function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

/* ---------- contatos e respostas parciais ---------- */

async function salvarRegistro(redis, sessao, campos) {
  const chave = 'spice:lead:' + sessao;
  const atual = (await redis.get(chave)) || { sessao, criadoEm: new Date().toISOString(), status: 'parcial' };
  const novo = { ...atual, ...campos, atualizadoEm: new Date().toISOString() };
  if (atual.status === 'completo') novo.status = 'completo';   // parcial nunca rebaixa um lead completo
  if (atual.respostas || campos.respostas) novo.respostas = { ...(atual.respostas || {}), ...(campos.respostas || {}) };
  await redis.set(chave, novo);
  await redis.zadd('spice:sessoes', { score: Date.now(), member: sessao });
}

function limparRespostas(r) {
  const out = {};
  if (!r || typeof r !== 'object') return out;
  for (const [k, v] of Object.entries(r).slice(0, 40)) {
    out[curto(k, 40)] = Array.isArray(v) ? v.slice(0, 10).map(x => curto(x)) : curto(v);
  }
  return out;
}

function limparLead(l) {
  if (!l || typeof l !== 'object') return null;
  return {
    nome: curto(l.nome, 80), instagram: curto(l.instagram, 60), whatsapp: curto(l.whatsapp, 20).replace(/\D/g, ''),
    tipo: curto(l.tipo, 60), perfil: curto(l.perfil, 60), icp: !!l.icp
  };
}

/* ---------- geração com IA ---------- */

const isoParaData = iso => new Date(iso + 'T12:00:00Z');
const dm = d => String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0');

// Mesma regra do front: blocos de até 7 dias, conteúdos distribuídos proporcionalmente.
function plano(inicio, fim, total) {
  const dias = Math.round((isoParaData(fim) - isoParaData(inicio)) / 86400000) + 1;
  const blocos = [];
  for (let s = 0; s < dias; s += 7) blocos.push({ n: blocos.length + 1, ini: s, len: Math.min(7, dias - s) });
  const raw = blocos.map(b => total * b.len / dias);
  const q = raw.map(Math.floor);
  let resto = total - q.reduce((a, b) => a + b, 0);
  const ordem = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < ordem.length && resto > 0; k++, resto--) q[ordem[k][1]]++;
  return blocos.map((b, i) => {
    const datas = [];
    for (let d = 0; d < b.len; d++) {
      const x = isoParaData(inicio); x.setUTCDate(x.getUTCDate() + b.ini + d);
      datas.push(dm(x) + ' (' + DIAS[x.getUTCDay()] + ')');
    }
    return { n: b.n, qtd: q[i], datas };
  });
}

function validarPeriodo(d) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(d.inicio || '') || !iso.test(d.fim || '')) return 'Período inválido.';
  const dias = Math.round((isoParaData(d.fim) - isoParaData(d.inicio)) / 86400000) + 1;
  const total = Number(d.total);
  if (dias < 1 || dias > 30) return 'O período precisa ter de 1 a 30 dias.';
  if (!(total >= 1 && total <= 15 && total <= dias)) return 'Quantidade de conteúdos inválida.';
  return '';
}

function perfilTexto(dados, lead, evento) {
  const linhas = [
    ['Tipo de restaurante', dados.tipo], ['Prato ou produto mais pedido', dados.campeao], ['Bairro e cidade', dados.bairro],
    ['Como vende', dados.operacao], ['Tempo de casa', dados.tempo],
    ['Cliente ideal', dados.faixa], ['Maior problema', dados.dor], ['Como é descoberto', dados.descoberta],
    ['Ticket médio', dados.ticket], ['Diferencial', dados.diferencial], ['Tom desejado', dados.tom],
    ['Quer vender', dados.vender], ['Concorrência', dados.concorrencia], ['Instagram hoje', dados.status],
    ['Não quer mostrar', dados.naoMostrar], ['O que já funcionou', dados.funcionou], ['Objetivo', dados.objetivo],
    ['Maior trava', dados.obstaculo], ['Quanto quer aparecer', dados.aparecer],
    ['Formatos preferidos', Array.isArray(dados.formatos) ? dados.formatos.join(', ') : dados.formatos],
    ['Instagram', lead && lead.instagram]
  ];
  let t = linhas.filter(([, v]) => v).map(([k, v]) => '- ' + k + ': ' + curto(v)).join('\n');
  if (evento === 'jotaja') t += '\n- Contexto: lead do evento JOTAJA (hamburguerias). Classifique cada post como entrada (atração), prato_principal (venda) ou sobremesa (fidelização).';
  if (evento === 'delivery') t += '\n- Contexto: evento MindHub Delivery. Priorize conteúdos que geram pedidos no delivery próprio.';
  return t;
}

const SISTEMA = `Você é estrategista de conteúdo da Spice, agência de marketing gastronômico do Rio de Janeiro.
Você cria calendários de Instagram para restaurantes, bares, hamburguerias e similares. Quem recebe é o dono, e ele precisa terminar a leitura com vontade de gravar.

Regras de qualidade:
- Nada genérico. Cada post precisa citar algo concreto deste restaurante: o prato mais pedido, o bairro, o diferencial, o problema que o dono contou ou o tipo de cliente. Se o post servisse para qualquer outro restaurante, reescreva.
- O gancho é a frase exata dita ou escrita na tela nos 3 primeiros segundos. Precisa gerar curiosidade, tensão ou identificação, em no máximo 12 palavras. Proibido abrir com "Venha conhecer", "Você sabia que somos", "Confira", "Olha só", "Bom dia", nome do restaurante ou adjetivos vazios (delicioso, irresistível, o melhor da cidade, qualidade e sabor).
- O roteiro diz o que gravar, cena por cena, em 2 a 4 passos curtos, possível de fazer com celular em menos de 30 minutos. Respeite o que o dono não quer mostrar e o quanto ele quer aparecer.
- A legenda é pronta para copiar: começa reforçando o gancho, entrega o contexto em 2 a 4 frases e termina no CTA.
- O CTA é uma única ação, ligada ao objetivo do dono (reservar, pedir pelo WhatsApp, salvar, marcar alguém, responder enquete).
- Não repita estrutura, gancho ou ideia entre posts. Varie formato, ângulo e tipo de gancho.
- Não invente preços, prêmios, números de vendas ou fatos sobre o restaurante. Pode sugerir que o dono mostre o preço real dele.
- Português do Brasil, linguagem de quem trabalha em restaurante, sem jargão de marketing. Hashtags: 3 a 5, específicas (prato, bairro, cidade).`;

// O que cada objetivo pede do calendário. Muda os temas, os ângulos e os CTAs de cada pessoa.
const PLANO_OBJETIVO = {
  'Encher o salão': 'Levar gente para o salão, principalmente nos dias fracos. Ângulos: a experiência que só existe no local (cheiro, som, ambiente, prato chegando à mesa), motivos para vir num dia específico da semana, grupos e aniversários, reserva fácil. CTAs de reserva, de marcar quem vem junto e de salvar para o fim de semana.',
  'Mais pedidos no delivery próprio': 'Gerar pedidos pelo canal próprio (WhatsApp ou link). Ângulos: o pedido chegando inteiro e quente, combos para dividir, o momento certo de pedir (jogo, chuva, noite de série), facilidade de pedir direto. CTAs de pedir pelo WhatsApp ou link da bio.',
  'Depender menos dos apps': 'Migrar o cliente dos apps para o canal próprio sem atacar os apps. Ângulos: vantagem exclusiva de quem pede direto, atendimento de gente de verdade, bastidor que o app não mostra, programa de fidelidade. CTAs de salvar o WhatsApp e pedir direto.',
  'Fazer o cliente voltar': 'Fidelizar quem já conhece. Ângulos: clientes reais e frequentes, novidades que dão motivo para voltar, rituais da casa, comunidade e pertencimento, pedido favorito do cliente. CTAs de comentar, marcar e participar.',
  'Lançar cardápio ou item novo': 'Lançar um item com sequência de expectativa. Ângulos: teaser sem revelar, bastidor do teste da receita, revelação, primeira reação de cliente, escassez real. CTAs de ativar lembrete, comentar e reservar ou pedir o lançamento.',
  'Ser referência no bairro': 'Virar a referência do bairro no tipo de comida. Ângulos: história e origem, conhecimento técnico do produto explicado de forma simples, conexão com o bairro e vizinhos, opinião forte sobre o próprio produto, parcerias locais. CTAs de salvar, compartilhar e seguir.'
};

// Tipos de gancho. Cada post recebe um diferente, numa ordem própria de cada visitante.
const GANCHOS = [
  'segredo ou bastidor ("o que ninguém vê antes de abrir")',
  'erro comum do cliente ("você está pedindo X do jeito errado")',
  'lista com número ("3 coisas que...")',
  'POV de uma situação do cliente ideal',
  'contraste ou antes e depois',
  'pergunta ou enquete que divide opiniões',
  'reação ou fala real de cliente',
  'desafio, teste ou cronômetro',
  'mito ou verdade sobre o produto',
  'história do dono ou da origem da receita',
  'detalhe extremo em close (som, textura, ponto)',
  'urgência real (dia, horário ou quantidade limitada que a casa de fato tem)'
];

function semente(texto) {
  let h = 0;
  for (const c of String(texto || 'x')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const SCHEMA_ESTRATEGIA = {
  type: 'object', additionalProperties: false,
  required: ['posicionamento', 'tom_de_voz', 'pilares', 'temas_semanais'],
  properties: {
    posicionamento: { type: 'string', description: 'Uma frase de posicionamento específica deste restaurante.' },
    tom_de_voz: { type: 'string', description: 'Como o perfil deve soar, em uma ou duas frases, com um exemplo de fala.' },
    pilares: { type: 'array', items: { type: 'string' }, description: '3 a 5 pilares de conteúdo ligados ao objetivo.' },
    temas_semanais: { type: 'array', items: { type: 'string' }, description: 'Um tema por semana, na ordem, formando uma progressão até o objetivo.' }
  }
};

const SCHEMA_SEMANA = {
  type: 'object', additionalProperties: false, required: ['tema', 'posts'],
  properties: {
    tema: { type: 'string' },
    posts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['data', 'formato', 'titulo', 'gancho', 'roteiro', 'legenda', 'cta', 'hashtags', 'categoria'],
        properties: {
          data: { type: 'string', description: 'Data no formato DD/MM, uma das datas permitidas.' },
          formato: { type: 'string', enum: ['Reels', 'Carrossel', 'Foto', 'Stories'] },
          titulo: { type: 'string', description: 'Nome curto da ideia, para o dono identificar o post.' },
          gancho: { type: 'string', description: 'Frase exata dos 3 primeiros segundos ou da primeira tela.' },
          roteiro: { type: 'array', items: { type: 'string' }, description: '2 a 4 passos do que gravar ou de cada tela do carrossel.' },
          legenda: { type: 'string', description: 'Legenda pronta para copiar.' },
          cta: { type: 'string' },
          hashtags: { type: 'string' },
          categoria: { type: 'string', enum: ['entrada', 'prato_principal', 'sobremesa'] }
        }
      }
    }
  }
};

async function gerarJSON(prompt, schema) {
  const client = new Anthropic();
  const resp = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system: SISTEMA,
    messages: [{ role: 'user', content: prompt }]
  });
  if (resp.stop_reason === 'refusal') throw new Error('A IA recusou o pedido.');
  const texto = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(texto);
}

async function dentroDoLimite(redis, sessao) {
  if (!redis) return true;
  const dia = new Date().toISOString().slice(0, 10);
  const [porSessao, global] = await Promise.all([
    redis.incr('spice:uso:' + dia + ':' + sessao), redis.incr('spice:uso:' + dia)
  ]);
  if (porSessao === 1) await redis.expire('spice:uso:' + dia + ':' + sessao, 172800);
  if (global === 1) await redis.expire('spice:uso:' + dia, 172800);
  return porSessao <= LIMITE_POR_SESSAO && global <= LIMITE_DIARIO;
}

/* ---------- handler ---------- */

export default async function handler(req, res) {
  const redis = getRedis();

  if (req.method === 'GET') {
    const token = process.env.SPICE_ADMIN_TOKEN;
    if (!token || req.query.token !== token) return res.status(401).json({ error: 'Acesso negado.' });
    if (!redis) return res.status(500).json({ error: 'Banco de dados não conectado.' });
    const ids = await redis.zrange('spice:sessoes', 0, 999, { rev: true });
    const registros = ids.length ? await redis.mget(...ids.map(id => 'spice:lead:' + id)) : [];
    return res.status(200).json({ registros: registros.filter(Boolean) });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end('Method not allowed');
  }

  const body = lerCorpo(req);
  const etapa = body.etapa;
  const evento = curto(body.evento, 20);

  try {
    if (etapa === 'parcial' || etapa === 'lead') {
      const sessao = etapa === 'lead' ? body.lead && body.lead.sessao : body.sessao;
      if (!sessaoOk(sessao)) return res.status(400).json({ error: 'Sessão inválida.' });
      if (!redis) return res.status(500).json({ error: 'Banco de dados não conectado.' });
      if (etapa === 'parcial') {
        await salvarRegistro(redis, sessao, { evento, etapaAtual: Number(body.etapaAtual) || null, respostas: limparRespostas(body.respostas) });
      } else {
        const lead = limparLead(body.lead);
        await salvarRegistro(redis, sessao, { evento: curto(body.lead.evento, 20), status: 'completo', lead, respostas: { nome: lead.nome, whatsapp: lead.whatsapp, instagram: lead.instagram, perfil: lead.perfil } });
      }
      return res.status(200).json({ ok: true });
    }

    if (etapa === 'estrategia' || etapa === 'semana') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ demo: true, error: 'IA não configurada.' });
      const dados = body.dados || {};
      const erroPeriodo = validarPeriodo(dados);
      if (erroPeriodo) return res.status(400).json({ error: erroPeriodo });
      const lead = limparLead(body.lead);
      const sessao = body.lead && body.lead.sessao;
      if (!(await dentroDoLimite(redis, sessaoOk(sessao) ? sessao : 'anon'))) {
        return res.status(429).json({ error: 'Limite de gerações atingido. Tente de novo amanhã.' });
      }
      const blocos = plano(dados.inicio, dados.fim, Number(dados.total)).filter(b => b.qtd > 0);
      const perfil = perfilTexto(dados, lead, evento);
      const planoObjetivo = PLANO_OBJETIVO[dados.objetivo] || 'Atingir o objetivo que o dono descreveu.';

      if (etapa === 'estrategia') {
        if (redis && sessaoOk(sessao) && lead) await salvarRegistro(redis, sessao, { evento, status: 'completo', lead });
        const prompt = `Perfil do restaurante:\n${perfil}\n\nO que o objetivo "${curto(dados.objetivo)}" pede: ${planoObjetivo}\n\n` +
          `O calendário tem ${blocos.length} semana(s). Defina o posicionamento, o tom de voz, de 3 a 5 pilares de conteúdo e exatamente ` +
          `${blocos.length} tema(s) semanal(is), em ordem, formando uma progressão que leve ao objetivo e ataque o maior problema do dono. ` +
          `Tudo precisa ser específico deste restaurante, nunca uma estratégia que serviria para qualquer um.`;
        return res.status(200).json({ data: await gerarJSON(prompt, SCHEMA_ESTRATEGIA) });
      }

      const bloco = blocos.find(b => b.n === Number(body.semana));
      if (!bloco) return res.status(400).json({ error: 'Semana inválida.' });
      const est = body.estrategia || {};
      const formatos = Array.isArray(dados.formatos) && dados.formatos.length ? dados.formatos.join(', ') : 'Reels, Carrossel, Foto';
      // Tipos de gancho deste bloco: seguem a numeração global do post e uma ordem própria de cada visitante.
      const antes = blocos.filter(b => b.n < bloco.n).reduce((a, b) => a + b.qtd, 0);
      const base = semente(sessao) % GANCHOS.length;
      const ganchos = Array.from({ length: bloco.qtd }, (_, i) => 'post ' + (i + 1) + ': ' + GANCHOS[(base + (antes + i) * 5) % GANCHOS.length]);
      const prompt = `Perfil do restaurante:\n${perfil}\n\nO que o objetivo "${curto(dados.objetivo)}" pede: ${planoObjetivo}\n\n` +
        `Estratégia definida:\n- Posicionamento: ${curto(est.posicionamento, 400)}\n` +
        `- Tom de voz: ${curto(est.tom_de_voz, 400)}\n- Pilares: ${(est.pilares || []).map(p => curto(p)).join('; ')}\n` +
        `- Tema desta semana: ${curto((est.temas_semanais || [])[bloco.n - 1])}\n\n` +
        `Crie exatamente ${bloco.qtd} post(s) para a semana ${bloco.n}. Datas permitidas: ${bloco.datas.join(', ')}. ` +
        `No máximo 1 post por data; espalhe os posts pela semana. Use só estes formatos: ${formatos}. ` +
        `Tipo de gancho de cada post, na ordem das datas: ${ganchos.join('; ')}. ` +
        `Cada post precisa avançar o objetivo e citar algo concreto do perfil (prato mais pedido, bairro, diferencial ou o problema do dono). ` +
        `No campo data, escreva só DD/MM.`;
      return res.status(200).json({ data: await gerarJSON(prompt, SCHEMA_SEMANA) });
    }

    return res.status(400).json({ error: 'Etapa desconhecida.' });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Muita gente gerando agora. Tente em alguns segundos.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: 'Erro na IA (' + err.status + ').' });
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}
