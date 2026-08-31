import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalysis } from './analytics.js';
import { makeXlsx } from './xlsx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'surveys.json'), 'utf8'));
const surveys = config.surveys;
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const hasDbParts = process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME;
if (!DATABASE_URL && !hasDbParts) {
  console.error('Database settings are required: DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME');
  process.exit(1);
}

const poolConfig = DATABASE_URL ? { connectionString: DATABASE_URL } : {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
};
poolConfig.max = Number(process.env.DB_POOL_MAX || 10);
poolConfig.idleTimeoutMillis = 30000;
poolConfig.connectionTimeoutMillis = 10000;
const explicitSsl = process.env.DATABASE_SSL;
if (explicitSsl === 'true' || (!DATABASE_URL && explicitSsl !== 'false')) {
  poolConfig.ssl = { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' };
}
const pool = new Pool(poolConfig);
pool.on('error', (err) => console.error(JSON.stringify({ event: 'postgres_pool_error', message: err.message })));

const schemaSql = `
CREATE TABLE IF NOT EXISTS survey_sessions (
  id UUID PRIMARY KEY,
  flow TEXT NOT NULL DEFAULT 'main',
  locale TEXT,
  workplace TEXT,
  tenure TEXT,
  survey_id TEXT,
  intro_seen BOOLEAN NOT NULL DEFAULT FALSE,
  active_block_id TEXT,
  trust_intro_seen BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS survey_answers (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES survey_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  answer JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_answers_session ON survey_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_survey_sessions_survey ON survey_sessions(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_sessions_started ON survey_sessions(started_at);
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

class PostgresStore {
  constructor(poolRef) { this.pool = poolRef; }
  rowSession(r) {
    if (!r) return null;
    return {
      ...r,
      intro_seen: Boolean(r.intro_seen),
      trust_intro_seen: Boolean(r.trust_intro_seen),
      completed: Boolean(r.completed)
    };
  }
  answerRow(r) {
    if (!r) return null;
    return { ...r, answer: r.answer };
  }
  async getSession(id) {
    const { rows } = await this.pool.query('SELECT * FROM survey_sessions WHERE id = $1', [id]);
    return this.rowSession(rows[0]);
  }
  async createSession(s) {
    await this.pool.query(`INSERT INTO survey_sessions
      (id,flow,locale,workplace,tenure,survey_id,intro_seen,active_block_id,trust_intro_seen,completed,started_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [s.id, s.flow || 'main', s.locale || null, s.workplace || null, s.tenure || null, s.survey_id || null,
       Boolean(s.intro_seen), s.active_block_id || null, Boolean(s.trust_intro_seen), Boolean(s.completed), iso(s.started_at)]);
    return this.getSession(s.id);
  }
  async updateSession(id, patch) {
    const allowed = ['flow','locale','workplace','tenure','survey_id','intro_seen','active_block_id','trust_intro_seen','completed','completed_at'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getSession(id);
    const values = keys.map((k) => patch[k] instanceof Date ? patch[k].toISOString() : patch[k]);
    values.push(id);
    await this.pool.query(`UPDATE survey_sessions SET ${keys.map((k,i) => `${k} = $${i+1}`).join(', ')} WHERE id = $${keys.length+1}`, values);
    return this.getSession(id);
  }
  async listAnswers(id) {
    const { rows } = await this.pool.query('SELECT * FROM survey_answers WHERE session_id = $1 ORDER BY submitted_at, id', [id]);
    return rows.map((x) => this.answerRow(x));
  }
  async hasAnswer(sessionId, questionId) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM survey_answers WHERE session_id = $1 AND question_id = $2 LIMIT 1', [sessionId, questionId]);
    return rowCount > 0;
  }
  async insertAnswer(a) {
    const { rowCount } = await this.pool.query(`INSERT INTO survey_answers
      (session_id,question_id,block_id,answer,submitted_at) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (session_id,question_id) DO NOTHING RETURNING id`,
      [a.session_id, a.question_id, a.block_id, JSON.stringify(a.answer), iso(a.submitted_at)]);
    return rowCount === 1;
  }
  async summary() {
    const { rows } = await this.pool.query(`SELECT COALESCE(survey_id,'not_selected') survey_id,
      COUNT(*)::int started, COUNT(*) FILTER (WHERE completed = TRUE)::int completed
      FROM survey_sessions GROUP BY COALESCE(survey_id,'not_selected') ORDER BY survey_id`);
    return rows;
  }
  async exportSessions() {
    const { rows } = await this.pool.query('SELECT * FROM survey_sessions ORDER BY started_at,id');
    return rows.map((x) => this.rowSession(x));
  }
  async exportRows() {
    const { rows } = await this.pool.query(`SELECT a.*,s.survey_id,s.flow,s.locale,s.workplace,s.tenure,s.completed
      FROM survey_answers a JOIN survey_sessions s ON s.id=a.session_id ORDER BY a.id`);
    return rows.map((x) => ({ ...this.answerRow(x), completed: Boolean(x.completed) }));
  }
}

const store = new PostgresStore(pool);
function iso(v) { return v instanceof Date ? v.toISOString() : new Date(v).toISOString(); }
function flowHint(req) { return req.get('x-survey-flow') === 'commercial' ? 'commercial' : 'main'; }
function cookieName(flow) { return flow === 'commercial' ? 'dymov_commercial' : 'dymov_survey'; }
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[decodeURIComponent(part.slice(0,i).trim())] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function cookieHeader(req, id, flow) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return `${cookieName(flow)}=${encodeURIComponent(id)}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=2592000`;
}
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Frame-Options':'DENY',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cache-Control':'no-store'
  });
  if (req.secure || process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
}
function postAllowed(req) {
  if (req.get('x-survey-request') !== '1') return false;
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}
function isNewTenure(t) { return t === 'lt1m' || t === '1to3m'; }
function answerValue(row) { return row?.answer; }
function condMatches(cond, amap) {
  if (!cond) return true;
  const a = amap.get(cond.questionId); if (!a) return false;
  const v = answerValue(a); if (v && typeof v === 'object' && v.skipped) return false;
  if (Object.hasOwn(cond,'equals')) return v === cond.equals;
  if (Array.isArray(cond.in)) return cond.in.includes(v);
  return true;
}
function applicableBlocks(s, amap) { return s.blocks.filter((b) => condMatches(b.showIf, amap)); }
function applicableQuestions(b, amap) { return b.questions.filter((q) => condMatches(q.showIf, amap)); }
function trustBlock(locale) { return config.finalTrustBlocks?.[locale] || config.finalTrustBlocks?.ru; }
function uiFor(locale) { return config.ui?.[locale] || config.ui?.ru || {}; }
function validateAnswer(q, p) {
  if (p?.skipped === true) {
    if (q.required) return { ok:false, error:'required' };
    return { ok:true, value:{ skipped:true } };
  }
  const v = p?.value;
  if (q.kind === 'text') {
    if (typeof v !== 'string') return { ok:false,error:'invalid_text' };
    const x = v.trim(); if (q.required && !x) return { ok:false,error:'required' };
    if (x.length > (q.maxLength || 3000)) return { ok:false,error:'too_long' };
    return { ok:true,value:x };
  }
  if (q.kind === 'scale') {
    if (typeof v === 'string' && (q.special || []).includes(v)) return { ok:true,value:v };
    const n = Number(v); if (!Number.isInteger(n) || n < q.min || n > q.max) return { ok:false,error:'invalid_scale' };
    return { ok:true,value:n };
  }
  if (q.kind === 'single') {
    if (typeof v !== 'string' || !q.options.includes(v)) return { ok:false,error:'invalid_option' };
    return { ok:true,value:v };
  }
  if (q.kind === 'multi') {
    if (!Array.isArray(v)) return { ok:false,error:'invalid_multi' };
    const u = [...new Set(v)]; if (q.required && !u.length) return { ok:false,error:'required' };
    if (u.length > (q.maxSelections || 99)) return { ok:false,error:'too_many' };
    if (u.some((x) => !q.options.includes(x))) return { ok:false,error:'invalid_option' };
    return { ok:true,value:u };
  }
  return { ok:false,error:'invalid_kind' };
}
async function currentSession(req) {
  const flow = flowHint(req); const id = parseCookies(req)[cookieName(flow)];
  return id ? store.getSession(id) : null;
}

async function computeState(session) {
  if (!session) return { step:'language' };
  const ui = uiFor(session.locale);
  if (session.completed) return { step:'complete', locale:session.locale, ui };
  if (!session.intro_seen) return { step:'intro', locale:session.locale, ui, flow:session.flow };
  if (!session.survey_id) {
    if (session.flow === 'commercial') return { step:'error', locale:session.locale, ui };
    if (session.locale === 'ru') {
      if (!session.workplace || !session.tenure) return { step:'route', locale:'ru', ui, routeMode:'ru' };
      const surveyId = isNewTenure(session.tenure) ? 'newcomer_ru' : (session.workplace === 'office' ? 'office_full_ru' : 'production_business_ru');
      const next = await store.updateSession(session.id,{survey_id:surveyId});
      return computeState(next);
    }
    if (session.locale === 'kk') {
      const next = await store.updateSession(session.id,{workplace:'production',survey_id:'production_simple_kk'});
      return computeState(next);
    }
    return { step:'error', locale:session.locale, ui };
  }
  const survey = surveys[session.survey_id];
  if (!survey) return { step:'error', locale:session.locale, ui };
  const answers = await store.listAnswers(session.id);
  const amap = new Map(answers.map((a) => [a.question_id,a]));
  const answered = new Set(answers.map((a) => a.question_id));
  const blocks = applicableBlocks(survey, amap);
  const states = blocks.map((b) => {
    const qs = applicableQuestions(b, amap);
    return { id:b.id,title:b.title,total:qs.length,answered:qs.filter((q) => answered.has(q.id)).length,completed:qs.every((q) => answered.has(q.id)) };
  });
  if (session.active_block_id) {
    const tb = trustBlock(session.locale);
    const block = session.active_block_id === 'trust' ? tb : blocks.find((b) => b.id === session.active_block_id);
    if (block) {
      const qs = session.active_block_id === 'trust' ? tb.questions : applicableQuestions(block, amap);
      const q = qs.find((x) => !answered.has(x.id));
      if (q) {
        const totalBase = blocks.reduce((n,b) => n + applicableQuestions(b,amap).length,0);
        return { step:'question', locale:session.locale, ui, survey:{id:survey.id,title:survey.title}, block:{id:block.id,title:block.title}, question:q,
          questionIndex:qs.findIndex((x) => x.id === q.id)+1, questionTotal:qs.length, progress:{answered:answers.length,total:totalBase+tb.questions.length} };
      }
    }
    await store.updateSession(session.id,{active_block_id:null});
    session = { ...session, active_block_id:null };
  }
  const allDone = states.every((b) => b.completed);
  if (allDone) {
    const tb = trustBlock(session.locale);
    const trustDone = tb.questions.every((q) => answered.has(q.id));
    if (trustDone) {
      await store.updateSession(session.id,{completed:true,completed_at:new Date()});
      return { step:'complete',locale:session.locale,ui };
    }
    if (!session.trust_intro_seen) return { step:'trust_intro',locale:session.locale,ui };
    await store.updateSession(session.id,{active_block_id:'trust'});
    return computeState(await store.getSession(session.id));
  }
  const totalBase = blocks.reduce((n,b) => n + applicableQuestions(b,amap).length,0);
  return { step:'toc',locale:session.locale,ui,survey:{id:survey.id,title:survey.title,estimatedMinutes:survey.estimatedMinutes},blocks:states,
    progress:{answered:answers.length,total:totalBase+trustBlock(session.locale).questions.length} };
}

const meta = {
  title:'Дымов 25. Честно о работе и не только',
  languages:[{id:'ru',label:'Русский'},{id:'kk',label:'Қазақша'}],
  tenures:[['lt1m','Менее 1 месяца'],['1to3m','От 1 до 3 месяцев'],['3to12m','От 3 месяцев до 1 года'],['1to3y','От 1 года до 3 лет'],['3to5y','От 3 до 5 лет'],['gt5y','Более 5 лет']],
  officeSurvey:{id:'office_full_ru',title:surveys.office_full_ru.title,time:surveys.office_full_ru.estimatedMinutes},
  commercialTime:surveys.commercial_ru.estimatedMinutes,
  ui:config.ui
};

function digest(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEq(a,b) { return crypto.timingSafeEqual(digest(a),digest(b)); }
function adminOK(req) {
  const pass = process.env.ADMIN_PASSWORD; if (!pass) return false;
  const user = process.env.ADMIN_USER || 'admin'; const h = req.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded=''; try { decoded = Buffer.from(h.slice(6),'base64').toString('utf8'); } catch { return false; }
  const i=decoded.indexOf(':'); if(i<0)return false;
  return safeEq(decoded.slice(0,i), user) && safeEq(decoded.slice(i+1), pass);
}
function esc(v){return String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function csvCell(v){const s=typeof v==='string'?v:JSON.stringify(v);return `"${String(s??'').replace(/"/g,'""')}"`;}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit:'96kb', type:'application/json' }));

app.get('/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.status(200).json({ok:true,service:'dymov-25-survey',database:'ok'}); }
  catch { res.status(503).json({ok:false,service:'dymov-25-survey',database:'unavailable'}); }
});
app.get('/api/meta', (req,res) => res.json(meta));
app.get('/api/state', async (req,res,next) => { try { res.json(await computeState(await currentSession(req))); } catch(e) { next(e); } });

app.use('/api', (req,res,next) => {
  if (req.method === 'POST' && !postAllowed(req)) return res.status(403).json({error:'invalid_request'});
  next();
});

app.post('/api/language', async (req,res,next) => {
  try {
    if (await currentSession(req)) return res.status(409).json({error:'session_exists'});
    const locale=req.body?.locale,flow=req.body?.flow==='commercial'?'commercial':'main';
    if(!['ru','kk'].includes(locale))return res.status(400).json({error:'invalid_locale'});
    if(flow==='commercial'&&locale!=='ru')return res.status(400).json({error:'commercial_ru_only'});
    const id=crypto.randomUUID();
    const s=await store.createSession({id,flow,locale,workplace:flow==='commercial'?'commercial':(locale==='kk'?'production':null),tenure:null,
      survey_id:flow==='commercial'?'commercial_ru':(locale==='kk'?'production_simple_kk':null),intro_seen:false,active_block_id:null,trust_intro_seen:false,completed:false,started_at:new Date()});
    res.set('Set-Cookie',cookieHeader(req,id,flow));
    res.json(await computeState(s));
  } catch(e){next(e);}
});
app.post('/api/intro', async (req,res,next) => {
  try { const s=await currentSession(req);if(!s)return res.status(401).json({error:'no_session'});res.json(await computeState(await store.updateSession(s.id,{intro_seen:true}))); }
  catch(e){next(e);}
});
app.post('/api/route', async (req,res,next) => {
  try {
    const s=await currentSession(req);if(!s||!s.intro_seen)return res.status(401).json({error:'no_session'});
    if(s.locale!=='ru')return res.status(400).json({error:'route_ru_only'});
    const tenure=req.body?.tenure;if(!['lt1m','1to3m','3to12m','1to3y','3to5y','gt5y'].includes(tenure))return res.status(400).json({error:'invalid_tenure'});
    const workplace=req.body?.workplace;if(!['office','production'].includes(workplace))return res.status(400).json({error:'invalid_workplace'});
    const surveyId=isNewTenure(tenure)?'newcomer_ru':(workplace==='office'?'office_full_ru':'production_business_ru');
    return res.json(await computeState(await store.updateSession(s.id,{workplace,tenure,survey_id:surveyId})));
  } catch(e){next(e);}
});
app.post('/api/block', async (req,res,next) => {
  try {
    const s=await currentSession(req);if(!s?.survey_id)return res.status(401).json({error:'no_session'});if(s.active_block_id)return res.status(409).json({error:'block_in_progress'});
    const survey=surveys[s.survey_id],answers=await store.listAnswers(s.id),amap=new Map(answers.map((a)=>[a.question_id,a]));
    const block=applicableBlocks(survey,amap).find((x)=>x.id===req.body?.blockId);if(!block)return res.status(404).json({error:'block_not_found'});
    const qs=applicableQuestions(block,amap),ans=new Set(answers.map((a)=>a.question_id));if(qs.every((q)=>ans.has(q.id)))return res.status(409).json({error:'block_completed'});
    return res.json(await computeState(await store.updateSession(s.id,{active_block_id:block.id})));
  } catch(e){next(e);}
});
app.post('/api/trust-intro', async (req,res,next) => {
  try { const s=await currentSession(req);if(!s?.survey_id)return res.status(401).json({error:'no_session'});res.json(await computeState(await store.updateSession(s.id,{trust_intro_seen:true,active_block_id:'trust'}))); }
  catch(e){next(e);}
});
app.post('/api/answer', async (req,res,next) => {
  try {
    const s=await currentSession(req);if(!s?.survey_id||!s.active_block_id)return res.status(409).json({error:'no_active_question'});
    const state=await computeState(s);if(state.step!=='question')return res.status(409).json({error:'no_active_question'});
    const q=state.question;if(req.body?.questionId!==q.id)return res.status(409).json({error:'question_not_current'});
    if(await store.hasAnswer(s.id,q.id))return res.status(409).json({error:'answer_locked'});
    const v=validateAnswer(q,req.body);if(!v.ok)return res.status(400).json({error:v.error});
    const ok=await store.insertAnswer({session_id:s.id,question_id:q.id,block_id:state.block.id,answer:v.value,submitted_at:new Date()});
    if(!ok)return res.status(409).json({error:'answer_locked'});
    return res.json(await computeState(await store.getSession(s.id)));
  } catch(e){next(e);}
});

app.use('/admin', async (req,res,next) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).type('text').send('ADMIN_PASSWORD is not configured');
  if (!adminOK(req)) { res.set('WWW-Authenticate','Basic realm="Dymov Survey Admin"'); return res.status(401).type('text').send('Authorization required'); }
  next();
});
app.get('/admin', async (req,res,next) => {
  try {
    const rows=await store.summary();
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dymov Survey Admin</title><style>body{font:15px system-ui;max-width:1050px;margin:40px auto;padding:0 18px;color:#202020}h1{font-size:28px}table{border-collapse:collapse;width:100%;margin:24px 0}th,td{padding:11px;border-bottom:1px solid #ddd;text-align:left}th{background:#b51f24;color:#fff}.btn{display:inline-block;padding:12px 15px;border:1px solid #ccc;border-radius:10px;text-decoration:none;margin:0 8px 8px 0;color:#9b181d;font-weight:700}</style><h1>Дымов 25 — результаты опросов</h1><p><a class="btn" href="/admin/export.xlsx">Скачать полный Excel</a><a class="btn" href="/admin/export-long.csv">CSV: ответы LONG</a></p><table><tr><th>Версия</th><th>Начато</th><th>Завершено</th></tr>${rows.map((r)=>`<tr><td>${esc(r.survey_id)}</td><td>${r.started}</td><td>${r.completed||0}</td></tr>`).join('')}</table><p>Excel содержит ответы по анонимным сессиям, long-формат, справочник вопросов, сводную статистику, индексы и корреляции.</p>`);
  } catch(e){next(e);}
});
app.get('/admin/export-long.csv', async (req,res,next) => {
  try {
    const rows=await store.exportRows();const head=['session_id','survey_id','flow','locale','workplace','tenure','completed','block_id','question_id','answer','submitted_at'];
    const csv='\uFEFF'+head.join(',')+'\n'+rows.map((r)=>head.map((k)=>csvCell(r[k])).join(',')).join('\n');
    res.set('Content-Disposition','attachment; filename="dymov-survey-long.csv"');res.type('text/csv; charset=utf-8').send(csv);
  } catch(e){next(e);}
});
app.get('/admin/export.xlsx', async (req,res,next) => {
  try {
    const [sessions,answers]=await Promise.all([store.exportSessions(),store.exportRows()]);
    const buf=makeXlsx(buildAnalysis(config,sessions,answers));
    res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="dymov-survey-results.xlsx"'}).send(buf);
  } catch(e){next(e);}
});

const publicDir = path.join(rootDir,'public');
app.use(express.static(publicDir,{index:false,fallthrough:true,setHeaders:(res)=>res.setHeader('Cache-Control','no-store')}));
app.get('*',(req,res)=>res.sendFile(path.join(publicDir,'index.html')));

app.use((err,req,res,next) => {
  console.error(JSON.stringify({event:'request_error',path:req.path,message:String(err?.message||err),code:err?.code||''}));
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({error:'body_too_large'});
  if (req.path.startsWith('/api/')) return res.status(500).json({error:'server_error'});
  res.status(500).type('text').send('Service temporarily unavailable');
});

const port = Number(process.env.PORT || 8080);
await initDb();
app.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'server_started',port,surveys:Object.keys(surveys).length,office_mode:'single'})));
